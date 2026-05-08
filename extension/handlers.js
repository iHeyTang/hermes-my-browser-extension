/**
 * Protocol handlers — routed by the `method` field in incoming WS messages.
 *
 * Each handler returns a JSON-serialisable result (or throws); the caller
 * in `connection.js` wraps the value into the response envelope and
 * forwards it back to the bridge.
 */

import { state } from "./state.js";
import {
  ensureAgentWindow,
  closeAgentWindow,
  waitForTabComplete,
} from "./agent-window.js";

export const HANDLERS = {
  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  connect: async (params = {}) => {
    const info = await ensureAgentWindow(params);
    let url = null;
    let title = null;
    try {
      const tab = await chrome.tabs.get(info.tabId);
      url = tab.url || tab.pendingUrl || null;
      title = tab.title || null;
    } catch {}
    return { ...info, url, title };
  },

  disconnect: async () => {
    await closeAgentWindow();
    return { closed: true };
  },

  status: async () => {
    let alive = false;
    let tab = null;
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
  },

  show: async () => {
    if (state.agentWindowId === null) await ensureAgentWindow();
    await chrome.windows.update(state.agentWindowId, {
      focused: true,
      drawAttention: true,
    });
    return { ok: true };
  },

  hide: async () => {
    if (state.agentWindowId !== null) {
      await chrome.windows.update(state.agentWindowId, { state: "minimized" });
    }
    return { ok: true };
  },

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  navigate: async (params = {}) => {
    const { url, wait_for_load = true, timeout_ms = 30000 } = params;
    if (!url) throw new Error("navigate: url is required");
    const { tabId } = await ensureAgentWindow();

    let waitPromise = null;
    if (wait_for_load) {
      waitPromise = waitForTabComplete(tabId, timeout_ms);
    }
    await chrome.tabs.update(tabId, { url });
    if (waitPromise) {
      await waitPromise;
    }
    const tab = await chrome.tabs.get(tabId);
    return { url: tab.url, title: tab.title, status: tab.status };
  },

  // Screenshot of the agent tab (viewport only).
  //
  // captureVisibleTab can only photograph the *active* tab of a window, so
  // in a multi-tab agent window we briefly activate the agent tab, capture,
  // then restore whichever tab the user (or anything else) had focused.
  // We never raise/focus the window itself, so the user's other windows
  // are unaffected.
  screenshot: async (params = {}) => {
    const { format = "png", quality = 80 } = params;
    const { tabId, windowId } = await ensureAgentWindow();
    const opts = { format };
    if (format === "jpeg") opts.quality = Math.max(0, Math.min(100, quality));

    const agentTab = await chrome.tabs.get(tabId);
    let previousActiveId = null;
    if (!agentTab.active) {
      try {
        const [active] = await chrome.tabs.query({ windowId, active: true });
        if (active) previousActiveId = active.id;
        await chrome.tabs.update(tabId, { active: true });
      } catch {}
    }

    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, opts);
      const comma = dataUrl.indexOf(",");
      const data = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
      return { data, format };
    } finally {
      if (previousActiveId !== null && previousActiveId !== tabId) {
        try {
          await chrome.tabs.update(previousActiveId, { active: true });
        } catch {}
      }
    }
  },

  // -------------------------------------------------------------------------
  // Page interaction
  // -------------------------------------------------------------------------

  // Run JavaScript in the agent tab.
  // params: { js, world?: "MAIN" | "ISOLATED" }
  eval: async (params = {}) => {
    const { js, world = "MAIN" } = params;
    if (!js) throw new Error("eval: js is required");
    const { tabId } = await ensureAgentWindow();

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world,
      args: [js],
      func: async (code) => {
        try {
          // eslint-disable-next-line no-new-func
          const fn = new Function(`return (async () => { ${code} })()`);
          const value = await fn();
          let serialized;
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
          return { ok: false, error: String((e && e.message) || e) };
        }
      },
    });

    const frame = results[0]?.result;
    if (!frame) throw new Error("eval: no result returned");
    if (!frame.ok) throw new Error(`eval threw: ${frame.error}`);
    return { value: frame.value };
  },

  // Click an element matching CSS selector.
  click: async (params = {}) => {
    const { selector } = params;
    if (!selector) throw new Error("click: selector is required");
    const { tabId } = await ensureAgentWindow();

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      args: [selector],
      func: (sel) => {
        const el = document.querySelector(sel);
        if (!el) return { ok: false, error: `No element matches: ${sel}` };
        try {
          if (typeof el.scrollIntoView === "function") {
            el.scrollIntoView({ block: "center", inline: "center" });
          }
          el.click();
          return { ok: true, tag: el.tagName.toLowerCase() };
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      },
    });
    const frame = results[0]?.result;
    if (!frame) throw new Error("click: no result");
    if (!frame.ok) throw new Error(frame.error);
    return { clicked: selector, tag: frame.tag };
  },

  // Type text into an input/textarea/contenteditable matching selector.
  type: async (params = {}) => {
    const { selector, text, clear = true } = params;
    if (!selector) throw new Error("type: selector is required");
    if (text === undefined || text === null) throw new Error("type: text is required");
    const { tabId } = await ensureAgentWindow();

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      args: [selector, String(text), clear],
      func: (sel, txt, doClear) => {
        const el = document.querySelector(sel);
        if (!el) return { ok: false, error: `No element matches: ${sel}` };
        try {
          el.focus();
          if ("value" in el) {
            if (doClear) el.value = "";
            el.value = (el.value || "") + txt;
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
          return { ok: false, error: String((e && e.message) || e) };
        }
      },
    });
    const frame = results[0]?.result;
    if (!frame) throw new Error("type: no result");
    if (!frame.ok) throw new Error(frame.error);
    return { typed: text.length, selector };
  },

  // -------------------------------------------------------------------------
  // DOM extraction
  // -------------------------------------------------------------------------

  get_html: async (params = {}) => {
    const { selector = null } = params;
    const { tabId } = await ensureAgentWindow();
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      args: [selector],
      func: (sel) => {
        if (sel) {
          const el = document.querySelector(sel);
          return el ? el.outerHTML : null;
        }
        return document.documentElement.outerHTML;
      },
    });
    return { html: results[0]?.result ?? null };
  },

  get_text: async (params = {}) => {
    const { selector = null } = params;
    const { tabId } = await ensureAgentWindow();
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      args: [selector],
      func: (sel) => {
        const root = sel ? document.querySelector(sel) : document.body;
        return root ? root.innerText : null;
      },
    });
    return { text: results[0]?.result ?? null };
  },

  // -------------------------------------------------------------------------
  // Cookies
  // -------------------------------------------------------------------------

  cookies_get: async (params = {}) => {
    const filter = {};
    if (params.url) filter.url = params.url;
    if (params.domain) filter.domain = params.domain;
    const cookies = await chrome.cookies.getAll(filter);
    return { cookies };
  },

  cookies_set: async (params = {}) => {
    const { cookie } = params;
    if (!cookie || !cookie.url) {
      throw new Error("cookies_set: cookie.url is required");
    }
    const result = await chrome.cookies.set(cookie);
    return { cookie: result };
  },

  // -------------------------------------------------------------------------
  // localStorage of the agent tab
  // -------------------------------------------------------------------------

  local_storage_get: async () => {
    const { tabId } = await ensureAgentWindow();
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const out = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          out[k] = localStorage.getItem(k);
        }
        return out;
      },
    });
    return { storage: results[0]?.result ?? {} };
  },

  local_storage_set: async (params = {}) => {
    const { items = {}, clear = false } = params;
    const { tabId } = await ensureAgentWindow();
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [items, clear],
      func: (items, clear) => {
        if (clear) localStorage.clear();
        for (const [k, v] of Object.entries(items)) {
          localStorage.setItem(k, v);
        }
      },
    });
    return { applied: Object.keys(items).length, cleared: clear };
  },
};
