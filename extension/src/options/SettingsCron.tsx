import {
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Zap,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Badge } from "~components/ui/badge";
import { Button } from "~components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~components/ui/dialog";
import { Input } from "~components/ui/input";
import { Label } from "~components/ui/label";
import { ScrollArea } from "~components/ui/scroll-area";
import { Switch } from "~components/ui/switch";
import { Textarea } from "~components/ui/textarea";
import {
  createHermesCronJob,
  deleteHermesCronJob,
  getHermesCronJobs,
  pauseHermesCronJob,
  previewHermesCronSchedule,
  resumeHermesCronJob,
  triggerHermesCronJob,
  updateHermesCronJob,
  type HermesCronCreateInput,
  type HermesCronJob,
  type HermesCronParsePreviewResponse,
  type HermesCronState,
  type HermesCronUpdateInput,
} from "~lib/hermes-cron";
import { cn } from "~lib/utils";

import { OPTIONS_SHELL_HEADER_ROW } from "./optionsPageChrome";

const STATE_META: Record<
  string,
  { label: string; className: string; tooltip: string }
> = {
  scheduled: {
    label: "Scheduled",
    className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    tooltip: "Next run is queued",
  },
  running: {
    label: "Running",
    className: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
    tooltip: "Currently executing",
  },
  paused: {
    label: "Paused",
    className: "bg-muted text-muted-foreground",
    tooltip: "Manually paused; will not fire on schedule",
  },
  completed: {
    label: "Completed",
    className: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
    tooltip: "One-shot job has finished",
  },
  error: {
    label: "Error",
    className: "bg-destructive/15 text-destructive",
    tooltip: "Failed to compute next run or the last run errored",
  },
};

function stateMeta(state: HermesCronState) {
  return (
    STATE_META[state] ?? {
      label: state || "Unknown",
      className: "bg-muted text-muted-foreground",
      tooltip: state || "",
    }
  );
}

