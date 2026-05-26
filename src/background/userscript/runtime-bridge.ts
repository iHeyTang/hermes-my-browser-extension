/**
 * Background-side message router that the userscript runtime in the page
 * talks to. Receives content-side IPC for: GM_xmlhttpRequest, GM_setValue
 * et al, GM_notification, GM_openInTab, GM_download, resource fetch, menu
 * registration, and the bootstrap query for "which scripts apply to my URL?".
 */

import type {
  GmXhrAbort,
  GmXhrRequest,
  UserScript,
  UserScriptMetadata,
} from "~lib/types";

import { buildMatchSet, matchUrl } from "./matcher";
import { getCachedResource, requireName } from "./resources";
import {
  deleteValue,
  getScript,
  getValue,
  listScripts,
  listValues,
  setValue,
} from "./store";
import { abortGmXhr, handleGmXhr } from "./xhr-proxy";

// ---------------------------------------------------------------------------
// Menu commands — keyed per (tabId, scriptId).
// ---------------------------------------------------------------------------

interface MenuEntry {
  id: number;
  caption: string;
  scriptId: string;
  tabId: number;
}

const MENU_BY_TAB = new Map<number, MenuEntry[]>();
let nextMenuId = 1;

export function getMenuFor(tabId: number): MenuEntry[] {
  return MENU_BY_TAB.get(tabId) || [];
}

export function clearMenuForTab(tabId: number) {
  MENU_BY_TAB.delete(tabId);
}

// ---------------------------------------------------------------------------
// Wiring — install in background entry.
// ---------------------------------------------------------------------------

export function registerRuntimeBridge() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== "object") return false;
    const type = (message as { type?: string }).type;

    if (type === "userscript.bootstrap") {
      void bootstrap(message, sender).then(sendResponse);
      return true;
    }
    if (type === "userscript.runManual") {
      void runManual(message, sender).then(sendResponse);
      return true;
    }
    if (type === "userscript.value.get") {
      void getValue(
        String((message as Record<string, unknown>).scriptId),
        String((message as Record<string, unknown>).name),
        (message as Record<string, unknown>).fallback,
      ).then((v) => sendResponse({ ok: true, value: v }));
      return true;
    }
    if (type === "userscript.value.set") {
      void setValue(
        String((message as Record<string, unknown>).scriptId),
        String((message as Record<string, unknown>).name),
        (message as Record<string, unknown>).value,
      ).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (type === "userscript.value.delete") {
      void deleteValue(
        String((message as Record<string, unknown>).scriptId),
        String((message as Record<string, unknown>).name),
      ).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (type === "userscript.value.list") {
      void listValues(String((message as Record<string, unknown>).scriptId)).then(
        (keys) => sendResponse({ ok: true, keys }),
      );
      return true;
    }
    if (type === "userscript.resource.get") {
      void getCachedResource(
        String((message as Record<string, unknown>).scriptId),
        String((message as Record<string, unknown>).name),
      ).then((r) => sendResponse({ ok: true, resource: r }));
      return true;
    }
    if (type === "userscript.notify") {
      void notify(message as never).then(sendResponse);
      return true;
    }
    if (type === "userscript.openInTab") {
      void openInTab(message as never).then(sendResponse);
      return true;
    }
    if (type === "userscript.download") {
      void download(message as never).then(sendResponse);
      return true;
    }
    if (type === "userscript.menu.register") {
      const m = message as Record<string, unknown>;
      const tabId = sender.tab?.id;
      if (!tabId) {
        sendResponse({ ok: false, error: "no tab id" });
        return true;
      }
      const id = nextMenuId++;
      const entry: MenuEntry = {
        id,
        caption: String(m.caption || ""),
        scriptId: String(m.scriptId || ""),
        tabId,
      };
      const list = MENU_BY_TAB.get(tabId) || [];
      list.push(entry);
      MENU_BY_TAB.set(tabId, list);
      sendResponse({ ok: true, id });
      return true;
    }
    if (type === "userscript.menu.unregister") {
      const m = message as Record<string, unknown>;
      const tabId = sender.tab?.id;
      const id = Number(m.id);
      if (tabId) {
        const list = MENU_BY_TAB.get(tabId) || [];
        MENU_BY_TAB.set(
          tabId,
          list.filter((e) => e.id !== id),
        );
      }
      sendResponse({ ok: true });
      return true;
    }
    if (type === "gm-xhr") {
      const req = message as GmXhrRequest;
      const tabId = sender.tab?.id;
      const frameId = sender.frameId;
      // Stream frames via tabs.sendMessage so callbacks are async.
      void handleGmXhr(req, (frame) => {
        if (typeof tabId === "number") {
          chrome.tabs
            .sendMessage(tabId, frame, frameId !== undefined ? { frameId } : {})
            .catch(() => {});
        }
      });
      sendResponse({ ok: true });
      return true;
    }
    if (type === "gm-xhr-abort") {
      abortGmXhr((message as GmXhrAbort).requestId);
      sendResponse({ ok: true });
      return true;
    }

    return false;
  });

  // Tab close → drop menu commands.
  chrome.tabs.onRemoved.addListener((tabId) => clearMenuForTab(tabId));
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url) clearMenuForTab(tabId);
  });
}

