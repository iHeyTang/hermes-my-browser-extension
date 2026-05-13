/**
 * New tab override.
 *
 * Plasmo auto-registers this as ``chrome_url_overrides.newtab`` because the
 * file lives at ``src/newtab/index.tsx``. The user-facing toggle lives in
 * Preferences (``settings.newtab.enabled``); when disabled the page either
 * redirects to the user's configured fallback URL or shows a small splash
 * with a link back to settings.
 *
 * Layout intent: an AI-native "Home" page (not an embedded side panel).
 * The page surfaces a hero greeting, a centered composer, suggestion
 * chips, and a Recent-sessions module. Submitting from the composer (or
 * clicking a recent session) hands off to the side panel for the actual
 * chat — the side panel reads ``home.pendingPrompt`` from storage on
 * mount and auto-fires send().
 */

import { ArrowUp, MessageSquare, Settings } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import "~style.css";

import { HermesLogo } from "~components/hermes-logo";
import { Textarea } from "~components/ui/textarea";
import { useSessions } from "~lib/sessions/use-sessions";
import type { SessionMeta } from "~lib/sessions/types";
import { useResolvedTheme } from "~lib/theme";
import { cn } from "~lib/utils";

const NEWTAB_ENABLED_KEY = "settings.newtab.enabled";
const NEWTAB_FALLBACK_KEY = "settings.newtab.fallbackUrl";
const HOME_PENDING_PROMPT_KEY = "home.pendingPrompt";

const NEWTAB_DEFAULT_ENABLED = true;

// Home runs without page context (unlike the side panel, which sits
// alongside an actual tab), so suggestions need to stand on their own.
// "Summarize the page I have open" / "Help me draft a reply" don't make
// sense here — the page in question is the Home itself, and there's no
// thread to reply to. Anything listed below should make sense as the
// FIRST message of a fresh chat with no other context.
const SUGGESTED_PROMPTS = [
  "What can you help me with?",
  "Give me 5 ideas for a side project",
  "Help me brainstorm a name for a project",
  "Suggest a book to read this week",
];

type LoadState =
  | { kind: "loading" }
  | { kind: "home" }
  | { kind: "redirecting"; url: string }
  | { kind: "disabled" };

