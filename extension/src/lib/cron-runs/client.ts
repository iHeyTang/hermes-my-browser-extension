/**
 * HTTP client for the bridge's cron run index.
 *
 *   GET /hermes/cron/output/index       — list of recent runs (with body)
 *   GET /hermes/cron/output/:job/:run   — single run by id
 */

import { ATTACHMENT_HTTP_BASE } from "../../background/config";
import type { CronRun, CronRunStatus } from "./types";

interface RawRun {
  job_id: string;
  run_id: string;
  run_at_ms: number;
  job_name: string;
  status: CronRunStatus;
  content: string;
  size_bytes: number;
  truncated_by_size?: boolean;
}

interface IndexResponse {
  ok: boolean;
  runs?: RawRun[];
  truncated?: boolean;
  total?: number;
  error?: string;
}

interface DetailResponse {
  ok: boolean;
  run?: RawRun;
  error?: string;
}

function fromRaw(e: RawRun): CronRun {
  return {
    jobId: e.job_id,
    runId: e.run_id,
    runAtMs: e.run_at_ms,
    jobName: e.job_name,
    status: e.status,
    content: typeof e.content === "string" ? e.content : "",
    sizeBytes: e.size_bytes,
    truncatedBySize: !!e.truncated_by_size,
  };
}

export interface ListCronRunsOptions {
  sinceMs?: number;
  limit?: number;
  /** Default: ``true`` — keep ``[SILENT]`` runs visible. */
  includeSilent?: boolean;
  signal?: AbortSignal;
}

export async function listCronRuns(
  opts: ListCronRunsOptions = {},
): Promise<{ runs: CronRun[]; truncated: boolean; total: number }> {
  const params = new URLSearchParams();
  if (typeof opts.sinceMs === "number" && opts.sinceMs > 0) {
    params.set("since_ms", String(opts.sinceMs));
  }
  if (typeof opts.limit === "number" && opts.limit > 0) {
    params.set("limit", String(opts.limit));
  }
  if (opts.includeSilent === false) params.set("include_silent", "0");

  const url = `${ATTACHMENT_HTTP_BASE}/hermes/cron/output/index?${params.toString()}`;
  const res = await fetch(url, { signal: opts.signal });
  let body: IndexResponse | null = null;
  try {
    body = (await res.json()) as IndexResponse;
  } catch {
    body = null;
  }
  if (!res.ok || !body || !body.ok) {
    const msg = body?.error || `${res.status} ${res.statusText}`;
    throw new Error(`listCronRuns failed: ${msg}`);
  }
  return {
    runs: (body.runs || []).map(fromRaw),
    truncated: !!body.truncated,
    total: body.total ?? body.runs?.length ?? 0,
  };
}

export async function getCronRun(
  jobId: string,
  runId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<CronRun> {
  const url = `${ATTACHMENT_HTTP_BASE}/hermes/cron/output/${encodeURIComponent(
    jobId,
  )}/${encodeURIComponent(runId)}`;
  const res = await fetch(url, { signal: opts.signal });
  let body: DetailResponse | null = null;
  try {
    body = (await res.json()) as DetailResponse;
  } catch {
    body = null;
  }
  if (!res.ok || !body || !body.ok || !body.run) {
    const msg = body?.error || `${res.status} ${res.statusText}`;
    throw new Error(`getCronRun failed: ${msg}`);
  }
  return fromRaw(body.run);
}
