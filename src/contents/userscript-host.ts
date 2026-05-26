/**
 * Userscript bouncer (ISOLATED world content script).
 *
 * Runs at document_start on every page. Asks the SW which scripts apply,
 * schedules their injection at the right `@run-at`, and relays IPC between
 * the wrapped runtime (MAIN world) and the SW.
 *
 * The wrapped runtime is built by `~lib/userscript/build-runtime.ts` and
 * carries the GM_* shim plus the user's source. Communication uses
 * `window.postMessage` on a per-page random channel so the host page can't
 * sniff or spoof us.
 */

import type {
  GmXhrRequest,
  GmXhrResponse,
  RunAt,
  UserScriptMetadata,
} from "~lib/types";
import { buildWrappedSource } from "~lib/userscript/build-runtime";

import type { PlasmoCSConfig } from "plasmo";

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  run_at: "document_start",
  all_frames: true,
};

interface BootstrapScript {
  id: string;
  name: string;
  source: string;
  meta: UserScriptMetadata;
  requires: string[];
  resources: { name: string; url: string; dataUrl: string }[];
  runtimeArgs?: unknown;
}

interface BootstrapPayload {
  scripts: BootstrapScript[];
}

const CHANNEL_ID =
  "hermes-userscript-" +
  (typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
    : Math.random().toString(36).slice(2));

// ---------------------------------------------------------------------------
// MAIN→ISOLATED channel
// ---------------------------------------------------------------------------

interface PageRpc {
  type: "rpc";
  channel: string;
  scriptId: string;
  rpcId: number;
  call: string;
  params: unknown;
}