function normalizeFallback(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export default function NewTab() {
  useResolvedTheme();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void chrome.storage.local
      .get([NEWTAB_ENABLED_KEY, NEWTAB_FALLBACK_KEY])
      .then((r) => {
        if (cancelled) return;
        const enabled =
          typeof r[NEWTAB_ENABLED_KEY] === "boolean"
            ? (r[NEWTAB_ENABLED_KEY] as boolean)
            : NEWTAB_DEFAULT_ENABLED;
        if (enabled) {
          setState({ kind: "home" });
          return;
        }
        const fallback = normalizeFallback(r[NEWTAB_FALLBACK_KEY]);
        if (fallback) {
          setState({ kind: "redirecting", url: fallback });
          try {
            window.location.replace(fallback);
          } catch {
            setState({ kind: "disabled" });
          }
          return;
        }
        setState({ kind: "disabled" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "home") return <Home />;
  if (state.kind === "redirecting") {
    return (
      <DisabledSplash
        headline="Redirecting…"
        message={`Opening ${state.url}`}
      />
    );
  }
  if (state.kind === "disabled") {
    return (
      <DisabledSplash
        headline="Hermes new tab is off"
        message="Enable it in Hermes options, or set a fallback URL to redirect new tabs elsewhere."
      />
    );
  }
  return <div className="h-screen w-full bg-background" />;
}

// ---------------------------------------------------------------------------
// Home page
// ---------------------------------------------------------------------------

/**
 * AI-native home page layout:
 *
 *   ┌────────────────────────────────────────────────┐
 *   │ [Logo] Hermes              [+ New] [Settings]  │
 *   ├────────────────────────────────────────────────┤
 *   │                                                │
 *   │              [Hermes Logo]                     │
 *   │            Good afternoon                      │
 *   │         How can I help you today?              │
 *   │                                                │
 *   │   ┌──────────────────────────────────┐  ▲     │
 *   │   │ Message Hermes…             [→]  │        │
 *   │   └──────────────────────────────────┘        │
 *   │                                                │
 *   │   [Suggested]  [Suggested]  [Suggested]       │
 *   │                                                │
 *   ├────────────────────────────────────────────────┤
 *   │ Recent                                         │
 *   │ ┌────┐ ┌────┐ ┌────┐ ┌────┐                  │
 *   │ │ s1 │ │ s2 │ │ s3 │ │ s4 │ ...              │
 *   │ └────┘ └────┘ └────┘ └────┘                  │
 *   └────────────────────────────────────────────────┘
 *
 * Submit / click-through opens the side panel; the side panel reads the
 * pending prompt and auto-sends.
 */
function Home() {
  const sessions = useSessions();
  const greeting = useMemo(getGreeting, []);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    // Focus the composer on first render so typing works immediately.
    inputRef.current?.focus();
  }, []);

  const recentSessions = useMemo(
    () => sortRecent(sessions.sessions).slice(0, 12),
    [sessions.sessions],
  );

  function goToChatTab() {
    // Navigate this new tab to the full-screen chat surface. We replace
    // the current location rather than `chrome.tabs.create` so the user
    // doesn't end up with a stale Home tab next to the Chat tab — the
    // intent of every launch action here is "take me to the chat", not
    // "spawn another tab". The chat page's own SidePanel
    // (variant="fullscreen") will pick up the prepared session + pending
    // prompt from storage on mount.
    try {
      window.location.replace(chrome.runtime.getURL("tabs/chat.html"));
    } catch {
      // Best-effort.
    }
  }

  async function submitToChat(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy || !sessions.ready) return;
    setBusy(true);
    try {
      // Always start a fresh session — submitting from Home is
      // conceptually "open a new chat with this prompt". Reusing
      // whatever happened to be the active session would silently
      // append to an unrelated conversation the user left running in
      // the side panel or chat tab.
      await sessions.createNew();
      await chrome.storage.local.set({
        [HOME_PENDING_PROMPT_KEY]: { text: trimmed, ts: Date.now() },
      });
      goToChatTab();
    } finally {
      // The navigation tears this React tree down; clearing `busy` is
      // only defensive in case `goToChatTab` failed (rare — replace()
      // throwing is essentially impossible).
      setBusy(false);
    }
  }

  async function openSession(id: string) {
    if (!sessions.ready) return;
    setBusy(true);
    try {
      await sessions.openTab(id);
      goToChatTab();
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    const ne = e.nativeEvent;
    if (ne.isComposing || e.key === "Process") return;
    if (
      (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ||
      (e.key === "Enter" && !e.shiftKey && !e.altKey)
    ) {
      e.preventDefault();
      void submitToChat(input);
    }
  }

  const canSend = input.trim().length > 0 && !busy && sessions.ready;

  return (
    <div className="flex h-screen w-full flex-col bg-background text-foreground">
      <TopBar onOpenSettings={() => chrome.runtime.openOptionsPage()} />

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 pb-8">
        {/*
          Vertically centered hero block (greeting + composer + suggestions).
          The Recent module sits below the centered block, so on tall
          screens the input stays near the optical center rather than
          drifting to the very top.
        */}
        <div className="flex flex-1 flex-col justify-center gap-6 pt-6">
          <div className="flex flex-col items-center gap-4 text-center">
            <HermesLogo size={64} />
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-muted-foreground">
                {greeting}
              </p>
              <h1 className="text-2xl font-semibold tracking-tight">
                How can I help you today?
              </h1>
            </div>
          </div>

          <div className="space-y-3">
            <ComposerCard
              ref={inputRef}
              value={input}
              onChange={setInput}
              onKeyDown={onKeyDown}
              onSend={() => void submitToChat(input)}
              canSend={canSend}
              busy={busy}
            />

            <div className="flex flex-wrap justify-center gap-1.5">
              {SUGGESTED_PROMPTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  disabled={busy}
                  // Suggestion chips drop into the composer as a starting
                  // point — the user can edit before pressing Enter.
                  // Auto-submitting was too aggressive: it removed the
                  // ability to tweak the prompt and made fat-finger taps
                  // unrecoverable without a Stop.
                  onClick={() => {
                    setInput(p);
                    inputRef.current?.focus();
                  }}
                  className={cn(
                    "rounded-full border border-border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground transition-colors",
                    "hover:bg-muted hover:text-foreground",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                  )}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        </div>

        <RecentSessions
          sessions={recentSessions}
          busy={busy}
          onOpen={(id) => void openSession(id)}
        />
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function TopBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <header className="flex shrink-0 items-center justify-between gap-3 px-6 py-4">
      <div className="flex items-center gap-2.5">
        <HermesLogo size={22} />
        <p className="text-sm font-semibold tracking-tight">Hermes</p>
      </div>
      <button
        type="button"
        onClick={onOpenSettings}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label="Open Hermes options"
        title="Open Hermes options"
      >
        <Settings className="h-4 w-4" />
      </button>
    </header>
  );
}

interface ComposerCardProps {
  value: string;
  onChange: (v: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  canSend: boolean;
  busy: boolean;
}

const ComposerCard = forwardRef<HTMLTextAreaElement, ComposerCardProps>(
  function ComposerCard(
    { value, onChange, onKeyDown, onSend, canSend, busy },
    ref,
  ) {
    return (
      <div className="relative rounded-2xl border border-border bg-background shadow-sm transition-colors focus-within:border-foreground/30">
        <Textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Message Hermes…"
          rows={2}
          disabled={busy}
          className="max-h-60 min-h-[3.5rem] resize-none border-0 bg-transparent px-4 py-3 pr-12 text-sm shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
        />
        <button
          type="button"
          onClick={onSend}
          disabled={!canSend}
          title="Send (Enter)"
          aria-label="Send"
          className={cn(
            "absolute bottom-2.5 right-2.5 inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors",
            canSend
              ? "bg-foreground text-background hover:bg-foreground/85"
              : "bg-muted text-muted-foreground/60",
          )}
        >
          <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
        </button>
      </div>
    );
  },
);

function RecentSessions({
  sessions,
  busy,
  onOpen,
}: {
  sessions: SessionMeta[];
  busy: boolean;
  onOpen: (id: string) => void;
}) {
  if (sessions.length === 0) return null;
  return (
    <section className="space-y-2.5 pt-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Recent
        </h2>
        <span className="text-[10px] text-muted-foreground/70">
          Click to resume
        </span>
      </div>
      <ul className="divide-y divide-border/40 overflow-hidden rounded-lg border border-border/60 bg-muted/10">
        {sessions.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              disabled={busy}
              onClick={() => onOpen(s.id)}
              className={cn(
                "flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors",
                "hover:bg-muted/50",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                {s.title?.trim() || "Untitled chat"}
              </span>
              {s.messageCount != null && s.messageCount > 0 && (
                <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground/70">
                  {s.messageCount} msgs
                </span>
              )}
              <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground/80">
                {formatRelative(s.updatedAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DisabledSplash({
  headline,
  message,
}: {
  headline: string;
  message: string;
}) {
  return (
    <div className="flex h-screen w-full items-center justify-center bg-background text-foreground">
      <div className="flex max-w-md flex-col items-center gap-4 px-6 text-center">
        <HermesLogo size={48} />
        <div className="space-y-1">
          <h1 className="text-base font-semibold tracking-tight">{headline}</h1>
          <p className="text-xs text-muted-foreground">{message}</p>
        </div>
        <button
          type="button"
          onClick={() => chrome.runtime.openOptionsPage()}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
        >
          Open Hermes options
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function sortRecent(sessions: SessionMeta[]): SessionMeta[] {
  return [...sessions]
    .filter((s) => !s.archived)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

function formatRelative(ms: number | undefined): string {
  if (!ms) return "";
  const diffSec = Math.round((Date.now() - ms) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) {
    const n = Math.floor(diffSec / 60);
    return `${n} min${n === 1 ? "" : "s"} ago`;
  }
  if (diffSec < 86400) {
    const n = Math.floor(diffSec / 3600);
    return `${n} hour${n === 1 ? "" : "s"} ago`;
  }
  if (diffSec < 86400 * 30) {
    const n = Math.floor(diffSec / 86400);
    return `${n} day${n === 1 ? "" : "s"} ago`;
  }
  return new Date(ms).toLocaleDateString();
}
