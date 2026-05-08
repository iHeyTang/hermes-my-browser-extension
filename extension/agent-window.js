/**
 * Lifecycle management for the dedicated "agent window" we operate on.
 *
 * Hermes uses a single fixed (window, tab) pair so the user's normal tabs
 * are never touched. This module also owns the helper that waits for a
 * navigation to finish, plus the listeners that detect when the user
 * manually closes the agent window/tab so we don't leak stale ids.
 */

import { state, saveAgentState } from "./state.js";
import { DEFAULT_AGENT_WINDOW } from "./config.js";

export async function ensureAgentWindow(opts = {}) {
  const config = { ...DEFAULT_AGENT_WINDOW, ...opts };

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
      // Fall through; we'll figure out which side is gone below.
    }
  }

  // Case 2: window still alive but our tab was closed (user closed it, or
  // navigated away in a way that replaced it). Reuse the window and open a
  // fresh tab inside it instead of spawning a whole new window.
  if (state.agentWindowId !== null) {
    try {
      await chrome.windows.get(state.agentWindowId);
      const tab = await chrome.tabs.create({
        windowId: state.agentWindowId,
        url: config.url,
        active: false,
      });
      state.agentTabId = tab.id;
      await saveAgentState();
      console.log(
        "[hermes-bridge] Agent tab recreated in window:",
        state.agentWindowId,
        "tab:",
        state.agentTabId
      );
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

  // Case 3: nothing left — create a brand new window.
  const win = await chrome.windows.create({
    url: config.url,
    width: config.width,
    height: config.height,
    type: config.type,
    focused: config.focused,
  });

  state.agentWindowId = win.id;
  state.agentTabId = win.tabs && win.tabs[0] ? win.tabs[0].id : null;

  if (state.agentTabId === null) {
    throw new Error("Agent window created but no tab found");
  }

  await saveAgentState();
  console.log(
    "[hermes-bridge] Agent window created:",
    state.agentWindowId,
    "tab:",
    state.agentTabId
  );
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

// Resolve once the given tab reaches `status === "complete"`, or reject on
// timeout. Used by the navigate handler.
export function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let timeoutHandle;
    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timeoutHandle);
        resolve(tab);
      }
    };
    timeoutHandle = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error(`Navigation timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);

    // Edge case: tab might already be complete before we attached the
    // listener. We deliberately don't resolve here because we want the
    // *next* "complete" event (post-navigate); this just stops the
    // promise from hanging if the URL doesn't actually change.
    chrome.tabs.get(tabId).catch(() => {});
  });
}

// React to user closing the agent window/tab manually.
chrome.windows.onRemoved.addListener(async (windowId) => {
  if (windowId === state.agentWindowId) {
    console.log("[hermes-bridge] Agent window closed by user");
    state.agentWindowId = null;
    state.agentTabId = null;
    await saveAgentState();
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === state.agentTabId) {
    console.log("[hermes-bridge] Agent tab closed");
    state.agentTabId = null;
    // Window may still exist; don't null it.
    await saveAgentState();
  }
});
