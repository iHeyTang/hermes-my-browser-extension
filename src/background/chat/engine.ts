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

import {
  HermesHttpError,
  runHermesAgent,
  type HermesApprovalRequest,
  type HermesToolProgress,
} from "~lib/chat/hermes-client";
import { shortId } from "~lib/utils";

import { state as bgState } from "../state";
import { broadcast } from "./port";
import {
  clearState,
  flushPersist,
  getState,
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

function appendApprovalToTimeline(
  timeline: AssistantTimelineItem[],
  approvalId: string,
): AssistantTimelineItem[] {
  const seen = timeline.some(
    (it) => it.kind === "approval" && it.approvalId === approvalId,
  );
  if (seen) return timeline;
  return [
    ...timeline,
    { kind: "approval", id: shortId("tl"), approvalId },
  ];
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
    pendingApprovals: [],
    runId: null,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  setState(initial);
  emit(sessionId, { kind: "begin", assistantUiId });

  const ctrl = new AbortController();
  controllers.set(sessionId, ctrl);

  // -----------------------------------------------------------------
  // Adapters for /v1/runs events.
  //
  // The runs API splits tool lifecycle into bare `tool.started` /
  // `tool.completed` events that DON'T carry a `tool_call_id`. We mint
  // synthetic ids here and FIFO-match completion events back to their
  // running counterpart per tool-name. Lives in a per-stream closure so
  // it dies with the stream — no cross-turn leakage.
  // -----------------------------------------------------------------
  const runningByTool = new Map<string, string[]>(); // toolName → stack of synthesised ids

  function emitToolProgress(progress: HermesToolProgress): void {
    mutateState(sessionId, (cur) => {
      const seen = cur.hermesOrder.includes(progress.toolCallId);
      const order = seen
        ? cur.hermesOrder
        : [...cur.hermesOrder, progress.toolCallId];
      const others = cur.hermesToolProgress.filter(
        (e) => e.toolCallId !== progress.toolCallId,
      );
      others.push(progress);
      const byId = new Map(others.map((e) => [e.toolCallId, e]));
      const ordered = order
        .map((id) => byId.get(id))
        .filter((e): e is HermesToolProgress => Boolean(e));
      return {
        hermesOrder: order,
        hermesToolProgress: ordered,
        timeline: seen
          ? cur.timeline
          : appendToolToTimeline(cur.timeline, progress.toolCallId),
      };
    });
    emit(sessionId, { kind: "hermesToolProgress", event: progress });
  }

  // The gateway emits an explicit `approval.responded` event but without
  // an approval id — only `choice` and a `resolved` count. We FIFO-match
  // against pendingApprovals on this side: the first N pendings get
  // resolved with the given choice. Edge case: if the user already
  // cleared the approval locally via `clearPendingApproval` (the panel
  // does this optimistically after a successful POST), there's nothing
  // left to resolve and this is a no-op.
  function resolveFifoApprovals(count: number): string[] {
    const cleared: string[] = [];
    mutateState(sessionId, (cur) => {
      const toResolve = cur.pendingApprovals.slice(0, count);
      cleared.push(...toResolve.map((a) => a.approvalId));
      return {
        pendingApprovals: cur.pendingApprovals.slice(toResolve.length),
      };
    });
    return cleared;
  }

  // Extract a system "instructions" string out of the message list so it
  // lands in the runs `instructions` field rather than as the first
  // conversation_history entry. Hermes treats them differently — the
  // system prompt is sticky across the conversation, while history is
  // per-turn replayable context.
  // (We pass everything through as `input` and let Hermes split it; the
  // gateway's `_handle_runs` already deals with both shapes. This is
  // forward-compat for if/when we want to be more explicit.)

  try {
    await runHermesAgent(
      history,
      {
        apiBase,
        apiKey,
        model,
        sessionId,
        signal: ctrl.signal,
        onRun: (runId) => {
          mutateState(sessionId, () => ({ runId }));
          emit(sessionId, { kind: "run", runId });
        },
      },
      {
        onMessageDelta: (delta) => {
          mutateState(sessionId, (cur) => ({
            assistantText: cur.assistantText + delta,
            timeline: appendTextToTimeline(cur.timeline, delta),
          }));
          emit(sessionId, { kind: "chunk", text: delta });
        },
        onReasoning: (text) => {
          // ─────────────────────────────────────────────────────────────────
          // Defensive dedup against a known Hermes server-side quirk.
          //
          // Root cause (NOT something we can fix here — lives in Hermes):
          //   run_agent.py:14390-14408 fires
          //     tool_progress_callback("reasoning.available", "_thinking",
          //       assistant_message.content[:500], None)
          //   on every top-level turn whose assistant message has any
          //   content. The "reasoning" name is misleading — `_think_text`
          //   is just `assistant_message.content` (the model's reply text
          //   for that turn, after stripping <think>/<reasoning>/<scratchpad>
          //   tags). For a final-answer turn (no tool_calls follow), this
          //   is literally the answer the user is about to read, NOT a
          //   separate reasoning channel.
          //
          // Why it causes visible doubling in the side panel:
          //   The runs API delivers the same text twice over the SSE
          //   stream — once as a sequence of `message.delta` events
          //   (streamed body) and once as a single `reasoning.available`
          //   event (one-shot, post-stream). The chat bubble has two
          //   render slots that consume these independently:
          //     - the timeline / bodyText slot (driven by message.delta)
          //     - the streamVerbose / reasoning slot (driven by
          //       reasoning.available)
          //   With the Thoughts toggle on, both slots render → user sees the same
          //   reply printed twice.
          //
          // Proper upstream fix (≈5 lines in Hermes):
          //   Only fire reasoning.available when the assistant_message
          //   has follow-up tool_calls — i.e., when the content is
          //   genuinely intermediate "what I'm about to do next" text
          //   rather than the final answer. Roughly:
          //     elif _think_text and assistant_message.tool_calls:
          //         self.tool_progress_callback("reasoning.available", ...)
          //   That would align with how Hermes's own WebUI's tui_gateway
          //   protocol splits the channels (`thinking.delta` vs.
          //   `reasoning.delta` vs. `reasoning.available` are three
          //   distinct events there).
          //
          // Why we keep this dedup even after a hypothetical upstream fix:
          //   1. We don't control which Hermes version users run.
          //   2. The event schema may regress or change shape on upgrade.
          //   3. If Hermes later starts emitting *actual* reasoning tokens
          //      (o1-style) through this same event name, the probe below
          //      won't match the accumulated answer text, so real
          //      reasoning will pass through and render normally.
          //
          // The probe: take the first 100 chars of the trimmed reasoning
          // text and check whether the already-accumulated assistantText
          // contains it. Order-wise the agent fires reasoning.available
          // AFTER the streaming response finishes (run_agent.py
          // ~14390+), so by the time this handler runs all
          // message.delta events for this turn have already been
          // processed into `assistantText`. A substring match is a
          // strong signal that this is an echo and not a distinct
          // reasoning channel.
          // ─────────────────────────────────────────────────────────────────
          if (!text) return;
          const trimmed = text.trim();
          if (!trimmed) return;
          const probe = trimmed.slice(0, 100);
          const cur = getState(sessionId);
          if (probe && cur && cur.assistantText.includes(probe)) {
            // Pure echo of the response — drop entirely.
            return;
          }
          mutateState(sessionId, () => ({ reasoning: text }));
          emit(sessionId, { kind: "reasoning", text });
        },
        onToolStarted: ({ tool, preview }) => {
          if (!tool) return;
          const toolCallId = shortId("rtc"); // run-tool-call
          const stack = runningByTool.get(tool) ?? [];
          stack.push(toolCallId);
          runningByTool.set(tool, stack);
          const now = Date.now();
          emitToolProgress({
            tool,
            toolCallId,
            status: "running",
            label: preview,
            startedAt: now,
          });
        },
        onToolCompleted: ({ tool, duration, error }) => {
          if (!tool) return;
          const stack = runningByTool.get(tool);
          // FIFO: oldest matching `running` is the one that completed.
          // (Hermes runs tools sequentially within a turn so this is
          // unambiguous in practice; the stack defends against future
          // parallelism quirks.)
          const toolCallId = stack && stack.length > 0 ? stack.shift()! : null;
          if (toolCallId == null) {
            // Completion without a matching start — drop it rather than
            // emit a ghost completed chip with no prior running state.
            console.warn(
              "[chat-engine] tool.completed without matching tool.started:",
              tool,
            );
            return;
          }
          if (stack && stack.length === 0) runningByTool.delete(tool);
          const now = Date.now();
          // Look up the previous `running` entry so we can stamp the
          // matching `startedAt` and compute a real duration even if the
          // server didn't send one.
          const prior = (getState(sessionId)?.hermesToolProgress ?? []).find(
            (e) => e.toolCallId === toolCallId,
          );
          const startedAt = prior?.startedAt ?? now;
          const durationMs =
            typeof duration === "number" && duration > 0
              ? Math.round(duration * 1000)
              : Math.max(0, now - startedAt);
          emitToolProgress({
            tool,
            toolCallId,
            status: "completed",
            label: error ? "(error)" : prior?.label,
            startedAt,
            durationMs,
          });
        },
        onApprovalRequest: (request: HermesApprovalRequest) => {
          // Slot the approval into the timeline at the exact position it
          // happened — between whatever text/tool events came before and
          // whatever comes after. The panel-side hydrateLocalFromSnapshot
          // copies this into the local timeline ref so the inline
          // approval chip renders in-place even when the panel opens
          // mid-stream.
          mutateState(sessionId, (cur) => {
            const enriched =
              request.runId || !cur.runId
                ? request
                : { ...request, runId: cur.runId };
            const without = cur.pendingApprovals.filter(
              (a) => a.approvalId !== request.approvalId,
            );
            return {
              pendingApprovals: [...without, enriched],
              timeline: appendApprovalToTimeline(
                cur.timeline,
                request.approvalId,
              ),
            };
          });
          emit(sessionId, { kind: "approvalRequest", request });
        },
        onApprovalResponded: ({ resolved }) => {
          // Resolve oldest N pending approvals (server didn't tell us
          // which one). Each gets its own approvalResolved broadcast so
          // the panel can clear cards individually.
          const cleared = resolveFifoApprovals(Math.max(1, resolved));
          for (const approvalId of cleared) {
            emit(sessionId, { kind: "approvalResolved", approvalId });
          }
        },
        onRunCompleted: ({ output }) => {
          // The gateway delivers the full final text in `output`. We've
          // been accumulating it incrementally via message.delta, so
          // unless we missed a chunk the two strings should match. If
          // they don't (delta dropped, reconnection, etc.), trust the
          // authoritative `output` field on the terminal event.
          mutateState(sessionId, (cur) => {
            if (output && output !== cur.assistantText) {
              return { assistantText: output };
            }
            return {};
          });
        },
        onRunFailed: ({ error }) => {
          // Throwing from runHermesAgent's own handler isn't needed —
          // the client already throws after invoking us. Just propagate
          // the error message through state so the catch below sees it.
          mutateState(sessionId, () => ({
            error: { message: error },
          }));
        },
        onRunCancelled: () => {
          // Mirror: runHermesAgent throws an AbortError after this fires,
          // so the catch arm picks it up.
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

/**
 * Optimistically drop a pending approval from the runtime state — the
 * panel calls this after successfully POSTing the decision so the UI
 * doesn't sit on a stale card while waiting for `approval.responded` on
 * the SSE stream. If the gateway's SSE confirmation later arrives, the
 * second remove is a harmless no-op.
 */
export function clearPendingApproval(
  sessionId: string,
  approvalId: string,
): void {
  if (!approvalId) return;
  mutateState(sessionId, (cur) => ({
    pendingApprovals: cur.pendingApprovals.filter(
      (a) => a.approvalId !== approvalId,
    ),
  }));
  broadcast(sessionId, { kind: "approvalResolved", approvalId });
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
