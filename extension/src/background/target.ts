/**
 * Resolve the concrete `(windowId, tabId)` a tool call should land on,
 * based on `state.runTarget`.
 *
 *   - "agent" → the dedicated background agent window (legacy default).
 *   - "user"  → the tab the user pinned when they flipped the toggle,
 *               falling back to whatever non-agent tab is currently
 *               active (the user's actual focus) if the pinned tab is
 *               gone.
 *
 * We don't expose a "mirror" mode here. Replaying agent navigates into
 * a parallel user tab only mirrors the URL — page state (form values,
 * scroll, JS-driven DOM, login cookies bound to the agent's storage
 * partition) is bound to the tab doing the work and can't be
 * reconstructed by reloading the URL elsewhere. A mirror mode would
 * silently lie about how much of "what the agent is doing" the user
 * is actually seeing. The end-of-turn "Open in my browser →" chip on
 * the assistant bubble covers the honest version of that intent.
 */

import { ensureAgentWindow } from "./agent-window";
import { state } from "./state";

export interface ResolvedTab {
  tabId: number;
  windowId: number;
  /** Which logical surface this tab represents — used by handlers to
   * decide whether they need to swap focus (agent only) or not. */
  kind: "agent" | "user";
}

export async function resolveTargetTab(): Promise<ResolvedTab> {
  if (state.runTarget.target === "agent") {
    const { tabId, windowId } = await ensureAgentWindow();
    return { tabId, windowId, kind: "agent" };
  }
  return resolveUserTab();
}

/**
 * Resolve the user-side tab (the one the agent should be driving in
 * "user" mode, or replaying into in "mirror" mode). Throws if no
 * suitable tab can be found — the caller turns that into a user-visible
 * error rather than silently navigating into the wrong window.
 */
export async function resolveUserTab(): Promise<ResolvedTab> {
  const { userTabId, userWindowId } = state.runTarget;

  // Path 1: pinned tab still exists. Cheapest, most predictable.
  if (typeof userTabId === "number") {
    try {
      const tab = await chrome.tabs.get(userTabId);
      if (tab.id !== undefined && tab.windowId !== undefined) {
        return { tabId: tab.id, windowId: tab.windowId, kind: "user" };
      }
    } catch {
      // Pinned tab was closed; fall through.
    }
  }

  // Path 2: pinned tab is gone but its window is still alive — pick the
  // currently active tab in that window. Avoids falling all the way back
  // onto `lastFocusedWindow`, which can resolve to the agent window if
  // the user just brought it forward.
  if (typeof userWindowId === "number") {
    try {
      const [active] = await chrome.tabs.query({
        active: true,
        windowId: userWindowId,
      });
      if (active?.id !== undefined && active.windowId !== undefined) {
        return {
          tabId: active.id,
          windowId: active.windowId,
          kind: "user",
        };
      }
    } catch {
      // Window also gone; fall through.
    }
  }

  // Path 3: ask Chrome for the user's last-focused tab, but exclude the
  // agent window so we don't accidentally drive the wrong surface if the
  // agent window happens to be focused.
  const candidates = await chrome.tabs.query({ active: true });
  const userCandidate = candidates.find(
    (t) =>
      t.id !== undefined &&
      t.windowId !== undefined &&
      t.windowId !== state.agentWindowId,
  );
  if (
    userCandidate &&
    userCandidate.id !== undefined &&
    userCandidate.windowId !== undefined
  ) {
    return {
      tabId: userCandidate.id,
      windowId: userCandidate.windowId,
      kind: "user",
    };
  }

  throw new Error(
    "No user tab available — the pinned tab and its window are gone. " +
      "Switch run mode back to Background or open a normal tab.",
  );
}
