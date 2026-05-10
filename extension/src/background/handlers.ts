/**
 * Bridge protocol handlers — routed by the `method` field on incoming WS
 * messages. Each handler returns a JSON-serialisable result (or throws);
 * `bridge.ts` wraps the value into the response envelope.
 *
 * Browser intent methods (`navigate`/`screenshot`/...) preserve the existing
 * v0.2.0 wire format. Userscript methods (`userscript.*`) are added in
 * Phase 2.
 */

import type { ScriptWorld } from "~lib/types";

import {
  closeAgentWindow,
  ensureAgentWindow,
  waitForTabComplete,
} from "./agent-window";
import { state } from "./state";
import { resolveTargetTab } from "./target";
import {
  installUserscriptFromSource,
  installUserscriptFromUrl,
  listUserscripts,
  removeUserscript,
  runUserscriptOnAgentTab,
  setUserscriptEnabled,
  updateUserscript,
} from "./userscript/orchestrator";
import { getScript } from "./userscript/store";
import {
  learnFinish,
  learnStartTab,
  learnStatus,
  resolveTabForScope,
} from "./learn-recorder";

type Handler = (params?: Record<string, unknown>) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const connect: Handler = async (params = {}) => {
  const info = await ensureAgentWindow(params as never);
  let url: string | null = null;
  let title: string | null = null;
  try {
    const tab = await chrome.tabs.get(info.tabId);
    url = tab.url || tab.pendingUrl || null;
    title = tab.title || null;
  } catch {
    // Tab might have been closed mid-call.
  }
  return { ...info, url, title };
};

const disconnect: Handler = async () => {
  await closeAgentWindow();
  return { closed: true };
};

const status: Handler = async () => {
  let alive = false;
  let tab: chrome.tabs.Tab | null = null;
  if (state.agentWindowId !== null && state.agentTabId !== null) {
    try {
      await chrome.windows.get(state.agentWindowId);
      tab = await chrome.tabs.get(state.agentTabId);
      alive = true;
    } catch {
      alive = false;
    }
  }
  return {
    bridge_connected: !!(state.ws && state.ws.readyState === WebSocket.OPEN),
    agent_window: alive
      ? { windowId: state.agentWindowId, tabId: state.agentTabId }
      : null,
    url: tab ? tab.url || tab.pendingUrl || null : null,
    title: tab ? tab.title : null,
  };
};

const show: Handler = async () => {
  if (state.agentWindowId === null) await ensureAgentWindow();
  if (state.agentWindowId !== null) {
    await chrome.windows.update(state.agentWindowId, {
      focused: true,
      drawAttention: true,
    });
  }
  return { ok: true };
};

const hide: Handler = async () => {
  if (state.agentWindowId !== null) {
    await chrome.windows.update(state.agentWindowId, { state: "minimized" });
  }
  return { ok: true };
};

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

const navigate: Handler = async (params = {}) => {
  const url = String(params.url || "");
  const wait_for_load = params.wait_for_load !== false;
  const timeout_ms =
    typeof params.timeout_ms === "number" ? params.timeout_ms : 30_000;
  if (!url) throw new Error("navigate: url is required");

  const { tabId, kind } = await resolveTargetTab();
  const waitPromise = wait_for_load
    ? waitForTabComplete(tabId, timeout_ms)
    : null;
  await chrome.tabs.update(tabId, { url });
  if (waitPromise) await waitPromise;
  const tab = await chrome.tabs.get(tabId);
  return { url: tab.url, title: tab.title, status: tab.status, target: kind };
};