interface PageRpcResult {
  type: "rpc-result";
  channel: string;
  rpcId: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

interface PageEvent {
  type: "event";
  channel: string;
  event: string;
  payload: unknown;
}

window.addEventListener(
  "message",
  (e) => {
    const data = e.data;
    if (!data || typeof data !== "object") return;
    if ((data as { channel?: string }).channel !== CHANNEL_ID) return;
    const kind = (data as { type?: string }).type;
    if (kind === "rpc") {
      void handleRpc(data as PageRpc);
    } else if (kind === "menu-invoke-ack") {
      // For symmetry: not currently used.
    }
  },
  false,
);

function postToPage(msg: PageRpcResult | PageEvent) {
  window.postMessage(msg, window.location.origin);
}

// ---------------------------------------------------------------------------
// SW-side IPC + XHR streaming
// ---------------------------------------------------------------------------

const PENDING_XHR = new Map<
  string,
  { scriptId: string; rpcId: number }
>();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  const type = (message as { type?: string }).type;
  if (type === "gm-xhr-response") {
    const frame = message as GmXhrResponse;
    const pending = PENDING_XHR.get(frame.requestId);
    if (!pending) return false;
    postToPage({
      type: "event",
      channel: CHANNEL_ID,
      event: "xhr-frame",
      payload: { rpcId: pending.rpcId, frame },
    });
    if (
      frame.phase === "load" ||
      frame.phase === "error" ||
      frame.phase === "abort" ||
      frame.phase === "timeout"
    ) {
      PENDING_XHR.delete(frame.requestId);
    }
    sendResponse({ ok: true });
    return true;
  }
  if (type === "userscript.menu.invoke") {
    postToPage({
      type: "event",
      channel: CHANNEL_ID,
      event: "menu-invoke",
      payload: { id: (message as { id: number }).id },
    });
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

// Forward "force run" dispatched from SW (executeScript) into the page.
window.addEventListener("message", (e) => {
  const data = e.data;
  if (!data || typeof data !== "object") return;
  if ((data as { type?: string }).type !== "hermes:userscript-run") return;
  const payload = (data as { script?: BootstrapScript }).script;
  if (!payload) return;
  injectScript(payload);
});

// ---------------------------------------------------------------------------
// Bootstrap: ask SW for matching scripts, schedule per `@run-at`
// ---------------------------------------------------------------------------

void (async function bootstrap() {
  let res: BootstrapPayload | undefined;
  try {
    res = await chrome.runtime.sendMessage({
      type: "userscript.bootstrap",
    });
  } catch (e) {
    console.warn("[hermes-userscript] bootstrap failed:", e);
    return;
  }
  if (!res || !Array.isArray(res.scripts)) return;
  for (const script of res.scripts) {
    schedule(script);
  }
})();

function schedule(script: BootstrapScript) {
  const at: RunAt = script.meta.runAt || "document-end";
  const inject = () => injectScript(script);
  if (at === "document-start") {
    inject();
    return;
  }
  if (at === "document-body") {
    if (document.body) return inject();
    new MutationObserver((_, obs) => {
      if (document.body) {
        obs.disconnect();
        inject();
      }
    }).observe(document.documentElement, { childList: true });
    return;
  }
  if (at === "document-end") {
    if (
      document.readyState === "interactive" ||
      document.readyState === "complete"
    ) {
      inject();
      return;
    }
    document.addEventListener("DOMContentLoaded", inject, { once: true });
    return;
  }
  // document-idle
  if (document.readyState === "complete") {
    setTimeout(inject, 0);
  } else {
    window.addEventListener("load", () => setTimeout(inject, 0), { once: true });
  }
}

// ---------------------------------------------------------------------------
// Injection — append an inline <script> to documentElement.
// ---------------------------------------------------------------------------

async function injectScript(script: BootstrapScript) {
  // Snapshot GM_setValue store so MAIN can read synchronously.
  let valueSnapshot: Record<string, unknown> = {};
  try {
    const { keys } = (await chrome.runtime.sendMessage({
      type: "userscript.value.list",
      scriptId: script.id,
    })) as { ok: boolean; keys?: string[] };
    if (Array.isArray(keys) && keys.length) {
      for (const k of keys) {
        const r = (await chrome.runtime.sendMessage({
          type: "userscript.value.get",
          scriptId: script.id,
          name: k,
          fallback: undefined,
        })) as { ok: boolean; value?: unknown };
        if (r.ok) valueSnapshot[k] = r.value;
      }
    }
  } catch {
    valueSnapshot = {};
  }

  const wrapped = buildWrappedSource({
    channelId: CHANNEL_ID,
    script,
    valueSnapshot,
  });
  try {
    const el = document.createElement("script");
    el.textContent = wrapped;
    el.dataset.hermesUserscript = script.id;
    (document.head || document.documentElement).appendChild(el);
    el.remove();
  } catch (e) {
    console.warn(
      `[hermes-userscript] inline injection failed for ${script.id}; falling back to executeScript`,
      e,
    );
    // Fallback for sites with strict CSP — ask SW to executeScript.
    chrome.runtime
      .sendMessage({
        type: "userscript.runManual",
        scriptId: script.id,
      })
      .catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// MAIN→ISOLATED RPC dispatch
// ---------------------------------------------------------------------------

async function handleRpc(msg: PageRpc) {
  const { rpcId, call, params } = msg;
  try {
    if (call === "value.get") {
      const { scriptId, name, fallback } = params as {
        scriptId: string;
        name: string;
        fallback: unknown;
      };
      const r = (await chrome.runtime.sendMessage({
        type: "userscript.value.get",
        scriptId,
        name,
        fallback,
      })) as { ok: boolean; value?: unknown };
      reply(rpcId, true, r.value);
      return;
    }
    if (call === "value.set") {
      const { scriptId, name, value } = params as {
        scriptId: string;
        name: string;
        value: unknown;
      };
      await chrome.runtime.sendMessage({
        type: "userscript.value.set",
        scriptId,
        name,
        value,
      });
      reply(rpcId, true);
      return;
    }
    if (call === "value.delete") {
      const { scriptId, name } = params as {
        scriptId: string;
        name: string;
      };
      await chrome.runtime.sendMessage({
        type: "userscript.value.delete",
        scriptId,
        name,
      });
      reply(rpcId, true);
      return;
    }
    if (call === "value.list") {
      const { scriptId } = params as { scriptId: string };
      const r = (await chrome.runtime.sendMessage({
        type: "userscript.value.list",
        scriptId,
      })) as { ok: boolean; keys?: string[] };
      reply(rpcId, true, r.keys || []);
      return;
    }
    if (call === "resource.get") {
      const { scriptId, name } = params as {
        scriptId: string;
        name: string;
      };
      const r = (await chrome.runtime.sendMessage({
        type: "userscript.resource.get",
        scriptId,
        name,
      })) as { ok: boolean; resource?: { text: string; dataUrl: string } };
      reply(rpcId, true, r.resource ?? null);
      return;
    }
    if (call === "notify") {
      const { scriptId, options } = params as {
        scriptId: string;
        options: unknown;
      };
      await chrome.runtime.sendMessage({
        type: "userscript.notify",
        scriptId,
        options,
      });
      reply(rpcId, true);
      return;
    }
    if (call === "openInTab") {
      const r = (await chrome.runtime.sendMessage({
        type: "userscript.openInTab",
        ...(params as Record<string, unknown>),
      })) as { ok: boolean; tabId?: number };
      reply(rpcId, true, r);
      return;
    }
    if (call === "download") {
      const r = (await chrome.runtime.sendMessage({
        type: "userscript.download",
        ...(params as Record<string, unknown>),
      })) as { ok: boolean; id?: number };
      reply(rpcId, true, r);
      return;
    }
    if (call === "menu.register") {
      const r = (await chrome.runtime.sendMessage({
        type: "userscript.menu.register",
        ...(params as Record<string, unknown>),
      })) as { ok: boolean; id?: number };
      reply(rpcId, true, r.id);
      return;
    }
    if (call === "menu.unregister") {
      await chrome.runtime.sendMessage({
        type: "userscript.menu.unregister",
        ...(params as Record<string, unknown>),
      });
      reply(rpcId, true);
      return;
    }
    if (call === "xhr") {
      const req = params as GmXhrRequest;
      PENDING_XHR.set(req.requestId, {
        scriptId: req.scriptId || "",
        rpcId,
      });
      await chrome.runtime.sendMessage(req);
      reply(rpcId, true);
      return;
    }
    if (call === "xhr.abort") {
      const { requestId } = params as { requestId: string };
      await chrome.runtime.sendMessage({ type: "gm-xhr-abort", requestId });
      reply(rpcId, true);
      return;
    }
    if (call === "log") {
      console.log("[userscript]", (params as { msg: string }).msg);
      reply(rpcId, true);
      return;
    }
    if (call === "setClipboard") {
      const { text } = params as { text: string };
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Best effort.
      }
      reply(rpcId, true);
      return;
    }
    reply(rpcId, false, undefined, `Unknown RPC: ${call}`);
  } catch (e) {
    reply(rpcId, false, undefined, String((e as Error)?.message || e));
  }
}

function reply(rpcId: number, ok: boolean, value?: unknown, error?: string) {
  postToPage({
    type: "rpc-result",
    channel: CHANNEL_ID,
    rpcId,
    ok,
    value,
    error,
  });
}
