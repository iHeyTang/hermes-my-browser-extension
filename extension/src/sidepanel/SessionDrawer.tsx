import {
  Check,
  Pencil,
  Plus,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~components/ui/button";
import { ScrollArea } from "~components/ui/scroll-area";
import { cn } from "~lib/utils";
import type { SessionMeta } from "~lib/sessions/types";

interface Props {
  open: boolean;
  sessions: SessionMeta[];
  /** ids currently shown as tabs in the header (not deleted, just maybe closed). */
  openTabIds: string[];
  activeId: string;
  onClose: () => void;
  /** Open the session as a tab and activate it. */
  onOpen: (id: string) => void;
  /** Spawn a brand new session and open it as a tab. */
  onCreate: () => void;
  onRename: (id: string, title: string) => void;
  /** Permanent delete: drops the session from history + closes its tab. */
  onDelete: (id: string) => void;
}

interface Group {
  label: string;
  items: SessionMeta[];
}

/**
 * Bins sessions by `updatedAt` into Today / Yesterday / Earlier this week /
 * This month / Older. Mirrors the grouping the Hermes WebUI uses; gives the
 * sidebar a familiar structure even when there are dozens of sessions.
 */
function groupSessions(sessions: SessionMeta[]): Group[] {
  const now = new Date();
  const startOfDay = (d: Date) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x.getTime();
  };
  const today = startOfDay(now);
  const yesterday = today - 24 * 60 * 60 * 1000;
  const sevenDays = today - 7 * 24 * 60 * 60 * 1000;
  const thirtyDays = today - 30 * 24 * 60 * 60 * 1000;

  const buckets: Group[] = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "Earlier this week", items: [] },
    { label: "This month", items: [] },
    { label: "Older", items: [] },
  ];

  // Pinned items always come first regardless of date.
  const pinned: SessionMeta[] = [];
  const rest: SessionMeta[] = [];
  for (const s of sessions) {
    if (s.archived) continue;
    if (s.pinned) pinned.push(s);
    else rest.push(s);
  }

  const sortByUpdated = (a: SessionMeta, b: SessionMeta) =>
    b.updatedAt - a.updatedAt;
  pinned.sort(sortByUpdated);
  rest.sort(sortByUpdated);

  for (const s of rest) {
    if (s.updatedAt >= today) buckets[0].items.push(s);
    else if (s.updatedAt >= yesterday) buckets[1].items.push(s);
    else if (s.updatedAt >= sevenDays) buckets[2].items.push(s);
    else if (s.updatedAt >= thirtyDays) buckets[3].items.push(s);
    else buckets[4].items.push(s);
  }

  const out: Group[] = [];
  if (pinned.length) out.push({ label: "Pinned", items: pinned });
  for (const b of buckets) if (b.items.length) out.push(b);
  return out;
}

