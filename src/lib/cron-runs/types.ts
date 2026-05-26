/**
 * Cron-run feed types.
 *
 * The new-tab page consumes the bridge's cron output index verbatim.
 * No aggregation across sources, no local persistence, no per-row user
 * state — those abstractions were tried (inbox, digest) and removed.
 * What's left is the literal shape of "a cron run", suitable for both
 * the history list and the content viewer.
 */

export type CronRunStatus = "ok" | "error" | "silent";

export interface CronRun {
  /** Stable id, used as the React key and the URL path. */
  jobId: string;
  /** Filename stem, e.g. ``"2026-05-14_10-16-10"``. Stable per run. */
  runId: string;
  /** Run completion timestamp (ms since epoch). */
  runAtMs: number;
  jobName: string;
  status: CronRunStatus;
  /**
   * Full markdown body — Response section for ok runs, Error section for
   * failures, or a canned line for silent runs.
   */
  content: string;
  sizeBytes: number;
  /** Bridge clipped the file because it exceeded its in-memory cap. */
  truncatedBySize: boolean;
}

/** Composite key for selection state across refetches. */
export function cronRunKey(r: Pick<CronRun, "jobId" | "runId">): string {
  return `${r.jobId}:${r.runId}`;
}
