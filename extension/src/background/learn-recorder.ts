/**
 * Records high-level user actions on a single tab for learn-mode RPA.
 */

import type {
  LearnRecordingMeta,
  LearnTrace,
  LearnTraceEvent,
} from "~lib/learn/types";
import { LEARN_STORAGE_KEYS } from "~lib/learn/types";

import { state } from "./state";

/** Serialize learn.finish so a second learn.stop never sees a half-cleared session. */
let finishInFlight: Promise<LearnTrace> | null = null;

let recordingTabId: number | null = null;
let startedAt = 0;
let events: LearnTraceEvent[] = [];
let lastNavUrl: string | null = null;

let tabUpdatedListener:
  | ((
      tabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ) => void)
  | null = null;

function broadcastLearnState(active: boolean, tabId?: number) {
  try {
    const msg: Record<string, unknown> = { type: "learn:state", active };
    if (active && tabId !== undefined) msg.tabId = tabId;
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch {
    // Ignore — no receivers.
  }
}

async function persistBuffer() {
  try {
    await chrome.storage.local.set({
      [LEARN_STORAGE_KEYS.buffer]: events,
    });
  } catch {
    // Best effort.
  }
}

async function persistMeta(meta: LearnRecordingMeta) {
  await chrome.storage.local.set({ [LEARN_STORAGE_KEYS.meta]: meta });
}

function pushEvent(ev: LearnTraceEvent) {
  events.push(ev);
  void persistBuffer();
}

function registerTabListener() {
  if (tabUpdatedListener) return;
  tabUpdatedListener = (tabId, changeInfo, tab) => {
    if (recordingTabId === null || tabId !== recordingTabId) return;
    const url =
      changeInfo.url ||
      (changeInfo.status === "complete" ? tab.url || tab.pendingUrl : null);
    if (!url || !/^https?:/i.test(url) || url === lastNavUrl) return;
    lastNavUrl = url;
    pushEvent({
      t: Date.now(),
      type: "navigate",
      url,
      title: tab.title || undefined,
    });
  };
  chrome.tabs.onUpdated.addListener(tabUpdatedListener);
}

function unregisterTabListener() {
  if (tabUpdatedListener) {
    chrome.tabs.onUpdated.removeListener(tabUpdatedListener);
    tabUpdatedListener = null;
  }
}

export async function restoreLearnSession(): Promise<void> {
  const data = await chrome.storage.local.get([
    LEARN_STORAGE_KEYS.meta,
    LEARN_STORAGE_KEYS.buffer,
  ]);
  const meta = data[LEARN_STORAGE_KEYS.meta] as LearnRecordingMeta | undefined;
  if (meta?.active && typeof meta.tabId === "number") {
    recordingTabId = meta.tabId;
    startedAt = meta.startedAt || Date.now();
    events = Array.isArray(data[LEARN_STORAGE_KEYS.buffer])
      ? (data[LEARN_STORAGE_KEYS.buffer] as LearnTraceEvent[])
      : [];
    lastNavUrl = null;
    const lastNav = [...events].reverse().find((e) => e.type === "navigate");
    if (lastNav) lastNavUrl = lastNav.url;
    registerTabListener();
  }
}

export async function learnDiscard(): Promise<void> {
  unregisterTabListener();
  recordingTabId = null;
  startedAt = 0;
  events = [];
  lastNavUrl = null;
  await chrome.storage.local.set({
    [LEARN_STORAGE_KEYS.meta]: {
      active: false,
      tabId: null,
      startedAt: 0,
    } satisfies LearnRecordingMeta,
    [LEARN_STORAGE_KEYS.buffer]: [],
  });
  // Do not broadcast here: learnStartTab calls discard then immediately
  // re-binds the same tab; a false broadcast races with the panel's
  // refreshLearnStatus and can leave the UI stuck "not recording".
}

export async function learnStartTab(tabId: number): Promise<void> {
  await learnDiscard();
  recordingTabId = tabId;
  startedAt = Date.now();
  lastNavUrl = null;
  events = [];
  await persistBuffer();
  await persistMeta({
    active: true,
    tabId,
    startedAt,
  });
  try {
    const tab = await chrome.tabs.get(tabId);
    const u = tab.url || tab.pendingUrl;
    if (u && /^https?:/i.test(u)) {
      lastNavUrl = u;
      pushEvent({
        t: Date.now(),
        type: "navigate",
        url: u,
        title: tab.title || undefined,
      });
    }
  } catch {
    // Tab may have closed — recording still starts; user navigates later.
  }
  registerTabListener();
  broadcastLearnState(true, tabId);
}

export function learnFinish(): Promise<LearnTrace> {
  if (finishInFlight) return finishInFlight;
  finishInFlight = doLearnFinish().finally(() => {
    finishInFlight = null;
  });
  return finishInFlight;
}

async function doLearnFinish(): Promise<LearnTrace> {
  const endedAt = Date.now();
  const tabId = recordingTabId;
  const start = startedAt;
  const ev = [...events];
  const trace: LearnTrace = {
    version: 1,
    startedAt: start,
    endedAt,
    tabId,
    eventCount: ev.length,
    events: ev,
  };
  await learnDiscard();
  broadcastLearnState(false);
  return trace;
}

export function learnStatus(): LearnRecordingMeta & { eventCount: number } {
  return {
    // During doLearnFinish, recordingTabId is cleared in learnDiscard before
    // the promise resolves — still "active" for UI / duplicate stop.
    active: recordingTabId !== null || finishInFlight !== null,
    tabId: recordingTabId,
    startedAt,
    eventCount: events.length,
  };
}

export function learnAppendEvent(
  senderTabId: number | undefined,
  partial: Omit<LearnTraceEvent, "t"> & { t?: number },
): void {
  if (
    recordingTabId === null ||
    senderTabId === undefined ||
    senderTabId !== recordingTabId
  ) {
    return;
  }
  const ev: LearnTraceEvent = {
    ...partial,
    t: partial.t ?? Date.now(),
  };
  pushEvent(ev);
}

export async function resolveTabForScope(
  scope: "agent" | "last_focused",
  explicitTabId?: number | null,
): Promise<number | null> {
  if (
    typeof explicitTabId === "number" &&
    Number.isFinite(explicitTabId) &&
    explicitTabId >= 0
  ) {
    try {
      await chrome.tabs.get(explicitTabId);
      return explicitTabId;
    } catch {
      return null;
    }
  }
  if (scope === "agent") {
    if (state.agentTabId !== null) {
      try {
        await chrome.tabs.get(state.agentTabId);
        return state.agentTabId;
      } catch {
        return null;
      }
    }
    return null;
  }
  try {
    const w = await chrome.windows.getLastFocused({ populate: true });
    const tab = w.tabs?.find((t) => t.active);
    if (tab?.id !== undefined) return tab.id;
  } catch {
    // Ignore.
  }
  return null;
}
