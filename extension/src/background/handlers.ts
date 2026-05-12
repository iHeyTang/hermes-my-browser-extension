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

import { ensureAgentWindow, waitForTabComplete } from "./agent-window";
import { setRunTarget, state } from "./state";
import { resolveTargetTab, resolveUserTab } from "./target";
import {
  installUserscriptFromSource,
  installUserscriptFromUrl,
  listUserscripts,
  removeUserscript,
  runUserscriptOnTab,
  setUserscriptEnabled,
  updateUserscript,
} from "./userscript/orchestrator";
import { getScript } from "./userscript/store";

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

type NavigateOpenIn = "auto" | "agent" | "user_new_tab" | "user_same_tab";

function parseNavigateOpenIn(raw: unknown): NavigateOpenIn {
  if (
    raw === "agent" ||
    raw === "user_new_tab" ||
    raw === "user_same_tab"
  ) {
    return raw;
  }
  return "auto";
}

/** Side panel policy wins when not Auto; otherwise use agent `open_in`. */
function resolveEffectiveNavigateOpenIn(
  params: Record<string, unknown>,
): NavigateOpenIn {
  const ui = state.navigateOpenPolicy;
  if (ui !== "auto") {
    return ui;
  }
  return parseNavigateOpenIn(params.open_in);
}

