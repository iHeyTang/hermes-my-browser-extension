/**
 * New-tab Home page.
 *
 * Plasmo auto-registers this file as ``chrome_url_overrides.newtab``. The
 * Preferences toggle (``settings.newtab.enabled``) gates whether the page
 * renders; when disabled we either redirect to the user-configured
 * fallback URL or show a small splash with a link back to settings.
 *
 * Layout intent — a cron-run reader, not a search box:
 *
 *   ┌─────────────────────────────────────────────────────┐
 *   │ [Logo] Hermes                       [⚙ Settings]    │
 *   ├─────────────────────────────────────────────────────┤
 *   │ ╭─ Message Hermes ─────────────────────────────╮    │
 *   │ ╰──────────────────────────────────────────────╯    │
 *   │                                                     │
 *   │ ╭ History ╮ ╭ Selected run (markdown) ╮ ╭ Recent ╮  │
 *   │ │ row     │ │  ...full body...        │ │ chats  │  │
 *   │ │ row*    │ │                         │ │        │  │
 *   │ ╰─────────╯ ╰─────────────────────────╯ ╰────────╯  │
 *   └─────────────────────────────────────────────────────┘
 *
 * Left column: a list of recent cron runs (history). Selecting a row
 * loads its content into the centre column. The centre column defaults
 * to the most recent run on first load.
 */

import {
  AlertTriangle,
  ArrowUp,
  Check,
  CheckCircle2,
  Inbox as InboxIcon,
  MessageSquare,
  Moon,
  Plus,
  RefreshCw,
  Settings,
} from "lucide-react";
import { Streamdown } from "streamdown";
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
import { useCronRuns } from "~lib/cron-runs/use-cron-runs";
import {
  cronRunKey,
  type CronRun,
  type CronRunStatus,
} from "~lib/cron-runs/types";
import {
  DEFAULT_ROUTINES,
  getInstalledRoutineIds,
  installRoutine,
  type RoutineTemplate,
} from "~lib/cron-runs/default-routines";
import { useResume, type ResumeItem } from "~lib/resume/use-resume";
import { useSessions } from "~lib/sessions/use-sessions";
import { useResolvedTheme } from "~lib/theme";
import { useT } from "~lib/i18n";
import { cn } from "~lib/utils";

const NEWTAB_ENABLED_KEY = "settings.newtab.enabled";
const NEWTAB_FALLBACK_KEY = "settings.newtab.fallbackUrl";
const HOME_PENDING_PROMPT_KEY = "home.pendingPrompt";

const NEWTAB_DEFAULT_ENABLED = true;

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
  const { t } = useT();
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
        headline={t("newtab.redirecting.headline")}
        message={t("newtab.redirecting.message", { url: state.url })}
      />
    );
  }
  if (state.kind === "disabled") {
    return (
      <DisabledSplash
        headline={t("newtab.disabled.headline")}
        message={t("newtab.disabled.message")}
      />
    );
  }
  return <div className="h-screen w-full bg-background" />;
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

