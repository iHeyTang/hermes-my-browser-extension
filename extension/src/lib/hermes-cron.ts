/**
 * Client for the bridge `/hermes/cron/*` routes.
 *
 * Thin wrapper around `cron.jobs` in Hermes Agent — see
 * `bridge/features/cron/service.py`. Field shape matches what
 * `cron.jobs.list_jobs(include_disabled=True)` returns; we don't translate
 * field names so the options page stays consistent with Hermes's own dump.
 */

import { ATTACHMENT_HTTP_BASE } from "../background/config";

export type HermesCronScheduleKind = "once" | "interval" | "cron";

export interface HermesCronSchedule {
  kind: HermesCronScheduleKind;
  /** Cron expression (kind=cron). */
  expr?: string;
  /** ISO timestamp (kind=once). */
  run_at?: string;
  /** Minutes between runs (kind=interval). */
  minutes?: number;
  display?: string;
}

export interface HermesCronRepeat {
  /** Total runs requested. `null` means unlimited (recurring forever). */
  times: number | null;
  /** Runs already completed. */
  completed: number;
}

export type HermesCronState =
  | "scheduled"
  | "running"
  | "paused"
  | "completed"
  | "error"
  | string;

/**
 * Cron delivery target.
 *
 * The new-tab feed is always populated — every cron run lands as a
 * markdown file under ``$HERMES_HOME/cron/output/...`` regardless of
 * this value (the bridge indexes those files; the new-tab page reads
 * the index). This field only controls *additional* channel push on top
 * of that:
 *
 *   - ``"local"``  — file-only (default). No channel push.
 *   - ``"inbox"``  — legacy alias for ``"local"``; bridge normalises it.
 *   - ``"origin"`` — also push back to the chat the job was created
 *                    from (the job's origin platform+chat_id).
 *   - any other string — passes through to Hermes core's parser, which
 *                        accepts platform names (``"feishu"``), explicit
 *                        targets (``"feishu:oc_xxx"``), ``"all"``, and
 *                        comma-separated combinations.
 */
export type HermesCronDeliver = "inbox" | "local" | "origin" | string;

export interface HermesCronOrigin {
  platform?: string;
  chat_id?: string;
  chat_name?: string;
  thread_id?: string | null;
  [k: string]: unknown;
}

export interface HermesCronJob {
  id: string;
  name: string;
  prompt: string;
  skills: string[];
  /** Legacy single-skill field; mirrors `skills[0]` when present. */
  skill: string | null;
  model: string | null;
  provider: string | null;
  base_url: string | null;
  script: string | null;
  no_agent: boolean;
  context_from: string[] | null;
  schedule: HermesCronSchedule;
  schedule_display: string;
  repeat: HermesCronRepeat;
  enabled: boolean;
  state: HermesCronState;
  paused_at: string | null;
  paused_reason: string | null;
  created_at: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: "ok" | "error" | null;
  last_error: string | null;
  last_delivery_error: string | null;
  deliver: HermesCronDeliver;
  origin: HermesCronOrigin | null;
  enabled_toolsets: string[] | null;
  workdir: string | null;
}

export interface HermesCronListResponse {
  ok: boolean;
  jobs: HermesCronJob[];
  error?: string;
}

export interface HermesCronJobResponse {
  ok: boolean;
  job?: HermesCronJob;
  error?: string;
}

export interface HermesCronDeleteResponse {
  ok: boolean;
  error?: string;
}

export interface HermesCronParsePreviewResponse {
  ok: boolean;
  schedule?: HermesCronSchedule;
  display?: string;
  next_run_at?: string | null;
  error?: string;
}

/** Inputs accepted by `POST /hermes/cron/jobs`. */
export interface HermesCronCreateInput {
  /** Required unless `no_agent` is true. */
  prompt?: string;
  /** Required. Hermes schedule string: "30m", "every 2h", "0 9 * * *", "2026-02-03T14:00". */
  schedule: string;
  name?: string;
  /** Default is `"local"` (logged to `~/.hermes/cron/output/...`). */
  deliver?: HermesCronDeliver;
  /** Times to run; omit for unlimited. One-shot schedules default to 1. */
  repeat?: number;
  skills?: string[];
  model?: string;
  provider?: string;
  base_url?: string;
  /** Path under `~/.hermes/scripts/`, or absolute. */
  script?: string;
  no_agent?: boolean;
  context_from?: string | string[];
  enabled_toolsets?: string[];
  workdir?: string;
}