const navigate: Handler = async (params = {}) => {
  const url = String(params.url || "");
  const wait_for_load = params.wait_for_load !== false;
  const timeout_ms =
    typeof params.timeout_ms === "number" ? params.timeout_ms : 30_000;
  if (!url) throw new Error("navigate: url is required");

  const openIn = resolveEffectiveNavigateOpenIn(params);

  let tabId: number;
  let targetKind: "agent" | "user";
  let appliedOpenIn: NavigateOpenIn;
  let createdTab = false;

  if (openIn === "agent") {
    const { tabId: tid } = await ensureAgentWindow();
    tabId = tid;
    targetKind = "agent";
    appliedOpenIn = "agent";
    await chrome.tabs.update(tabId, { url });
    await setRunTarget({ target: "agent", userTabId: null, userWindowId: null });
  } else if (openIn === "user_same_tab") {
    const u = await resolveUserTab();
    tabId = u.tabId;
    targetKind = "user";
    appliedOpenIn = "user_same_tab";
    await chrome.tabs.update(tabId, { url });
    await setRunTarget({
      target: "user",
      userTabId: u.tabId,
      userWindowId: u.windowId,
    });
  } else if (openIn === "user_new_tab") {
    const { windowId } = await resolveUserTab();
    const tab = await chrome.tabs.create({
      windowId,
      url,
      active: true,
    });
    if (tab.id === undefined) {
      throw new Error("navigate: tabs.create returned no tab id");
    }
    tabId = tab.id;
    targetKind = "user";
    appliedOpenIn = "user_new_tab";
    createdTab = true;
    await setRunTarget({
      target: "user",
      userTabId: tabId,
      userWindowId: windowId,
    });
  } else {
    // auto — default to "replace the user's current tab".
    //
    // Why: from a browser side panel, "open <site>" overwhelmingly means
    // "take me there", not "do this in a hidden background window". The
    // model can still override by passing `open_in=agent` for explicit
    // background-research flows, or `open_in=user_new_tab` to preserve
    // the current tab. The auto path no longer follows `runTarget` — that
    // would make a fresh `navigate` inherit whatever surface the previous
    // turn happened to land on, which is exactly the surprise the user
    // hit ("I'm on Auto, why did it pop a separate window?").
    const u = await resolveUserTab();
    tabId = u.tabId;
    targetKind = "user";
    appliedOpenIn = "auto";
    await chrome.tabs.update(tabId, { url });
    await setRunTarget({
      target: "user",
      userTabId: u.tabId,
      userWindowId: u.windowId,
    });
  }

  const waitPromise = wait_for_load
    ? waitForTabComplete(tabId, timeout_ms)
    : null;
  if (waitPromise) await waitPromise;
  const tab = await chrome.tabs.get(tabId);
  return {
    url: tab.url,
    title: tab.title,
    status: tab.status,
    target: targetKind,
    open_in: appliedOpenIn,
    created_tab: createdTab,
    tab_id: tabId,
  };
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

/**
 * Run a JS snippet on the target tab.
 *
 * Failure modes we worked around (vs. the old `new Function` + JSON.stringify):
 *
 *  1. Page CSP `unsafe-eval` blocks `new Function` in MAIN world. We now
 *     inject the code as an inline `<script>` element, which is governed
 *     by `script-src` (much more commonly permitted) instead.
 *  2. Code like `document.title` is an expression but the old wrapper
 *     dropped the value. We try `return (CODE)` first; on SyntaxError
 *     fall back to running CODE as statements (in which case the caller
 *     must `return` explicitly).
 *  3. DOM nodes / unserializable values used to come back as
 *     `"[object HTMLElement]"`. We now summarize them into a structured
 *     `{__type:"dom", tag, id, classes, text}` shape so the caller can
 *     still see what they got.
 *  4. ISOLATED world is exposed as a `world` parameter — it bypasses page
 *     CSP entirely (content-script context). Default stays MAIN for
 *     backward compatibility; callers can opt in when they only need DOM
 *     access.
 */
const evalHandler: Handler = async (params = {}) => {
  const js = String(params.js || "");
  const requestedWorld = String(params.world || "MAIN").toUpperCase();
  const world: ScriptWorld =
    requestedWorld === "ISOLATED" ? "ISOLATED" : "MAIN";
  if (!js) throw new Error("eval: js is required");
  const { tabId } = await resolveTargetTab();

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world,
    args: [js, world],
    func: async (code: string, worldName: string) => {
      // ── Serializer: keep informative summaries for things JSON drops. ──
      const summarizeNode = (n: Node): Record<string, unknown> => {
        const el = n as Element & { value?: unknown };
        const out: Record<string, unknown> = {
          __type: "dom",
          tag: (el.tagName || el.nodeName || "").toLowerCase() || undefined,
        };
        if (el.id) out.id = el.id;
        const cls =
          typeof el.className === "string" ? el.className.trim() : "";
        if (cls) out.classes = cls.split(/\s+/).slice(0, 12);
        const text = (el.textContent || "").trim();
        if (text) out.text = text.length > 200 ? text.slice(0, 200) + "…" : text;
        if (el instanceof HTMLAnchorElement && el.href) out.href = el.href;
        if (typeof el.value !== "undefined") out.value = String(el.value);
        return out;
      };

      const safeSerialize = (v: unknown, depth = 0): unknown => {
        if (v === undefined) return null;
        if (v === null) return null;
        const t = typeof v;
        if (t === "string" || t === "number" || t === "boolean") return v;
        if (t === "bigint") return String(v);
        if (t === "function") return { __type: "function", name: (v as Function).name || "" };
        if (t === "symbol") return { __type: "symbol", description: (v as symbol).description ?? "" };
        if (typeof Node !== "undefined" && v instanceof Node) {
          return summarizeNode(v);
        }
        if (v instanceof Error) {
          return { __type: "error", name: v.name, message: v.message };
        }
        // Iterables (NodeList, HTMLCollection, Set, Map keys, …)
        const isArrayLike =
          Array.isArray(v) ||
          (v &&
            typeof (v as Iterable<unknown>)[Symbol.iterator] === "function");
        if (isArrayLike && depth < 3) {
          try {
            const arr = Array.from(v as Iterable<unknown>);
            return arr.slice(0, 200).map((item) => safeSerialize(item, depth + 1));
          } catch {
            // fall through
          }
        }
        try {
          return JSON.parse(JSON.stringify(v));
        } catch {
          return { __type: "unserializable", summary: String(v).slice(0, 200) };
        }
      };

      // ── Build the user code into a function body that returns a value. ──
      // Try expression-form first (so `document.title` works), fall back
      // to statement-form (where the caller must `return` themselves).
      const buildWrappedSource = (): string => {
        return `(async () => {
  const __code = ${JSON.stringify(code)};
  let __fn;
  try {
    __fn = new Function('return (async () => { return (' + __code + '); })()');
  } catch (__se) {
    if (__se instanceof SyntaxError) {
      __fn = new Function('return (async () => { ' + __code + ' })()');
    } else {
      throw __se;
    }
  }
  return await __fn();
})()`;
      };

      // ── Method A: page-CSP-friendly inline <script> injection. ──
      // The wrapped function still uses `new Function` internally, but it
      // runs in the page's MAIN world via a `<script>` element instead of
      // being constructed from an extension-side string — that swaps the
      // applicable CSP directive from `script-src 'unsafe-eval'` to
      // `script-src` (inline). Inline is permitted on far more sites than
      // unsafe-eval.
      const runViaInlineScript = (): Promise<unknown> => {
        return new Promise((resolve, reject) => {
          const channel = "__hermes_eval_" + Math.random().toString(36).slice(2);
          const timer = setTimeout(() => {
            window.removeEventListener("message", onMsg);
            reject(
              new Error(
                "inline <script> injection timed out — page CSP may be blocking script-src",
              ),
            );
          }, 10000);
          const onMsg = (ev: MessageEvent) => {
            const d = ev.data as
              | { __channel?: string; ok?: boolean; value?: unknown; error?: string }
              | null;
            if (!d || d.__channel !== channel) return;
            clearTimeout(timer);
            window.removeEventListener("message", onMsg);
            if (d.ok) resolve(d.value);
            else reject(new Error(d.error || "inline eval failed"));
          };
          window.addEventListener("message", onMsg);

          const body = buildWrappedSource();
          const inlineSrc = `(async () => {
  const __id = ${JSON.stringify(channel)};
  try {
    const __v = await ${body};
    window.postMessage({ __channel: __id, ok: true, value: __v }, "*");
  } catch (__e) {
    window.postMessage({ __channel: __id, ok: false, error: String(__e && __e.message || __e) }, "*");
  }
})();`;

          try {
            const el = document.createElement("script");
            el.textContent = inlineSrc;
            (document.head || document.documentElement).appendChild(el);
            el.remove();
          } catch (e) {
            clearTimeout(timer);
            window.removeEventListener("message", onMsg);
            reject(
              new Error(
                `<script> injection threw: ${String((e as Error)?.message || e)}`,
              ),
            );
          }
        });
      };

      // ── Method B: direct `new Function` (used in ISOLATED world, which
      // is the content-script context and is not subject to page CSP). ──
      const runViaFunction = async (): Promise<unknown> => {
        const wrappedThunk = new Function(
          `return ${buildWrappedSource()}`,
        ) as () => Promise<unknown>;
        return await wrappedThunk();
      };

      const isCspEvalError = (msg: string): boolean =>
        /unsafe-eval|Refused to evaluate|EvalError/i.test(msg);

      try {
        let raw: unknown;
        if (worldName === "ISOLATED") {
          // ISOLATED is the content-script world. MV3 extension CSP does
          // not apply to content scripts, so `new Function` is fine here.
          raw = await runViaFunction();
        } else {
          // MAIN: try `new Function` directly first (it's slightly faster
          // and avoids the message round-trip), then fall back to inline
          // <script> injection if page CSP blocks unsafe-eval.
          try {
            raw = await runViaFunction();
          } catch (e) {
            const msg = String((e as Error)?.message || e);
            if (isCspEvalError(msg)) {
              raw = await runViaInlineScript();
            } else {
              throw e;
            }
          }
        }
        return { ok: true, value: safeSerialize(raw), world: worldName };
      } catch (e) {
        const msg = String((e as Error)?.message || e);
        return {
          ok: false,
          error: msg,
          world: worldName,
          hint: isCspEvalError(msg)
            ? "Page CSP blocked script execution. Try world:'ISOLATED' (DOM access only, no page globals) or a less restrictive tab."
            : undefined,
        };
      }
    },
  });

  const frame = results[0]?.result as
    | {
        ok: boolean;
        value?: unknown;
        error?: string;
        world?: string;
        hint?: string;
      }
    | undefined;
  if (!frame) throw new Error("eval: no result returned");
  if (!frame.ok) {
    const hint = frame.hint ? ` ${frame.hint}` : "";
    throw new Error(
      `eval threw [world=${frame.world ?? world}]: ${frame.error}.${hint}`,
    );
  }
  return { value: frame.value, world: frame.world ?? world };
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
// Tab inspection — let the agent decide which user tab to look at, instead
// of relying on the side panel to splat the current page into the prompt
// before every turn.
// ---------------------------------------------------------------------------

