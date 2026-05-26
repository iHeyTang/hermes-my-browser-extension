/**
 * Track the user's currently-focused browsing tab from inside the side panel.
 *
 * The side panel re-runs this hook independently of any `executeScript`
 * call we might do at send-time, so the "Page" chip can show the live tab
 * title even before the user toggles include-page on. We listen to the
 * coarse-grained `tabs.onActivated` / `windows.onFocusChanged` /
 * `tabs.onUpdated` events, plus a focus listener on the panel itself in
 * case Chrome silently swapped tabs while the side panel was hidden.
 */

import { useEffect, useState } from "react";

import { getActiveBrowserTab } from "./capture";

export interface ActiveTabInfo {
  id?: number;
  url?: string;
  title?: string;
  favIconUrl?: string;
}

export function useActiveTab(): {
  tab: ActiveTabInfo | null;
  refresh: () => void;
} {
  const [tab, setTab] = useState<ActiveTabInfo | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const t = await getActiveBrowserTab();
      if (cancelled) return;
      setTab(
        t
          ? {
              id: t.id,
              url: t.url || t.pendingUrl || "",
              title: t.title || "",
              favIconUrl: t.favIconUrl,
            }
          : null,
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  useEffect(() => {
    const onActivated = () => refresh();
    const onFocusChanged = (windowId: number) => {
      if (windowId === chrome.windows.WINDOW_ID_NONE) return;
      refresh();
    };
    const onUpdated = (
      _tabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
      changedTab: chrome.tabs.Tab,
    ) => {
      if (!changedTab.active) return;
      if (changeInfo.title || changeInfo.url || changeInfo.favIconUrl) {
        refresh();
      }
    };
    const onWindowFocus = () => refresh();

    chrome.tabs.onActivated.addListener(onActivated);
    chrome.windows.onFocusChanged.addListener(onFocusChanged);
    chrome.tabs.onUpdated.addListener(onUpdated);
    window.addEventListener("focus", onWindowFocus);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.windows.onFocusChanged.removeListener(onFocusChanged);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      window.removeEventListener("focus", onWindowFocus);
    };
  }, []);

  return { tab, refresh };
}

/**
 * Best-effort hostname for display, e.g. "github.com" from
 * "https://github.com/foo/bar".
 */
export function hostnameOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
