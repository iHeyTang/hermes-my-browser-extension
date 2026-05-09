/**
 * Hermes Browser Extension — service worker entry point.
 *
 * Lifecycle: bootstrap on SW startup, periodic keepalive alarm, popup ↔
 * background message channel, userscript runtime IPC, dynamic content script
 * re-registration after SW restart.
 */

import {
  KEEPALIVE_ALARM,
  KEEPALIVE_PERIOD_MIN,
  USERSCRIPT_UPDATE_ALARM,
  USERSCRIPT_UPDATE_PERIOD_MIN,
} from "./config";
import {
  ensureAgentWindow,
  registerAgentWindowListeners,
} from "./agent-window";
import {
  connect,
  disconnect,
  isBridgeConnected,
  sendRequest as sendBridgeRequest,
} from "./bridge";
import {
  isChatCorsRuleActive,
  refreshChatCorsRule,
  registerChatCorsListeners,
} from "./chat-cors";
import { HANDLERS } from "./handlers";
import {
  getCurrentState,
  loadAgentState,
  loadDesiredConnected,
  loadRunTarget,
  setDesiredConnected,
  setRunTarget,
  state,
  syncState,
} from "./state";
import { resolveUserTab } from "./target";
import {
  reapplyAllRegistrations,
  installUserscriptFromUrl,
  setUserscriptEnabled,
  removeUserscript,
  listUserscripts,
} from "./userscript/orchestrator";
import { registerRuntimeBridge, getMenuFor } from "./userscript/runtime-bridge";
import { listScripts } from "./userscript/store";
import { readUpdateURL } from "./userscript/parser";

// ---------------------------------------------------------------------------
// Wire side-effect listeners
// ---------------------------------------------------------------------------

registerAgentWindowListeners();
registerRuntimeBridge();
registerChatCorsListeners();

// Toolbar-icon click opens the side panel directly. We deliberately removed
// the popup so the click lands on the chat surface in one step. Connection
// state and bridge actions (connect/disconnect, show agent window, scripts)
// are surfaced inside the side panel via BridgeStatusBar instead.
chrome.sidePanel
  ?.setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

// Install the Origin-stripping DNR rule for the configured Hermes host.
// Session rules clear on browser restart but persist across SW restarts, so
// we re-call this on every SW spin-up to be safe.
void refreshChatCorsRule();

// ---------------------------------------------------------------------------
// SW lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  // Drop a friendly hint into the SW console.
  console.log("[hermes-bridge] Installed");
  void reapplyAllRegistrations();
});

async function bootstrap() {
  await loadAgentState();
  await loadDesiredConnected();
  await loadRunTarget();
  syncState();

  try {
    chrome.alarms.create(KEEPALIVE_ALARM, {
      periodInMinutes: KEEPALIVE_PERIOD_MIN,
    });
    chrome.alarms.create(USERSCRIPT_UPDATE_ALARM, {
      periodInMinutes: USERSCRIPT_UPDATE_PERIOD_MIN,
    });
  } catch (e) {
    console.warn("[hermes-bridge] Failed to register alarms:", e);
  }

  await reapplyAllRegistrations().catch((e) =>
    console.warn("[hermes-bridge] reapplyAllRegistrations failed:", e),
  );

  if (state.desiredConnected) {
    console.log("[hermes-bridge] Auto-reconnecting (desiredConnected=true)");
    connect();
  }
}

bootstrap().catch((e) =>
  console.warn("[hermes-bridge] bootstrap failed:", e),
);

chrome.runtime.onStartup?.addListener(() => {
  bootstrap().catch((e) =>
    console.warn("[hermes-bridge] startup bootstrap failed:", e),
  );
});

// ---------------------------------------------------------------------------
// Keepalive
// ---------------------------------------------------------------------------

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
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
        try {
          state.ws.close();
        } catch {
          // Ignore.
        }
      }
    }
    syncState();
    return;
  }

  if (alarm.name === USERSCRIPT_UPDATE_ALARM) {
    await pollUserscriptUpdates().catch((e) =>
      console.warn("[hermes-bridge] userscript update poll failed:", e),
    );
  }
});