/** Truncate visible text to keep one tool result from blowing the context. */
const READ_TAB_MAX_CHARS = 16_000;

function trimText(text: string | null): {
  text: string | null;
  truncated: boolean;
  full_length: number;
} {
  if (text == null) return { text: null, truncated: false, full_length: 0 };
  const full = text.length;
  if (full <= READ_TAB_MAX_CHARS) {
    return { text, truncated: false, full_length: full };
  }
  return {
    text: text.slice(0, READ_TAB_MAX_CHARS),
    truncated: true,
    full_length: full,
  };
}

async function readTabText(tabId: number): Promise<string | null> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () =>
        document.body ? (document.body as HTMLElement).innerText : null,
    });
    return (results[0]?.result as string | null) ?? null;
  } catch {
    // chrome:// and similar internal pages reject executeScript.
    return null;
  }
}

const active_tab: Handler = async () => {
  const { tabId, windowId } = await resolveUserTab();
  const tab = await chrome.tabs.get(tabId);
  const text = await readTabText(tabId);
  const trimmed = trimText(text);
  return {
    tab_id: tabId,
    window_id: windowId,
    url: tab.url ?? tab.pendingUrl ?? null,
    title: tab.title ?? null,
    ...trimmed,
  };
};

const list_tabs: Handler = async () => {
  const all = await chrome.tabs.query({});
  const tabs = all
    .filter(
      (t) =>
        t.id !== undefined &&
        t.windowId !== undefined &&
        t.windowId !== state.agentWindowId,
    )
    .map((t) => ({
      tab_id: t.id!,
      window_id: t.windowId!,
      url: t.url ?? t.pendingUrl ?? null,
      title: t.title ?? null,
      active: !!t.active,
      pinned: !!t.pinned,
    }));
  return { tabs };
};

