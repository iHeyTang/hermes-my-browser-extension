/**
 * Shared mutable state for the extension.
 *
 * Exposed as a single object so modules that mutate it (connection,
 * agent-window) and modules that read it (handlers, icon, popup
 * messaging) all see the same live values without setter boilerplate.
 *
 * Also owns the *single source of truth* for the connection-state
 * tri-state ("disconnected" / "connecting" / "connected"), which both the
 * toolbar icon and the popup derive from.
 */

import { applyIcon } from "./icon.js";

export const state = {
  ws: null,
  reconnectTimer: null,
  heartbeatTimer: null,
  // In-memory mirror of `chrome.storage.local.desiredConnected`. Used as a
  // synchronous source of truth for the badge / popup so every code path
  // derives the displayed state from the same value.
  desiredConnected: false,
  agentWindowId: null,
  agentTabId: null,
};

// ---------------------------------------------------------------------------
// Persistence (survives service worker restarts within a browser session)
// ---------------------------------------------------------------------------

export async function saveAgentState() {
  await chrome.storage.session.set({
    agentWindowId: state.agentWindowId,
    agentTabId: state.agentTabId,
  });
}

export async function loadAgentState() {
  const { agentWindowId: w, agentTabId: t } = await chrome.storage.session.get([
    "agentWindowId",
    "agentTabId",
  ]);
  if (w && t) {
    try {
      await chrome.windows.get(w);
      await chrome.tabs.get(t);
      state.agentWindowId = w;
      state.agentTabId = t;
      return true;
    } catch {
      state.agentWindowId = null;
      state.agentTabId = null;
      await saveAgentState();
    }
  }
  return false;
}

// "Desired connection" survives SW termination and full browser restarts so
// the worker can transparently re-establish the WS without user action.
export async function loadDesiredConnected() {
  const { desiredConnected: stored } = await chrome.storage.local.get("desiredConnected");
  state.desiredConnected = !!stored;
  return state.desiredConnected;
}

export async function setDesiredConnected(value) {
  state.desiredConnected = !!value;
  await chrome.storage.local.set({ desiredConnected: state.desiredConnected });
  syncState();
}

// ---------------------------------------------------------------------------
// Connection state — single source of truth for badge / popup.
//
// "disconnected" — user did not (or no longer) wants a connection.
// "connecting"   — user wants a connection but the WS isn't OPEN yet.
//                  Covers initial handshake AND backoff between retries
//                  when the bridge server is unreachable, so the UI no
//                  longer flickers connecting → disconnected → connecting.
// "connected"    — WS is OPEN.
// ---------------------------------------------------------------------------

export function getCurrentState() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) return "connected";
  if (state.desiredConnected) return "connecting";
  return "disconnected";
}

// Recompute and reflect the current state everywhere (icon + popup).
export function syncState() {
  const s = getCurrentState();
  applyIcon(s);
  broadcastStatus();
}

export function broadcastStatus() {
  // No-op when nobody is listening (popup closed); swallow the rejection.
  chrome.runtime.sendMessage({ type: "hermes:status-changed" }).catch(() => {});
}
