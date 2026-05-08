/**
 * Hermes Browser Bridge — service worker entry point.
 *
 * All meaningful logic lives in sibling modules; this file just wires
 * lifecycle events together: bootstrap on SW startup, the periodic
 * keepalive alarm, and the popup ↔ background message channel.
 *
 * Architecture: Hermes operates in a *dedicated background window* using
 * stock chrome.* APIs (tabs, scripting, cookies). No chrome.debugger means
 * no "is debugging this browser" banner, and the user's active tabs are
 * never touched.
 *
 * Protocol (high-level intent, not raw CDP):
 *   {"id":"req_1","method":"navigate",  "params":{"url":"https://..."}}
 *   {"id":"req_1","method":"screenshot","params":{"format":"png"}}
 *   {"id":"req_1","method":"eval",      "params":{"js":"document.title","world":"MAIN"}}
 *   {"id":"req_1","method":"click",     "params":{"selector":"#btn"}}
 *   ...
 *
 * Response envelope:
 *   {"id":"req_1","result":{...}}  or  {"id":"req_1","error":{"message":"..."}}
 */

import { KEEPALIVE_ALARM, KEEPALIVE_PERIOD_MIN } from "./config.js";
import {
  state,
  loadAgentState,
  loadDesiredConnected,
  setDesiredConnected,
  syncState,
  getCurrentState,
} from "./state.js";
import { connect, disconnect } from "./connection.js";
// Side-effect import: registers chrome.windows / chrome.tabs onRemoved
// listeners at module scope so a manual close clears stale ids.
import { ensureAgentWindow } from "./agent-window.js";
import { HANDLERS } from "./handlers.js";

// ---------------------------------------------------------------------------
// SW lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  console.log("[hermes-bridge] Installed");
});

// Run once per SW startup: restore window state, paint the icon to match
// reality (clears any stale colour from a previous SW lifecycle), and
// resume the connection if the user wanted it.
async function bootstrap() {
  await loadAgentState();
  await loadDesiredConnected();
  syncState();

  // Always have a backup wake-up registered so the SW gets revived even
  // after a hard termination.
  try {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MIN });
  } catch (e) {
    console.warn("[hermes-bridge] Failed to register keepalive alarm:", e);
  }

  if (state.desiredConnected) {
    console.log("[hermes-bridge] Auto-reconnecting (desiredConnected=true)");
    connect();
  }
}

bootstrap().catch((e) => console.warn("[hermes-bridge] bootstrap failed:", e));

chrome.runtime.onStartup?.addListener(() => {
  bootstrap().catch((e) =>
    console.warn("[hermes-bridge] startup bootstrap failed:", e)
  );
});

// ---------------------------------------------------------------------------
// Keepalive
// ---------------------------------------------------------------------------

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  // Re-hydrate desiredConnected in case the SW was just woken up.
  await loadDesiredConnected();
  if (!state.desiredConnected) {
    syncState();
    return;
  }
  if (
    !state.ws ||
    state.ws.readyState === WebSocket.CLOSED ||
    state.ws.readyState === WebSocket.CLOSING
  ) {
    console.log("[hermes-bridge] Keepalive: ws gone, reconnecting");
    connect();
  } else if (state.ws.readyState === WebSocket.OPEN) {
    try {
      state.ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
    } catch (e) {
      console.warn("[hermes-bridge] Keepalive ping failed:", e);
      try { state.ws.close(); } catch {}
    }
  }
  syncState();
});

// ---------------------------------------------------------------------------
// Popup ↔ background message channel
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    if (request.action === "connect") {
      await setDesiredConnected(true);
      connect();
      // Eagerly open agent window so the user sees it appear.
      try {
        await ensureAgentWindow();
      } catch (e) {
        console.warn("[hermes-bridge] ensureAgentWindow failed:", e);
      }
      sendResponse({ ok: true });
      return;
    }

    if (request.action === "disconnect") {
      await disconnect();
      sendResponse({ ok: true });
      return;
    }

    if (request.action === "show") {
      try {
        await HANDLERS.show();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
      return;
    }

    if (request.action === "status") {
      let agentAlive = false;
      let url = null;
      if (state.agentWindowId !== null && state.agentTabId !== null) {
        try {
          await chrome.windows.get(state.agentWindowId);
          const tab = await chrome.tabs.get(state.agentTabId);
          agentAlive = true;
          url = tab.url || tab.pendingUrl || null;
        } catch {
          agentAlive = false;
        }
      }
      // Single source of truth — same value the icon derives from.
      const cs = getCurrentState();
      sendResponse({
        state: cs, // "disconnected" | "connecting" | "connected"
        connected: cs === "connected",
        connecting: cs === "connecting",
        desiredConnected: state.desiredConnected,
        agentWindowId: state.agentWindowId,
        agentTabId: state.agentTabId,
        agentAlive,
        url,
      });
    }
  })();
  return true; // keep channel open for async sendResponse
});
