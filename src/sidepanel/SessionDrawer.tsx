import { Check, Pencil, Trash2, X, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~components/ui/button";
import { ScrollArea } from "~components/ui/scroll-area";
import { useT, type TranslateFn } from "~lib/i18n";
import type { SessionMeta } from "~lib/sessions/types";
import { cn } from "~lib/utils";

interface Props {
  open: boolean;
  sessions: SessionMeta[];
  /** ids currently shown as tabs in the header (not deleted, just maybe closed). */
  openTabIds: string[];
  activeId: string;
  onClose: () => void;
  /** Open the session as a tab and activate it. */
  onOpen: (id: string) => void;
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
function groupSessions(sessions: SessionMeta[], t: TranslateFn): Group[] {
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
    { label: t("sidepanel.sessions.group.today"), items: [] },
    { label: t("sidepanel.sessions.group.yesterday"), items: [] },
    { label: t("sidepanel.sessions.group.earlierWeek"), items: [] },
    { label: t("sidepanel.sessions.group.thisMonth"), items: [] },
    { label: t("sidepanel.sessions.group.older"), items: [] },
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
  if (pinned.length)
    out.push({ label: t("sidepanel.sessions.group.pinned"), items: pinned });
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
  onRename,
  onDelete,
}: Props) {
  const { t } = useT();
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

  const groups = useMemo(() => groupSessions(sessions, t), [sessions, t]);
  const openSet = useMemo(() => new Set(openTabIds), [openTabIds]);

  if (!open) return null;

  const visibleCount = sessions.filter((s) => !s.archived).length;

  return (
    <div
      className="absolute inset-0 z-30 flex flex-col bg-background"
      role="dialog"
      aria-label={t("sidepanel.sessions.dialogAria")}
    >
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <h2 className="text-sm font-semibold">
          {t("sidepanel.sessions.title")}
        </h2>
        <span className="text-xs text-muted-foreground">{visibleCount}</span>
        <div className="ml-auto">
          <Button
            size="icon"
            variant="ghost"
            onClick={onClose}
            title={t("sidepanel.sessions.close")}
          >
            <X />
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="p-2">
            {groups.length === 0 && (
              <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
                {t("sidepanel.sessions.empty")}
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
                        const trimmed = editingValue.trim();
                        if (trimmed) onRename(s.id, trimmed);
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
  const { t } = useT();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const displayTitle = session.title || t("sidepanel.sessions.newChatTitle");

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
        title={isOpen ? t("sidepanel.sessions.openAsTab") : ""}
      />

      {editing ? (
        <input
          ref={inputRef}
          value={editingValue}
          onChange={(e) => onEditingValueChange(e.target.value)}
          onKeyDown={(e) => {
            const ne = e.nativeEvent;
            if (ne.isComposing || e.key === "Process") {
              return;
            }
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
          <RowAction
            icon={Check}
            title={t("sidepanel.sessions.save")}
            onClick={onCommitEdit}
          />
          <RowAction
            icon={X}
            title={t("sidepanel.sessions.cancel")}
            onClick={onCancelEdit}
          />
        </>
      ) : (
        <div
          className={cn(
            "flex items-center gap-0.5 opacity-0 transition-opacity",
            active ? "opacity-100" : "group-hover:opacity-100",
          )}
        >
          <RowAction
            icon={Pencil}
            title={t("sidepanel.sessions.rename")}
            onClick={onStartEdit}
          />
          <RowAction
            icon={Trash2}
            title={t("sidepanel.sessions.deletePermanently")}
            onClick={() => {
              if (
                confirm(
                  t("sidepanel.sessions.deleteConfirm", {
                    title: displayTitle,
                  }),
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
