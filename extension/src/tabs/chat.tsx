/**
 * Full-screen chat tab.
 *
 * Plasmo emits this as ``tabs/chat.html`` (because the file lives at
 * ``src/tabs/chat.tsx``). It's reached from the new-tab Home's "Open in
 * tab" affordance and from background actions; nothing auto-opens it.
 *
 * Layout: a thin top bar above a two-pane body — sessions rail on the
 * left, chat on the right. The chat itself is just the side panel
 * rendered in ``variant="fullscreen"`` so it skips its own TabBar (the
 * left rail handles session switching here) and fills its parent
 * vertically. Both panes share session state via ``chrome.storage`` —
 * the sessions rail uses its own ``useSessions`` instance, but writes
 * propagate to the SidePanel's instance through storage events.
 */

import {
  MessageSquare,
  Pencil,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
} from "react";

import "~style.css";

import { HermesLogo } from "~components/hermes-logo";
import { Input } from "~components/ui/input";
import { ScrollArea } from "~components/ui/scroll-area";
import { useSessions } from "~lib/sessions/use-sessions";
import type { SessionMeta } from "~lib/sessions/types";
import { useResolvedTheme } from "~lib/theme";
import { cn } from "~lib/utils";

import SidePanel, { type MessagesMaxWidth } from "../sidepanel";

const MESSAGES_WIDTH_KEY = "settings.chat.messagesWidth";
const DEFAULT_MESSAGES_WIDTH: MessagesMaxWidth = "comfortable";

const WIDTH_OPTIONS: Array<{ value: MessagesMaxWidth; label: string; tooltip: string }> = [
  { value: "narrow", label: "Narrow", tooltip: "Narrow message column (same as input)" },
  { value: "comfortable", label: "Medium", tooltip: "Medium message column" },
  { value: "full", label: "Full", tooltip: "Full-width messages" },
];

function isMessagesMaxWidth(v: unknown): v is MessagesMaxWidth {
  return v === "narrow" || v === "comfortable" || v === "full";
}

