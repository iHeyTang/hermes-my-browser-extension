/**
 * Long-lived `chrome.runtime` port hub for the chat engine.
 *
 * Each side panel opens one port (`name: "hermes-chat"`) for its lifetime.
 * A panel can subscribe to multiple sessions simultaneously (matches the
 * tab bar in the side panel where switching tabs swaps the active session
 * but other open tabs keep streaming in the background).
 *
 * Multiple panels (e.g. two browser windows each with a side panel open on
 * the same session) all subscribe to the same `Set<Port>` for that session
 * and see identical event streams.
 */

import {
  abortStream,
  clearPendingApproval,
  clearRuntime,
  startStream,
} from "./engine";
import { getState } from "./state";
import {
  CHAT_PORT_NAME,
  type BgToClientMessage,
  type ClientToBgMessage,
  type StreamEvent,
} from "./types";

const subs = new Map<string, Set<chrome.runtime.Port>>();

export function broadcast(sessionId: string, event: StreamEvent): void {
  const set = subs.get(sessionId);
  if (!set || set.size === 0) return;
  const frame: BgToClientMessage = { type: "event", sessionId, event };
  for (const port of set) {
    try {
      port.postMessage(frame);
    } catch (e) {
      // Port may already be torn down on the panel side; the onDisconnect
      // handler will clean up the subscription eventually. Drop the frame
      // for this port without affecting others.
      console.warn("[chat-engine] broadcast failed:", e);
    }
  }
}

function subscribe(port: chrome.runtime.Port, sessionId: string): void {
  if (!sessionId) return;
  let set = subs.get(sessionId);
  if (!set) {
    set = new Set();
    subs.set(sessionId, set);
  }
  set.add(port);
}

function unsubscribeAll(port: chrome.runtime.Port): void {
  for (const [id, set] of subs.entries()) {
    set.delete(port);
    if (set.size === 0) subs.delete(id);
  }
}

function sendSnapshot(port: chrome.runtime.Port, sessionId: string): void {
  const state = getState(sessionId);
  const frame: BgToClientMessage = {
    type: "snapshot",
    sessionId,
    state,
  };
  try {
    port.postMessage(frame);
  } catch (e) {
    console.warn("[chat-engine] snapshot post failed:", e);
  }
}

export function registerChatPort(): void {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== CHAT_PORT_NAME) return;

    port.onMessage.addListener((raw: ClientToBgMessage) => {
      if (!raw || typeof raw !== "object") return;
      switch (raw.type) {
        case "subscribe":
          subscribe(port, raw.sessionId);
          sendSnapshot(port, raw.sessionId);
          break;
        case "snapshot":
          sendSnapshot(port, raw.sessionId);
          break;
        case "submit":
          // Subscribe first so the panel doesn't miss the synchronous
          // `begin` event broadcast inside startStream.
          subscribe(port, raw.payload.sessionId);
          void startStream(raw.payload);
          break;
        case "abort":
          abortStream(raw.sessionId);
          break;
        case "clear":
          clearRuntime(raw.sessionId);
          break;
        case "clearApproval":
          clearPendingApproval(raw.sessionId, raw.approvalId);
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      unsubscribeAll(port);
    });
  });
}
