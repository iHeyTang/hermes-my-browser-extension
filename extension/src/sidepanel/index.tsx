import {
  ArrowUp,
  Bot,
  Disc,
  ExternalLink,
  File as FileIcon,
  FileText,
  Globe,
  History,
  ImageIcon,
  Loader2,
  MousePointerClick,
  Paperclip,
  Pin,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";

import "~style.css";

import { Button } from "~components/ui/button";
import { HermesLogo } from "~components/hermes-logo";
import { Label } from "~components/ui/label";
import { ScrollArea } from "~components/ui/scroll-area";
import { Switch } from "~components/ui/switch";
import { Textarea } from "~components/ui/textarea";

import {
  DEFAULT_HERMES_API_BASE,
  DEFAULT_HERMES_MODEL,
} from "../background/config";
import {
  ATTACHMENT_INPUT_ACCEPT,
  attachmentToBadge,
  deleteAttachmentFile,
  formatBytesShort,
  isAttachmentReadOk,
  classify,
  readBlobAsAttachment,
  readFileAsAttachment,
} from "~lib/attachments/read";
import { formatFileAttachmentsForPrompt } from "~lib/attachments/format";
import type {
  Attachment,
  AttachmentBadge,
  AttachmentKind,
} from "~lib/attachments/types";
import type { AttachmentReadResult } from "~lib/attachments/read";
import type {
  HermesToolProgress,
  StreamedToolCall,
} from "~lib/chat/hermes-client";
import {
  CHAT_PORT_NAME,
  type BgToClientMessage,
  type ChatRuntimeState,
  type StreamEvent,
} from "../background/chat/types";
import {
  capturePageContext,
  formatPageContextsForPrompt,
  getActiveBrowserTab,
  getPageRestrictedReason,
  type PageContext,
} from "~lib/page-context/capture";
import {
  hostnameOf,
  useActiveTab,
} from "~lib/page-context/use-active-tab";
import { useSessions } from "~lib/sessions/use-sessions";
import { useResolvedTheme } from "~lib/theme";
import type { ChatMessage, NavigateOpenPolicy } from "~lib/types";
import { cn, shortId } from "~lib/utils";

import { BridgeStatusBar } from "./BridgeStatusBar";
import { NavigateOpenPolicyToggle } from "./NavigateOpenPolicyToggle";
import { SessionDrawer } from "./SessionDrawer";
import { TabBar } from "./TabBar";

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(() => {
      reject(new Error(`${label}（超过 ${Math.round(ms / 1000)} 秒）`));
    }, ms);
    p.then(
      (v) => {
        window.clearTimeout(t);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(t);
        reject(e);
      },
    );
  });
}

const SETTINGS_KEYS = {
  apiBase: "settings.chat.apiBase",
  apiKey: "settings.chat.apiKey",
  model: "settings.chat.model",
  /** When true, assistant bubbles show streamed tool-call + reasoning deltas. */
  showStreamDetails: "settings.sidepanel.showStreamDetails",
  /** Where navigate opens + (when not Auto) where all browser tools run. */
  navigateOpenPolicy: "settings.sidepanel.navigateOpenPolicy",
};

/** Push Open policy into `runTarget` when the user chose a concrete surface. */
async function applyOpenPolicyToRunTarget(
  policy: NavigateOpenPolicy,
): Promise<void> {
  if (policy === "auto") return;
  if (policy === "agent") {
    await chrome.runtime.sendMessage({ action: "runTarget.set", target: "agent" });
    return;
  }
  const win = await chrome.windows.getCurrent();
  const wid = win.id;
  if (wid === undefined) return;
  const [activeUserTab] = await chrome.tabs.query({
    active: true,
    windowId: wid,
  });
  await chrome.runtime.sendMessage({
    action: "runTarget.set",
    target: "user",
    userTabId: activeUserTab?.id ?? null,
    userWindowId: wid,
  });
}

/** Composer input grows with text until this height, then scrolls internally. */
const COMPOSER_TEXTAREA_MAX_PX = 200;

interface UiMessage extends ChatMessage {
  uiId: string;
  streaming?: boolean;
  /**
   * Pages attached as system context for this turn (live current tab and/or
   * pinned snapshots, after URL-deduplication). Persisted alongside the
   * message so the provenance chip survives panel reloads.
   */
  pageBadges?: Array<{ title: string; url: string }>;
  /**
   * @deprecated Older sessions saved a single attachment under `pageBadge`.
   * We still read it for backward compatibility but never write to it again.
   */
  pageBadge?: { title: string; url: string };
  /**
   * Files (images / text) the user uploaded with this turn. Persisted as
   * lightweight metadata + a downscaled image thumbnail so the chip /
   * preview survives panel reloads without storing the full payload.
   * The full file content lives only in the in-flight request.
   */
  attachmentBadges?: AttachmentBadge[];
  /**
   * URL the agent's tab ended up on after this assistant turn finished
   * — i.e. the last page the agent navigated to. Surfaced as a small
   * "Open in my browser →" chip on the assistant bubble so the user
   * can teleport over after a "go look it up" delegation. Only
   * populated when the service worker's `runTarget` is still the agent
   * surface at end of turn (user-only turns skip the chip). Stored as
   * plain strings so the chip survives panel reloads and history navigation.
   */
  agentFinalUrl?: string;
  agentFinalTitle?: string;
  /** Streamed reasoning trace (markdown) for this assistant turn. */
  streamVerbose?: string;
  /** Live tool-progress events from the gateway, rendered as chips. */
  hermesToolProgress?: HermesToolProgress[];
  /**
   * Per-event timeline preserving the real interleave of model text and
   * tool calls as they streamed in. Without this the side panel reduces
   * the turn to "all chips on top, all text on bottom", which hides the
   * fact that the agent often spoke between tool calls. Each item carries
   * a stable `id` so React keys are stable across rehydration.
   */
  assistantTimeline?: AssistantTimelineItem[];
}

type AssistantTimelineItem =
  | { kind: "text"; id: string; text: string }
  | { kind: "tool"; id: string; toolCallId: string };

/**
 * In-memory record of a page the user has explicitly pinned to the next
 * message. We snapshot the page content at pin time so the attachment
 * survives the user navigating away or closing the source tab. Pinned
 * state is intentionally NOT persisted across panel reloads — the content
 * payloads can be large (~16KB each) and pinning is conceptually a
 * "compose-time" concern, not a session-level one.
 */
interface PinnedPage extends PageContext {
  uiId: string;
}

/** One user turn waiting while the model is still streaming the previous reply. */
interface PendingChatTurn {
  queueId: string;
  text: string;
  attachments: Attachment[];
  attachedPagesSnapshot: PinnedPage[];
  navigateOpenPolicySnapshot: NavigateOpenPolicy;
}

function previewPendingTurn(t: PendingChatTurn): string {
  const parts: string[] = [];
  const body = t.text.trim();
  if (body) parts.push(body.length > 160 ? `${body.slice(0, 157)}…` : body);
  const n = t.attachments.filter((a) => a.path && !a.uploading).length;
  if (n > 0) parts.push(n === 1 ? "（1 个附件）" : `（${n} 个附件）`);
  return parts.join(" ") || "（空）";
}

interface ChatError {
  message: string;
  hint?: string;
}