export function SessionDrawer({
  open,
  sessions,
  openTabIds,
  activeId,
  onClose,
  onOpen,
  onCreate,
  onRename,
  onDelete,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");

  // Drop the editing state when the drawer closes; otherwise reopening
  // would land us in stale rename mode.
  useEffect(() => {
    if (!open) {
      setEditingId(null);
      setEditingValue("");
    }
  }, [open]);

  const groups = useMemo(() => groupSessions(sessions), [sessions]);
  const openSet = useMemo(() => new Set(openTabIds), [openTabIds]);

  if (!open) return null;

  const visibleCount = sessions.filter((s) => !s.archived).length;

  return (
    <div
      className="absolute inset-0 z-30 flex flex-col bg-background"
      role="dialog"
      aria-label="Session history"
    >
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <h2 className="text-sm font-semibold">History</h2>
        <span className="text-xs text-muted-foreground">{visibleCount}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            onClick={() => {
              onCreate();
              onClose();
            }}
          >
            <Plus className="mr-1" />
            New
          </Button>
          <Button size="icon" variant="ghost" onClick={onClose} title="Close">
            <X />
          </Button>
        </div>
      </header>

      <p className="border-b px-3 py-1.5 text-[11px] text-muted-foreground">
        Click a session to open it as a tab. The trash button{" "}
        <span className="font-medium">deletes permanently</span>; closing a
        tab from the top bar keeps it here.
      </p>

      <div className="flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="p-2">
            {groups.length === 0 && (
              <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
                No sessions yet. Send a message to start one.
              </div>
            )}
            {groups.map((g) => (
              <div key={g.label} className="mb-3">
                <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {g.label}
                </div>
                <ul className="space-y-0.5">
                  {g.items.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      active={s.id === activeId}
                      isOpen={openSet.has(s.id)}
                      editing={editingId === s.id}
                      editingValue={editingValue}
                      onEditingValueChange={setEditingValue}
                      onOpen={() => {
                        onOpen(s.id);
                        onClose();
                      }}
                      onStartEdit={() => {
                        setEditingId(s.id);
                        setEditingValue(s.title || "");
                      }}
                      onCommitEdit={() => {
                        const t = editingValue.trim();
                        if (t) onRename(s.id, t);
                        setEditingId(null);
                      }}
                      onCancelEdit={() => setEditingId(null)}
                      onDelete={() => onDelete(s.id)}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

interface RowProps {
  session: SessionMeta;
  active: boolean;
  /** Currently shown as a tab (not just kept in history). */
  isOpen: boolean;
  editing: boolean;
  editingValue: string;
  onEditingValueChange: (v: string) => void;
  onOpen: () => void;
  onStartEdit: () => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
}

function SessionRow({
  session,
  active,
  isOpen,
  editing,
  editingValue,
  onEditingValueChange,
  onOpen,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onDelete,
}: RowProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const displayTitle = session.title || "New chat";

  return (
    <li
      className={cn(
        "group flex items-center gap-1 rounded-md px-2 py-1.5 text-xs",
        active
          ? "bg-accent text-accent-foreground"
          : "hover:bg-accent/60 hover:text-accent-foreground",
      )}
    >
      {/* Open indicator: a small dot in the gutter for sessions whose tab
          is currently visible. Lets the user tell at a glance which History
          entries are also pinned in the working set. */}
      <span
        aria-hidden
        className={cn(
          "mr-0.5 h-1.5 w-1.5 shrink-0 rounded-full",
          isOpen ? "bg-foreground/40" : "bg-transparent",
        )}
        title={isOpen ? "Open as tab" : ""}
      />

      {editing ? (
        <input
          ref={inputRef}
          value={editingValue}
          onChange={(e) => onEditingValueChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onCommitEdit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancelEdit();
            }
          }}
          // Don't auto-commit on blur — that would race with the Cancel
          // button, which blurs the input before its onClick fires.
          className="min-w-0 flex-1 rounded border border-input bg-background px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-ring"
        />
      ) : (
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 truncate text-left"
          title={displayTitle}
        >
          <span className="truncate">{displayTitle}</span>
        </button>
      )}

      {editing ? (
        <>
          <RowAction icon={Check} title="Save" onClick={onCommitEdit} />
          <RowAction icon={X} title="Cancel" onClick={onCancelEdit} />
        </>
      ) : (
        <div
          className={cn(
            "flex items-center gap-0.5 opacity-0 transition-opacity",
            active ? "opacity-100" : "group-hover:opacity-100",
          )}
        >
          <RowAction icon={Pencil} title="Rename" onClick={onStartEdit} />
          <RowAction
            icon={Trash2}
            title="Delete permanently"
            onClick={() => {
              if (
                confirm(
                  `Permanently delete "${displayTitle}"? This drops the session and its messages from History — closing the tab from the top bar would have just hidden it.`,
                )
              ) {
                onDelete();
              }
            }}
          />
        </div>
      )}
    </li>
  );
}

function RowAction({
  icon: Icon,
  title,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="rounded p-1 hover:bg-foreground/10"
      title={title}
      aria-label={title}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}