const screenshot: Handler = async (params = {}) => {
  const format = (params.format as "png" | "jpeg") || "png";
  const quality =
    typeof params.quality === "number" ? Math.max(0, Math.min(100, params.quality)) : 80;
  const { tabId, windowId, kind } = await resolveTargetTab();
  const opts: chrome.tabs.CaptureVisibleTabOptions = { format };
  if (format === "jpeg") opts.quality = quality;

  // captureVisibleTab grabs whatever tab is *active* in the window, not
  // the one we hand it. In user mode the pinned tab might not be active
  // (the user alt-tabbed within their own window), and just calling
  // captureVisibleTab there would silently return a different page than
  // what click/type/eval are targeting — a nasty source-of-truth split
  // for the agent. So we briefly activate the resolved tab, capture,
  // then restore. This causes one frame of focus flicker in user mode,
  // which we accept as the cost of consistency.
  const targetTab = await chrome.tabs.get(tabId);
  let previousActiveId: number | null = null;
  if (!targetTab.active) {
    try {
      const [active] = await chrome.tabs.query({ windowId, active: true });
      if (active?.id) previousActiveId = active.id;
      await chrome.tabs.update(tabId, { active: true });
    } catch {
      // Best effort.
    }
  }
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, opts);
    const comma = dataUrl.indexOf(",");
    const data = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    return { data, format, target: kind };
  } finally {
    if (previousActiveId !== null && previousActiveId !== tabId) {
      try {
        await chrome.tabs.update(previousActiveId, { active: true });
      } catch {
        // Best effort.
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Page interaction
// ---------------------------------------------------------------------------

const evalHandler: Handler = async (params = {}) => {
  const js = String(params.js || "");
  const world: ScriptWorld = (params.world as ScriptWorld) || "MAIN";
  if (!js) throw new Error("eval: js is required");
  const { tabId } = await resolveTargetTab();

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world,
    args: [js],
    func: async (code: string) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const fn = new Function(`return (async () => { ${code} })()`);
        const value = await fn();
        let serialized: unknown;
        if (value === undefined) {
          serialized = null;
        } else {
          try {
            serialized = JSON.parse(JSON.stringify(value));
          } catch {
            serialized = String(value);
          }
        }
        return { ok: true, value: serialized };
      } catch (e) {
        return {
          ok: false,
          error: String((e as Error)?.message || e),
        };
      }
    },
  });

  const frame = results[0]?.result as
    | { ok: boolean; value?: unknown; error?: string }
    | undefined;
  if (!frame) throw new Error("eval: no result returned");
  if (!frame.ok) throw new Error(`eval threw: ${frame.error}`);
  return { value: frame.value };
};

const click: Handler = async (params = {}) => {
  const selector = String(params.selector || "");
  if (!selector) throw new Error("click: selector is required");
  const { tabId } = await resolveTargetTab();

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args: [selector],
    func: (sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return { ok: false, error: `No element matches: ${sel}` };
      try {
        if (typeof el.scrollIntoView === "function") {
          el.scrollIntoView({ block: "center", inline: "center" });
        }
        el.click();
        return { ok: true, tag: el.tagName.toLowerCase() };
      } catch (e) {
        return { ok: false, error: String((e as Error)?.message || e) };
      }
    },
  });
  const frame = results[0]?.result as
    | { ok: boolean; tag?: string; error?: string }
    | undefined;
  if (!frame) throw new Error("click: no result");
  if (!frame.ok) throw new Error(frame.error);
  return { clicked: selector, tag: frame.tag };
};

const typeHandler: Handler = async (params = {}) => {
  const selector = String(params.selector || "");
  const text = params.text == null ? "" : String(params.text);
  const clear = params.clear !== false;
  if (!selector) throw new Error("type: selector is required");
  if (params.text === undefined || params.text === null) {
    throw new Error("type: text is required");
  }
  const { tabId } = await resolveTargetTab();

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args: [selector, text, clear],
    func: (sel: string, txt: string, doClear: boolean) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return { ok: false, error: `No element matches: ${sel}` };
      try {
        el.focus();
        const valueEl = el as HTMLInputElement | HTMLTextAreaElement;
        if ("value" in el && typeof valueEl.value === "string") {
          if (doClear) valueEl.value = "";
          valueEl.value = (valueEl.value || "") + txt;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (el.isContentEditable) {
          if (doClear) el.textContent = "";
          el.textContent = (el.textContent || "") + txt;
          el.dispatchEvent(new InputEvent("input", { bubbles: true }));
        } else {
          return { ok: false, error: "Element is not editable" };
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String((e as Error)?.message || e) };
      }
    },
  });
  const frame = results[0]?.result as
    | { ok: boolean; error?: string }
    | undefined;
  if (!frame) throw new Error("type: no result");
  if (!frame.ok) throw new Error(frame.error);
  return { typed: text.length, selector };
};