function formatAbsolute(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diffSec = Math.round((t - Date.now()) / 1000);
  const abs = Math.abs(diffSec);
  const future = diffSec > 0;
  const word = (n: number, unit: string) =>
    future ? `in ${n} ${unit}${n === 1 ? "" : "s"}` : `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (abs < 60) return future ? "soon" : "just now";
  if (abs < 3600) return word(Math.floor(abs / 60), "minute");
  if (abs < 86400) return word(Math.floor(abs / 3600), "hour");
  if (abs < 86400 * 30) return word(Math.floor(abs / 86400), "day");
  if (abs < 86400 * 365) return word(Math.floor(abs / (86400 * 30)), "month");
  return word(Math.floor(abs / (86400 * 365)), "year");
}

/**
 * Live-validates a schedule string by calling the bridge's preview endpoint.
 * Debounced; the parse is cheap on the backend but we still don't need to
 * re-run it on every keystroke. Tracks both the latest parsed result and an
 * error string for invalid inputs.
 */
function useSchedulePreview(value: string, enabled: boolean) {
  const [preview, setPreview] =
    useState<HermesCronParsePreviewResponse | null>(null);
  const [pending, setPending] = useState(false);
  const debounceRef = useRef<number | null>(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (!enabled || !value.trim()) {
      setPreview(null);
      setPending(false);
      return;
    }
    setPending(true);
    debounceRef.current = window.setTimeout(() => {
      const id = ++reqIdRef.current;
      void previewHermesCronSchedule(value.trim()).then((r) => {
        if (id !== reqIdRef.current) return;
        setPreview(r);
        setPending(false);
      });
    }, 300);
    return () => {
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [value, enabled]);

  return { preview, pending };
}

interface JobFormState {
  name: string;
  prompt: string;
  schedule: string;
  deliver: "local" | "origin";
  noAgent: boolean;
  script: string;
  repeat: string;
  skills: string;
  model: string;
  workdir: string;
}

function emptyForm(): JobFormState {
  return {
    name: "",
    prompt: "",
    schedule: "",
    deliver: "local",
    noAgent: false,
    script: "",
    repeat: "",
    skills: "",
    model: "",
    workdir: "",
  };
}

function jobToForm(job: HermesCronJob): JobFormState {
  return {
    name: job.name ?? "",
    prompt: job.prompt ?? "",
    schedule: job.schedule_display ?? job.schedule?.display ?? "",
    deliver: job.deliver === "origin" ? "origin" : "local",
    noAgent: !!job.no_agent,
    script: job.script ?? "",
    repeat:
      job.repeat?.times != null ? String(job.repeat.times) : "",
    skills: (job.skills ?? []).join(", "),
    model: job.model ?? "",
    workdir: job.workdir ?? "",
  };
}

function buildCreateInput(form: JobFormState): HermesCronCreateInput | string {
  const schedule = form.schedule.trim();
  if (!schedule) return "Schedule is required";

  const prompt = form.prompt.trim();
  const noAgent = form.noAgent;
  const script = form.script.trim() || undefined;

  if (noAgent && !script) {
    return "no_agent mode requires a script";
  }
  if (!noAgent && !prompt) {
    return "Prompt is required (unless no_agent mode is enabled)";
  }

  const skillsList = form.skills
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const repeatRaw = form.repeat.trim();
  let repeat: number | undefined;
  if (repeatRaw) {
    const n = Number(repeatRaw);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      return "Repeat must be 0 or a positive integer";
    }
    repeat = n;
  }

  const input: HermesCronCreateInput = {
    schedule,
    deliver: form.deliver,
    no_agent: noAgent,
  };
  if (prompt) input.prompt = prompt;
  if (form.name.trim()) input.name = form.name.trim();
  if (script) input.script = script;
  if (skillsList.length) input.skills = skillsList;
  if (form.model.trim()) input.model = form.model.trim();
  if (form.workdir.trim()) input.workdir = form.workdir.trim();
  if (repeat != null) input.repeat = repeat;

  return input;
}

function buildUpdateInput(form: JobFormState): HermesCronUpdateInput | string {
  const created = buildCreateInput(form);
  if (typeof created === "string") return created;
  const update: HermesCronUpdateInput = {
    schedule: created.schedule,
    deliver: created.deliver,
    no_agent: created.no_agent,
    name: created.name ?? "",
    prompt: created.prompt ?? "",
    skills: created.skills ?? [],
    model: created.model ?? null,
    script: created.script ?? null,
    workdir: created.workdir ?? null,
  };
  if (typeof created.repeat === "number") {
    update.repeat = created.repeat;
  }
  return update;
}

interface JobDialogProps {
  open: boolean;
  mode: "create" | "edit";
  initial: JobFormState;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (form: JobFormState) => Promise<void>;
}

function JobDialog({
  open,
  mode,
  initial,
  busy,
  error,
  onClose,
  onSubmit,
}: JobDialogProps) {
  const [form, setForm] = useState<JobFormState>(initial);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(initial);
      // Open the advanced panel automatically if any advanced field is set,
      // so editing an existing job doesn't hide non-default values.
      setAdvancedOpen(
        !!(
          initial.skills ||
          initial.model ||
          initial.workdir ||
          initial.repeat ||
          initial.noAgent ||
          initial.script
        ),
      );
    }
  }, [open, initial]);

  const { preview, pending: previewPending } = useSchedulePreview(
    form.schedule,
    open,
  );

  function patch<K extends keyof JobFormState>(key: K, value: JobFormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="flex max-h-[85vh] w-[90vw] max-w-2xl flex-col gap-0 p-0">
        <DialogHeader className="border-b border-border bg-muted/30 px-4 py-3">
          <DialogTitle className="text-sm font-semibold">
            {mode === "create" ? "Create cron job" : "Edit cron job"}
          </DialogTitle>
          <DialogDescription className="text-[11px] text-muted-foreground">
            Stored in ~/.hermes/cron/jobs.json and executed by Hermes Agent
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 px-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="cron-name" className="text-xs">
                Name
              </Label>
              <Input
                id="cron-name"
                value={form.name}
                onChange={(e) => patch("name", e.target.value)}
                placeholder="(optional; defaults to the first 50 chars of the prompt)"
                className="h-8 text-xs"
                disabled={busy}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cron-schedule" className="text-xs">
                Schedule <span className="text-destructive">*</span>
              </Label>
              <Input
                id="cron-schedule"
                value={form.schedule}
                onChange={(e) => patch("schedule", e.target.value)}
                placeholder="0 9 * * *  /  every 30m  /  30m  /  2026-02-03T14:00"
                className="h-8 font-mono text-xs"
                disabled={busy}
              />
              <p className="text-[10px] text-muted-foreground">
                Accepts: 5-field cron expression · "every 30m / 2h / 1d" ·
                duration "30m / 2h / 1d" (one-shot) · ISO timestamp
              </p>
              <SchedulePreview
                schedule={form.schedule}
                preview={preview}
                pending={previewPending}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cron-prompt" className="text-xs">
                Prompt {form.noAgent ? "" : <span className="text-destructive">*</span>}
              </Label>
              <Textarea
                id="cron-prompt"
                value={form.prompt}
                onChange={(e) => patch("prompt", e.target.value)}
                placeholder={
                  form.noAgent
                    ? "(optional in no_agent mode; used only as a name hint)"
                    : "Instructions Hermes Agent will run. Must be self-contained (no session context)."
                }
                className="min-h-[120px] font-mono text-xs"
                disabled={busy}
              />
            </div>

            <div className="flex flex-wrap items-center gap-4 rounded border border-border/60 bg-muted/20 px-3 py-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="cron-deliver" className="text-xs">
                  Delivery
                </Label>
                <select
                  id="cron-deliver"
                  value={form.deliver}
                  onChange={(e) =>
                    patch("deliver", e.target.value as "local" | "origin")
                  }
                  disabled={busy}
                  className="h-7 rounded border border-border bg-background px-2 text-xs"
                >
                  <option value="local">local (write to disk only)</option>
                  <option value="origin">origin (post back to source chat)</option>
                </select>
              </div>
              <button
                type="button"
                onClick={() => setAdvancedOpen((v) => !v)}
                className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:underline"
              >
                {advancedOpen ? "Hide advanced" : "Show advanced"}
              </button>
            </div>

            {advancedOpen && (
              <div className="space-y-3 rounded border border-border/60 bg-muted/10 px-3 py-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-xs font-medium">no_agent mode</p>
                    <p className="text-[10px] text-muted-foreground">
                      Run the script directly without the LLM; empty stdout is silent.
                    </p>
                  </div>
                  <Switch
                    checked={form.noAgent}
                    onCheckedChange={(v) => patch("noAgent", v)}
                    disabled={busy}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="cron-script" className="text-xs">
                    Script
                  </Label>
                  <Input
                    id="cron-script"
                    value={form.script}
                    onChange={(e) => patch("script", e.target.value)}
                    placeholder="Resolved under ~/.hermes/scripts/; absolute paths also accepted"
                    className="h-8 font-mono text-xs"
                    disabled={busy}
                  />
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="cron-repeat" className="text-xs">
                      Repeat count
                    </Label>
                    <Input
                      id="cron-repeat"
                      type="number"
                      min={0}
                      value={form.repeat}
                      onChange={(e) => patch("repeat", e.target.value)}
                      placeholder="Leave blank = unlimited"
                      className="h-8 text-xs"
                      disabled={busy}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="cron-model" className="text-xs">
                      Model override
                    </Label>
                    <Input
                      id="cron-model"
                      value={form.model}
                      onChange={(e) => patch("model", e.target.value)}
                      placeholder="e.g. claude-opus-4-7"
                      className="h-8 font-mono text-xs"
                      disabled={busy}
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="cron-skills" className="text-xs">
                    Skills (comma-separated)
                  </Label>
                  <Input
                    id="cron-skills"
                    value={form.skills}
                    onChange={(e) => patch("skills", e.target.value)}
                    placeholder="lark-mail, lark-calendar"
                    className="h-8 font-mono text-xs"
                    disabled={busy}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="cron-workdir" className="text-xs">
                    Working directory
                  </Label>
                  <Input
                    id="cron-workdir"
                    value={form.workdir}
                    onChange={(e) => patch("workdir", e.target.value)}
                    placeholder="Absolute path; blank = scheduler cwd"
                    className="h-8 font-mono text-xs"
                    disabled={busy}
                  />
                </div>
              </div>
            )}

            {error && (
              <p className="text-xs text-destructive">{error}</p>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="border-t border-border bg-muted/20 px-4 py-3">
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void onSubmit(form)}
          >
            {busy ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : null}
            {mode === "create" ? "Create" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SchedulePreview({
  schedule,
  preview,
  pending,
}: {
  schedule: string;
  preview: HermesCronParsePreviewResponse | null;
  pending: boolean;
}) {
  if (!schedule.trim()) return null;
  if (pending) {
    return (
      <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Parsing…
      </p>
    );
  }
  if (!preview) return null;
  if (!preview.ok) {
    return (
      <p className="text-[10px] text-destructive">{preview.error}</p>
    );
  }
  const kind = preview.schedule?.kind ?? "?";
  return (
    <p className="text-[10px] text-emerald-700 dark:text-emerald-300">
      ✓ {kind} · parsed as “{preview.display ?? schedule}”
      {preview.next_run_at && (
        <span className="ml-1 text-muted-foreground">
          · next: {formatAbsolute(preview.next_run_at)}
        </span>
      )}
    </p>
  );
}

interface JobRowProps {
  job: HermesCronJob;
  busy: boolean;
  onPause: (job: HermesCronJob) => void;
  onResume: (job: HermesCronJob) => void;
  onTrigger: (job: HermesCronJob) => void;
  onEdit: (job: HermesCronJob) => void;
  onDelete: (job: HermesCronJob) => void;
}

function JobRow({
  job,
  busy,
  onPause,
  onResume,
  onTrigger,
  onEdit,
  onDelete,
}: JobRowProps) {
  const stateInfo = stateMeta(job.state);
  const paused = job.state === "paused" || !job.enabled;
  const nextRunRel = formatRelative(job.next_run_at);
  const lastRunRel = formatRelative(job.last_run_at);

  return (
    <li className="flex flex-col gap-2 border-b border-border/40 px-3 py-3 last:border-b-0 hover:bg-muted/30">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-xs font-semibold tracking-tight">
          {job.name}
        </span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[10px] font-medium",
            stateInfo.className,
          )}
          title={stateInfo.tooltip}
        >
          {stateInfo.label}
        </span>
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {job.schedule_display}
        </code>
        {job.no_agent && (
          <Badge
            variant="outline"
            className="h-4 px-1 text-[9px] leading-none"
            title="no_agent mode: runs the script directly"
          >
            no_agent
          </Badge>
        )}
        {job.deliver !== "local" && (
          <Badge
            variant="outline"
            className="h-4 px-1 text-[9px] leading-none"
            title="Delivery target"
          >
            {job.deliver}
          </Badge>
        )}
        {job.repeat?.times != null && (
          <span
            className="text-[10px] text-muted-foreground"
            title="Completed / total scheduled runs"
          >
            {job.repeat.completed}/{job.repeat.times}
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/70">
          {job.id}
        </span>
      </div>

      {job.prompt && (
        <p className="line-clamp-2 whitespace-pre-wrap break-words text-[11px] leading-snug text-muted-foreground">
          {job.prompt}
        </p>
      )}

      {job.script && (
        <p
          className="truncate font-mono text-[10px] text-muted-foreground/80"
          title={job.script}
        >
          script: {job.script}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        <span title={formatAbsolute(job.next_run_at)}>
          Next: {nextRunRel || formatAbsolute(job.next_run_at)}
        </span>
        <span title={formatAbsolute(job.last_run_at)}>
          Last: {lastRunRel || "—"}
          {job.last_status === "error" && (
            <span className="ml-1 text-destructive">· failed</span>
          )}
        </span>
        {job.skills.length > 0 && (
          <span title={`skills: ${job.skills.join(", ")}`}>
            skills: {job.skills.join(", ")}
          </span>
        )}
      </div>

      {(job.last_error || job.last_delivery_error || job.paused_reason) && (
        <div className="space-y-0.5 rounded border border-destructive/30 bg-destructive/5 px-2 py-1 text-[10px] text-destructive">
          {job.last_error && <p>Error: {job.last_error}</p>}
          {job.last_delivery_error && (
            <p>Delivery failed: {job.last_delivery_error}</p>
          )}
          {job.paused_reason && <p>Paused: {job.paused_reason}</p>}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          disabled={busy}
          onClick={() => onTrigger(job)}
          title="Trigger one run now (fires on the next scheduler tick)"
        >
          <Zap className="h-3.5 w-3.5" />
          Trigger now
        </Button>
        {paused ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            disabled={busy}
            onClick={() => onResume(job)}
            title="Resume scheduling"
          >
            <Play className="h-3.5 w-3.5" />
            Resume
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            disabled={busy}
            onClick={() => onPause(job)}
            title="Pause the job (keeps configuration)"
          >
            <Pause className="h-3.5 w-3.5" />
            Pause
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          disabled={busy}
          onClick={() => onEdit(job)}
          title="Edit job"
        >
          <Pencil className="h-3.5 w-3.5" />
          Edit
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-7 gap-1 px-2 text-xs text-destructive hover:text-destructive"
          disabled={busy}
          onClick={() => onDelete(job)}
          title="Delete job"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </Button>
      </div>
    </li>
  );
}

export function SettingsCron() {
  const [jobs, setJobs] = useState<HermesCronJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Single-flight per-job lock for lifecycle actions. Lets each row spin its
  // own buttons without blocking the table; matches what SettingsSkills does.
  const [busyJobIds, setBusyJobIds] = useState<Set<string>>(() => new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<HermesCronJob | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const r = await getHermesCronJobs();
    setLoading(false);
    if (!r.ok) {
      setError(r.error || "Failed to load");
      setJobs([]);
      return;
    }
    setJobs(r.jobs);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const markBusy = useCallback((id: string, on: boolean) => {
    setBusyJobIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const runAction = useCallback(
    async (
      job: HermesCronJob,
      op: () => Promise<{ ok: boolean; error?: string; job?: HermesCronJob }>,
    ) => {
      markBusy(job.id, true);
      setActionError(null);
      const r = await op();
      markBusy(job.id, false);
      if (!r.ok) {
        setActionError(`${job.name || job.id}: ${r.error || "Action failed"}`);
        return;
      }
      if (r.job) {
        setJobs((prev) => prev.map((j) => (j.id === r.job!.id ? r.job! : j)));
      } else {
        void refresh();
      }
    },
    [markBusy, refresh],
  );

  const handlePause = useCallback(
    (job: HermesCronJob) =>
      void runAction(job, () => pauseHermesCronJob(job.id)),
    [runAction],
  );
  const handleResume = useCallback(
    (job: HermesCronJob) =>
      void runAction(job, () => resumeHermesCronJob(job.id)),
    [runAction],
  );
  const handleTrigger = useCallback(
    (job: HermesCronJob) =>
      void runAction(job, () => triggerHermesCronJob(job.id)),
    [runAction],
  );

  const handleDelete = useCallback(
    (job: HermesCronJob) => {
      // Cron jobs aren't easily recoverable (jobs.json overwrite is atomic),
      // and outputs are wiped along with them — confirm before nuking.
      if (
        !confirm(
          `Delete “${job.name || job.id}”? The output directory ~/.hermes/cron/output/${job.id} will also be removed.`,
        )
      ) {
        return;
      }
      markBusy(job.id, true);
      setActionError(null);
      void deleteHermesCronJob(job.id).then((r) => {
        markBusy(job.id, false);
        if (!r.ok) {
          setActionError(`${job.name || job.id}: ${r.error || "Delete failed"}`);
          return;
        }
        setJobs((prev) => prev.filter((j) => j.id !== job.id));
      });
    },
    [markBusy],
  );

  const handleSubmit = useCallback(
    async (form: JobFormState) => {
      setFormError(null);
      if (editing) {
        const update = buildUpdateInput(form);
        if (typeof update === "string") {
          setFormError(update);
          return;
        }
        setFormBusy(true);
        const r = await updateHermesCronJob(editing.id, update);
        setFormBusy(false);
        if (!r.ok) {
          setFormError(r.error || "Save failed");
          return;
        }
        if (r.job) {
          setJobs((prev) => prev.map((j) => (j.id === r.job!.id ? r.job! : j)));
        }
        setEditing(null);
      } else {
        const input = buildCreateInput(form);
        if (typeof input === "string") {
          setFormError(input);
          return;
        }
        setFormBusy(true);
        const r = await createHermesCronJob(input);
        setFormBusy(false);
        if (!r.ok) {
          setFormError(r.error || "Create failed");
          return;
        }
        if (r.job) {
          setJobs((prev) => [...prev, r.job!]);
        }
        setCreating(false);
      }
    },
    [editing],
  );

  const initialForm = useMemo<JobFormState>(
    () => (editing ? jobToForm(editing) : emptyForm()),
    [editing],
  );

  const dialogOpen = creating || editing != null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header
        className={`${OPTIONS_SHELL_HEADER_ROW} flex-wrap justify-between gap-3 bg-muted/20 px-4`}
      >
        <div className="flex min-w-0 flex-col justify-center gap-0.5 leading-tight">
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            Cron
          </h2>
          <p className="truncate text-[11px] text-muted-foreground">
            Hermes Agent scheduled jobs ({jobs.length} total)
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => setCreating(true)}
          >
            <Plus className="h-3.5 w-3.5" />
            New job
          </Button>
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-6">
          {error && <p className="text-xs text-destructive">{error}</p>}
          {actionError && (
            <p className="rounded border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive">
              {actionError}
            </p>
          )}

          {!error && jobs.length === 0 && !loading ? (
            <div className="rounded-md border border-dashed border-border bg-muted/10 px-6 py-8 text-center">
              <p className="text-sm text-muted-foreground">No cron jobs yet</p>
              <p className="mt-1 text-[11px] text-muted-foreground/70">
                Click “New job” in the top right to create your first
              </p>
            </div>
          ) : (
            <ul className="overflow-hidden rounded-md border border-border/60 bg-card">
              {jobs.map((j) => (
                <JobRow
                  key={j.id}
                  job={j}
                  busy={busyJobIds.has(j.id)}
                  onPause={handlePause}
                  onResume={handleResume}
                  onTrigger={handleTrigger}
                  onEdit={(job) => setEditing(job)}
                  onDelete={handleDelete}
                />
              ))}
            </ul>
          )}
        </div>
      </ScrollArea>

      <JobDialog
        open={dialogOpen}
        mode={editing ? "edit" : "create"}
        initial={initialForm}
        busy={formBusy}
        error={formError}
        onClose={() => {
          if (formBusy) return;
          setCreating(false);
          setEditing(null);
          setFormError(null);
        }}
        onSubmit={handleSubmit}
      />
    </div>
  );
}
