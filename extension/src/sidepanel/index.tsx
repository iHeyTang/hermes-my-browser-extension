import {
  ArrowUp,
  Bot,
  ExternalLink,
  File as FileIcon,
  FileText,
  Globe,
  History,
  ImageIcon,
  MousePointerClick,
  Paperclip,
  Pin,
  Plus,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";

import "~style.css";

import { Button } from "~components/ui/button";
import { HermesLogo } from "~components/hermes-logo";
import { ScrollArea } from "~components/ui/scroll-area";
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
  readFileAsAttachment,
} from "~lib/attachments/read";
import { formatFileAttachmentsForPrompt } from "~lib/attachments/format";
import type {
  Attachment,
  AttachmentBadge,
  AttachmentKind,
} from "~lib/attachments/types";
import { HermesHttpError, streamChat } from "~lib/chat/hermes-client";
import {
  capturePageContext,
  formatPageContextsForPrompt,
  getPageRestrictedReason,
  type PageContext,
} from "~lib/page-context/capture";
import {
  hostnameOf,
  useActiveTab,
} from "~lib/page-context/use-active-tab";
import { useSessions } from "~lib/sessions/use-sessions";
import { useResolvedTheme } from "~lib/theme";
import type { ChatMessage, RunTarget } from "~lib/types";
import { cn, shortId } from "~lib/utils";

import { BridgeStatusBar } from "./BridgeStatusBar";
import { RunModeToggle } from "./RunModeToggle";
import { SessionDrawer } from "./SessionDrawer";
import { TabBar } from "./TabBar";

const SETTINGS_KEYS = {
  apiBase: "settings.chat.apiBase",
  apiKey: "settings.chat.apiKey",
  model: "settings.chat.model",
  pageMode: "settings.sidepanel.pageMode",
  // Sticky default for the run-mode toggle. The override (one-shot
  // change for the next send) lives in component state only — by
  // design, persisting it would defeat the "resets after send" promise.
  runModeDefault: "settings.sidepanel.runModeDefault",
};

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
   * populated for turns that ran in agent or mirror mode (user-mode
   * turns already happened in the user's tab; offering to "open" is
   * redundant). Stored as plain strings so the chip survives panel
   * reloads and history navigation.
   */
  agentFinalUrl?: string;
  agentFinalTitle?: string;
}

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

interface ChatError {
  message: string;
  hint?: string;
}