const read_tab: Handler = async (params = {}) => {
  const tabId =
    typeof params.tab_id === "number" ? params.tab_id : Number(params.tab_id);
  if (!Number.isFinite(tabId)) {
    throw new Error("read_tab: tab_id is required (number)");
  }
  if (state.agentWindowId !== null) {
    // The agent already has its own surface (use get_text / get_html for that).
    // Forwarding an agent tab through this tool would be a footgun.
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId === state.agentWindowId) {
      throw new Error(
        "read_tab: target is the agent window. Use get_text/get_html instead.",
      );
    }
  }
  const tab = await chrome.tabs.get(tabId);
  const text = await readTabText(tabId);
  const trimmed = trimText(text);
  return {
    tab_id: tabId,
    window_id: tab.windowId ?? null,
    url: tab.url ?? tab.pendingUrl ?? null,
    title: tab.title ?? null,
    ...trimmed,
  };
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
  // Honour `state.runTarget` like every other tool handler does — without
  // this, forcing a userscript was hard-pinned to the agent window even
  // when the user had toggled Open → user.
  const { tabId } = await resolveTargetTab();
  const result = await runUserscriptOnTab(id, tabId, args);
  return result;
};

// ---------------------------------------------------------------------------
// Public dispatch table
// ---------------------------------------------------------------------------

export const HANDLERS: Record<string, Handler> = {
  connect,
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
  active_tab,
  list_tabs,
  read_tab,
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
};
