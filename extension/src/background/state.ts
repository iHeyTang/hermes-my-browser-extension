/**
 * Shared mutable state for the background SW.
 *
 * Single source of truth for:
 *   - The bridge WebSocket lifecycle (`ws`, reconnect/heartbeat timers)
 *   - The agent window/tab ids (persisted across SW restarts via session storage)
 *   - The user's intent to be connected (persisted across full Chrome restarts)
 *
 * Tri-state ("disconnected"/"connecting"/"connected") is derived here so the
 * toolbar icon and the popup agree.
 */

import type { ConnectionState, RunTarget, RunTargetState } from "~lib/types";

import { applyIcon } from "./icon";

interface State {
  ws: WebSocket | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  /** In-memory mirror of `chrome.storage.local.desiredConnected`. */
  desiredConnected: boolean;
  agentWindowId: number | null;
  agentTabId: number | null;
  /**
   * Where the agent's tool calls go. See `RunTarget` for semantics.
   * Persisted in session storage so SW restarts don't reset the user's
   * mid-conversation choice; cleared automatically on Chrome restart.
   */
  runTarget: RunTargetState;
}

export const state: State = {
  ws: null,
  reconnectTimer: null,
  heartbeatTimer: null,
  desiredConnected: false,
  agentWindowId: null,
  agentTabId: null,
  runTarget: {
    target: "agent",
    userTabId: null,
    userWindowId: null,
  },
};

// ---------------------------------------------------------------------------
// Persistence — survives SW restarts within a session and full restarts.
// ---------------------------------------------------------------------------

export async function saveAgentState() {
  await chrome.storage.session.set({
    agentWindowId: state.agentWindowId,
    agentTabId: state.agentTabId,
  });
}

export async function loadAgentState(): Promise<boolean> {
  const { agentWindowId: w, agentTabId: t } = await chrome.storage.session.get([
    "agentWindowId",
    "agentTabId",
  ]);
  if (typeof w === "number" && typeof t === "number") {
    try {
      await chrome.windows.get(w);
      await chrome.tabs.get(t);
      state.agentWindowId = w;
      state.agentTabId = t;
      return true;
    } catch {
      state.agentWindowId = null;
      state.agentTabId = null;
      await saveAgentState();
    }
  }
  return false;
}

export async function loadDesiredConnected(): Promise<boolean> {
  const { desiredConnected: stored } =
    await chrome.storage.local.get("desiredConnected");
  state.desiredConnected = !!stored;
  return state.desiredConnected;
}

// ---------------------------------------------------------------------------
// Run-target persistence (session storage so it survives SW restarts but
// resets cleanly when Chrome itself is restarted).
// ---------------------------------------------------------------------------

const RUN_TARGET_KEY = "runTarget";

export async function saveRunTarget() {
  await chrome.storage.session.set({ [RUN_TARGET_KEY]: state.runTarget });
  broadcastRunTarget();
}

export async function loadRunTarget(): Promise<RunTargetState> {
  const r = await chrome.storage.session.get(RUN_TARGET_KEY);
  const raw = r[RUN_TARGET_KEY] as Partial<RunTargetState> | undefined;
  if (raw && typeof raw === "object") {
    const target: RunTarget = raw.target === "user" ? "user" : "agent";
    state.runTarget = {
      target,
      userTabId: typeof raw.userTabId === "number" ? raw.userTabId : null,
      userWindowId:
        typeof raw.userWindowId === "number" ? raw.userWindowId : null,
    };
  }
  return state.runTarget;
}

export async function setRunTarget(next: Partial<RunTargetState>) {
  const target: RunTarget =
    next.target === "user" || next.target === "agent"
      ? next.target
      : state.runTarget.target;
  // When falling back to "agent" we always clear the user-tab pin: a future
  // switch back to "user" should re-capture the current tab, not re-use a
  // stale id from a prior session.
  const userTabId =
    target === "agent"
      ? null
      : next.userTabId !== undefined
        ? next.userTabId
        : state.runTarget.userTabId;
  const userWindowId =
    target === "agent"
      ? null
      : next.userWindowId !== undefined
        ? next.userWindowId
        : state.runTarget.userWindowId;
  state.runTarget = { target, userTabId, userWindowId };
  await saveRunTarget();
}

export function broadcastRunTarget() {
  // Same fire-and-forget pattern as `broadcastStatus`: the side panel may
  // not be open. We surface the message so the panel's RunModeToggle can
  // sync if some other surface (e.g. an in-flight promotion) changed it.
  chrome.runtime
    .sendMessage({
      type: "hermes:run-target-changed",
      runTarget: state.runTarget,
    })
    .catch(() => {});
}

export async function setDesiredConnected(value: boolean) {
  state.desiredConnected = !!value;
  await chrome.storage.local.set({ desiredConnected: state.desiredConnected });
  syncState();
}

// ---------------------------------------------------------------------------
// Tri-state derivation
// ---------------------------------------------------------------------------

export function getCurrentState(): ConnectionState {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) return "connected";
  if (state.desiredConnected) return "connecting";
  return "disconnected";
}

export function syncState() {
  const s = getCurrentState();
  applyIcon(s);
  broadcastStatus();
}

export function broadcastStatus() {
  // No-op when nobody is listening (popup closed); swallow the rejection.
  chrome.runtime
    .sendMessage({ type: "hermes:status-changed" })
    .catch(() => {});
}