async function pollUserscriptUpdates() {
  const all = await listScripts();
  for (const s of all) {
    const url = s.meta.updateURL || s.sourceURL;
    if (!url) continue;
    try {
      const res = await fetch(url, { credentials: "omit" });
      if (!res.ok) continue;
      const remoteSource = await res.text();
      const remoteUpdate = readUpdateURL(remoteSource) || url;
      // We re-import via installUserscriptFromUrl-equivalent (treat as source
      // refresh keeping the same id so the registration is replaced).
      const remoteVer = remoteSource.match(/@version\s+(\S+)/i)?.[1];
      if (remoteVer && remoteVer === s.meta.version) continue;
      // Heuristic: if the version did not change, skip.
      const _ = remoteUpdate;
      const { updateUserscript } = await import("./userscript/orchestrator");
      await updateUserscript(s.id, remoteSource).catch((e) =>
        console.warn(
          `[hermes-bridge] update failed for ${s.id}:`,
          (e as Error)?.message,
        ),
      );
    } catch (e) {
      console.warn(
        `[hermes-bridge] update poll fetch failed for ${s.id}:`,
        (e as Error)?.message,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Popup / options ↔ background message channel
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  (async () => {
    if (!request || typeof request !== "object") {
      sendResponse({ ok: false, error: "invalid request" });
      return;
    }
    const action = (request as { action?: string }).action;
    if (action === "connect") {
      await setDesiredConnected(true);
      connect();
      try {
        await ensureAgentWindow();
      } catch (e) {
        console.warn("[hermes-bridge] ensureAgentWindow failed:", e);
      }
      sendResponse({ ok: true });
      return;
    }

    if (action === "disconnect") {
      await disconnect();
      sendResponse({ ok: true });
      return;
    }

    if (action === "show") {
      try {
        await HANDLERS.show();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String((e as Error)?.message || e) });
      }
      return;
    }

    // ---------------------------------------------------------------------
    // Run-target: where browser-control tool calls go (agent / user / mirror).
    //
    // The side panel pushes the user's choice in here right before each
    // send, and can also pull it on mount to restore the toggle UI after a
    // panel reload. `runTarget.promoteToUser` is the mid-run hand-off:
    // flip to user-tab AND optionally bring the agent's current URL
    // along, so the user lands on whatever page the agent had open.
    // ---------------------------------------------------------------------

    if (action === "runTarget.get") {
      sendResponse({ ok: true, runTarget: state.runTarget });
      return;
    }

    if (action === "runTarget.set") {
      try {
        const r = request as Record<string, unknown>;
        const target = r.target as "agent" | "user" | undefined;
        await setRunTarget({
          target,
          userTabId:
            typeof r.userTabId === "number" ? (r.userTabId as number) : null,
          userWindowId:
            typeof r.userWindowId === "number"
              ? (r.userWindowId as number)
              : null,
        });
        sendResponse({ ok: true, runTarget: state.runTarget });
      } catch (e) {
        sendResponse({ ok: false, error: String((e as Error)?.message || e) });
      }
      return;
    }

    if (action === "runTarget.promoteToUser") {
      // Mid-run "Move to my tab": pin a user tab and (best-effort) jump
      // it to the agent's current URL so the user picks up the trail
      // exactly where the agent left off. We deliberately don't switch
      // any subsequent tool calls *back* to agent mode automatically —
      // the user explicitly chose to take over, so they keep the wheel
      // until they flip the toggle themselves.
      try {
        const r = request as Record<string, unknown>;
        const userTabId =
          typeof r.userTabId === "number" ? (r.userTabId as number) : null;
        const userWindowId =
          typeof r.userWindowId === "number"
            ? (r.userWindowId as number)
            : null;
        let agentUrl: string | null = null;
        if (state.agentTabId !== null) {
          try {
            const agentTab = await chrome.tabs.get(state.agentTabId);
            agentUrl = agentTab.url || agentTab.pendingUrl || null;
          } catch {
            agentUrl = null;
          }
        }
        await setRunTarget({ target: "user", userTabId, userWindowId });
        let navigatedTo: string | null = null;
        if (agentUrl && /^(https?|file|ftp):/i.test(agentUrl)) {
          try {
            const target = await resolveUserTab();
            await chrome.tabs.update(target.tabId, {
              url: agentUrl,
              active: true,
            });
            // Bring the user's window to focus so they actually see the
            // page the agent had open — without this the user is left
            // wondering whether the click did anything.
            try {
              await chrome.windows.update(target.windowId, { focused: true });
            } catch {
              // Best effort.
            }
            navigatedTo = agentUrl;
          } catch (e) {
            console.warn(
              "[hermes-bridge] promoteToUser navigate failed:",
              e,
            );
          }
        }
        sendResponse({
          ok: true,
          runTarget: state.runTarget,
          navigatedTo,
        });
      } catch (e) {
        sendResponse({ ok: false, error: String((e as Error)?.message || e) });
      }
      return;
    }

    if (action === "agent.lastUrl") {
      let url: string | null = null;
      let title: string | null = null;
      if (state.agentTabId !== null) {
        try {
          const tab = await chrome.tabs.get(state.agentTabId);
          url = tab.url || tab.pendingUrl || null;
          title = tab.title || null;
        } catch {
          // Agent tab gone.
        }
      }
      sendResponse({ ok: true, url, title });
      return;
    }

    if (action === "chatCors.status") {
      try {
        const active = await isChatCorsRuleActive();
        sendResponse({ ok: true, active });
      } catch (e) {
        sendResponse({ ok: false, error: String((e as Error)?.message || e) });
      }
      return;
    }

    if (action === "chatCors.refresh") {
      try {
        await refreshChatCorsRule();
        const active = await isChatCorsRuleActive();
        sendResponse({ ok: true, active });
      } catch (e) {
        sendResponse({ ok: false, error: String((e as Error)?.message || e) });
      }
      return;
    }

    if (action === "openSidePanel") {
      try {
        const win = await chrome.windows.getCurrent();
        if (win.id !== undefined) {
          await chrome.sidePanel.open({ windowId: win.id });
        }
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String((e as Error)?.message || e) });
      }
      return;
    }

    if (action === "openOptions") {
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return;
    }

    if (action === "status") {
      let agentAlive = false;
      let url: string | null = null;
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
      const cs = getCurrentState();
      sendResponse({
        state: cs,
        connected: cs === "connected",
        connecting: cs === "connecting",
        desiredConnected: state.desiredConnected,
        agentWindowId: state.agentWindowId,
        agentTabId: state.agentTabId,
        agentAlive,
        url,
      });
      return;
    }

    if (action === "menu.list") {
      const tabId = (request as { tabId?: number }).tabId;
      const list =
        typeof tabId === "number" ? getMenuFor(tabId) : [];
      sendResponse({ ok: true, items: list });
      return;
    }

    if (action === "menu.invoke") {
      const tabId = (request as { tabId?: number }).tabId;
      const id = (request as { id?: number }).id;
      if (typeof tabId === "number" && typeof id === "number") {
        chrome.tabs
          .sendMessage(tabId, { type: "userscript.menu.invoke", id })
          .catch(() => {});
      }
      sendResponse({ ok: true });
      return;
    }

    // ---------------------------------------------------------------------
    // Side-panel attachments → Python.
    //
    // The side panel reads a File / fetched Blob, base64-encodes its bytes
    // and asks the SW to forward the payload through the bridge to Python,
    // which writes it under ~/.hermes/plugins/.../attachments/<session>/
    // and returns the absolute path. The path is what we then reference in
    // the chat prompt — the agent uses its own read_file / pdf / image
    // tools to actually read the bytes if it cares.
    //
    // Two actions:
    //   - `attachment.put`    : upload bytes, get back { path, name, mime, size }
    //   - `attachment.delete` : remove a previously-uploaded file (or a
    //                           whole per-session directory) when the user
    //                           drops a chip pre-send or deletes a chat.
    //
    // Bridge-required: both fail fast with a clear error if Hermes isn't
    // connected. The side panel surfaces that as a tooltip on the chip.
    // ---------------------------------------------------------------------

    if (action === "attachment.put") {
      try {
        if (!isBridgeConnected()) {
          sendResponse({
            ok: false,
            error:
              "Not connected to Hermes. Click the bridge status pill in " +
              "the side panel to connect, then enable file attachments.",
          });
          return;
        }
        const r = request as Record<string, unknown>;
        const params = {
          name: typeof r.name === "string" ? r.name : "file",
          mime:
            typeof r.mime === "string" && r.mime
              ? r.mime
              : "application/octet-stream",
          data_b64: typeof r.data_b64 === "string" ? r.data_b64 : "",
          session_id: typeof r.session_id === "string" ? r.session_id : "default",
        };
        // Generous timeout: 50 MB over a localhost WS is sub-second, but
        // base64 decode + write on the Python side has surprised us before.
        const result = await sendBridgeRequest<{
          path: string;
          name: string;
          mime: string;
          size: number;
        }>("attachment.put", params, 60_000);
        sendResponse({ ok: true, ...result });
      } catch (e) {
        sendResponse({ ok: false, error: String((e as Error)?.message || e) });
      }
      return;
    }

    if (action === "attachment.delete") {
      try {
        if (!isBridgeConnected()) {
          // Silent no-op when disconnected: the UI calls this opportunistically
          // on chip-remove and shouldn't yell at the user about an offline
          // bridge they may not even know exists.
          sendResponse({ ok: true, deleted: false, reason: "not connected" });
          return;
        }
        const r = request as Record<string, unknown>;
        const path = typeof r.path === "string" ? r.path : "";
        if (!path) {
          sendResponse({ ok: false, error: "missing path" });
          return;
        }
        const result = await sendBridgeRequest<{
          deleted: boolean;
          reason?: string;
        }>("attachment.delete", { path }, 10_000);
        sendResponse({ ok: true, ...result });
      } catch (e) {
        sendResponse({ ok: false, error: String((e as Error)?.message || e) });
      }
      return;
    }

    if (action === "attachment.deleteSession") {
      // Wipe an entire per-session attachments directory in one call —
      // wired to the side panel's "Delete chat" affordance so we don't
      // leak files for conversations the user has thrown away. Same
      // silent-noop-when-disconnected stance as `attachment.delete`.
      try {
        if (!isBridgeConnected()) {
          sendResponse({ ok: true, deleted: false, reason: "not connected" });
          return;
        }
        const r = request as Record<string, unknown>;
        const session_id =
          typeof r.session_id === "string" ? r.session_id : "";
        if (!session_id) {
          sendResponse({ ok: false, error: "missing session_id" });
          return;
        }
        const result = await sendBridgeRequest<{
          deleted: boolean;
          reason?: string;
        }>("attachment.deleteSession", { session_id }, 10_000);
        sendResponse({ ok: true, ...result });
      } catch (e) {
        sendResponse({ ok: false, error: String((e as Error)?.message || e) });
      }
      return;
    }

    if (action === "userscript.list") {
      const items = await listUserscripts();
      sendResponse({ ok: true, scripts: items });
      return;
    }

    if (action === "userscript.installFromUrl") {
      try {
        const url = String((request as Record<string, unknown>).url || "");
        const enabled = (request as Record<string, unknown>).enabled !== false;
        const s = await installUserscriptFromUrl(url, { enabled });
        sendResponse({ ok: true, script: s });
      } catch (e) {
        sendResponse({ ok: false, error: String((e as Error)?.message || e) });
      }
      return;
    }

    if (action === "userscript.installFromSource") {
      try {
        const source = String(
          (request as Record<string, unknown>).source || "",
        );
        const enabled = (request as Record<string, unknown>).enabled !== false;
        const { installUserscriptFromSource } = await import(
          "./userscript/orchestrator"
        );
        const s = await installUserscriptFromSource(source, { enabled });
        sendResponse({ ok: true, script: s });
      } catch (e) {
        sendResponse({ ok: false, error: String((e as Error)?.message || e) });
      }
      return;
    }

    if (action === "userscript.save") {
      try {
        const id = String((request as Record<string, unknown>).id || "");
        const source = String(
          (request as Record<string, unknown>).source || "",
        );
        const { updateUserscript } = await import("./userscript/orchestrator");
        const s = await updateUserscript(id, source);
        sendResponse({ ok: true, script: s });
      } catch (e) {
        sendResponse({ ok: false, error: String((e as Error)?.message || e) });
      }
      return;
    }

    if (action === "userscript.remove") {
      try {
        const id = String((request as Record<string, unknown>).id || "");
        await removeUserscript(id);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String((e as Error)?.message || e) });
      }
      return;
    }

    if (action === "userscript.setEnabled") {
      try {
        const id = String((request as Record<string, unknown>).id || "");
        const enabled =
          (request as Record<string, unknown>).enabled !== false;
        const s = await setUserscriptEnabled(id, enabled);
        sendResponse({ ok: true, script: s });
      } catch (e) {
        sendResponse({ ok: false, error: String((e as Error)?.message || e) });
      }
      return;
    }

    sendResponse({ ok: false, error: `Unknown action: ${action}` });
  })();
  return true;
});
