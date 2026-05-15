/**
 * React hook that pulls the cron-run feed for the new-tab page.
 *
 *   - `runs`    list of recent runs, sorted newest-first
 *   - `ready`   first fetch settled
 *   - `error`   last fetch error (if any)
 *   - `refresh` re-fetch on demand (focus, manual button)
 *
 * No persistence. Single-flight inside.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { listCronRuns } from "./client";
import type { CronRun } from "./types";

const FETCH_LIMIT = 100;

function sortRuns(runs: CronRun[]): CronRun[] {
  return [...runs].sort((a, b) => b.runAtMs - a.runAtMs);
}

export interface CronRunsController {
  ready: boolean;
  runs: CronRun[];
  error: string | null;
  refresh: () => Promise<void>;
}

export function useCronRuns(): CronRunsController {
  const [runs, setRuns] = useState<CronRun[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);

  const doFetch = useCallback(async (): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const p = (async () => {
      try {
        const r = await listCronRuns({ limit: FETCH_LIMIT });
        if (!mounted.current) return;
        setRuns(sortRuns(r.runs));
        setError(null);
      } catch (e) {
        if (!mounted.current) return;
        setError((e as Error)?.message || String(e));
      } finally {
        if (mounted.current) setReady(true);
        inFlight.current = null;
      }
    })();
    inFlight.current = p;
    return p;
  }, []);

  useEffect(() => {
    mounted.current = true;
    void doFetch();
    return () => {
      mounted.current = false;
    };
  }, [doFetch]);

  return { ready, runs, error, refresh: doFetch };
}
