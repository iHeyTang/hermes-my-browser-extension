/**
 * Background chat engine — owns the LLM streaming loop and tool-progress
 * dispatch. The side panel becomes a thin viewer: it posts user input over
 * a `chrome.runtime` port and the engine streams `StreamEvent`s back.
 *
 * Why this lives in the service worker, not the side panel:
 *   - Closing the side panel was killing the React component and aborting
 *     the in-flight `fetch` (the panel held the `AbortController`).
 *   - The SW stays alive as long as a fetch is reading from `ReadableStream`,
 *     so the stream survives panel closure end-to-end.
 *   - Tool calls already route through the SW, so there's no longer a chasm
 *     between "where streaming happens" and "where tool dispatch happens".
 */

import { HermesHttpError, streamChat } from "~lib/chat/hermes-client";
import { shortId } from "~lib/utils";

import { state as bgState } from "../state";
import { broadcast } from "./port";
import {
  clearState,
  flushPersist,
  mutateState,
  setState,
} from "./state";
import type {
  AssistantTimelineItem,
  ChatRuntimeState,
  StreamEvent,
  SubmitPayload,
} from "./types";

/**
 * Read the agent tab's current URL/title (used to attach the
 * "Open in my browser →" chip to the assistant bubble at end of turn).
 * Only returns a result when the run target is "agent" — user-mode turns
 * already happened in the user's own tab so the chip would be a no-op.
 */
async function resolveAgentFinalLocation(): Promise<{
  url?: string;
  title?: string;
}> {
  if (bgState.runTarget.target !== "agent") return {};
  const tabId = bgState.agentTabId;
  if (tabId === null) return {};
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || tab.pendingUrl || null;
    if (
      !url ||
      url === "about:blank" ||
      !/^(https?|file|ftp):/i.test(url)
    ) {
      return {};
    }
    return { url, title: tab.title || undefined };
  } catch {
    return {};
  }
}

const controllers = new Map<string, AbortController>();

function emit(sessionId: string, event: StreamEvent): void {
  broadcast(sessionId, event);
}

function appendTextToTimeline(
  timeline: AssistantTimelineItem[],
  delta: string,
): AssistantTimelineItem[] {
  const last = timeline[timeline.length - 1];
  if (last && last.kind === "text") {
    const next = timeline.slice(0, -1);
    next.push({ ...last, text: last.text + delta });
    return next;
  }
  return [...timeline, { kind: "text", id: shortId("tl"), text: delta }];
}

function appendToolToTimeline(
  timeline: AssistantTimelineItem[],
  toolCallId: string,
): AssistantTimelineItem[] {
  const seen = timeline.some(
    (it) => it.kind === "tool" && it.toolCallId === toolCallId,
  );
  if (seen) return timeline;
  return [...timeline, { kind: "tool", id: shortId("tl"), toolCallId }];
}

export async function startStream(payload: SubmitPayload): Promise<void> {
  const { sessionId, assistantUiId, apiBase, apiKey, model, history } = payload;

  if (controllers.has(sessionId)) {
    emit(sessionId, {
      kind: "error",
      message: "A stream is already in progress for this session.",
    });
    return;
  }

  const initial: ChatRuntimeState = {
    sessionId,
    assistantUiId,
    streaming: true,
    assistantText: "",
    reasoning: "",
    toolCalls: [],
    hermesOrder: [],
    hermesToolProgress: [],
    timeline: [],
    error: null,
    agentFinalUrl: null,
    agentFinalTitle: null,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  setState(initial);
  emit(sessionId, { kind: "begin", assistantUiId });

  const ctrl = new AbortController();
  controllers.set(sessionId, ctrl);

  try {
    await streamChat(
      history,
      { apiBase, apiKey, model, sessionId, signal: ctrl.signal },
      {
        onChunk: (delta) => {
          mutateState(sessionId, (cur) => ({
            assistantText: cur.assistantText + delta,
            timeline: appendTextToTimeline(cur.timeline, delta),
          }));
          emit(sessionId, { kind: "chunk", text: delta });
        },
        onReasoningChunk: (delta) => {
          mutateState(sessionId, (cur) => ({
            reasoning: cur.reasoning + delta,
          }));
          emit(sessionId, { kind: "reasoning", text: delta });
        },
        onToolCallsState: (calls) => {
          mutateState(sessionId, () => ({ toolCalls: calls.slice() }));
          emit(sessionId, { kind: "toolCalls", calls });
        },
        onHermesToolProgress: (event) => {
          mutateState(sessionId, (cur) => {
            const seen = cur.hermesOrder.includes(event.toolCallId);
            const order = seen
              ? cur.hermesOrder
              : [...cur.hermesOrder, event.toolCallId];
            // Replace any prior event for the same toolCallId (running →
            // completed), then re-order by `order` so chips render in the
            // sequence the tools actually fired.
            const others = cur.hermesToolProgress.filter(
              (e) => e.toolCallId !== event.toolCallId,
            );
            others.push(event);
            const byId = new Map(others.map((e) => [e.toolCallId, e]));
            const ordered = order
              .map((id) => byId.get(id))
              .filter((e): e is typeof event => Boolean(e));
            return {
              hermesOrder: order,
              hermesToolProgress: ordered,
              timeline: seen
                ? cur.timeline
                : appendToolToTimeline(cur.timeline, event.toolCallId),
            };
          });
          emit(sessionId, { kind: "hermesToolProgress", event });
        },
        onSession: (s) => {
          emit(sessionId, { kind: "session", sessionId: s });
        },
      },
    );

    const final = await resolveAgentFinalLocation();
    mutateState(sessionId, () => ({
      streaming: false,
      agentFinalUrl: final.url ?? null,
      agentFinalTitle: final.title ?? null,
    }));
    emit(sessionId, {
      kind: "done",
      ...(final.url ? { agentFinalUrl: final.url } : {}),
      ...(final.title ? { agentFinalTitle: final.title } : {}),
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") {
      mutateState(sessionId, () => ({ streaming: false }));
      emit(sessionId, { kind: "aborted" });
    } else {
      const status =
        err instanceof HermesHttpError ? err.status : undefined;
      const hint =
        err instanceof HermesHttpError ? err.hint() || undefined : undefined;
      const message = String(err?.message || err);
      mutateState(sessionId, () => ({
        streaming: false,
        error: { message, status, hint },
      }));
      emit(sessionId, { kind: "error", message, status, hint });
    }
  } finally {
    controllers.delete(sessionId);
    await flushPersist(sessionId);
  }
}

export function abortStream(sessionId: string): void {
  const ctrl = controllers.get(sessionId);
  if (!ctrl) return;
  try {
    ctrl.abort();
  } catch (e) {
    console.warn("[chat-engine] abort failed:", e);
  }
}

/** Forget runtime state for a session (e.g. user permanently deleted it). */
export function clearRuntime(sessionId: string): void {
  abortStream(sessionId);
  clearState(sessionId);
}