/** Inputs accepted by `POST /hermes/cron/jobs/{id}`. Only listed fields are honored. */
export interface HermesCronUpdateInput {
  name?: string;
  prompt?: string;
  schedule?: string;
  deliver?: HermesCronDeliver;
  skills?: string[];
  model?: string | null;
  provider?: string | null;
  base_url?: string | null;
  script?: string | null;
  no_agent?: boolean;
  context_from?: string | string[] | null;
  enabled_toolsets?: string[] | null;
  workdir?: string | null;
  repeat?: number | { times: number | null; completed?: number };
}

function stripSlash(b: string): string {
  return b.endsWith("/") ? b.slice(0, -1) : b;
}

function responseError(
  res: Response,
  data: { error?: string } | null | undefined,
): string {
  return (
    (data && typeof data.error === "string" && data.error) ||
    `${res.status} ${res.statusText}`
  );
}

async function readJson<T extends { ok: boolean; error?: string }>(
  res: Response,
): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    return { ok: false, error: `${res.status} ${res.statusText}` } as T;
  }
}

export async function getHermesCronJobs(): Promise<HermesCronListResponse> {
  try {
    const url = `${stripSlash(ATTACHMENT_HTTP_BASE)}/hermes/cron/jobs`;
    const res = await fetch(url, { method: "GET" });
    const data = await readJson<HermesCronListResponse>(res);
    if (!res.ok || data.ok === false) {
      return {
        ok: false,
        jobs: [],
        error: responseError(res, data),
      };
    }
    return { ok: true, jobs: data.jobs ?? [] };
  } catch (e) {
    return { ok: false, jobs: [], error: String((e as Error)?.message || e) };
  }
}

export async function getHermesCronJob(
  jobId: string,
): Promise<HermesCronJobResponse> {
  try {
    const url = `${stripSlash(ATTACHMENT_HTTP_BASE)}/hermes/cron/jobs/${encodeURIComponent(jobId)}`;
    const res = await fetch(url, { method: "GET" });
    const data = await readJson<HermesCronJobResponse>(res);
    if (!res.ok || data.ok === false) {
      return { ok: false, error: responseError(res, data) };
    }
    return data;
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

export async function createHermesCronJob(
  input: HermesCronCreateInput,
): Promise<HermesCronJobResponse> {
  try {
    const url = `${stripSlash(ATTACHMENT_HTTP_BASE)}/hermes/cron/jobs`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const data = await readJson<HermesCronJobResponse>(res);
    if (!res.ok || data.ok === false) {
      return { ok: false, error: responseError(res, data) };
    }
    return data;
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

export async function updateHermesCronJob(
  jobId: string,
  updates: HermesCronUpdateInput,
): Promise<HermesCronJobResponse> {
  try {
    const url = `${stripSlash(ATTACHMENT_HTTP_BASE)}/hermes/cron/jobs/${encodeURIComponent(jobId)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    const data = await readJson<HermesCronJobResponse>(res);
    if (!res.ok || data.ok === false) {
      return { ok: false, error: responseError(res, data) };
    }
    return data;
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

async function lifecycle(
  jobId: string,
  op: "pause" | "resume" | "trigger",
): Promise<HermesCronJobResponse> {
  try {
    const url = `${stripSlash(ATTACHMENT_HTTP_BASE)}/hermes/cron/jobs/${encodeURIComponent(jobId)}/${op}`;
    const res = await fetch(url, { method: "POST" });
    const data = await readJson<HermesCronJobResponse>(res);
    if (!res.ok || data.ok === false) {
      return { ok: false, error: responseError(res, data) };
    }
    return data;
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

export const pauseHermesCronJob = (id: string) => lifecycle(id, "pause");
export const resumeHermesCronJob = (id: string) => lifecycle(id, "resume");
export const triggerHermesCronJob = (id: string) => lifecycle(id, "trigger");

export async function deleteHermesCronJob(
  jobId: string,
): Promise<HermesCronDeleteResponse> {
  try {
    const url = `${stripSlash(ATTACHMENT_HTTP_BASE)}/hermes/cron/jobs/${encodeURIComponent(jobId)}`;
    const res = await fetch(url, { method: "DELETE" });
    const data = await readJson<HermesCronDeleteResponse>(res);
    if (!res.ok || data.ok === false) {
      return { ok: false, error: responseError(res, data) };
    }
    return data;
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

export async function previewHermesCronSchedule(
  schedule: string,
): Promise<HermesCronParsePreviewResponse> {
  try {
    const url = `${stripSlash(ATTACHMENT_HTTP_BASE)}/hermes/cron/parse-schedule`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schedule }),
    });
    const data = await readJson<HermesCronParsePreviewResponse>(res);
    if (!res.ok || data.ok === false) {
      return { ok: false, error: responseError(res, data) };
    }
    return data;
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}