// ---------------------------------------------------------------------------
// DOM extraction
// ---------------------------------------------------------------------------

const get_html: Handler = async (params = {}) => {
  const selector =
    typeof params.selector === "string" ? params.selector : null;
  const { tabId } = await resolveTargetTab();
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args: [selector],
    func: (sel: string | null) => {
      if (sel) {
        const el = document.querySelector(sel);
        return el ? (el as Element).outerHTML : null;
      }
      return document.documentElement.outerHTML;
    },
  });
  return { html: (results[0]?.result as string | null) ?? null };
};

const get_text: Handler = async (params = {}) => {
  const selector =
    typeof params.selector === "string" ? params.selector : null;
  const { tabId } = await resolveTargetTab();
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args: [selector],
    func: (sel: string | null) => {
      const root = sel
        ? (document.querySelector(sel) as HTMLElement | null)
        : document.body;
      return root ? root.innerText : null;
    },
  });
  return { text: (results[0]?.result as string | null) ?? null };
};

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

const cookies_get: Handler = async (params = {}) => {
  const filter: chrome.cookies.GetAllDetails = {};
  if (typeof params.url === "string") filter.url = params.url;
  if (typeof params.domain === "string") filter.domain = params.domain;
  const cookies = await chrome.cookies.getAll(filter);
  return { cookies };
};

const cookies_set: Handler = async (params = {}) => {
  const cookie = params.cookie as chrome.cookies.SetDetails | undefined;
  if (!cookie || !cookie.url) {
    throw new Error("cookies_set: cookie.url is required");
  }
  const result = await chrome.cookies.set(cookie);
  return { cookie: result };
};

// ---------------------------------------------------------------------------
// localStorage of the agent tab
// ---------------------------------------------------------------------------

const local_storage_get: Handler = async () => {
  const { tabId } = await ensureAgentWindow();
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const out: Record<string, string | null> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k != null) out[k] = localStorage.getItem(k);
      }
      return out;
    },
  });
  return { storage: (results[0]?.result as Record<string, string>) ?? {} };
};

const local_storage_set: Handler = async (params = {}) => {
  const items = (params.items as Record<string, string>) || {};
  const clear = !!params.clear;
  const { tabId } = await ensureAgentWindow();
  await chrome.scripting.executeScript({
    target: { tabId },
    args: [items, clear],
    func: (i: Record<string, string>, c: boolean) => {
      if (c) localStorage.clear();
      for (const [k, v] of Object.entries(i)) localStorage.setItem(k, v);
    },
  });
  return { applied: Object.keys(items).length, cleared: clear };
};

// ---------------------------------------------------------------------------
// Userscript bridge methods (Phase 2)
// ---------------------------------------------------------------------------

const userscript_list: Handler = async () => {
  const items = await listUserscripts();
  return {
    scripts: items.map((s) => ({
      id: s.id,
      name: s.meta.name,
      version: s.meta.version || null,
      enabled: s.enabled,
      matches: s.meta.match,
      include: s.meta.include,
      exclude: s.meta.exclude,
      runAt: s.meta.runAt,
      grants: s.meta.grant,
      sourceURL: s.sourceURL || null,
      installedAt: s.installedAt,
      updatedAt: s.updatedAt,
      lastError: s.lastError || null,
    })),
  };
};