export default function SidePanel() {
  // The side panel sits next to the user's active tab, so we let the user
  // opt into mirroring that page's theme via Settings → Theme = "Match
  // active page". Other preferences (`auto`/`light`/`dark`) behave the same
  // as in the popup/options.
  useResolvedTheme({ allowPage: true });

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
  // immediately attaches the user's current tab as context — that's
  // the most common intent for a side-panel chat.
  const [pageMode, setPageMode] = useState(true);
  // Where the agent's browser-control tool calls land. "agent" — the
  // dedicated background window — is the safe default. The toggle is
  // sticky, matching the existing Page toggle's pattern: a pick is a
  // pick, and the user re-flips it if they want a one-off. We chose
  // sticky-only over a separate "next send only" override because
  // (a) it removes a UI mode (no override-dot to explain),
  // (b) it matches every other persistent toggle in this side panel,
  // (c) anyone running the same kind of task repeatedly (e.g., always
  //     in their own tab) gets the right behaviour for free without
  //     re-flipping every send.
  // If the one-shot use case becomes common we can layer a "this turn
  // only" affordance on top later — easier than removing one.
  const [runMode, setRunMode] = useState<RunTarget>("agent");
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
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { tab: activeTab, refresh: refreshActiveTab } = useActiveTab();
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Load chat-config on mount and watch for changes from the Options page so
  // the side panel always reflects the latest model / apiBase / apiKey.
  useEffect(() => {
    void (async () => {
      const r = await chrome.storage.local.get([
        SETTINGS_KEYS.apiBase,
        SETTINGS_KEYS.apiKey,
        SETTINGS_KEYS.model,
        SETTINGS_KEYS.pageMode,
        SETTINGS_KEYS.runModeDefault,
      ]);
      if (typeof r[SETTINGS_KEYS.pageMode] === "boolean") {
        setPageMode(r[SETTINGS_KEYS.pageMode] as boolean);
      }
      const storedRunMode = r[SETTINGS_KEYS.runModeDefault];
      if (storedRunMode === "agent" || storedRunMode === "user") {
        setRunMode(storedRunMode);
      }
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
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  // Persist the include-page toggle so it survives panel reloads. The
  // first write right after the loader hydrates is redundant-but-cheap;
  // we accept that to avoid the ref-based "skip first run" gymnastics.
  useEffect(() => {
    void chrome.storage.local.set({ [SETTINGS_KEYS.pageMode]: pageMode });
  }, [pageMode]);

  // Same write-on-change pattern for the run-mode toggle. Sticky across
  // panel reloads.
  useEffect(() => {
    void chrome.storage.local.set({
      [SETTINGS_KEYS.runModeDefault]: runMode,
    });
  }, [runMode]);

  // If the panel was reloaded mid-stream (or the user closed the side panel
  // while the assistant was still emitting tokens), the persisted history
  // can still carry `streaming: true` on the last assistant message. Clear
  // those flags whenever we activate a session so we don't render a fake
  // loading indicator forever.
  const lastSanitisedRef = useRef<string>("");
  useEffect(() => {
    if (!sessions.ready) return;
    if (sessions.activeId === lastSanitisedRef.current) return;
    lastSanitisedRef.current = sessions.activeId;
    const dirty = (sessions.activeMessages as UiMessage[]).some(
      (m) => m.streaming,
    );
    if (!dirty) return;
    sessions.setActiveMessages((prev) =>
      (prev as UiMessage[]).map((m) =>
        m.streaming
          ? {
              ...m,
              streaming: false,
              content: m.content
                ? m.content + "\n\n[interrupted]"
                : "[interrupted]",
            }
          : m,
      ),
    );
  }, [sessions.ready, sessions.activeId, sessions.activeMessages, sessions]);

  // Auto-scroll on new content.
  useEffect(() => {
    const el = scrollRef.current?.querySelector(
      "[data-radix-scroll-area-viewport]",
    );
    if (el) (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
  }, [sessions.activeMessages]);

  // Aborting the in-flight stream when the user switches to a different
  // session avoids race conditions where late-arriving SSE chunks would
  // append to whatever session happens to be active. We also drop any
  // pinned page snapshots: pins are a compose-time affordance scoped to
  // the conversation the user was looking at when they pinned.
  const lastSeenActiveRef = useRef<string>("");
  useEffect(() => {
    if (sessions.activeId !== lastSeenActiveRef.current) {
      const wasInitialised = lastSeenActiveRef.current !== "";
      lastSeenActiveRef.current = sessions.activeId;
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
      if (wasInitialised) {
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

  async function send() {
    const text = input.trim();
    // Allow send when the user has uploaded attachments but hasn't typed
    // anything (e.g. "here's a screenshot — what's wrong with it?"). We
    // still gate on having SOMETHING to send so an empty composer with
    // no attachments stays a no-op.
    if ((!text && attachments.length === 0) || busy) return;
    if (!sessions.ready) return;

    setError(null);
    setPageError(null);

    const sessionId = await sessions.ensureActive();

    // Build the page-context list for THIS turn:
    //   1. All pinned snapshots (already captured at pin time).
    //   2. The live current tab if `pageMode` is on, freshly extracted so
    //      follow-ups against an evolving page work.
    //
    // Pinned entries take precedence on URL collision so we never re-extract
    // a page the user has already explicitly pinned.
    const pages: PageContext[] = [...pinnedPages];
    if (pageMode) {
      const result = await capturePageContext();
      if (result.kind === "page") {
        if (!pages.some((p) => p.url === result.page.url)) {
          pages.push(result.page);
        }
      } else {
        setPageError(result.error.error);
      }
    }

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
    const fileSystemMessage: ChatMessage | null =
      attachments.length > 0
        ? {
            role: "system",
            content: formatFileAttachmentsForPrompt(attachments),
          }
        : null;
    // Build the persisted-on-bubble badges in parallel with the request:
    // images need a small thumbnail re-encode which is non-trivial, so we
    // kick that off but don't block the send path on it.
    const badgesPromise: Promise<AttachmentBadge[] | undefined> =
      attachments.length > 0
        ? Promise.all(attachments.map(attachmentToBadge))
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
    setInput("");
    setAttachments([]);
    setAttachmentError(null);
    setBusy(true);

    // Push the run-target for this turn into the SW *before* the chat
    // request opens — once `streamChat` returns its first chunk the
    // gateway is already free to dispatch tool calls, so the SW state
    // it reads at that moment must already be the user's choice. We
    // capture the side-panel's window id so "user" mode has a stable
    // handle on the user's tab even if Chrome reshuffles focus
    // mid-conversation.
    const turnRunMode = runMode;
    try {
      if (turnRunMode === "user") {
        const win = await chrome.windows.getCurrent();
        const [activeUserTab] = await chrome.tabs.query({
          active: true,
          windowId: win.id,
        });
        await chrome.runtime.sendMessage({
          action: "runTarget.set",
          target: "user",
          userTabId: activeUserTab?.id ?? null,
          userWindowId: win.id ?? null,
        });
      } else {
        await chrome.runtime.sendMessage({
          action: "runTarget.set",
          target: "agent",
        });
      }
    } catch (e) {
      console.warn("[sidepanel] runTarget.set failed:", e);
    }

    const ctrl = new AbortController();
    abortRef.current = ctrl;

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

    try {
      await streamChat(
        history,
        {
          apiBase: config.apiBase,
          apiKey: config.apiKey,
          model: config.model,
          sessionId,
          signal: ctrl.signal,
        },
        {
          onChunk: (delta) => {
            sessions.setActiveMessages((prev) => {
              const next = (prev as UiMessage[]).slice();
              const i = next.findIndex((m) => m.uiId === assistantMsg.uiId);
              if (i >= 0)
                next[i] = { ...next[i], content: next[i].content + delta };
              return next;
            });
          },
          onSession: (s) => {
            // 1:1 model: the extension owns the session id; only warn if
            // the gateway echoes a different value.
            if (s && s !== sessionId) {
              console.warn(
                "[sidepanel] gateway returned session id %s but we expected %s; ignoring.",
                s,
                sessionId,
              );
            }
          },
        },
      );
      // After the stream resolves, ask the SW where the agent tab
      // currently is — this becomes the "Open in my browser →" chip on
      // the just-finished assistant bubble, the "teleport at end"
      // affordance for the delegate-and-forget case. Only meaningful
      // when this turn ran on the agent surface; user-mode turns
      // already happened in the user's tab so the chip would be a
      // no-op pointing at where they already are.
      let agentFinalUrl: string | undefined;
      let agentFinalTitle: string | undefined;
      if (turnRunMode === "agent") {
        try {
          const r = (await chrome.runtime.sendMessage({
            action: "agent.lastUrl",
          })) as
            | { ok?: boolean; url?: string | null; title?: string | null }
            | undefined;
          if (
            r?.ok &&
            typeof r.url === "string" &&
            /^(https?|file|ftp):/i.test(r.url) &&
            r.url !== "about:blank"
          ) {
            agentFinalUrl = r.url;
            if (typeof r.title === "string" && r.title) {
              agentFinalTitle = r.title;
            }
          }
        } catch {
          // Agent window might be gone — chip just won't render.
        }
      }
      sessions.setActiveMessages((prev) => {
        const next = (prev as UiMessage[]).map((m) =>
          m.uiId === assistantMsg.uiId
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
    } catch (e) {
      const err = e as Error;
      if (err.name === "AbortError") {
        sessions.setActiveMessages((prev) =>
          (prev as UiMessage[]).map((m) =>
            m.uiId === assistantMsg.uiId
              ? {
                  ...m,
                  streaming: false,
                  content: m.content + "\n\n[stopped]",
                }
              : m,
          ),
        );
      } else {
        const message = String(err?.message || err);
        const hint =
          err instanceof HermesHttpError ? err.hint() || undefined : undefined;
        setError({ message, hint });
        sessions.setActiveMessages((prev) =>
          (prev as UiMessage[]).filter((m) => m.uiId !== assistantMsg.uiId),
        );
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
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

  // Mid-run hand-off: flip to "user" mode AND ferry the agent's
  // current URL into the user's tab so the user picks up exactly
  // where the agent left off. We don't abort the run — the agent
  // keeps streaming whatever it was about to say; only the *next*
  // tool call (if any) routes to the user tab.
  async function moveToMyTab() {
    try {
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
      // Reflect the change locally so the toggle and status bar agree
      // without waiting for the SW broadcast round-trip. A future
      // SW-driven resync (via `hermes:run-target-changed`) would
      // overwrite this if needed.
      setRunMode("user");
    } catch (e) {
      console.warn("[sidepanel] promoteToUser failed:", e);
    }
  }

  async function newChat() {
    setError(null);
    setPinnedPages([]);
    setPageError(null);
    // Drop any composer-time attachments and unlink their on-disk files —
    // they were tied to the old session and won't be referenced again.
    for (const a of attachments) void deleteAttachmentFile(a);
    setAttachments([]);
    setAttachmentError(null);
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
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
      // Pinning is also the canonical "re-attach this page" gesture: if
      // the user previously hit × on the live chip (which flips pageMode
      // off), clicking Pin should bring the page back AND pin it. Setting
      // pageMode on here also means a later unpin via the Pin toggle
      // leaves the page attached as the live current-tab chip rather
      // than removing it entirely.
      setPageMode(true);
    } finally {
      setPinning(false);
    }
  }

  function unpinPage(uiId: string) {
    setPinnedPages((prev) => prev.filter((p) => p.uiId !== uiId));
  }

  // × handler shared by both pinned chips and the live current-tab chip.
  // Conceptually "remove this page from the next request":
  //   - drop the pinned snapshot (if any), AND
  //   - if the chip represents the active tab, also flip pageMode off so
  //     it doesn't immediately re-appear as the live current-tab chip.
  // A pinned chip whose URL doesn't match the active tab keeps the
  // existing semantics — we just unpin it and leave pageMode alone.
  function dismissPageChip(opts: { uiId?: string; url?: string }) {
    if (opts.uiId) {
      setPinnedPages((prev) => prev.filter((p) => p.uiId !== opts.uiId));
    }
    if (opts.url && activeTab?.url === opts.url) {
      setPageMode(false);
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
    const sessionId = sessions.ready
      ? await sessions.ensureActive()
      : "default";
    const errors: string[] = [];
    const accepted: Attachment[] = [];
    const results = await Promise.all(
      files.map((f) => readFileAsAttachment(f, { sessionId })),
    );
    for (const r of results) {
      if (isAttachmentReadOk(r)) {
        accepted.push(r.attachment);
      } else {
        errors.push(`${r.name}: ${r.error}`);
      }
    }
    if (accepted.length > 0) {
      setAttachments((prev) => [...prev, ...accepted]);
    }
    if (errors.length > 0) {
      setAttachmentError(errors.join("\n"));
    }
    setAttachmentBusy(false);
  }

  function removeAttachment(uiId: string) {
    setAttachments((prev) => {
      const target = prev.find((a) => a.uiId === uiId);
      if (target) {
        // Best-effort delete of the on-disk file — fire-and-forget so
        // the chip drops instantly without waiting on the bridge.
        void deleteAttachmentFile(target);
      }
      return prev.filter((a) => a.uiId !== uiId);
    });
  }

  /**
   * Open the hidden file picker. We re-set `value=""` first so picking
   * the same file twice in a row still fires `onChange` (browsers
   * suppress the event if the selection is identical).
   */
  function openFilePicker() {
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
                <MessageTurns messages={messages} />
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
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
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
          Cursor-style composer: the textarea and an internal action row live
          inside a single rounded, bordered container. The textarea itself is
          borderless / shadowless so the outer box is the only visible frame;
          focus styling is delegated to the box via focus-within. The action
          row at the bottom holds the circular send/stop button on the right
          and a left-aligned "Page" toggle pill that streams the current
          tab's content into the next request as a system message.
        */}
        <div
          className={cn(
            "relative flex flex-col rounded-lg border border-input bg-background shadow-sm transition-colors focus-within:border-ring/60",
            dragOver && "border-primary/60 ring-2 ring-primary/30",
          )}
          onDragOver={(e) => {
            // Only flag a "real" file drag — text-selection drags inside
            // the textarea also fire dragover, but their dataTransfer
            // doesn't contain the "Files" type.
            if (
              e.dataTransfer &&
              Array.from(e.dataTransfer.types || []).includes("Files")
            ) {
              e.preventDefault();
              if (!dragOver) setDragOver(true);
            }
          }}
          onDragLeave={(e) => {
            // Only clear the highlight when leaving the wrapper, not
            // when the drag crosses an internal element boundary.
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
          {(() => {
            // The live current chip is suppressed when:
            //   - its URL already matches a pinned snapshot (de-dupe), OR
            //   - the current page is restricted (chrome://, Web Store…)
            //     so we couldn't read it even if we tried.
            // In both cases showing a chip would be misleading.
            const liveTabVisible =
              pageMode &&
              !!activeTab &&
              !!activeTab.url &&
              !pageRestrictedReason &&
              !pinnedPages.some((p) => p.url === activeTab.url);
            const anyChips =
              pinnedPages.length > 0 ||
              liveTabVisible ||
              attachments.length > 0;
            if (!anyChips) return null;
            return (
              <div className="flex flex-wrap items-center gap-1 border-b border-border/50 px-2 py-1.5">
                {pinnedPages.map((p) => (
                  <PageChip
                    key={p.uiId}
                    title={p.title}
                    url={p.url}
                    favIconUrl={p.favicon}
                    onRemove={() =>
                      dismissPageChip({ uiId: p.uiId, url: p.url })
                    }
                  />
                ))}
                {liveTabVisible && (
                  <PageChip
                    title={activeTab!.title}
                    url={activeTab!.url}
                    favIconUrl={activeTab!.favIconUrl}
                    live
                    onRemove={() =>
                      dismissPageChip({ url: activeTab!.url })
                    }
                  />
                )}
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
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              attachments.length > 0
                ? "Add a question about your file(s)…"
                : pageMode
                ? "Ask about this page…"
                : "Message Hermes…"
            }
            rows={2}
            className="min-h-[56px] resize-none border-0 bg-transparent px-3 py-2 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            onPaste={handleComposerPaste}
            onKeyDown={(e) => {
              if (
                (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ||
                (e.key === "Enter" && !e.shiftKey && !e.altKey)
              ) {
                e.preventDefault();
                void send();
              }
            }}
            disabled={busy}
          />
          {dragOver && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-primary/5 text-[12px] font-medium text-primary">
              Drop files to attach
            </div>
          )}
          <div className="flex items-center justify-between gap-2 px-2 pb-2">
            {busy ? (
              // While streaming we collapse the pre-run pills (Paperclip /
              // Page / RunModeToggle) into a live status cluster so the
              // composer's bottom row doubles as the run-status bar — one
              // chrome row instead of two. Mirrors the affordances of the
              // old standalone <RunStatusBar/>: pulse + label, plus the
              // mid-run hand-off buttons when the agent is working in its
              // own window. Stop stays on the right slot, replacing Send.
              <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-muted-foreground">
                <span aria-hidden className="hermes-thinking-dot shrink-0" />
                {runMode === "user" ? (
                  <MousePointerClick className="h-3 w-3 shrink-0" />
                ) : (
                  <Bot className="h-3 w-3 shrink-0" />
                )}
                <span className="min-w-0 truncate">
                  {runMode === "user"
                    ? "Driving your tab"
                    : "Working in background"}
                </span>
                {runMode !== "user" && (
                  <div className="ml-auto flex shrink-0 items-center gap-1">
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
                      title="Switch to your tab and bring the agent's current URL with you"
                    >
                      Move to my tab
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={openFilePicker}
                disabled={busy || attachmentBusy}
                title="Attach files (images, text, code)"
                aria-label="Attach files"
                className={cn(
                  "inline-flex h-6 w-6 items-center justify-center rounded-full border border-border bg-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  (busy || attachmentBusy) &&
                    "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted-foreground",
                )}
              >
                <Paperclip className="h-3 w-3" />
              </button>
              {/*
                The composer pill is conceptually one element — the "Page"
                toggle — with a small pin icon embedded on its right edge as
                a secondary toggle. To keep the pill *visually* seamless we
                don't split the surface into segments; to keep it accessible
                we use a div-as-button outside (role=button + tabIndex +
                keydown for Enter/Space) and a real <button> inside.
                `stopPropagation` on the inner click/keydown is what
                prevents the Pin action from also toggling Page.
              */}
              <div
                role="button"
                tabIndex={0}
              aria-pressed={pageMode}
              onClick={() => {
                setPageError(null);
                setPageMode((v) => !v);
                refreshActiveTab();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setPageError(null);
                  setPageMode((v) => !v);
                  refreshActiveTab();
                }
              }}
              title={
                pageMode
                  ? "Stop attaching the current page"
                  : "Attach the current page as context"
              }
              className={cn(
                "inline-flex h-6 cursor-pointer select-none items-center gap-1 rounded-full border pl-2 pr-1 text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                pageMode
                  ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90"
                  : "border-border bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <Globe className="h-3 w-3" />
              <span>Page</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void toggleCurrentPagePin();
                }}
                onKeyDown={(e) => {
                  // Don't let Enter/Space bubble to the wrapper's keyboard
                  // handler — otherwise hitting Space on the focused Pin
                  // icon would also fire the Page toggle.
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                  }
                }}
                disabled={pinDisabled}
                title={
                  pageRestrictedReason && !isCurrentPagePinned
                    ? pageRestrictedReason
                    : isCurrentPagePinned
                      ? "Unpin this page"
                      : "Pin the current page (snapshot — survives switching tabs)"
                }
                aria-pressed={isCurrentPagePinned}
                aria-label={
                  isCurrentPagePinned
                    ? "Unpin current page"
                    : "Pin current page"
                }
                className={cn(
                  "inline-flex h-5 w-5 items-center justify-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                  pageMode
                    ? "hover:bg-primary-foreground/20"
                    : "hover:bg-foreground/10",
                  pinDisabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
                )}
              >
                <Pin
                  className="h-3 w-3"
                  fill={isCurrentPagePinned ? "currentColor" : "none"}
                />
              </button>
              </div>
              <RunModeToggle
                mode={runMode}
                disabled={busy}
                onChange={setRunMode}
              />
              </div>
            )}
            {busy ? (
              <Button
                size="icon"
                onClick={stop}
                title="Stop"
                className="h-6 w-6 rounded-full"
              >
                <span
                  aria-hidden
                  className="block h-2 w-2 rounded-[1.5px] bg-current"
                />
              </Button>
            ) : (
              <Button
                size="icon"
                onClick={() => void send()}
                disabled={!input.trim() && attachments.length === 0}
                title="Send (⌘/Ctrl+Enter)"
                className="h-6 w-6 rounded-full [&_svg]:size-3"
              >
                <ArrowUp strokeWidth={3} />
              </Button>
            )}
          </div>
        </div>
      </footer>

      <SessionDrawer
        open={historyOpen}
        sessions={sessions.sessions}
        openTabIds={sessions.openTabIds}
        activeId={sessions.activeId}
        onClose={() => setHistoryOpen(false)}
        onOpen={(id) => void sessions.openTab(id)}
        onCreate={() => void sessions.createNew()}
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
  const titleLines: string[] = [attachment.name];
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
    >
      {attachment.kind === "image" && attachment.thumbDataUrl ? (
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
      <span className="truncate">{attachment.name}</span>
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

// Group the flat message list into "turns" (one user message + the assistant
// replies that follow it, up to the next user message) and pin each user
// bubble to the top of the scroll viewport via `position: sticky`. While the
// reader is scrolling through a long assistant reply, the originating user
// question stays visible at the top — Cursor-style — so the context of the
// reply is never lost. Sticky elements are bounded by their parent, so once
// the next turn enters view its own user bubble takes over the pin without
// any JS / scroll-listener gymnastics.
function MessageTurns({ messages }: { messages: UiMessage[] }) {
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
            <Bubble key={m.uiId} m={m} />
          ))}
        </div>
      ))}
    </>
  );
}

function Bubble({ m }: { m: UiMessage }) {
  if (m.role === "user") {
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
    const hasContent = !!m.content && m.content.length > 0;
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
          <div className="whitespace-pre-wrap break-words">{m.content}</div>
        )}
      </div>
    );
  }
  if (m.role === "assistant") {
    // While the request is in flight but no token has arrived yet, the bubble
    // would otherwise be just Streamdown's bare ● caret on an empty line —
    // which reads as a stray glyph rather than a status. Replace that with an
    // explicit "Thinking…" placeholder + breathing dot until content streams
    // in.
    const isEmptyStreaming =
      !!m.streaming && (!m.content || m.content.trim() === "");
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
    return (
      <div className="min-w-0 px-1 py-1 text-sm">
        <Streamdown
          mode="streaming"
          parseIncompleteMarkdown
          caret="circle"
          isAnimating={!!m.streaming}
          className="chat-md break-words"
        >
          {m.content}
        </Streamdown>
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
      [{m.role}] {m.content}
    </div>
  );
}