// ---------------------------------------------------------------------------
// Bootstrap: tells the runtime which scripts to run on the current URL.
// ---------------------------------------------------------------------------

interface BootstrapPayload {
  scripts: Array<{
    id: string;
    name: string;
    source: string;
    meta: UserScriptMetadata;
    requires: string[];
    resources: Array<{ name: string; url: string; dataUrl: string }>;
    runtimeArgs?: unknown;
  }>;
}

async function bootstrap(
  message: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<BootstrapPayload> {
  const url = sender.url || (sender.tab?.url ?? "");
  const all = await listScripts();
  const out: BootstrapPayload["scripts"] = [];
  for (const s of all) {
    if (!s.enabled) continue;
    const set = buildMatchSet({
      match: s.meta.match,
      include: s.meta.include,
      exclude: s.meta.exclude,
      excludeMatch: s.meta.excludeMatch,
    });
    if (!matchUrl(url, set)) continue;
    out.push(await materialize(s, null));
  }
  return { scripts: out };
}

async function runManual(
  message: unknown,
  _sender: chrome.runtime.MessageSender,
): Promise<BootstrapPayload> {
  const m = message as { scriptId: string; runtimeArgs?: unknown };
  const s = await getScript(m.scriptId);
  if (!s) return { scripts: [] };
  return { scripts: [await materialize(s, m.runtimeArgs ?? null)] };
}

async function materialize(
  s: UserScript,
  runtimeArgs: unknown,
): Promise<BootstrapPayload["scripts"][number]> {
  const requires: string[] = [];
  for (const url of s.meta.require) {
    const cached = await getCachedResource(s.id, requireName(url));
    if (cached) requires.push(cached.text);
  }
  const resources: Array<{ name: string; url: string; dataUrl: string }> = [];
  for (const r of s.meta.resource) {
    const cached = await getCachedResource(s.id, r.name);
    if (cached) {
      resources.push({ name: r.name, url: r.url, dataUrl: cached.dataUrl });
    }
  }
  return {
    id: s.id,
    name: s.meta.name,
    source: s.source,
    meta: s.meta,
    requires,
    resources,
    runtimeArgs,
  };
}

// ---------------------------------------------------------------------------
// Notifications / openInTab / download — thin wrappers over chrome.* APIs.
// ---------------------------------------------------------------------------

async function notify(message: {
  scriptId: string;
  options:
    | string
    | {
        text?: string;
        title?: string;
        image?: string;
        timeout?: number;
        silent?: boolean;
      };
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const opts =
      typeof message.options === "string"
        ? { text: message.options }
        : message.options;
    await chrome.notifications.create({
      type: "basic",
      title: opts.title || "Userscript",
      message: opts.text || "",
      iconUrl: opts.image || chrome.runtime.getURL("assets/icon128.png"),
      silent: !!opts.silent,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

async function openInTab(message: {
  url: string;
  loadInBackground?: boolean;
  active?: boolean;
}): Promise<{ ok: boolean; tabId?: number; error?: string }> {
  try {
    const tab = await chrome.tabs.create({
      url: message.url,
      active: message.active !== false && !message.loadInBackground,
    });
    return { ok: true, tabId: tab.id };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

async function download(message: {
  url: string;
  name?: string;
  saveAs?: boolean;
}): Promise<{ ok: boolean; id?: number; error?: string }> {
  try {
    const id = await chrome.downloads.download({
      url: message.url,
      filename: message.name,
      saveAs: !!message.saveAs,
    });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}