export default function ChatTab() {
  useResolvedTheme();
  const sessions = useSessions();
  const [query, setQuery] = useState("");
  const [messagesWidth, setMessagesWidth] = useState<MessagesMaxWidth>(
    DEFAULT_MESSAGES_WIDTH,
  );

  useEffect(() => {
    let cancelled = false;
    void chrome.storage.local.get(MESSAGES_WIDTH_KEY).then((r) => {
      if (cancelled) return;
      const v = r[MESSAGES_WIDTH_KEY];
      if (isMessagesMaxWidth(v)) setMessagesWidth(v);
    });
    // Reflect external writes (e.g. a debug command or a future
    // Preferences entry) so the toggle stays in sync with storage.
    const listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (
      changes,
      area,
    ) => {
      if (area !== "local") return;
      const ch = changes[MESSAGES_WIDTH_KEY];
      if (ch && isMessagesMaxWidth(ch.newValue)) setMessagesWidth(ch.newValue);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  function onWidthChange(next: MessagesMaxWidth) {
    setMessagesWidth(next);
    void chrome.storage.local.set({ [MESSAGES_WIDTH_KEY]: next });
  }

  const onNewChat = useCallback(async () => {
    if (!sessions.ready) return;
    await sessions.createNew();
  }, [sessions]);

  const onOpenSession = useCallback(
    async (id: string) => {
      if (!sessions.ready) return;
      await sessions.openTab(id);
    },
    [sessions],
  );

  return (
    <div className="flex h-screen w-full flex-col bg-background text-foreground">
      <TopBar
        messagesWidth={messagesWidth}
        onMessagesWidthChange={onWidthChange}
        onNewChat={() => void onNewChat()}
        onOpenSettings={() => chrome.runtime.openOptionsPage()}
      />

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col border-r border-border/60 bg-muted/15">
          <SessionsRail
            sessions={sessions.sessions}
            activeId={sessions.activeId}
            ready={sessions.ready}
            query={query}
            onQuery={setQuery}
            onOpen={(id) => void onOpenSession(id)}
            onRename={(id, title) => void sessions.rename(id, title)}
            onDelete={(id) => void sessions.remove(id)}
          />
        </aside>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <SidePanel variant="fullscreen" messagesMaxWidth={messagesWidth} />
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

function TopBar({
  messagesWidth,
  onMessagesWidthChange,
  onNewChat,
  onOpenSettings,
}: {
  messagesWidth: MessagesMaxWidth;
  onMessagesWidthChange: (next: MessagesMaxWidth) => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 bg-muted/15 px-4 py-2">
      <div className="flex items-center gap-2.5">
        <HermesLogo size={20} />
        <p className="text-sm font-semibold tracking-tight">Hermes Chat</p>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onNewChat}
          className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="Start a new chat"
        >
          <Plus className="h-3.5 w-3.5" />
          New chat
        </button>
        <WidthToggle value={messagesWidth} onChange={onMessagesWidthChange} />
        <button
          type="button"
          onClick={onOpenSettings}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Open Hermes options"
          title="Open Hermes options"
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}

/**
 * Three icon buttons laid out inline next to the other top-bar icons —
 * same `h-8 w-8` cell size, same hover behavior, just an active-state
 * fill to mark the current preset. No outer border / chip so the
 * control reads at the same visual weight as `⛶ pop back` and `⚙`.
 */
function WidthToggle({
  value,
  onChange,
}: {
  value: MessagesMaxWidth;
  onChange: (next: MessagesMaxWidth) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Message column width"
      className="flex items-center"
    >
      {WIDTH_OPTIONS.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            title={opt.tooltip}
            aria-label={opt.tooltip}
            className={cn(
              "inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors",
              active
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <WidthBars value={opt.value} />
          </button>
        );
      })}
    </div>
  );
}

/**
 * Tiny inline width indicator: a horizontal bar whose visible portion
 * grows with the preset. Pure CSS — no extra dependency on an icon set
 * that doesn't ship something this specific.
 */
function WidthBars({ value }: { value: MessagesMaxWidth }) {
  const span = value === "narrow" ? "w-1.5" : value === "comfortable" ? "w-3" : "w-4";
  return (
    <span className="relative inline-block h-2.5 w-4 overflow-hidden rounded-[2px] border border-current">
      <span className={cn("absolute inset-y-0 left-0 bg-current", span)} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Right rail — sessions list
// ---------------------------------------------------------------------------

interface SessionsRailProps {
  sessions: SessionMeta[];
  activeId: string;
  ready: boolean;
  query: string;
  onQuery: (v: string) => void;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}

/**
 * Vertical session list grouped by recency (Today / Yesterday / Older).
 * Selecting an entry hands the click off to the SidePanel via shared
 * session state (storage-backed) — there is no direct cross-component
 * messaging here, just side-effects through ``chrome.storage``.
 */
function SessionsRail({
  sessions,
  activeId,
  ready,
  query,
  onQuery,
  onOpen,
  onRename,
  onDelete,
}: SessionsRailProps) {
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const live = sessions.filter((s) => !s.archived);
    if (!q) return live;
    return live.filter((s) =>
      (s.title || "untitled chat").toLowerCase().includes(q),
    );
  }, [sessions, query]);

  const groups = useMemo(() => groupByRecency(filtered), [filtered]);

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          type="text"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search sessions…"
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
        />
        {query && (
          <button
            type="button"
            onClick={() => onQuery("")}
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {!ready ? (
          <p className="px-3 py-4 text-[11px] text-muted-foreground">
            Loading sessions…
          </p>
        ) : filtered.length === 0 ? (
          <p className="px-3 py-4 text-[11px] text-muted-foreground">
            {query ? "No matches." : "No saved sessions yet."}
          </p>
        ) : (
          <nav className="flex flex-col py-1">
            {groups.map((g) =>
              g.items.length === 0 ? null : (
                <div key={g.key} className="flex flex-col">
                  <p className="px-3 pt-2.5 pb-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    {g.label}
                  </p>
                  {g.items.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      active={s.id === activeId}
                      onOpen={() => onOpen(s.id)}
                      onRename={(title) => onRename(s.id, title)}
                      onDelete={() => onDelete(s.id)}
                    />
                  ))}
                </div>
              ),
            )}
          </nav>
        )}
      </ScrollArea>
    </>
  );
}

interface SessionRowProps {
  session: SessionMeta;
  active: boolean;
  onOpen: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}

function SessionRow({
  session,
  active,
  onOpen,
  onRename,
  onDelete,
}: SessionRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);

  // Re-sync the rename draft when the upstream title changes (e.g. the
  // auto-title generator wrote a fresh value while we weren't editing).
  useEffect(() => {
    if (!editing) setDraft(session.title);
  }, [session.title, editing]);

  function commit() {
    const next = draft.trim();
    if (next && next !== session.title) onRename(next);
    setEditing(false);
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setDraft(session.title);
      setEditing(false);
    }
  }

  if (editing) {
    return (
      <div
        className={cn(
          "group flex items-center gap-1 px-3 py-1.5",
          active && "bg-muted/70",
        )}
      >
        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onBlur={commit}
          className="h-6 min-w-0 flex-1 px-1.5 text-xs"
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group flex items-center gap-2 px-3 py-1.5 text-left transition-colors",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      <MessageSquare className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-xs font-medium">
        {session.title?.trim() || "Untitled chat"}
      </span>
      <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
          className="rounded p-0.5 text-muted-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground"
          title="Rename"
          aria-label="Rename"
        >
          <Pencil className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (
              confirm(
                `Delete "${session.title?.trim() || "this chat"}"? This removes it from history.`,
              )
            ) {
              onDelete();
            }
          }}
          className="rounded p-0.5 text-muted-foreground/70 transition-colors hover:bg-destructive/15 hover:text-destructive"
          title="Delete"
          aria-label="Delete"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </span>
      <span className="shrink-0 text-[9px] tabular-nums text-muted-foreground/70 group-hover:hidden">
        {formatRelativeShort(session.updatedAt)}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SessionGroup {
  key: "today" | "yesterday" | "older";
  label: string;
  items: SessionMeta[];
}

/**
 * Bucket sessions into Today / Yesterday / Older based on `updatedAt`.
 * Within each bucket, newest first (the input arrives in whatever order
 * `useSessions` returned — we sort defensively).
 */
function groupByRecency(sessions: SessionMeta[]): SessionGroup[] {
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;

  const groups: SessionGroup[] = [
    { key: "today", label: "Today", items: [] },
    { key: "yesterday", label: "Yesterday", items: [] },
    { key: "older", label: "Older", items: [] },
  ];

  for (const s of sessions) {
    const ts = s.updatedAt ?? 0;
    if (ts >= startOfToday) groups[0].items.push(s);
    else if (ts >= startOfYesterday) groups[1].items.push(s);
    else groups[2].items.push(s);
  }
  for (const g of groups) {
    g.items.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }
  return groups;
}

function formatRelativeShort(ms: number | undefined): string {
  if (!ms) return "";
  const diffSec = Math.round((Date.now() - ms) / 1000);
  if (diffSec < 60) return "now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  if (diffSec < 86400 * 30) return `${Math.floor(diffSec / 86400)}d`;
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

