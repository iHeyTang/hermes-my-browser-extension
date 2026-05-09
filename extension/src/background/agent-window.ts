/**
 * Lifecycle for the dedicated "agent window" Hermes operates on.
 *
 * Hermes uses a single fixed (window, tab) pair so the user's normal tabs are
 * never touched. Listeners detect manual close so we don't leak stale ids.
 */

import { DEFAULT_AGENT_WINDOW, type AgentWindowConfig } from "./config";
import { saveAgentState, state } from "./state";

export interface EnsureAgentWindowResult {
  windowId: number;
  tabId: number;
  created: boolean;
}

export async function ensureAgentWindow(
  opts: Partial<AgentWindowConfig> = {},
): Promise<EnsureAgentWindowResult> {
  const config: AgentWindowConfig = { ...DEFAULT_AGENT_WINDOW, ...opts };

  // Case 1: window + tab still alive → reuse.
  if (state.agentWindowId !== null && state.agentTabId !== null) {
    try {
      await chrome.windows.get(state.agentWindowId);
      await chrome.tabs.get(state.agentTabId);
      return {
        windowId: state.agentWindowId,
        tabId: state.agentTabId,
        created: false,
      };
    } catch {
      // Fall through.
    }
  }

  // Case 2: window alive but our tab died → reuse window with a fresh tab.
  if (state.agentWindowId !== null) {
    try {
      await chrome.windows.get(state.agentWindowId);
      const tab = await chrome.tabs.create({
        windowId: state.agentWindowId,
        url: config.url,
        active: false,
      });
      state.agentTabId = tab.id ?? null;
      await saveAgentState();
      if (state.agentTabId === null) {
        throw new Error("Agent tab created but no id returned");
      }
      return {
        windowId: state.agentWindowId,
        tabId: state.agentTabId,
        created: false,
      };
    } catch {
      state.agentWindowId = null;
      state.agentTabId = null;
    }
  }

  // Case 3: nothing left — spawn a fresh window.
  const win = await chrome.windows.create({
    url: config.url,
    width: config.width,
    height: config.height,
    type: config.type,
    focused: config.focused,
  });
  state.agentWindowId = win?.id ?? null;
  state.agentTabId = win?.tabs?.[0]?.id ?? null;
  if (state.agentWindowId === null || state.agentTabId === null) {
    throw new Error("Agent window created but missing window/tab id");
  }
  await saveAgentState();
  return {
    windowId: state.agentWindowId,
    tabId: state.agentTabId,
    created: true,
  };
}

export async function closeAgentWindow() {
  if (state.agentWindowId === null) return;
  const wid = state.agentWindowId;
  state.agentWindowId = null;
  state.agentTabId = null;
  await saveAgentState();
  try {
    await chrome.windows.remove(wid);
  } catch {
    // Already closed.
  }
}

/**
 * Resolve once the given tab reaches `status === "complete"`, or reject on
 * timeout. Used by the navigate handler.
 */
export function waitForTabComplete(
  tabId: number,
  timeoutMs = 30_000,
): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const onUpdated = (
      updatedTabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        resolve(tab);
      }
    };
    timeoutHandle = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error(`Navigation timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).catch(() => {});
  });
}

/** Listeners that clean up our cached ids when the user closes things manually. */
export function registerAgentWindowListeners() {
  chrome.windows.onRemoved.addListener(async (windowId) => {
    if (windowId === state.agentWindowId) {
      state.agentWindowId = null;
      state.agentTabId = null;
      await saveAgentState();
    }
  });

  chrome.tabs.onRemoved.addListener(async (tabId) => {
    if (tabId === state.agentTabId) {
      state.agentTabId = null;
      await saveAgentState();
    }
  });
}