function Home() {
  const { t } = useT();
  const sessions = useSessions();
  const cronRuns = useCronRuns();
  const resume = useResume(sessions.sessions);

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // On mount: focus composer; on focus re-pull runs so a long-open tab
  // catches up. Initial fetch is fired by the hook itself.
  useEffect(() => {
    inputRef.current?.focus();
    const onFocus = () => {
      void cronRuns.refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Selection rule: the user's explicit pick if it's still in the list;
  // otherwise the newest run. Keeps "latest by default" without stomping
  // a deliberate selection that survives a refresh.
  const selectedRun = useMemo<CronRun | null>(() => {
    if (cronRuns.runs.length === 0) return null;
    if (selectedKey) {
      const found = cronRuns.runs.find((r) => cronRunKey(r) === selectedKey);
      if (found) return found;
    }
    return cronRuns.runs[0];
  }, [cronRuns.runs, selectedKey]);

  function goToChatTab() {
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
      await sessions.createNew();
      await chrome.storage.local.set({
        [HOME_PENDING_PROMPT_KEY]: { text: trimmed, ts: Date.now() },
      });
      goToChatTab();
    } finally {
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

  /**
   * "Continue in chat": seed a fresh session with the selected run's
   * full markdown so the assistant has context without a round-trip
   * through memory.
   */
  async function continueRunInChat(run: CronRun) {
    if (!sessions.ready) return;
    setBusy(true);
    try {
      await sessions.createNew();
      const stamp = new Date(run.runAtMs).toLocaleString();
      const prompt = t("newtab.continueInChat.prompt", {
        name: run.jobName,
        time: stamp,
        content: run.content,
      });
      await chrome.storage.local.set({
        [HOME_PENDING_PROMPT_KEY]: { text: prompt, ts: Date.now() },
      });
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
      <TopBar
        onRefresh={() => void cronRuns.refresh()}
        onOpenSettings={() => chrome.runtime.openOptionsPage()}
      />

      <main className="flex w-full flex-1 flex-col gap-6 overflow-hidden px-8 pb-8 pt-8">
        <section className="mx-auto w-full max-w-2xl shrink-0 space-y-2">
          <div className="space-y-0.5 px-0.5">
            <p className="text-sm font-semibold text-foreground">
              {t("newtab.greeting")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("newtab.subtitle")}
            </p>
          </div>
          <ComposerCard
            ref={inputRef}
            value={input}
            onChange={setInput}
            onKeyDown={onKeyDown}
            onSend={() => void submitToChat(input)}
            canSend={canSend}
            busy={busy}
          />
        </section>

        {/* Three columns: History · Selected run content · Recent chats.
            The centre column is the focal point (~2× the sides). On
            narrow viewports (< lg) the three stack vertically. */}
        <div className="flex min-h-0 flex-1 flex-col gap-5 lg:flex-row">
          <CronHistorySection
            ready={cronRuns.ready}
            runs={cronRuns.runs}
            selectedKey={selectedRun ? cronRunKey(selectedRun) : null}
            onSelect={(r) => setSelectedKey(cronRunKey(r))}
          />

          <CronContentSection
            ready={cronRuns.ready}
            run={selectedRun}
            onContinueInChat={(r) => void continueRunInChat(r)}
          />

          <ResumeSection
            ready={resume.ready}
            items={resume.items}
            busy={busy}
            onOpenSession={(id) => void openSession(id)}
          />
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

function TopBar({
  onRefresh,
  onOpenSettings,
}: {
  onRefresh: () => void;
  onOpenSettings: () => void;
}) {
  const { t } = useT();
  return (
    <header className="flex shrink-0 items-center justify-between gap-3 px-6 py-4">
      <div className="flex items-center gap-2.5">
        <HermesLogo size={22} />
        <p className="text-sm font-semibold tracking-tight">
          {t("app.title")}
        </p>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onRefresh}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={t("newtab.refresh")}
          title={t("newtab.refresh")}
        >
          <RefreshCw className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={t("newtab.openOptions")}
          title={t("newtab.openOptions")}
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Module wrapper — shared visual container for every dashboard column.
// ---------------------------------------------------------------------------

function ModuleCard({
  title,
  meta,
  sizeClass,
  bodyClassName,
  children,
}: {
  title: string;
  meta?: React.ReactNode;
  sizeClass: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border border-border bg-card/40",
        sizeClass,
      )}
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-4 py-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h2>
        {meta}
      </header>
      <div className={cn("min-h-0 flex-1 overflow-y-auto", bodyClassName)}>
        {children}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Cron history — left column
// ---------------------------------------------------------------------------

function CronHistorySection({
  ready,
  runs,
  selectedKey,
  onSelect,
}: {
  ready: boolean;
  runs: CronRun[];
  selectedKey: string | null;
  onSelect: (run: CronRun) => void;
}) {
  const { t } = useT();
  const isEmpty = ready && runs.length === 0;
  return (
    <ModuleCard
      title={t("newtab.history")}
      sizeClass="min-h-0 min-w-0 flex-1 lg:flex-1"
    >
      {!ready ? (
        <HistorySkeleton />
      ) : isEmpty ? (
        <EmptyState />
      ) : (
        <ul className="divide-y divide-border/40">
          {runs.map((r) => {
            const key = cronRunKey(r);
            return (
              <li key={key}>
                <CronHistoryRow
                  run={r}
                  selected={key === selectedKey}
                  onSelect={onSelect}
                />
              </li>
            );
          })}
        </ul>
      )}
    </ModuleCard>
  );
}

function CronHistoryRow({
  run,
  selected,
  onSelect,
}: {
  run: CronRun;
  selected: boolean;
  onSelect: (r: CronRun) => void;
}) {
  const { t } = useT();
  return (
    <button
      type="button"
      onClick={() => onSelect(run)}
      className={cn(
        "flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors",
        selected ? "bg-muted/60" : "hover:bg-muted/50",
        "focus:outline-none focus-visible:bg-muted/50",
      )}
    >
      <StatusIcon status={run.status} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-foreground">
          {run.jobName}
          {run.status === "error" && (
            <span className="ml-1 text-muted-foreground">
              {t("newtab.row.failed")}
            </span>
          )}
          {run.status === "silent" && (
            <span className="ml-1 text-muted-foreground">
              {t("newtab.row.silent")}
            </span>
          )}
        </span>
      </span>
      <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground/80">
        {formatRelative(run.runAtMs, t)}
      </span>
    </button>
  );
}

function HistorySkeleton() {
  return (
    <div className="divide-y divide-border/40">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-2.5 px-4 py-2">
          <div className="h-3.5 w-3.5 shrink-0 animate-pulse rounded-full bg-muted/40" />
          <div className="h-3 flex-1 animate-pulse rounded bg-muted/40" />
        </div>
      ))}
    </div>
  );
}

function StatusIcon({ status }: { status: CronRunStatus }) {
  if (status === "error") {
    return (
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
    );
  }
  if (status === "silent") {
    return (
      <Moon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
    );
  }
  return (
    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
  );
}

/**
 * Cold-start state for the history column — no cron jobs installed yet,
 * so offer one-click installs of the default routines instead of
 * dead-ending the user.
 */
function EmptyState() {
  const { t } = useT();
  const [installedIds, setInstalledIds] = useState<Set<string>>(new Set());
  const [ready, setReady] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getInstalledRoutineIds().then((s) => {
      if (cancelled) return;
      setInstalledIds(s);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onInstall(routine: RoutineTemplate) {
    setBusyId(routine.id);
    setError(null);
    const res = await installRoutine(routine);
    setBusyId(null);
    if (res.ok) {
      setInstalledIds((prev) => new Set(prev).add(routine.id));
    } else {
      setError(res.error ?? t("newtab.install.failed"));
    }
  }

  const anyInstalled = installedIds.size > 0;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
      <div className="text-center">
        <h3 className="text-sm font-semibold">
          {anyInstalled
            ? t("newtab.empty.installed")
            : t("newtab.empty.headline")}
        </h3>
        <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
          {anyInstalled
            ? t("newtab.empty.installedDesc")
            : t("newtab.empty.headlineDesc")}
        </p>
      </div>

      <div className="flex w-full max-w-md flex-col gap-1.5">
        {DEFAULT_ROUTINES.map((routine) => {
          const installed = installedIds.has(routine.id);
          const rowBusy = busyId === routine.id;
          return (
            <button
              key={routine.id}
              type="button"
              disabled={!ready || installed || rowBusy}
              onClick={() => void onInstall(routine)}
              className={cn(
                "flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                installed
                  ? "border-border/50 bg-muted/20"
                  : "border-border bg-background hover:border-foreground/30 hover:bg-muted/40",
                "disabled:cursor-default",
              )}
            >
              <span className="text-base leading-none">{routine.emoji}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-foreground">
                  {routine.name}
                </span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {routine.description} · {routine.scheduleLabel}
                </span>
              </span>
              <span className="shrink-0 text-muted-foreground">
                {installed ? (
                  <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                ) : rowBusy ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
              </span>
            </button>
          );
        })}
      </div>

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-[11px] text-destructive">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={() => chrome.runtime.openOptionsPage()}
        className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground/80 transition-colors hover:text-foreground"
      >
        <InboxIcon className="h-3.5 w-3.5" />
        {t("newtab.empty.customCron")}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cron content — centre column
// ---------------------------------------------------------------------------

function CronContentSection({
  ready,
  run,
  onContinueInChat,
}: {
  ready: boolean;
  run: CronRun | null;
  onContinueInChat: (run: CronRun) => void;
}) {
  const { t } = useT();
  const meta = run ? (
    <span className="truncate text-[10px] tabular-nums text-muted-foreground/70">
      {run.jobName} · {new Date(run.runAtMs).toLocaleString()}
    </span>
  ) : null;

  return (
    <ModuleCard
      title={t("newtab.latest")}
      meta={meta}
      sizeClass="min-h-0 min-w-0 flex-1 lg:flex-[2]"
      bodyClassName={!run ? "" : "flex flex-col"}
    >
      {!ready ? (
        <ContentSkeleton />
      ) : !run ? (
        <div className="flex h-full items-center justify-center p-6">
          <p className="text-xs text-muted-foreground">
            {t("newtab.content.empty")}
          </p>
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {run.content ? (
              <Streamdown
                mode="static"
                className="chat-md break-words text-sm text-foreground/90"
              >
                {run.content}
              </Streamdown>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t("newtab.content.empty.row")}
              </p>
            )}
            {run.truncatedBySize && (
              <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
                {t("newtab.content.truncated")}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border/60 bg-muted/20 px-4 py-2">
            <button
              type="button"
              onClick={() => onContinueInChat(run)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                "bg-foreground text-background hover:bg-foreground/85",
              )}
            >
              <MessageSquare className="h-3.5 w-3.5" />
              {t("newtab.continueInChat")}
            </button>
          </div>
        </>
      )}
    </ModuleCard>
  );
}

function ContentSkeleton() {
  return (
    <div className="space-y-3 px-6 py-5">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="h-4 animate-pulse rounded bg-muted/40"
          style={{ width: `${[88, 72, 95, 60][i]}%` }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

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
    const { t } = useT();
    return (
      <div className="relative rounded-2xl border border-border bg-background shadow-sm transition-colors focus-within:border-foreground/30">
        <Textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("newtab.placeholder")}
          rows={2}
          disabled={busy}
          className="max-h-60 min-h-[3.5rem] resize-none border-0 bg-transparent px-4 py-3 pr-12 text-sm shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
        />
        <button
          type="button"
          onClick={onSend}
          disabled={!canSend}
          title={t("newtab.send.tooltip")}
          aria-label={t("newtab.send")}
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

// ---------------------------------------------------------------------------
// Resume section — right column
// ---------------------------------------------------------------------------

function ResumeSection({
  ready,
  items,
  busy,
  onOpenSession,
}: {
  ready: boolean;
  items: ResumeItem[];
  busy: boolean;
  onOpenSession: (id: string) => void;
}) {
  const { t } = useT();
  if (!ready || items.length === 0) return null;

  return (
    <ModuleCard
      title={t("newtab.recentChats")}
      meta={
        <span className="text-[10px] text-muted-foreground/70">
          {t("newtab.clickToResume")}
        </span>
      }
      sizeClass="min-h-0 min-w-0 flex-1 lg:flex-1"
    >
      <ul className="divide-y divide-border/40">
        {items.map((item) => (
          <li key={item.id}>
            <ResumeRow item={item} busy={busy} onOpenSession={onOpenSession} />
          </li>
        ))}
      </ul>
    </ModuleCard>
  );
}

function ResumeRow({
  item,
  busy,
  onOpenSession,
}: {
  item: ResumeItem;
  busy: boolean;
  onOpenSession: (id: string) => void;
}) {
  const { t } = useT();
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => onOpenSession(item.id)}
      className={cn(
        "flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors",
        "hover:bg-muted/50",
        "disabled:cursor-not-allowed disabled:opacity-50",
      )}
    >
      <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-foreground">
          {item.title}
        </span>
      </span>
      {item.messageCount > 0 && (
        <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground/70">
          {t("newtab.row.msgs", { count: item.messageCount })}
        </span>
      )}
      <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground/80">
        {formatRelative(item.ts, t)}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Disabled splash
// ---------------------------------------------------------------------------

function DisabledSplash({
  headline,
  message,
}: {
  headline: string;
  message: string;
}) {
  const { t } = useT();
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
          {t("newtab.openOptions")}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelative(
  ms: number | undefined,
  t: ReturnType<typeof useT>["t"],
): string {
  if (!ms) return "";
  const diffSec = Math.round((Date.now() - ms) / 1000);
  if (diffSec < 60) return t("newtab.relative.justNow");
  if (diffSec < 3600) {
    return t("newtab.relative.mAgo", { n: Math.floor(diffSec / 60) });
  }
  if (diffSec < 86400) {
    return t("newtab.relative.hAgo", { n: Math.floor(diffSec / 3600) });
  }
  if (diffSec < 86400 * 7) {
    return t("newtab.relative.dAgo", { n: Math.floor(diffSec / 86400) });
  }
  return new Date(ms).toLocaleDateString();
}
