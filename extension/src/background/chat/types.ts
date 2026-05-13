/**
 * Wire protocol + runtime-state types for the background chat engine.
 *
 * The agent loop now lives in the service worker; the side panel is a thin
 * subscriber that posts user input over a long-lived `chrome.runtime` port
 * and renders live `StreamEvent`s. Persisted message history (in
 * `chrome.storage.local`) stays owned by the panel; the engine only owns the
 * per-session `ChatRuntimeState` (in `chrome.storage.session`) so closing
 * and reopening the side panel mid-stream can recover the partial assistant
 * message without aborting the stream.
 */

import type {
  HermesApprovalRequest,
  HermesToolProgress,
  StreamedToolCall,
} from "~lib/chat/hermes-client";
import type { ChatMessage } from "~lib/types";

export type { HermesApprovalRequest };

export const CHAT_PORT_NAME = "hermes-chat";

/** Payload the panel sends on `submit` to start one assistant turn. */
export interface SubmitPayload {
  sessionId: string;
  /** Stable uiId of the assistant placeholder bubble the panel just appended. */
  assistantUiId: string;
  apiBase: string;
  apiKey?: string;
  model: string;
  history: ChatMessage[];
}

/**
 * Interleaved text+tool timeline preserving wire order. Mirrors the panel's
 * `AssistantTimelineItem` so a snapshot from the engine can be rendered
 * directly without translation.
 */
export type AssistantTimelineItem =
  | { kind: "text"; id: string; text: string }
  | { kind: "tool"; id: string; toolCallId: string }
  | { kind: "approval"; id: string; approvalId: string };

export interface ChatRuntimeError {
  message: string;
  status?: number;
  hint?: string;
}

/** Everything the panel needs to reconstruct an in-flight or just-ended turn. */
export interface ChatRuntimeState {
  sessionId: string;
  assistantUiId: string | null;
  streaming: boolean;
  assistantText: string;
  reasoning: string;
  toolCalls: StreamedToolCall[];
  hermesOrder: string[];
  hermesToolProgress: HermesToolProgress[];
  timeline: AssistantTimelineItem[];
  error: ChatRuntimeError | null;
  /**
   * URL/title the agent tab ended on, captured at `done` emit time. Stays
   * `null` until the stream finishes (and stays null for user-mode turns
   * where the chip would be a no-op). Persisted so a panel that reopens
   * after the stream completed in the background can still attach the
   * "Open in my browser →" chip from the snapshot.
   */
  agentFinalUrl: string | null;
  agentFinalTitle: string | null;
  /**
   * Approval requests the gateway emitted that haven't been answered yet.
   * Survives panel close (via `chrome.storage.session`) so reopening
   * during a paused agent run shows the prompt again instead of leaving
   * the agent silently blocked.
   */
  pendingApprovals: HermesApprovalRequest[];
  /**
   * `X-Hermes-Run-Id` from the in-flight or last-completed chat
   * completion request. Required to POST approval decisions back
   * (`/v1/runs/{runId}/approval`). May be `null` on older gateways that
   * don't emit the header — in that case the approval event's own
   * `runId` field is the only source.
   */
  runId: string | null;
  startedAt: number;
  updatedAt: number;
}

/** Panel → background frames. */
export type ClientToBgMessage =
  | { type: "subscribe"; sessionId: string }
  | { type: "snapshot"; sessionId: string }
  | { type: "submit"; payload: SubmitPayload }
  | { type: "abort"; sessionId: string }
  | { type: "clear"; sessionId: string }
  | {
      type: "clearApproval";
      sessionId: string;
      approvalId: string;
    };

/** Background → panel frames. */
export type BgToClientMessage =
  | { type: "snapshot"; sessionId: string; state: ChatRuntimeState | null }
  | { type: "event"; sessionId: string; event: StreamEvent };

/**
 * Live deltas. Mirrors the existing `StreamHandlers` callbacks so the panel
 * can apply them with the same logic it already had — only the source
 * changes (port vs direct `streamChat` callback).
 */
export type StreamEvent =
  | { kind: "begin"; assistantUiId: string }
  | { kind: "chunk"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "toolCalls"; calls: StreamedToolCall[] }
  | { kind: "hermesToolProgress"; event: HermesToolProgress }
  | { kind: "session"; sessionId: string }
  | { kind: "run"; runId: string }
  | { kind: "approvalRequest"; request: HermesApprovalRequest }
  | { kind: "approvalResolved"; approvalId: string }
  | {
      kind: "done";
      /**
       * URL the agent tab ended on, when the just-finished turn ran on the
       * agent surface. Drives the "Open in my browser →" chip on the
       * assistant bubble. Omitted for user-mode turns (chip would be a
       * no-op pointing at the user's current tab).
       */
      agentFinalUrl?: string;
      agentFinalTitle?: string;
    }
  | { kind: "aborted" }
  | { kind: "error"; message: string; status?: number; hint?: string };