const userscript_get: Handler = async (params = {}) => {
  const id = String(params.id || "");
  if (!id) throw new Error("userscript.get: id is required");
  const s = await getScript(id);
  if (!s) throw new Error(`Script not found: ${id}`);
  return { script: s };
};

const userscript_install: Handler = async (params = {}) => {
  const enabled = params.enabled !== false;
  if (typeof params.url === "string" && params.url) {
    const s = await installUserscriptFromUrl(params.url, { enabled });
    return { script: s };
  }
  if (typeof params.source === "string" && params.source) {
    const s = await installUserscriptFromSource(params.source, {
      enabled,
      sourceURL:
        typeof params.sourceURL === "string" ? params.sourceURL : undefined,
    });
    return { script: s };
  }
  throw new Error("userscript.install: source or url is required");
};

const userscript_save: Handler = async (params = {}) => {
  const id = String(params.id || "");
  const source = String(params.source || "");
  if (!id || !source) {
    throw new Error("userscript.save: id and source are required");
  }
  const s = await updateUserscript(id, source);
  return { script: s };
};

const userscript_remove: Handler = async (params = {}) => {
  const id = String(params.id || "");
  if (!id) throw new Error("userscript.remove: id is required");
  await removeUserscript(id);
  return { removed: id };
};

const userscript_set_enabled: Handler = async (params = {}) => {
  const id = String(params.id || "");
  const enabled = params.enabled !== false;
  if (!id) throw new Error("userscript.setEnabled: id is required");
  const s = await setUserscriptEnabled(id, enabled);
  return { script: s };
};

const userscript_run: Handler = async (params = {}) => {
  const id = String(params.id || "");
  if (!id) throw new Error("userscript.run: id is required");
  const args = params.args ?? null;
  const { tabId } = await ensureAgentWindow();
  const result = await runUserscriptOnAgentTab(id, tabId, args);
  return result;
};

// ---------------------------------------------------------------------------
// Learn mode (record user demo → trace JSON for agent RPA)
// ---------------------------------------------------------------------------

const learn_start: Handler = async (params = {}) => {
  const tabIdParam =
    typeof params.tab_id === "number" && Number.isFinite(params.tab_id)
      ? params.tab_id
      : null;
  const scope = params.scope === "agent" ? "agent" : "last_focused";
  const tabId = await resolveTabForScope(scope, tabIdParam);
  if (tabId === null) {
    throw new Error(
      "learn.start: no tab — use my_browser_connect for agent scope, or focus a normal browser window for last_focused.",
    );
  }
  await learnStartTab(tabId);
  return { ok: true, ...learnStatus() };
};

const learn_stop: Handler = async () => {
  const st = learnStatus();
  if (!st.active) {
    return {
      ok: true,
      recording: false,
      trace: null,
      message: "learn.stop: not recording.",
    };
  }
  const trace = await learnFinish();
  return { ok: true, recording: false, trace };
};

const learn_status: Handler = async () => ({ ok: true, ...learnStatus() });

// ---------------------------------------------------------------------------
// Public dispatch table
// ---------------------------------------------------------------------------

export const HANDLERS: Record<string, Handler> = {
  connect,
  disconnect,
  status,
  show,
  hide,
  navigate,
  screenshot,
  eval: evalHandler,
  click,
  type: typeHandler,
  get_html,
  get_text,
  cookies_get,
  cookies_set,
  local_storage_get,
  local_storage_set,
  // Userscript methods
  "userscript.list": userscript_list,
  "userscript.get": userscript_get,
  "userscript.install": userscript_install,
  "userscript.save": userscript_save,
  "userscript.remove": userscript_remove,
  "userscript.setEnabled": userscript_set_enabled,
  "userscript.run": userscript_run,
  learn_start,
  learn_stop,
  learn_status,
};