export default function SidePanel() {
  // The side panel sits next to the user's active tab, so we let the user
  // opt into mirroring that page's theme via Settings → Theme = "Match
  // active page". Other preferences (`auto`/`light`/`dark`) behave the same
  // as in the popup/options.
  useResolvedTheme();

  const sessions = useSessions();

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ChatError | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [config, setConfig] = useState({
    apiBase: DEFAULT_HERMES_API_BASE,
    apiKey: "",
    model: DEFAULT_HERMES_MODEL,
  });
  // Persisted across panel reloads so toggling "include current page"
  // survives the SW restarts that happen whenever the side panel is
  // closed and re-opened. We default to `true` so a fresh install
  /**
   * Open: Auto / Agent / New tab / Same tab — single control for where browser
   * tools run. Non-Auto pins `runTarget` in the service worker; Auto leaves
   * `runTarget` to `my_browser_navigate` + model `open_in` (defaulting to the
   * agent window when still ambiguous). Persisted in chrome.storage.local.
   */
  const [navigateOpenPolicy, setNavigateOpenPolicy] =
    useState<NavigateOpenPolicy>("auto");
  /** Show streamed tool-call + reasoning blocks above assistant markdown. */
  const [showStreamDetails, setShowStreamDetails] = useState(false);
  const showStreamDetailsRef = useRef(false);
  /**
   * Guards the `showStreamDetails` write-back so it can't clobber the stored
   * value before the initial chrome.storage load resolves. Without this, the
   * effect runs at mount with `false`, races the async load, and persists
   * `false` on top of a user's `true`, making the toggle "forget" itself
   * every time the side panel reopens.
   */
  const showStreamDetailsLoadedRef = useRef(false);
  // Pinned pages live alongside the live current-tab attachment. Each is
  // a frozen snapshot taken at pin time so the user can keep referencing
  // a page even after they navigate away or close its tab. Reset on
  // conversation switch (see the activeId effect below).
  const [pinnedPages, setPinnedPages] = useState<PinnedPage[]>([]);
  const [pinning, setPinning] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  // Composer-time uploads — files the user dropped, pasted or picked
  // before sending the next turn. Like `pinnedPages`, these are
  // intentionally NOT persisted across panel reloads: the data URLs can
  // be sizeable and "what's in my composer" is a session-volatile
  // concept. After send we lift only a lightweight `AttachmentBadge`
  // onto the user message so the chip survives reloads.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const attachmentUploading = attachments.some((a) => !!a.uploading);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [learnRecording, setLearnRecording] = useState(false);
  const [learnEventCount, setLearnEventCount] = useState(0);
  const [learnStopBusy, setLearnStopBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** Composer textarea: grows with content up to max, then scrolls inside. */
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const { tab: activeTab, refresh: refreshActiveTab } = useActiveTab();
  // Long-lived pub/sub port to the SW chat engine. The agent loop runs over
  // there now; the panel only posts user input and renders broadcasts.
  const portRef = useRef<chrome.runtime.Port | null>(null);
  /**
   * Verbose-state accumulator for the currently active in-flight stream.
   * Mirrors the per-turn closure the old inline `streamChat` used, lifted to
   * component scope so port events (which fire outside any particular
   * `runChatTurn` invocation) can find it. Reset on activeId change and
   * rebuilt wholesale from the SW snapshot on (re)subscribe.
   */
  const verboseStateRef = useRef<{
    assistantUiId: string;
    reasoning: string;
    tools: StreamedToolCall[];
    hermesOrder: string[];
    hermesById: Map<string, HermesToolProgress>;
    timeline: AssistantTimelineItem[];
  } | null>(null);
  const verboseFlushRafRef = useRef<number | null>(null);
  /**
   * Promise plumbing so `runChatTurn` can `await` a stream that runs in the
   * service worker. Resolved by the terminal port event for this sessionId;
   * left empty when the panel reopens to an already-running stream (no local
   * `runChatTurn` is waiting on it in that case).
   */
  const pendingTurnRef = useRef<{
    sessionId: string;
    resolve: () => void;
    reject: (e: Error) => void;
  } | null>(null);
  /** FIFO: user turns composed while `busy`; shown above the composer and drained after each stream. */
  const [pendingQueue, setPendingQueue] = useState<PendingChatTurn[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /**
   * Coalesce SSE `delta.content` strings into at most one React update per
   * animation frame. Token-at-a-time `setActiveMessages` forces Streamdown /
   * the whole tree to re-render hundreds of times per second and can wedge or
   * OOM the side panel on long replies.
   */
  const streamChunkBufRef = useRef<{
    assistantUiId: string;
    pending: string;
  } | null>(null);
  const streamFlushRafRef = useRef<number | null>(null);

  function cancelStreamChunkFlush(): void {
    if (streamFlushRafRef.current != null) {
      cancelAnimationFrame(streamFlushRafRef.current);
      streamFlushRafRef.current = null;
    }
  }

  function flushStreamChunksToMessages(): void {
    const slot = streamChunkBufRef.current;
    if (!slot || slot.pending.length === 0) return;
    const delta = slot.pending;
    slot.pending = "";
    const uiId = slot.assistantUiId;
    sessions.setActiveMessages((prev) => {
      const next = (prev as UiMessage[]).slice();
      const i = next.findIndex((m) => m.uiId === uiId);
      if (i >= 0) {
        next[i] = { ...next[i], content: next[i].content + delta };
      }
      return next;
    });
  }

  function scheduleStreamChunkFlush(): void {
    if (streamFlushRafRef.current != null) return;
    streamFlushRafRef.current = requestAnimationFrame(() => {
      streamFlushRafRef.current = null;
      flushStreamChunksToMessages();
      if (streamChunkBufRef.current?.pending) {
        scheduleStreamChunkFlush();
      }
    });
  }

  useEffect(() => {
    return () => {
      cancelStreamChunkFlush();
    };
  }, []);

  function appendTextToVerboseTimeline(delta: string): void {
    const v = verboseStateRef.current;
    if (!v) return;
    const last = v.timeline[v.timeline.length - 1];
    if (last && last.kind === "text") {
      last.text += delta;
    } else {
      v.timeline.push({ kind: "text", id: shortId("tl"), text: delta });
    }
  }

  function appendToolToVerboseTimeline(toolCallId: string): void {
    const v = verboseStateRef.current;
    if (!v) return;
    const seen = v.timeline.some(
      (it) => it.kind === "tool" && it.toolCallId === toolCallId,
    );
    if (seen) return;
    v.timeline.push({ kind: "tool", id: shortId("tl"), toolCallId });
  }

  function cancelVerboseFlush(): void {
    if (verboseFlushRafRef.current != null) {
      cancelAnimationFrame(verboseFlushRafRef.current);
      verboseFlushRafRef.current = null;
    }
  }

  function applyVerboseToAssistant(): void {
    const v = verboseStateRef.current;
    if (!v) return;
    const parts: string[] = [];
    const rs = v.reasoning.trimEnd();
    if (rs) parts.push(rs);
    const named = v.tools.filter((t) => t.name);
    if (named.length > 0) {
      const blocks = named.map((t) => {
        const args = (t.arguments || "").trimEnd();
        return `**${t.name}**${args ? `\n\n\`\`\`json\n${args}\n\`\`\`` : ""}`;
      });
      parts.push(blocks.join("\n\n"));
    }
    const md = parts.join("\n\n");
    const progress = v.hermesOrder
      .map((id) => v.hermesById.get(id))
      .filter((ev): ev is HermesToolProgress => Boolean(ev));
    // Snapshot the timeline so React sees a new identity for each text item
    // when its content grows (text items are mutated in place during the run).
    const timelineSnapshot = v.timeline.map((it) =>
      it.kind === "text" ? { ...it } : it,
    );
    const assistantUiId = v.assistantUiId;
    sessions.setActiveMessages((prev) =>
      (prev as UiMessage[]).map((m) =>
        m.uiId === assistantUiId
          ? {
              ...m,
              streamVerbose: md,
              hermesToolProgress: progress,
              assistantTimeline: timelineSnapshot,
            }
          : m,
      ),
    );
  }

  function scheduleVerboseFlush(): void {
    if (verboseFlushRafRef.current != null) return;
    verboseFlushRafRef.current = requestAnimationFrame(() => {
      verboseFlushRafRef.current = null;
      applyVerboseToAssistant();
    });
  }

  // -------------------------------------------------------------------------
  // Chat port: subscribe/snapshot/event handling.
  //
  // The agent loop lives in the service worker. The panel posts user input
  // and receives `StreamEvent`s back over a long-lived port. Snapshot is the
  // recovery path — sent on `subscribe` so a freshly mounted panel (or one
  // switching to a session that was streaming in another tab) can rebuild
  // the in-flight assistant bubble from accumulated runtime state.
  // -------------------------------------------------------------------------

  function resetLiveStreamState(): void {
    cancelStreamChunkFlush();
    cancelVerboseFlush();
    streamChunkBufRef.current = null;
    verboseStateRef.current = null;
  }

  function hydrateLocalFromSnapshot(state: ChatRuntimeState): void {
    if (!state.assistantUiId) return;
    verboseStateRef.current = {
      assistantUiId: state.assistantUiId,
      reasoning: state.reasoning,
      tools: state.toolCalls.slice(),
      hermesOrder: state.hermesOrder.slice(),
      hermesById: new Map(
        state.hermesToolProgress.map((e) => [e.toolCallId, e]),
      ),
      // Copy text items so the in-place `last.text += delta` mutations
      // from future chunk events don't retroactively rewrite history.
      timeline: state.timeline.map((it) =>
        it.kind === "text" ? { ...it } : { ...it },
      ),
    };
    if (state.streaming) {
      // The accumulator buffers later deltas on top of the snapshot's
      // accumulated text. We start `pending` empty; the next chunk event
      // appends to message.content (which we'll set to assistantText below).
      streamChunkBufRef.current = {
        assistantUiId: state.assistantUiId,
        pending: "",
      };
    }
  }

  function handleSnapshot(
    sessionId: string,
    state: ChatRuntimeState | null,
  ): void {
    if (sessionId !== sessions.activeId) return;
    if (!state) {
      // No runtime state for this session. Whatever the persisted
      // `streaming` flag said, the panel-level busy must drop now —
      // otherwise switching to a fresh session keeps the composer
      // disabled from a previous session's streaming state.
      setBusy(false);
      // If the persisted log still carries a `streaming: true` flag
      // (panel was reloaded after the SW was killed mid-stream and
      // forgot the runtime), sanitize it here — otherwise the bubble
      // spins forever.
      sessions.setActiveMessages((prev) => {
        const dirty = (prev as UiMessage[]).some((m) => m.streaming);
        if (!dirty) return prev;
        return (prev as UiMessage[]).map((m) =>
          m.streaming
            ? {
                ...m,
                streaming: false,
                content: m.content
                  ? m.content + "\n\n[interrupted]"
                  : "[interrupted]",
              }
            : m,
        );
      });
      return;
    }
    // Rebuild local accumulators from the snapshot, then overlay
    // accumulated content onto the matching assistant bubble.
    hydrateLocalFromSnapshot(state);
    setBusy(state.streaming);
    sessions.setActiveMessages((prev) => {
      const next = (prev as UiMessage[]).map((m) => {
        if (m.uiId !== state.assistantUiId) return m;
        const interrupted = !state.streaming && state.error;
        return {
          ...m,
          content:
            state.assistantText +
            (interrupted ? "\n\n[interrupted]" : ""),
          streaming: state.streaming,
          // Carry the chip URL the engine captured at end-of-turn through to
          // any panel that opens AFTER the stream finished. While the panel
          // is open, handleStreamDone writes this directly from the event
          // payload; this is just the cold-open fallback.
          ...(state.agentFinalUrl
            ? {
                agentFinalUrl: state.agentFinalUrl,
                agentFinalTitle: state.agentFinalTitle ?? undefined,
              }
            : {}),
        };
      });
      return next;
    });
    applyVerboseToAssistant();
    if (state.error && !state.streaming) {
      setError({
        message: state.error.message,
        hint: state.error.hint,
      });
    }
  }

  function resolvePendingTurn(sessionId: string): void {
    const p = pendingTurnRef.current;
    if (p && p.sessionId === sessionId) {
      pendingTurnRef.current = null;
      p.resolve();
    }
    // Busy clearance is owned by the terminal-event handlers when the
    // session is active, or by `handleSnapshot` on the no-runtime path
    // — both of which the caller has already invoked. Touching busy
    // here would clobber the active session's flag when a background
    // session's terminal event arrives mid-stream of the foreground one.
  }

  function rejectPendingTurn(sessionId: string, err: Error): void {
    const p = pendingTurnRef.current;
    if (p && p.sessionId === sessionId) {
      pendingTurnRef.current = null;
      p.reject(err);
    }
  }

  function handleStreamDone(
    sessionId: string,
    agentFinalUrl?: string,
    agentFinalTitle?: string,
  ): void {
    if (sessionId !== sessions.activeId) {
      resolvePendingTurn(sessionId);
      return;
    }
    cancelStreamChunkFlush();
    applyVerboseToAssistant();
    cancelVerboseFlush();
    flushStreamChunksToMessages();
    const assistantUiId =
      streamChunkBufRef.current?.assistantUiId ??
      verboseStateRef.current?.assistantUiId ??
      null;
    streamChunkBufRef.current = null;
    verboseStateRef.current = null;
    if (assistantUiId) {
      sessions.setActiveMessages((prev) => {
        const next = (prev as UiMessage[]).map((m) =>
          m.uiId === assistantUiId
            ? {
                ...m,
                streaming: false,
                ...(agentFinalUrl
                  ? { agentFinalUrl, agentFinalTitle }
                  : {}),
              }
            : m,
        );
        void sessions.touchSession(sessionId, next);
        return next;
      });
    }
    setBusy(false);
    resolvePendingTurn(sessionId);
  }

  function handleStreamAborted(sessionId: string): void {
    if (sessionId !== sessions.activeId) {
      rejectPendingTurn(sessionId, new DOMException("aborted", "AbortError"));
      return;
    }
    cancelStreamChunkFlush();
    applyVerboseToAssistant();
    cancelVerboseFlush();
    flushStreamChunksToMessages();
    const assistantUiId =
      streamChunkBufRef.current?.assistantUiId ??
      verboseStateRef.current?.assistantUiId ??
      null;
    streamChunkBufRef.current = null;
    verboseStateRef.current = null;
    if (assistantUiId) {
      sessions.setActiveMessages((prev) =>
        (prev as UiMessage[]).map((m) =>
          m.uiId === assistantUiId
            ? {
                ...m,
                streaming: false,
                content: m.content + "\n\n[stopped]",
              }
            : m,
        ),
      );
    }
    setBusy(false);
    rejectPendingTurn(sessionId, new DOMException("aborted", "AbortError"));
  }

  function handleStreamError(
    sessionId: string,
    event: Extract<StreamEvent, { kind: "error" }>,
  ): void {
    if (sessionId !== sessions.activeId) {
      rejectPendingTurn(sessionId, new Error(event.message));
      return;
    }
    cancelStreamChunkFlush();
    cancelVerboseFlush();
    const assistantUiId =
      streamChunkBufRef.current?.assistantUiId ??
      verboseStateRef.current?.assistantUiId ??
      null;
    streamChunkBufRef.current = null;
    verboseStateRef.current = null;
    setPendingQueue((pq) => {
      for (const q of pq) {
        for (const a of q.attachments) void deleteAttachmentFile(a);
      }
      return [];
    });
    setError({ message: event.message, hint: event.hint });
    if (assistantUiId) {
      sessions.setActiveMessages((prev) =>
        (prev as UiMessage[]).filter((m) => m.uiId !== assistantUiId),
      );
    }
    setBusy(false);
    rejectPendingTurn(sessionId, new Error(event.message));
  }

  function handleStreamEvent(sessionId: string, event: StreamEvent): void {
    if (sessionId !== sessions.activeId) {
      // Terminal events for non-active sessions still need to settle the
      // local awaiter (if any) — otherwise `runChatTurn` for a backgrounded
      // tab would never resolve.
      if (event.kind === "done")
        handleStreamDone(sessionId, event.agentFinalUrl, event.agentFinalTitle);
      else if (event.kind === "aborted") handleStreamAborted(sessionId);
      else if (event.kind === "error") handleStreamError(sessionId, event);
      return;
    }
    switch (event.kind) {
      case "begin":
        setBusy(true);
        if (!streamChunkBufRef.current) {
          streamChunkBufRef.current = {
            assistantUiId: event.assistantUiId,
            pending: "",
          };
        }
        if (!verboseStateRef.current) {
          verboseStateRef.current = {
            assistantUiId: event.assistantUiId,
            reasoning: "",
            tools: [],
            hermesOrder: [],
            hermesById: new Map(),
            timeline: [],
          };
        }
        break;
      case "chunk": {
        const slot = streamChunkBufRef.current;
        if (slot) slot.pending += event.text;
        appendTextToVerboseTimeline(event.text);
        scheduleStreamChunkFlush();
        scheduleVerboseFlush();
        break;
      }
      case "reasoning": {
        const v = verboseStateRef.current;
        if (v) v.reasoning += event.text;
        scheduleVerboseFlush();
        break;
      }
      case "toolCalls": {
        const v = verboseStateRef.current;
        if (v) v.tools = event.calls.slice();
        scheduleVerboseFlush();
        break;
      }
      case "hermesToolProgress": {
        const v = verboseStateRef.current;
        const inner = event.event;
        if (v) {
          if (!v.hermesById.has(inner.toolCallId)) {
            v.hermesOrder.push(inner.toolCallId);
            appendToolToVerboseTimeline(inner.toolCallId);
          }
          v.hermesById.set(inner.toolCallId, inner);
        }
        scheduleVerboseFlush();
        break;
      }
      case "session":
        if (event.sessionId && event.sessionId !== sessionId) {
          console.warn(
            "[sidepanel] gateway returned session id %s but we expected %s; ignoring.",
            event.sessionId,
            sessionId,
          );
        }
        break;
      case "done":
        handleStreamDone(sessionId, event.agentFinalUrl, event.agentFinalTitle);
        break;
      case "aborted":
        handleStreamAborted(sessionId);
        break;
      case "error":
        handleStreamError(sessionId, event);
        break;
    }
  }

  // The port handler closes over the current render's `sessions`, so it must
  // be re-bound when activeId changes. We keep the latest function in a ref
  // and install a single stable listener that delegates through it; this
  // sidesteps the listener add/remove race that swapping the listener on
  // every activeId change would create.
  const portMessageRef = useRef<(raw: BgToClientMessage) => void>(() => {});
  useEffect(() => {
    portMessageRef.current = (raw: BgToClientMessage) => {
      if (!raw || typeof raw !== "object") return;
      if (raw.type === "snapshot") handleSnapshot(raw.sessionId, raw.state);
      else if (raw.type === "event") handleStreamEvent(raw.sessionId, raw.event);
    };
  });

  useEffect(() => {
    let port: chrome.runtime.Port | null = null;
    try {
      port = chrome.runtime.connect({ name: CHAT_PORT_NAME });
    } catch (e) {
      console.warn("[sidepanel] chat port connect failed:", e);
      return;
    }
    portRef.current = port;
    const stableListener = (raw: unknown) =>
      portMessageRef.current(raw as BgToClientMessage);
    port.onMessage.addListener(stableListener);
    port.onDisconnect.addListener(() => {
      portRef.current = null;
    });
    return () => {
      try {
        port?.disconnect();
      } catch {
        // Best-effort: port may already be torn down.
      }
      portRef.current = null;
    };
  }, []);

  // (Re)subscribe whenever the active tab flips. The SW dedupes via its
  // subscription Set; calling subscribe also re-delivers a snapshot, which
  // is how we recover an in-flight stream when the user switches back to a
  // tab that was streaming in the background.
  useEffect(() => {
    if (!sessions.ready || !sessions.activeId) return;
    const port = portRef.current;
    if (!port) return;
    try {
      port.postMessage({ type: "subscribe", sessionId: sessions.activeId });
    } catch (e) {
      console.warn("[sidepanel] subscribe failed:", e);
    }
  }, [sessions.ready, sessions.activeId]);

  useLayoutEffect(() => {
    const el = composerTextareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const sh = el.scrollHeight;
    const next = Math.min(sh, COMPOSER_TEXTAREA_MAX_PX);
    el.style.height = `${next}px`;
    el.style.overflowY = sh > COMPOSER_TEXTAREA_MAX_PX ? "auto" : "hidden";
  }, [input, pendingQueue.length]);

  async function refreshLearnStatus() {
    try {
      const r = (await chrome.runtime.sendMessage({
        action: "learn.status",
      })) as { ok?: boolean; active?: boolean; eventCount?: number };
      if (r?.ok) {
        setLearnRecording(!!r.active);
        setLearnEventCount(
          typeof r.eventCount === "number" ? r.eventCount : 0,
        );
      }
    } catch {
      // Service worker may not be ready yet.
    }
  }

  async function startLearnFromPanel() {
    try {
      const tab = await getActiveBrowserTab();
      if (tab?.id === undefined) {
        setPageError(
          "无法开始录制：没有检测到活动网页标签页。请先打开要演示的页面，再点「记录操作」。",
        );
        return;
      }
      const r = (await chrome.runtime.sendMessage({
        action: "learn.start",
        tabId: tab.id,
      })) as { ok?: boolean; error?: string };
      if (!r?.ok) {
        setPageError(r?.error || "无法开始录制");
        return;
      }
      await refreshLearnStatus();
    } catch (e) {
      setPageError(String((e as Error)?.message || e));
    }
  }

  async function stopLearnToComposer() {
    setLearnStopBusy(true);
    let trace: unknown = null;
    try {
      const r = (await withTimeout(
        chrome.runtime.sendMessage({ action: "learn.stop" }) as Promise<{
          ok?: boolean;
          trace?: unknown;
          error?: string;
        }>,
        25_000,
        "结束录制无响应（扩展后台可能未唤醒）",
      )) as { ok?: boolean; trace?: unknown; error?: string };
      if (!r?.ok) {
        setPageError(r?.error || "结束录制失败");
        return;
      }
      if (!r.trace) {
        setPageError(
          "当前没有在录制，或状态已失效。请先点「记录操作」再操作页面，然后点「结束并附加到对话」。",
        );
        await refreshLearnStatus();
        return;
      }
      trace = r.trace;
    } catch (e) {
      setPageError(String((e as Error)?.message || e));
      return;
    } finally {
      // Clear before attachment upload: put 可能因未连接桥接而长时间挂起，
      // 不应让「结束」按钮一直卡在「处理中」。
      setLearnStopBusy(false);
    }

    await refreshLearnStatus();

    try {
      const st = (await chrome.runtime.sendMessage({
        action: "status",
      })) as { connected?: boolean };
      if (!st?.connected) {
        setAttachmentError(
          "未连接 Hermes 桥接，无法上传录制轨迹。请先点击状态栏「Online」，再点一次「结束并附加到对话」。",
        );
        await refreshLearnStatus();
        return;
      }
    } catch {
      setAttachmentError("无法检测桥接状态，请确认已连接 Hermes 后再试。");
      await refreshLearnStatus();
      return;
    }

    setAttachmentBusy(true);
    setAttachmentError(null);
    const sessionId = sessions.ready
      ? await sessions.ensureActive()
      : "default";
    const name = `learn-trace-${Date.now()}.json`;
    const blob = new Blob([JSON.stringify(trace, null, 2)], {
      type: "application/json",
    });
    const pendingUiId = shortId("att");
    const pending: Attachment = {
      uiId: pendingUiId,
      name,
      mime: "application/json",
      size: blob.size,
      kind: classify(name, "application/json"),
      uploading: true,
    };
    setAttachments((prev) => [...prev, pending]);
    try {
      const read = (await withTimeout(
        readBlobAsAttachment({
          blob,
          name,
          mime: "application/json",
          options: { sessionId, uiId: pendingUiId },
        }),
        130_000,
        "上传录制轨迹超时（请保持 Hermes 在线；轨迹过大时也会较慢）",
      )) as AttachmentReadResult;
      if (!isAttachmentReadOk(read)) {
        const hint =
          read.error.includes("No Hermes plugin peer") ||
          read.error.includes("role=agent")
            ? "扩展已连桥接，但 Hermes 未以插件身份连上（缺 agent 端）。请启动 Hermes 并加载本浏览器插件。"
            : "请确认 Hermes 已启动、桥接已连接，且网关正常。";
        setAttachmentError(`${read.name}: ${read.error} ${hint}`);
        setAttachments((prev) => prev.filter((a) => a.uiId !== pendingUiId));
        return;
      }
      setAttachments((prev) =>
        prev.map((a) => (a.uiId === pendingUiId ? read.attachment : a)),
      );
      setPageError(null);
    } catch (e) {
      setAttachmentError(String((e as Error)?.message || e));
      setAttachments((prev) => prev.filter((a) => a.uiId !== pendingUiId));
    } finally {
      setAttachmentBusy(false);
    }
    await refreshLearnStatus();
  }

  useEffect(() => {
    void refreshLearnStatus();
    const onMsg = (msg: { type?: string }) => {
      if (msg?.type === "learn:state") void refreshLearnStatus();
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  useEffect(() => {
    const onMsg = (msg: {
      type?: string;
      navigateOpenPolicy?: NavigateOpenPolicy;
    }) => {
      if (msg?.type !== "hermes:navigate-open-policy-changed") return;
      const p = msg.navigateOpenPolicy;
      if (
        p === "auto" ||
        p === "agent" ||
        p === "user_new_tab" ||
        p === "user_same_tab"
      ) {
        setNavigateOpenPolicy(p);
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  // Load chat-config on mount and watch for changes from the Options page so
  // the side panel always reflects the latest model / apiBase / apiKey.
  useEffect(() => {
    void (async () => {
      const r = await chrome.storage.local.get([
        SETTINGS_KEYS.apiBase,
        SETTINGS_KEYS.apiKey,
        SETTINGS_KEYS.model,
        SETTINGS_KEYS.navigateOpenPolicy,
        SETTINGS_KEYS.showStreamDetails,
      ]);
      if (typeof r[SETTINGS_KEYS.showStreamDetails] === "boolean") {
        setShowStreamDetails(r[SETTINGS_KEYS.showStreamDetails] as boolean);
      }
      showStreamDetailsLoadedRef.current = true;
      const storedNavPolicy = r[SETTINGS_KEYS.navigateOpenPolicy];
      const legacyRun = r["settings.sidepanel.runModeDefault"] as string | undefined;
      let navPol: NavigateOpenPolicy =
        storedNavPolicy === "agent" ||
        storedNavPolicy === "user_new_tab" ||
        storedNavPolicy === "user_same_tab"
          ? storedNavPolicy
          : "auto";
      if (
        storedNavPolicy === undefined &&
        (legacyRun === "user" || legacyRun === "agent")
      ) {
        navPol = legacyRun === "user" ? "user_same_tab" : "agent";
      }
      setNavigateOpenPolicy(navPol);
      try {
        await chrome.runtime.sendMessage({
          action: "navigateOpenPolicy.set",
          policy: navPol,
        });
      } catch {
        // SW may not be ready yet.
      }
      await applyOpenPolicyToRunTarget(navPol);
      setConfig({
        apiBase:
          typeof r[SETTINGS_KEYS.apiBase] === "string"
            ? r[SETTINGS_KEYS.apiBase]
            : DEFAULT_HERMES_API_BASE,
        apiKey:
          typeof r[SETTINGS_KEYS.apiKey] === "string"
            ? r[SETTINGS_KEYS.apiKey]
            : "",
        model:
          typeof r[SETTINGS_KEYS.model] === "string"
            ? r[SETTINGS_KEYS.model]
            : DEFAULT_HERMES_MODEL,
      });
    })();

    const onChanged = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: chrome.storage.AreaName,
    ) => {
      if (area !== "local") return;
      setConfig((prev) => ({
        apiBase:
          typeof changes[SETTINGS_KEYS.apiBase]?.newValue === "string"
            ? (changes[SETTINGS_KEYS.apiBase]!.newValue as string)
            : prev.apiBase,
        apiKey:
          typeof changes[SETTINGS_KEYS.apiKey]?.newValue === "string"
            ? (changes[SETTINGS_KEYS.apiKey]!.newValue as string)
            : prev.apiKey,
        model:
          typeof changes[SETTINGS_KEYS.model]?.newValue === "string"
            ? (changes[SETTINGS_KEYS.model]!.newValue as string)
            : prev.model,
      }));
      if (typeof changes[SETTINGS_KEYS.showStreamDetails]?.newValue === "boolean") {
        setShowStreamDetails(
          changes[SETTINGS_KEYS.showStreamDetails]!.newValue as boolean,
        );
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  useEffect(() => {
    showStreamDetailsRef.current = showStreamDetails;
  }, [showStreamDetails]);

  useEffect(() => {
    if (!showStreamDetailsLoadedRef.current) return;
    void chrome.storage.local.set({
      [SETTINGS_KEYS.showStreamDetails]: showStreamDetails,
    });
  }, [showStreamDetails]);

  // Recovery for persisted `streaming: true` flags is now driven by the
  // snapshot the SW returns on `subscribe`: if there's no runtime state for
  // the session, `handleSnapshot` marks any still-streaming bubble as
  // `[interrupted]`; if there IS runtime state, the bubble is rehydrated
  // with the accumulated content from the still-running (or just-finished)
  // background stream. The old eager sanitize-on-activate effect that lived
  // here used to wipe partial text before the snapshot could arrive — see
  // `handleSnapshot` for the replacement.

  // Auto-scroll on new content.
  useEffect(() => {
    const el = scrollRef.current?.querySelector(
      "[data-radix-scroll-area-viewport]",
    );
    if (el) (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
  }, [sessions.activeMessages]);

  // Session switch: drop panel-local stream accumulators and compose-time
  // affordances (pinned pages, attachments). The previous session's stream
  // keeps running in the SW; switching back to that session will
  // re-subscribe and rebuild local state from the snapshot.
  const lastSeenActiveRef = useRef<string>("");
  useEffect(() => {
    if (sessions.activeId !== lastSeenActiveRef.current) {
      const wasInitialised = lastSeenActiveRef.current !== "";
      lastSeenActiveRef.current = sessions.activeId;
      resetLiveStreamState();
      if (wasInitialised) {
        setPendingQueue((prev) => {
          for (const q of prev) {
            for (const a of q.attachments) void deleteAttachmentFile(a);
          }
          return [];
        });
        setPinnedPages([]);
        setPageError(null);
        // Same fire-and-forget GC as `newChat` — the composer-time
        // attachments belonged to the session we're leaving.
        for (const a of attachments) void deleteAttachmentFile(a);
        setAttachments([]);
        setAttachmentError(null);
      }
    }
  }, [sessions.activeId]);

  const composerHasSendablePayload =
    !!input.trim() ||
    attachments.some((a) => a.path && !a.uploading);

  async function runChatTurn(args: {
    text: string;
    attachments: Attachment[];
    attachedPagesForTurn: PinnedPage[];
    navigateOpenPolicyForTurn: NavigateOpenPolicy;
  }): Promise<void> {
    const {
      text,
      attachments: attachmentsForTurn,
      attachedPagesForTurn,
      navigateOpenPolicyForTurn,
    } = args;

    setError(null);
    setPageError(null);

    const sessionId = await sessions.ensureActive();

    // One-shot page attachments for THIS turn only. Each was captured at
    // pin time (eager snapshot) — `attachedPages` is cleared after send so
    // they never persist into follow-up turns. Inspecting the user's tab
    // live happens via the agent's `my_browser_active_tab` tool.
    const pages: PageContext[] = [...attachedPagesForTurn];

    const pageSystemMessage: ChatMessage | null =
      pages.length > 0
        ? {
            role: "system",
            content: formatPageContextsForPrompt(pages),
          }
        : null;
    const pageBadges =
      pages.length > 0
        ? pages.map((p) => ({ title: p.title, url: p.url }))
        : undefined;

    // Every attachment — image, text, pdf, binary — flows through the same
    // `<file-attachment path="...">` system block. The agent reads the
    // file by path with whatever tools it has; we don't inline payloads.
    const attachmentsForSend = attachmentsForTurn.filter(
      (a) => a.path && !a.uploading,
    );
    const fileSystemMessage: ChatMessage | null =
      attachmentsForSend.length > 0
        ? {
            role: "system",
            content: formatFileAttachmentsForPrompt(attachmentsForSend),
          }
        : null;
    // Build the persisted-on-bubble badges in parallel with the request:
    // images need a small thumbnail re-encode which is non-trivial, so we
    // kick that off but don't block the send path on it.
    const badgesPromise: Promise<AttachmentBadge[] | undefined> =
      attachmentsForSend.length > 0
        ? Promise.all(attachmentsForSend.map(attachmentToBadge))
        : Promise.resolve(undefined);

    const userMsg: UiMessage = {
      uiId: shortId("u"),
      role: "user",
      content: text,
      // Annotate the user bubble with the pages we attached so the user
      // can see what context the model was given for this turn.
      pageBadges,
    };
    const assistantMsg: UiMessage = {
      uiId: shortId("a"),
      role: "assistant",
      content: "",
      streaming: true,
    };

    sessions.setActiveMessages((prev) => {
      const next = [...prev, userMsg, assistantMsg];
      void sessions.touchSession(sessionId, next);
      return next;
    });
    // Once the user message is in the log, attach the (async-built)
    // badges in a follow-up update so the chips render as soon as the
    // thumbnails are ready.
    void badgesPromise.then((attachmentBadges) => {
      if (!attachmentBadges) return;
      sessions.setActiveMessages((prev) => {
        const next = (prev as UiMessage[]).map((m) =>
          m.uiId === userMsg.uiId ? { ...m, attachmentBadges } : m,
        );
        void sessions.touchSession(sessionId, next);
        return next;
      });
    });
    setBusy(true);

    // Push runTarget from Open policy *before* the gateway may dispatch tools.
    try {
      await applyOpenPolicyToRunTarget(navigateOpenPolicyForTurn);
    } catch (e) {
      console.warn("[sidepanel] applyOpenPolicyToRunTarget failed:", e);
    }

    // Snapshot the history we're sending so we don't accidentally include
    // the empty assistant placeholder we just appended.
    const baseMessages = (sessions.activeMessages as UiMessage[]).map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.name ? { name: m.name } : {}),
    }));
    // All attachment context lives in `fileSystemMessage` (path-only),
    // mirroring the `pageSystemMessage` shape. There is no per-turn
    // multimodal payload on the user message any more — the agent picks
    // up images via its own image tool by path. (See
    // `INLINE_IMAGES_AS_DATA_URL` in `attachments/format.ts` for the
    // escape hatch back to inline `image_url` parts.)
    const history: ChatMessage[] = [
      ...(fileSystemMessage ? [fileSystemMessage] : []),
      ...(pageSystemMessage ? [pageSystemMessage] : []),
      ...baseMessages,
      {
        role: userMsg.role,
        content: userMsg.content,
      },
    ];

    // Prime the panel-local accumulators BEFORE submitting so the port
    // event listener (which fires asynchronously once the SW broadcasts
    // back) finds populated state to mutate. The SW also maintains its
    // own copy for snapshot-on-resubscribe; the two are kept in sync by
    // applying every event on both sides.
    cancelStreamChunkFlush();
    cancelVerboseFlush();
    streamChunkBufRef.current = {
      assistantUiId: assistantMsg.uiId,
      pending: "",
    };
    verboseStateRef.current = {
      assistantUiId: assistantMsg.uiId,
      reasoning: "",
      tools: [],
      hermesOrder: [],
      hermesById: new Map(),
      timeline: [],
    };

    try {
      await new Promise<void>((resolve, reject) => {
        pendingTurnRef.current = { sessionId, resolve, reject };
        const port = portRef.current;
        if (!port) {
          pendingTurnRef.current = null;
          reject(new Error("Background chat port is not connected."));
          return;
        }
        try {
          port.postMessage({
            type: "submit",
            payload: {
              sessionId,
              assistantUiId: assistantMsg.uiId,
              apiBase: config.apiBase,
              apiKey: config.apiKey,
              model: config.model,
              history,
            },
          });
        } catch (e) {
          pendingTurnRef.current = null;
          reject(e as Error);
        }
      });
    } catch (e) {
      // The terminal-event handlers (handleStreamAborted /
      // handleStreamError) have already applied the visible UI changes —
      // marking the bubble [stopped], surfacing the error banner, etc.
      // We only log non-abort failures here for debugging.
      const err = e as Error;
      if (err.name !== "AbortError") {
        console.warn("[sidepanel] stream failed:", err.message);
      }
    } finally {
      // Busy clearance is owned by the terminal-event handlers (so a
      // background session's `done` doesn't clobber the active session's
      // busy state). Do NOT touch busy here.
      setPendingQueue((prev) => {
        if (prev.length === 0) return prev;
        const [head, ...tail] = prev;
        queueMicrotask(() =>
          void runChatTurn({
            text: head.text,
            attachments: head.attachments,
            attachedPagesForTurn: head.attachedPagesSnapshot,
            navigateOpenPolicyForTurn: head.navigateOpenPolicySnapshot,
          }),
        );
        return tail;
      });
    }
  }

  async function send() {
    const text = input.trim();
    // Allow send when the user has uploaded attachments but hasn't typed
    // anything (e.g. "here's a screenshot — what's wrong with it?"). We
    // still gate on having SOMETHING to send so an empty composer with
    // no attachments stays a no-op.
    if (!text && attachments.every((a) => !a.path || a.uploading)) return;
    if (attachmentUploading) return;
    if (!sessions.ready) return;

    const attachmentsForSend = attachments.filter((a) => a.path && !a.uploading);

    if (busy) {
      setPendingQueue((prev) => [
        ...prev,
        {
          queueId: shortId("q"),
          text,
          attachments: attachmentsForSend.map((a) => ({ ...a })),
          attachedPagesSnapshot: pinnedPages.map((p) => ({ ...p })),
          navigateOpenPolicySnapshot: navigateOpenPolicy,
        },
      ]);
      setInput("");
      setAttachments([]);
      // Page attachments are one-shot — clear so they don't double-attach
      // to a follow-up turn the user types while this one is still in flight.
      setPinnedPages([]);
      setAttachmentError(null);
      return;
    }

    setInput("");
    setAttachments([]);
    const attachedPagesForSend = pinnedPages.map((p) => ({ ...p }));
    setPinnedPages([]);
    setAttachmentError(null);

    await runChatTurn({
      text,
      attachments: attachmentsForSend,
      attachedPagesForTurn: attachedPagesForSend,
      navigateOpenPolicyForTurn: navigateOpenPolicy,
    });
  }

  function stop() {
    setPendingQueue((prev) => {
      for (const q of prev) {
        for (const a of q.attachments) void deleteAttachmentFile(a);
      }
      return [];
    });
    const sid = sessions.activeId;
    const port = portRef.current;
    if (sid && port) {
      try {
        port.postMessage({ type: "abort", sessionId: sid });
      } catch (e) {
        console.warn("[sidepanel] abort post failed:", e);
      }
    }
  }

  function removePendingQueueItem(queueId: string) {
    setPendingQueue((prev) => {
      const hit = prev.find((q) => q.queueId === queueId);
      if (hit) {
        for (const a of hit.attachments) void deleteAttachmentFile(a);
      }
      return prev.filter((q) => q.queueId !== queueId);
    });
  }

  // Show / hide the agent window — same SW action the popup already
  // exposes via its "Show Agent Window" button. Wired to the run-status
  // bar so users can peek at the agent without leaving the chat.
  async function showAgentWindow() {
    try {
      await chrome.runtime.sendMessage({ action: "show" });
    } catch (e) {
      console.warn("[sidepanel] show agent window failed:", e);
    }
  }

  async function handleNavigateOpenPolicyChange(next: NavigateOpenPolicy) {
    setNavigateOpenPolicy(next);
    await chrome.storage.local.set({
      [SETTINGS_KEYS.navigateOpenPolicy]: next,
    });
    try {
      await chrome.runtime.sendMessage({
        action: "navigateOpenPolicy.set",
        policy: next,
      });
    } catch (e) {
      console.warn("[sidepanel] navigateOpenPolicy.set failed:", e);
    }
    await applyOpenPolicyToRunTarget(next);
  }

  // Mid-run hand-off: pin Open to Same tab, then ferry the agent's
  // current URL into the user's tab so the user picks up exactly
  // where the agent left off. We don't abort the run — the agent
  // keeps streaming whatever it was about to say; only the *next*
  // tool call (if any) routes to the user tab.
  async function moveToMyTab() {
    try {
      await handleNavigateOpenPolicyChange("user_same_tab");
      const win = await chrome.windows.getCurrent();
      const [activeUserTab] = await chrome.tabs.query({
        active: true,
        windowId: win.id,
      });
      await chrome.runtime.sendMessage({
        action: "runTarget.promoteToUser",
        userTabId: activeUserTab?.id ?? null,
        userWindowId: win.id ?? null,
      });
    } catch (e) {
      console.warn("[sidepanel] promoteToUser failed:", e);
    }
  }

  async function newChat() {
    setError(null);
    setPinnedPages([]);
    setPageError(null);
    setPendingQueue((prev) => {
      for (const q of prev) {
        for (const a of q.attachments) void deleteAttachmentFile(a);
      }
      return [];
    });
    // Drop any composer-time attachments and unlink their on-disk files —
    // they were tied to the old session and won't be referenced again.
    for (const a of attachments) void deleteAttachmentFile(a);
    setAttachments([]);
    setAttachmentError(null);
    const sid = sessions.activeId;
    const port = portRef.current;
    if (sid && port) {
      try {
        port.postMessage({ type: "abort", sessionId: sid });
      } catch (e) {
        console.warn("[sidepanel] abort post failed:", e);
      }
    }
    await sessions.createNew();
  }

  // Whether the *currently active* tab's URL is already pinned. Drives
  // the visual state of the Pin segment in the composer pill so the user
  // can tell at a glance whether clicking it will pin or unpin.
  const isCurrentPagePinned =
    !!activeTab?.url && pinnedPages.some((p) => p.url === activeTab.url);
  // If the current tab can't be scripted (chrome://, Web Store, etc.) we
  // can detect that synchronously from the URL alone — there's no point
  // letting the user click Pin only to surface the error after a
  // round-trip through `chrome.scripting.executeScript`. Stays `null` for
  // pages we should attempt; otherwise carries the reason we'll show as a
  // tooltip on the disabled Pin button.
  const pageRestrictedReason = getPageRestrictedReason(activeTab?.url);
  // Allow unpinning even on a restricted current page: that operation
  // doesn't touch the page, it just removes a previously-captured
  // snapshot from the in-memory list.
  const pinDisabled =
    pinning || (!!pageRestrictedReason && !isCurrentPagePinned);

  // One handler for both directions:
  //   - If the current tab's URL is already in the pinned list → unpin it.
  //   - Otherwise → snapshot the page (eager capture so the pin survives
  //     navigation / tab close) and append.
  // We capture eagerly rather than just remembering a tab id because the
  // whole point of pinning vs. the live "Page" toggle is to outlive the
  // tab's current state.
  async function toggleCurrentPagePin() {
    if (pinning) return;
    setPageError(null);

    const url = activeTab?.url;
    if (url) {
      const existing = pinnedPages.find((p) => p.url === url);
      if (existing) {
        unpinPage(existing.uiId);
        return;
      }
    }

    setPinning(true);
    try {
      const result = await capturePageContext();
      if (result.kind === "error") {
        setPageError(result.error.error);
        return;
      }
      const ctx = result.page;
      setPinnedPages((prev) => {
        if (prev.some((p) => p.url === ctx.url)) return prev;
        return [...prev, { uiId: shortId("pin"), ...ctx }];
      });
    } finally {
      setPinning(false);
    }
  }

  function unpinPage(uiId: string) {
    setPinnedPages((prev) => prev.filter((p) => p.uiId !== uiId));
  }

  /** × handler on a pending-page chip — just drop the snapshot. */
  function dismissPageChip(opts: { uiId?: string }) {
    if (opts.uiId) {
      setPinnedPages((prev) => prev.filter((p) => p.uiId !== opts.uiId));
    }
  }

  /**
   * Read a batch of files into composer-time `Attachment`s. Used by the
   * file picker, drag-and-drop, and clipboard-paste paths so they share
   * one error-handling pipeline. Errors are concatenated into a single
   * banner string so the user sees one chip-row of bad files instead of
   * a stack of disposable toasts.
   *
   * We materialise the active session id up-front (so Python can group
   * uploads under that id) — adding files implicitly creates a session
   * the same way clicking Send does. Anything unsupported on the agent
   * side is still accepted: identifying / parsing the file is the
   * agent's job, not the picker's.
   */
  async function addFiles(files: File[]) {
    if (files.length === 0) return;
    setAttachmentBusy(true);
    setAttachmentError(null);
    const pendingUiIds: string[] = [];
    try {
      const sessionId = sessions.ready
        ? await sessions.ensureActive()
        : "default";
      const errors: string[] = [];
      const pending: Attachment[] = files.map((f) => ({
        uiId: shortId("att"),
        name: f.name || "file",
        mime: f.type || "",
        size: f.size,
        kind: classify(f.name || "file", (f.type || "").toLowerCase()),
        uploading: true,
      }));
      pendingUiIds.push(...pending.map((p) => p.uiId));
      setAttachments((prev) => [...prev, ...pending]);
      for (let i = 0; i < files.length; i += 1) {
        const f = files[i];
        const uiId = pending[i].uiId;
        const r = await readFileAsAttachment(f, { sessionId, uiId });
        if (isAttachmentReadOk(r)) {
          setAttachments((prev) => {
            if (!prev.some((a) => a.uiId === uiId)) {
              if (r.attachment.path) void deleteAttachmentFile(r.attachment.path);
              return prev;
            }
            return prev.map((a) => (a.uiId === uiId ? r.attachment : a));
          });
        } else {
          errors.push(`${r.name}: ${r.error}`);
          setAttachments((prev) => prev.filter((a) => a.uiId !== uiId));
        }
      }
      if (errors.length > 0) {
        setAttachmentError(errors.join("\n"));
      }
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      setAttachmentError(`附件处理异常：${msg}`);
      setAttachments((prev) => prev.filter((a) => !pendingUiIds.includes(a.uiId)));
    } finally {
      setAttachmentBusy(false);
    }
  }

  function removeAttachment(uiId: string) {
    setAttachments((prev) => {
      const target = prev.find((a) => a.uiId === uiId);
      if (target?.path) {
        // Best-effort delete of the on-disk file — fire-and-forget so
        // the chip drops instantly without waiting on the bridge.
        void deleteAttachmentFile(target);
      }
      return prev.filter((a) => a.uiId !== uiId);
    });
  }

  /**
   * Open a multi-select file picker. Prefer `showOpenFilePicker({ multiple })`
   * so Chromium shows a native multi-file dialog; fall back to a hidden
   * `<input type="file" multiple>` when the API is missing or errors
   * (e.g. some extension contexts). Re-set `value=""` on the fallback
   * input so picking the same file twice still fires `onChange`.
   */
  async function openFilePicker() {
    const w = window as Window & {
      showOpenFilePicker?: (opts?: {
        multiple?: boolean;
      }) => Promise<FileSystemFileHandle[]>;
    };
    if (typeof w.showOpenFilePicker === "function") {
      try {
        const handles = await w.showOpenFilePicker({ multiple: true });
        if (handles.length === 0) return;
        const files = await Promise.all(handles.map((h) => h.getFile()));
        if (files.length > 0) void addFiles(files);
        return;
      } catch (e) {
        if ((e as DOMException)?.name === "AbortError") return;
        console.warn("[sidepanel] showOpenFilePicker failed, using fallback:", e);
      }
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
      fileInputRef.current.click();
    }
  }

  /**
   * Capture pasted images from the clipboard so users can Cmd+V a
   * screenshot straight into the composer. We deliberately don't
   * preventDefault on paste events that contain only text — that would
   * break the normal text-paste behaviour of the textarea.
   */
  async function handleComposerPaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length === 0) return;
    e.preventDefault();
    await addFiles(files);
  }

  // Ask the SW to (re)install the Origin-stripping DNR rule. Useful when
  // the user has just edited the API base URL or is debugging a 403.
  async function refreshCorsRule() {
    try {
      await chrome.runtime.sendMessage({ action: "chatCors.refresh" });
    } catch (e) {
      console.warn("[sidepanel] chatCors.refresh failed:", e);
    }
  }

  // First-run hint: surface the API-key requirement before the user types,
  // so they hit Settings instead of an opaque 401 on send.
  const messages = sessions.activeMessages as UiMessage[];
  const hasActive = !!sessions.activeId;
  const showApiKeyHint =
    !config.apiKey && hasActive && messages.length === 0 && !error;

  return (
    <div className="relative flex h-screen flex-col bg-background text-foreground">
      <TabBar
        tabs={sessions.openTabs}
        activeId={sessions.activeId}
        onActivate={(id) => void sessions.switchToTab(id)}
        onClose={(id) => void sessions.closeTab(id)}
        onCloseMany={(ids) => void sessions.closeTabs(ids)}
        onNew={() => void newChat()}
        onOpenHistory={() => setHistoryOpen(true)}
        onOpenSettings={() => chrome.runtime.openOptionsPage()}
      />

      {/*
        `pt-2` reserves a fixed 8px strip of `bg-background` between the
        TabBar and the scrollable chat area. Because the gap lives OUTSIDE
        the ScrollArea it never scrolls, so a sticky user bubble (which
        pins to the ScrollArea's viewport top) lands a few pixels below
        the tabs instead of butting up against them.
      */}
      <div
        className="relative min-w-0 flex-1 overflow-hidden pt-2"
        ref={scrollRef}
      >
        {hasActive && messages.length === 0 ? (
          // Borderless empty-conversation hint, anchored to a stable
          // viewport-relative offset rather than `justify-center`. The
          // chat area is `flex-1`, so centring against it would cause
          // the content to creep upward whenever the composer grew
          // (chip row, error banners, …) — the chat area shrinks to
          // compensate, and `justify-center` follows the new midpoint.
          // The chat area's TOP edge is stable (it sits right under the
          // TabBar), so `absolute top-[40vh] -translate-y-1/2` pins the
          // hint at a fixed point regardless of footer height. We skip
          // the ScrollArea entirely here because there is nothing to
          // scroll; companion blocks (api-key warning, first-request
          // error) stack in the same centred column so the layout stays
          // cohesive.
          <div className="absolute inset-x-0 top-[40vh] flex -translate-y-1/2 flex-col items-center gap-3 px-6 text-center text-xs text-muted-foreground">
            <HermesLogo size={72} />
            <p className="max-w-[28ch] leading-relaxed">
              Ask Hermes anything. Messages stay on this device; history
              persists in extension storage.
            </p>
            {showApiKeyHint && (
              <div className="w-full max-w-sm rounded-md border border-warning/40 bg-warning/10 p-3 text-left text-xs text-foreground">
                <div className="mb-1 font-semibold">API key not set</div>
                <p className="text-muted-foreground">
                  If your gateway has <code>API_SERVER_KEY</code> configured in{" "}
                  <code>~/.hermes/.env</code>, paste the same value into
                  Settings → API key. Otherwise the gateway will reject
                  requests with HTTP 401.
                </p>
                <button
                  onClick={() => chrome.runtime.openOptionsPage()}
                  className="mt-2 inline-flex items-center gap-1 rounded border border-foreground/20 px-2 py-1 text-[11px] uppercase tracking-wider hover:bg-foreground/10"
                >
                  Open Settings
                </button>
              </div>
            )}
            {error && (
              <ErrorBlock
                error={error}
                onOpenSettings={() => chrome.runtime.openOptionsPage()}
                onRefreshCors={() => void refreshCorsRule()}
              />
            )}
          </div>
        ) : (
          <ScrollArea className="h-full min-w-0">
            <div className="min-w-0 space-y-2 p-3">
              {!hasActive ? (
                <EmptyState
                  onNew={() => void newChat()}
                  onOpenHistory={() => setHistoryOpen(true)}
                  hasHistory={sessions.sessions.length > 0}
                />
              ) : (
                <MessageTurns
                  messages={messages}
                  showStreamDetails={showStreamDetails}
                />
              )}

              {error && (
                <ErrorBlock
                  error={error}
                  onOpenSettings={() => chrome.runtime.openOptionsPage()}
                  onRefreshCors={() => void refreshCorsRule()}
                />
              )}
            </div>
          </ScrollArea>
        )}
      </div>

      <footer className="p-2">
        {/*
          BridgeStatusBar is the steady-state replacement for the legacy
          toolbar popup AND the catch-all surface for transient
          warnings (page-capture failure, attachment upload error,
          etc.). Anything new the panel needs to tell the user
          should land here as a `BridgeStatusMessage` rather than a
          fresh banner row above the composer.
        */}
        <BridgeStatusBar
          messages={[
            ...(pageError
              ? [
                  {
                    id: "page-error",
                    level: "warning" as const,
                    text: pageError,
                    onDismiss: () => setPageError(null),
                  },
                ]
              : []),
            ...(attachmentError
              ? [
                  {
                    id: "attachment-error",
                    level: "warning" as const,
                    text: attachmentError,
                    onDismiss: () => setAttachmentError(null),
                  },
                ]
              : []),
          ]}
          afterConnection={
            <div className="flex shrink-0 flex-wrap items-center gap-1">
              {!learnRecording ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-6 gap-1 px-2 text-[11px]"
                  disabled={attachmentUploading}
                  title="在活动标签页记录点击与输入；结束后将轨迹 JSON 附加到对话，提示词由你自行编写"
                  onClick={() => void startLearnFromPanel()}
                >
                  <Disc className="h-3 w-3 shrink-0" />
                  记录操作
                </Button>
              ) : (
                <>
                  <span className="max-w-[10rem] truncate text-[11px] text-muted-foreground">
                    录制中 · {learnEventCount} 步
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    disabled={learnStopBusy || attachmentUploading}
                    onClick={() => void stopLearnToComposer()}
                  >
                    {learnStopBusy ? "处理中…" : "结束并附加"}
                  </Button>
                </>
              )}
            </div>
          }
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple={true}
          accept={ATTACHMENT_INPUT_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const list = e.target.files;
            if (!list || list.length === 0) return;
            const files = Array.from(list);
            void addFiles(files);
          }}
        />
        {/*
          Cursor-style composer: optional queued turns render in a slim strip
          *above* the bordered box (popup stack). The textarea + action row
          stay inside the rounded frame; focus-within still targets that box.
        */}
        <div
          className={cn(
            "relative flex w-full flex-col",
            dragOver && "rounded-lg ring-2 ring-primary/30",
          )}
          onDragOver={(e) => {
            if (
              e.dataTransfer &&
              Array.from(e.dataTransfer.types || []).includes("Files")
            ) {
              e.preventDefault();
              if (!dragOver) setDragOver(true);
            }
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            setDragOver(false);
          }}
          onDrop={(e) => {
            if (
              !e.dataTransfer ||
              !Array.from(e.dataTransfer.types || []).includes("Files")
            ) {
              return;
            }
            e.preventDefault();
            setDragOver(false);
            const files = Array.from(e.dataTransfer.files || []);
            if (files.length > 0) void addFiles(files);
          }}
        >
          {pendingQueue.length > 0 && (
            <div
              className={cn(
                "relative z-[1] overflow-hidden rounded-t-lg border border-input border-b-0 bg-muted/50 shadow-[0_-2px_10px_-2px_rgba(0,0,0,0.12)] dark:bg-muted/35 dark:shadow-[0_-2px_14px_-2px_rgba(0,0,0,0.45)]",
                dragOver && "border-primary/50",
              )}
            >
              <ul className="max-h-[7rem] divide-y divide-border/60 overflow-y-auto">
                {pendingQueue.map((item) => (
                  <li
                    key={item.queueId}
                    className="flex items-start gap-1.5 py-1.5 pl-2.5 pr-1"
                  >
                    <p className="min-w-0 flex-1 truncate text-[12px] leading-snug text-foreground/90">
                      {previewPendingTurn(item)}
                    </p>
                    <button
                      type="button"
                      onClick={() => removePendingQueueItem(item.queueId)}
                      className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                      title="从队列移除"
                      aria-label="从队列移除"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        <div
          className={cn(
            "relative flex flex-col rounded-lg border border-input bg-background shadow-sm transition-colors focus-within:border-ring/60",
            pendingQueue.length > 0 && "rounded-t-none",
          )}
        >
          {(() => {
            // The live current chip is suppressed when:
            // The pending-page list is now strictly opt-in (click Pin to add
            // a one-shot snapshot of the current tab). No more "live current
            // tab" chip — the agent reads the user's tab on demand via
            // my_browser_active_tab.
            const anyChips =
              pinnedPages.length > 0 || attachments.length > 0;
            if (!anyChips) return null;
            return (
              <div className="flex flex-wrap items-center gap-1 border-b border-border/50 px-2 py-1.5">
                {pinnedPages.map((p) => (
                  <PageChip
                    key={p.uiId}
                    title={p.title}
                    url={p.url}
                    favIconUrl={p.favicon}
                    onRemove={() => dismissPageChip({ uiId: p.uiId })}
                  />
                ))}
                {attachments.map((a) => (
                  <AttachmentChip
                    key={a.uiId}
                    attachment={a}
                    onRemove={() => removeAttachment(a.uiId)}
                  />
                ))}
              </div>
            );
          })()}
          <Textarea
            ref={composerTextareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              attachmentUploading
                ? "等待附件上传完成…"
                : attachments.length > 0
                  ? "Add a question about your file(s)…"
                  : pinnedPages.length > 0
                    ? "Ask about the attached page(s)…"
                    : "Message Hermes…"
            }
            rows={2}
            style={{ maxHeight: COMPOSER_TEXTAREA_MAX_PX }}
            className="min-h-9 resize-none overflow-hidden border-0 bg-transparent px-3 py-2 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            onPaste={handleComposerPaste}
            onKeyDown={(e) => {
              // Ignore Enter while an IME (e.g. Chinese) is composing — the
              // user may press Enter to commit Latin/pinyin, not to send.
              const ne = e.nativeEvent;
              if (ne.isComposing || e.key === "Process") {
                return;
              }
              if (
                (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ||
                (e.key === "Enter" && !e.shiftKey && !e.altKey)
              ) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="flex items-center justify-between gap-2 px-2 pb-2">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-muted-foreground">
              {busy &&
                (navigateOpenPolicy === "auto" ||
                  navigateOpenPolicy === "agent") && (
                  // Mid-run handoff affordances for the agent window. The
                  // "running" signal itself lives on individual tool chips
                  // (amber + breathing dot) and the bubble caret, so a
                  // separate global spinner + "Open: …" status would just
                  // duplicate state the user can already see in the bubble.
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void showAgentWindow()}
                      className="h-5 px-1.5 text-[10px]"
                      title="Bring the agent's background window forward"
                    >
                      Show window
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void moveToMyTab()}
                      className="h-5 px-1.5 text-[10px]"
                      title="Switch to Same tab + bring the agent's current URL with you"
                    >
                      Move to my tab
                    </Button>
                  </div>
                )}
              <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => void openFilePicker()}
                disabled={attachmentBusy || attachmentUploading}
                title="附加文件（可多选）· Attach files"
                aria-label="Attach files"
                className={cn(
                  "inline-flex h-6 w-6 items-center justify-center rounded-full border border-border bg-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  (attachmentBusy || attachmentUploading) &&
                    "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted-foreground",
                )}
              >
                <Paperclip className="h-3 w-3" />
              </button>
              {/*
                Pin: attach the user's current tab as a one-shot snapshot for
                the next message. Cleared after send (the agent reads live
                pages on demand via `my_browser_active_tab` / `read_tab`).
                Re-clicking before send toggles the pin off.
              */}
              <button
                type="button"
                onClick={() => void toggleCurrentPagePin()}
                disabled={pinDisabled}
                aria-pressed={isCurrentPagePinned}
                aria-label={
                  isCurrentPagePinned
                    ? "Unpin current page"
                    : "Attach current page to next message"
                }
                title={
                  pageRestrictedReason && !isCurrentPagePinned
                    ? pageRestrictedReason
                    : isCurrentPagePinned
                      ? "Detach this page from the next message"
                      : "Attach the current page to the next message (one-shot snapshot)"
                }
                className={cn(
                  "inline-flex h-6 cursor-pointer select-none items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  isCurrentPagePinned
                    ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90"
                    : "border-border bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  pinDisabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
                )}
              >
                <Pin
                  className="h-3 w-3"
                  fill={isCurrentPagePinned ? "currentColor" : "none"}
                />
                <span>Pin</span>
              </button>
              <NavigateOpenPolicyToggle
                policy={navigateOpenPolicy}
                onChange={(next) => void handleNavigateOpenPolicyChange(next)}
              />
              <div
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border/80 bg-muted/30 px-2 py-0.5"
                title="在助手气泡中展示流式工具调用与推理片段（需模型返回相应字段）"
              >
                <Switch
                  id="hermes-show-stream-details"
                  checked={showStreamDetails}
                  onCheckedChange={setShowStreamDetails}
                  className="h-4 w-7 [&>span]:h-3 [&>span]:w-3 [&>span]:data-[state=checked]:translate-x-3"
                />
                <Label
                  htmlFor="hermes-show-stream-details"
                  className="cursor-pointer whitespace-nowrap text-[10px] font-medium text-muted-foreground"
                >
                  展示
                </Label>
              </div>
              </div>
            </div>
            {busy ? (
              composerHasSendablePayload ? (
                <Button
                  size="icon"
                  onClick={() => void send()}
                  disabled={attachmentUploading || attachmentBusy}
                  title="加入队列，本轮结束后发送"
                  className="h-6 w-6 shrink-0 rounded-full [&_svg]:size-3"
                >
                  <ArrowUp strokeWidth={3} />
                </Button>
              ) : (
                <Button
                  type="button"
                  size="icon"
                  onClick={stop}
                  title="停止生成"
                  aria-label="停止生成"
                  className="h-6 w-6 shrink-0 rounded-full"
                >
                  <span
                    aria-hidden
                    className="block h-2 w-2 rounded-[1.5px] bg-current"
                  />
                </Button>
              )
            ) : (
              <Button
                size="icon"
                onClick={() => void send()}
                disabled={
                  (!input.trim() &&
                    !attachments.some((a) => a.path && !a.uploading)) ||
                  attachmentUploading ||
                  attachmentBusy
                }
                title="Send (⌘/Ctrl+Enter)"
                className="h-6 w-6 shrink-0 rounded-full [&_svg]:size-3"
              >
                <ArrowUp strokeWidth={3} />
              </Button>
            )}
          </div>
        </div>
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-[8] flex items-center justify-center rounded-lg bg-primary/5 text-[12px] font-medium text-primary">
            Drop files to attach
          </div>
        )}
        </div>
      </footer>

      <SessionDrawer
        open={historyOpen}
        sessions={sessions.sessions}
        openTabIds={sessions.openTabIds}
        activeId={sessions.activeId}
        onClose={() => setHistoryOpen(false)}
        onOpen={(id) => void sessions.openTab(id)}
        onRename={(id, title) => void sessions.rename(id, title)}
        onDelete={(id) => void sessions.remove(id)}
      />
    </div>
  );
}

interface EmptyStateProps {
  onNew: () => void;
  onOpenHistory: () => void;
  hasHistory: boolean;
}

function EmptyState({ onNew, onOpenHistory, hasHistory }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 px-6 py-12 text-center">
      <HermesLogo size={112} />
      <div className="space-y-1">
        <p className="text-sm font-medium">No conversation open</p>
        <p className="text-xs text-muted-foreground">
          {hasHistory
            ? "Start a new chat or pick one up from History."
            : "Start your first chat with Hermes."}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Button onClick={onNew}>
          <Plus className="mr-1" />
          New chat
        </Button>
        {hasHistory && (
          <Button variant="outline" onClick={onOpenHistory}>
            <History className="mr-1" />
            Open from History
          </Button>
        )}
      </div>
    </div>
  );
}

interface ErrorBlockProps {
  error: ChatError;
  onOpenSettings: () => void;
  onRefreshCors: () => void;
}

function ErrorBlock({ error, onOpenSettings, onRefreshCors }: ErrorBlockProps) {
  return (
    <div className="w-full max-w-sm rounded-md border border-destructive/50 bg-destructive/10 p-3 text-left text-xs text-destructive">
      <div className="break-all font-mono">{error.message}</div>
      {error.hint && (
        <pre className="mt-2 whitespace-pre-wrap break-words text-foreground/90">
          {error.hint}
        </pre>
      )}
      <div className="mt-2 flex gap-2">
        <button
          onClick={onOpenSettings}
          className="inline-flex items-center gap-1 rounded border border-foreground/20 px-2 py-0.5 text-[10px] uppercase tracking-wider text-foreground hover:bg-foreground/10"
        >
          Settings
        </button>
        <button
          onClick={onRefreshCors}
          className="inline-flex items-center gap-1 rounded border border-foreground/20 px-2 py-0.5 text-[10px] uppercase tracking-wider text-foreground hover:bg-foreground/10"
          title="Re-install the Origin-stripping rule"
        >
          Reset CORS rule
        </button>
      </div>
    </div>
  );
}

interface AgentDestinationChipProps {
  url: string;
  title?: string;
}

/**
 * "Open in my browser →" chip stamped onto a finished assistant bubble
 * for runs that happened on the agent surface. Closes the loop on the
 * delegate-and-forget pattern: user asks Hermes to go look something
 * up, lets it run in the background, gets the answer, and *then*
 * decides "I want to see this myself" without re-issuing the URL.
 *
 * Click handler opens the URL in a fresh user-side tab and brings that
 * window forward — picking the user's last-focused window so we don't
 * accidentally pop a tab inside the agent window.
 */
function AgentDestinationChip({ url, title }: AgentDestinationChipProps) {
  const display = title || hostnameOf(url) || url;
  async function open() {
    try {
      // Prefer the user's own window — `chrome.windows.getCurrent()`
      // returns the window the side panel is docked to, which by
      // construction is a normal user window (the agent window doesn't
      // host the panel). Falling back to a default `tabs.create` would
      // still work but might land in the wrong window if focus has
      // since shifted to the agent's.
      const win = await chrome.windows.getCurrent();
      await chrome.tabs.create({ url, active: true, windowId: win.id });
      try {
        if (win.id !== undefined) {
          await chrome.windows.update(win.id, { focused: true });
        }
      } catch {
        // Best effort.
      }
    } catch {
      try {
        await chrome.tabs.create({ url, active: true });
      } catch (e) {
        console.warn("[sidepanel] open in browser failed:", e);
      }
    }
  }
  return (
    <button
      type="button"
      onClick={() => void open()}
      title={`Open ${display} in your browser`}
      className="mt-2 inline-flex max-w-full items-center gap-1 rounded-full border border-border/60 bg-background/70 px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
    >
      <ExternalLink className="h-2.5 w-2.5 shrink-0" />
      <span className="truncate">{display}</span>
    </button>
  );
}

interface PageChipProps {
  title?: string;
  url?: string;
  favIconUrl?: string;
  /** A "live" chip is the auto-tracked current tab; styled with a dashed
   * border to telegraph that its target updates as the user switches
   * tabs. Pinned chips render solid and own a remove (×) action. */
  live?: boolean;
  onRemove?: () => void;
}

function PageChip({
  title,
  url,
  favIconUrl,
  live,
  onRemove,
}: PageChipProps) {
  const host = hostnameOf(url);
  const display = title || host || "page";
  return (
    <div
      className={cn(
        "inline-flex max-w-[180px] items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px]",
        live
          ? "border-dashed border-primary/50 bg-primary/5 text-foreground/80"
          : "border-border bg-muted/40 text-muted-foreground",
      )}
      title={url ? `${display}\n${url}` : display}
    >
      {favIconUrl ? (
        <img
          src={favIconUrl}
          alt=""
          className="h-3 w-3 shrink-0 rounded-sm"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      ) : (
        <Globe className="h-3 w-3 shrink-0" />
      )}
      <span className="truncate">{display}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="-mr-0.5 ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
          title="Remove"
          aria-label="Remove attached page"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </div>
  );
}

interface AttachmentChipProps {
  attachment: Attachment;
  onRemove: () => void;
}

/**
 * Compose-time chip for an uploaded file. Image attachments show a 20px
 * thumbnail (the full file is on disk; the chip just needs *something*
 * recognisable); text/pdf/binary attachments show a kind-appropriate icon
 * plus the filename. Hovering reveals the full path so the user can tell
 * where the file landed.
 */
function AttachmentChip({ attachment, onRemove }: AttachmentChipProps) {
  const sizeLabel = formatBytesShort(attachment.size);
  const titleLines: string[] = [];
  if (attachment.uploading) titleLines.push("上传中…");
  titleLines.push(attachment.name);
  titleLines.push(`${attachment.kind} • ${sizeLabel}`);
  if (attachment.mime) titleLines.push(attachment.mime);
  if (attachment.path) titleLines.push(attachment.path);
  if (attachment.fromPageContext && attachment.sourceUrl) {
    titleLines.push(`from ${attachment.sourceUrl}`);
  }
  if (attachment.textPreview) {
    titleLines.push("");
    titleLines.push(attachment.textPreview);
  }
  return (
    <div
      className="group inline-flex h-6 max-w-[220px] items-center gap-1 rounded-full border border-border bg-muted/40 pl-0.5 pr-1 text-[11px] text-muted-foreground"
      title={titleLines.join("\n")}
      aria-busy={attachment.uploading || undefined}
    >
      {attachment.uploading ? (
        <span className="ml-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted/60">
          <Loader2
            className="h-3.5 w-3.5 animate-spin text-foreground"
            aria-label="上传中"
          />
        </span>
      ) : attachment.kind === "image" && attachment.thumbDataUrl ? (
        <img
          src={attachment.thumbDataUrl}
          alt=""
          className="h-5 w-5 shrink-0 rounded-full object-cover"
        />
      ) : (
        <span className="ml-1 inline-flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
          <KindIcon kind={attachment.kind} className="h-3 w-3" />
        </span>
      )}
      <span className="truncate">
        {attachment.uploading ? "上传中 · " : ""}
        {attachment.name}
      </span>
      {attachment.fromPageContext && (
        <span
          className="ml-0.5 rounded-sm bg-foreground/10 px-1 text-[9px] uppercase tracking-wide text-muted-foreground"
          title={`Auto-attached from ${attachment.sourceUrl ?? "current tab"}`}
        >
          page
        </span>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="-mr-0.5 ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
        title="Remove"
        aria-label={`Remove ${attachment.name}`}
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </div>
  );
}

interface KindIconProps {
  kind: AttachmentKind;
  className?: string;
}

/**
 * Single-source-of-truth icon picker for an attachment kind. Used by both
 * the live chip and the persisted-on-bubble badge so they stay visually
 * consistent.
 */
function KindIcon({ kind, className }: KindIconProps) {
  switch (kind) {
    case "image":
      return <ImageIcon className={className} />;
    case "text":
      return <FileText className={className} />;
    case "pdf":
    case "binary":
    default:
      return <FileIcon className={className} />;
  }
}

interface AttachmentBadgeViewProps {
  badge: AttachmentBadge;
}

/**
 * Persisted-on-bubble view of one attachment. Image badges render their
 * downscaled thumbnail; everything else renders a chip mirroring the
 * `pageBadges` styling so the user-bubble footer reads as one cohesive
 * "what was attached to this turn" row.
 */
function AttachmentBadgeView({ badge }: AttachmentBadgeViewProps) {
  const titleLines: string[] = [
    badge.name,
    `${badge.kind} • ${formatBytesShort(badge.size)}`,
  ];
  if (badge.mime) titleLines.push(badge.mime);
  if (badge.path) titleLines.push(badge.path);
  if (badge.fromPageContext && badge.sourceUrl) {
    titleLines.push(`from ${badge.sourceUrl}`);
  }
  const title = titleLines.join("\n");

  if (badge.kind === "image") {
    if (badge.thumbDataUrl) {
      return (
        <img
          src={badge.thumbDataUrl}
          alt={badge.name}
          title={title}
          className="h-12 w-12 rounded-md border border-border object-cover"
        />
      );
    }
    return (
      <div
        className="inline-flex h-12 w-12 items-center justify-center rounded-md border border-border bg-muted/40 text-muted-foreground"
        title={title}
      >
        <ImageIcon className="h-4 w-4" />
      </div>
    );
  }
  return (
    <div
      // Background uses `--background` (instead of `--muted`, which equals
      // `--secondary` in the current palette) so the chip stays visible when
      // it sits inside the user-message card whose surface is `bg-secondary`.
      className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/60 bg-background/70 px-2 py-0.5 text-[10px] text-muted-foreground"
      title={title}
    >
      <KindIcon kind={badge.kind} className="h-2.5 w-2.5 shrink-0" />
      <span className="truncate">{badge.name}</span>
      {badge.fromPageContext && (
        <span
          className="rounded-sm bg-foreground/10 px-1 text-[8px] uppercase tracking-wide"
          title={
            badge.sourceUrl
              ? `Auto-attached from ${badge.sourceUrl}`
              : "Auto-attached from a tab"
          }
        >
          page
        </span>
      )}
    </div>
  );
}

// Streamdown assumes string children; its code path uses `.length` / `.split`
// on the markdown source. Persisted sessions or edge cases may still surface
// null or non-string `content`, which would otherwise crash inside Streamdown.
function bubbleTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  return String(content);
}

// Group the flat message list into "turns" (one user message + the assistant
// replies that follow it, up to the next user message) and pin each user
// bubble to the top of the scroll viewport via `position: sticky`. While the
// reader is scrolling through a long assistant reply, the originating user
// question stays visible at the top — Cursor-style — so the context of the
// reply is never lost. Sticky elements are bounded by their parent, so once
// the next turn enters view its own user bubble takes over the pin without
// any JS / scroll-listener gymnastics.
function MessageTurns({
  messages,
  showStreamDetails,
}: {
  messages: UiMessage[];
  showStreamDetails: boolean;
}) {
  type Turn = { user: UiMessage | null; replies: UiMessage[] };
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const m of messages) {
    if (m.role === "user") {
      cur = { user: m, replies: [] };
      turns.push(cur);
    } else if (cur) {
      cur.replies.push(m);
    } else {
      // Pre-conversation entries (e.g. an orphan system message) get their
      // own group with no sticky lead so layout stays consistent.
      cur = { user: null, replies: [m] };
      turns.push(cur);
    }
  }
  return (
    <>
      {turns.map((turn, i) => (
        <div
          key={turn.user?.uiId ?? `turn-${i}`}
          className="space-y-2"
        >
          {turn.user && (
            // The strip extends edge-to-edge via `-mx-3` (cancelling the
            // parent's `p-3` horizontal padding) so the opaque background
            // fully covers any assistant content scrolling underneath when
            // the bubble is pinned — no blur / translucency, just a hard
            // mask. We bump z-index above Streamdown's in-bubble code-block
            // toolbar (`z-10`) so the pinned question always wins the
            // stacking contest while scrolling through long replies.
            <div className="sticky top-0 z-20 -mx-3 bg-background px-3 pb-1">
              <Bubble m={turn.user} />
            </div>
          )}
          {turn.replies.map((m) => (
            <Bubble key={m.uiId} m={m} showStreamDetails={showStreamDetails} />
          ))}
        </div>
      ))}
    </>
  );
}

/**
 * One tool-progress chip. Click toggles its own details panel. Running
 * chips get an amber treatment + a breathing dot in place of the emoji
 * so the live state is visible without a separate label.
 */
function ToolChip({ event }: { event: HermesToolProgress }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail =
    !!event.label &&
    event.label.trim() !== "" &&
    event.label.trim() !== event.tool;
  const running = event.status === "running";
  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={!hasDetail}
        onClick={() => hasDetail && setExpanded((v) => !v)}
        className={cn(
          "inline-flex max-w-full items-center gap-1.5 rounded-md border px-1.5 py-0.5 font-mono text-[10.5px] leading-none transition-colors",
          running
            ? "border-amber-400/60 bg-amber-50/70 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
            : hasDetail
              ? expanded
                ? "border-border bg-muted text-foreground"
                : "cursor-pointer border-border/60 bg-muted/30 text-foreground/75 hover:bg-muted/60"
              : "cursor-default border-border/40 bg-muted/20 text-foreground/55",
        )}
        title={
          running
            ? `${event.tool} — running…`
            : hasDetail
              ? "Click to view details"
              : event.tool
        }
      >
        {running && (
          <span aria-hidden className="hermes-thinking-dot shrink-0" />
        )}
        {!running && event.emoji && (
          <span aria-hidden className="leading-none">
            {event.emoji}
          </span>
        )}
        <span>{event.tool}</span>
      </button>
      {expanded && hasDetail && (
        <div className="w-full rounded-md border border-border/50 bg-muted/25 px-2 py-1.5">
          <pre className="whitespace-pre-wrap break-all font-mono text-[10.5px] leading-snug text-muted-foreground">
            {event.label}
          </pre>
        </div>
      )}
    </div>
  );
}

/** Legacy stack-of-chips renderer used for old messages without a timeline. */
function ToolProgressChips({ events }: { events: HermesToolProgress[] }) {
  return (
    <div className="flex flex-col items-start gap-1">
      {events.map((ev) => (
        <ToolChip key={ev.toolCallId} event={ev} />
      ))}
    </div>
  );
}

function Bubble({
  m,
  showStreamDetails = false,
}: {
  m: UiMessage;
  showStreamDetails?: boolean;
}) {
  if (m.role === "user") {
    const bodyText = bubbleTextContent(m.content);
    // Prefer the new plural `pageBadges`. Fall back to the single legacy
    // `pageBadge` so messages saved by older builds still render their
    // attachment chip.
    const pageBadges =
      m.pageBadges && m.pageBadges.length > 0
        ? m.pageBadges
        : m.pageBadge
          ? [m.pageBadge]
          : [];
    const fileBadges = m.attachmentBadges ?? [];
    const imageFileBadges = fileBadges.filter((b) => b.kind === "image");
    const textFileBadges = fileBadges.filter((b) => b.kind === "text");
    const hasReferences =
      pageBadges.length > 0 ||
      imageFileBadges.length > 0 ||
      textFileBadges.length > 0;
    const hasContent = bodyText.length > 0;
    // Cursor-style user message: a single full-width rounded card. References
    // (page snapshots, text/image attachments) live INSIDE the card at the top
    // so the question + everything it pulls in always reads as one unit, even
    // when the bubble is pinned via the parent's sticky wrapper. Order: image
    // thumbnails first (most visually distinctive), then page chips, then text
    // file chips. They wrap freely on narrow widths.
    return (
      <div className="min-w-0 rounded-xl border border-border/60 bg-secondary px-4 py-3 text-sm text-secondary-foreground">
        {hasReferences && (
          <div
            className={cn(
              "flex flex-wrap items-center gap-1.5",
              hasContent && "mb-2",
            )}
          >
            {imageFileBadges.map((b) => (
              <AttachmentBadgeView key={b.uiId} badge={b} />
            ))}
            {pageBadges.map((b, i) => (
              <div
                key={`page-${b.url}-${i}`}
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/60 bg-background/70 px-2 py-0.5 text-[10px] text-muted-foreground"
                title={b.url}
              >
                <Globe className="h-2.5 w-2.5 shrink-0" />
                <span className="truncate">
                  {b.title || hostnameOf(b.url) || b.url}
                </span>
              </div>
            ))}
            {textFileBadges.map((b) => (
              <AttachmentBadgeView key={b.uiId} badge={b} />
            ))}
          </div>
        )}
        {hasContent && (
          <div className="whitespace-pre-wrap break-words">{bodyText}</div>
        )}
      </div>
    );
  }
  if (m.role === "assistant") {
    const bodyText = bubbleTextContent(m.content);
    const verboseText = bubbleTextContent(m.streamVerbose);
    const toolProgress = m.hermesToolProgress ?? [];
    const timeline = m.assistantTimeline ?? [];
    const hasTimeline = showStreamDetails && timeline.length > 0;
    const hasReasoningBlock =
      showStreamDetails && verboseText.trim().length > 0;
    const hasLegacyToolList =
      showStreamDetails && !hasTimeline && toolProgress.length > 0;
    const hasVerboseBlock =
      hasReasoningBlock || hasLegacyToolList || hasTimeline;
    // While the request is in flight but no token has arrived yet, the bubble
    // would otherwise be just Streamdown's bare ● caret on an empty line —
    // which reads as a stray glyph rather than a status. Replace that with an
    // explicit "Thinking…" placeholder + breathing dot until content streams
    // in — unless we're already showing a verbose (tools / reasoning) block.
    const isEmptyStreaming =
      !!m.streaming && bodyText.trim() === "" && !hasVerboseBlock;
    if (isEmptyStreaming) {
      return (
        <div className="px-1 py-1 text-sm" aria-live="polite">
          <div className="inline-flex items-center gap-2 text-muted-foreground">
            <span className="hermes-thinking-dot" aria-hidden="true" />
            <span>Thinking…</span>
          </div>
        </div>
      );
    }
    // Only show "Generating answer…" when there's no other live signal:
    // a running tool chip already communicates "agent is working", so the
    // separate label would just be noise. Once every chip has flipped to
    // completed AND no tokens have arrived yet, the agent is back in the
    // model and we want the explicit "Generating answer…" hint.
    const hasRunningTool = toolProgress.some((e) => e.status === "running");
    // In timeline mode the answer text is already woven through the timeline,
    // so "Generating answer…" only makes sense when we're rendering the
    // legacy (chips-on-top, text-on-bottom) layout.
    const awaitingAnswerOnly =
      !!m.streaming &&
      bodyText.trim() === "" &&
      hasVerboseBlock &&
      !hasRunningTool &&
      !hasTimeline;
    const progressMap = new Map(
      toolProgress.map((p) => [p.toolCallId, p] as const),
    );
    return (
      <div className="min-w-0 px-1 py-1 text-sm">
        {hasReasoningBlock && (
          <Streamdown
            mode={m.streaming ? "streaming" : "static"}
            parseIncompleteMarkdown
            caret="circle"
            isAnimating={!!m.streaming}
            className="chat-md mb-2 break-words text-xs text-muted-foreground/80"
          >
            {verboseText}
          </Streamdown>
        )}
        {hasLegacyToolList && (
          <div className="mb-2">
            <ToolProgressChips events={toolProgress} />
            {awaitingAnswerOnly && (
              <div className="mt-1.5 inline-flex items-center gap-2 text-[11px] text-muted-foreground">
                <span className="hermes-thinking-dot" aria-hidden="true" />
                <span>Generating answer…</span>
              </div>
            )}
          </div>
        )}
        {hasTimeline ? (
          (() => {
            // Only the very last text item can still be receiving tokens —
            // earlier text items were closed off when a tool call landed
            // after them. Marking those earlier items as `isAnimating`
            // leaves a stray caret on every paragraph the agent ever
            // spoke, which reads as "still generating" forever.
            let lastTextId: string | null = null;
            for (let i = timeline.length - 1; i >= 0; i--) {
              const it = timeline[i];
              if (it.kind === "text") {
                lastTextId = it.id;
                break;
              }
            }
            return (
              <div className="flex flex-col gap-2">
                {timeline.map((item) => {
                  if (item.kind === "text") {
                    if (!item.text.trim()) return null;
                    const isLive =
                      !!m.streaming && item.id === lastTextId;
                    return (
                      <Streamdown
                        key={item.id}
                        mode={isLive ? "streaming" : "static"}
                        parseIncompleteMarkdown
                        caret="circle"
                        isAnimating={isLive}
                        className="chat-md break-words"
                      >
                        {item.text}
                      </Streamdown>
                    );
                  }
                  const ev = progressMap.get(item.toolCallId);
                  if (!ev) return null;
                  return <ToolChip key={item.id} event={ev} />;
                })}
              </div>
            );
          })()
        ) : (
          bodyText.trim().length > 0 && (
            <Streamdown
              mode="streaming"
              parseIncompleteMarkdown
              caret="circle"
              isAnimating={!!m.streaming}
              className="chat-md break-words"
            >
              {bodyText}
            </Streamdown>
          )
        )}
        {/*
          Persist-to-bubble teleport chip for delegate-and-forget runs.
          Stamped on the message after the stream resolves (see send()),
          so it survives panel reloads and history navigation. We only
          render once streaming is done — flashing the chip while tokens
          are still arriving would imply the URL is final when it might
          not be (the agent could still navigate again).
        */}
        {!m.streaming && m.agentFinalUrl && (
          <AgentDestinationChip
            url={m.agentFinalUrl}
            title={m.agentFinalTitle}
          />
        )}
      </div>
    );
  }
  return (
    <div className="mx-3 rounded-md bg-muted/50 p-2 font-mono text-xs">
      [{m.role}] {bubbleTextContent(m.content)}
    </div>
  );
}
