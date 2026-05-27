/**
 * Client for the backplane's status + lifecycle endpoints (mirrors
 * upstream ``/api/status`` + ``/api/gateway/restart`` + ``/api/hermes/update``
 * + ``/api/actions/{name}/status``).
 *
 * Used by the Options page's Status tab to render the snapshot and to
 * drive the two long-running buttons (gateway restart / self-upgrade)
 * via the fire-and-poll pattern: POST kicks off a detached subprocess,
 * GET on the action status polls for liveness + tails the log.
 */

import { backplaneFetch } from "./backplane-client";

function responseError(
  res: Response,
  body: { error?: string; detail?: string } | null | undefined,
): string {
  return (
    (body && (body.error || body.detail)) ||
    `${res.status} ${res.statusText}`
  );
}

// ---------------------------------------------------------------------------
// /hermes/status
// ---------------------------------------------------------------------------

export interface HermesUpdateCheck {
  /** ``up_to_date`` / ``behind`` / ``unknown``. */
  status: "up_to_date" | "behind" | "unknown" | string;
  /** Commits behind upstream; ``null`` when ``status === "behind"`` but count unknown. */
  commits_behind: number | null;
}

export interface HermesStatusResponse {
  ok: boolean;
  error?: string;
  version?: string;
  release_date?: string;
  hermes_home?: string;
  config_path?: string | null;
  env_path?: string | null;
  config_version?: number | null;
  latest_config_version?: number | null;
  gateway_running?: boolean;
  gateway_pid?: number | null;
  gateway_state?: string | null;
  /** Platform-specific status keyed by platform name (telegram/slack/...). */
  gateway_platforms?: Record<string, unknown>;
  gateway_exit_reason?: string | null;
  gateway_updated_at?: unknown;
  active_sessions?: number;
  update_check?: HermesUpdateCheck;
}

export interface GetHermesStatusOptions {
  /**
   * Bust the backend's 6h update-check cache so the returned
   * ``update_check`` reflects a fresh remote probe. Only the
   * user-triggered Refresh should set this; the auto-poll uses cache.
   */
  forceUpdateCheck?: boolean;
}

export async function getHermesStatus(
  opts: GetHermesStatusOptions = {},
): Promise<HermesStatusResponse> {
  const path = opts.forceUpdateCheck
    ? "/hermes/status?force_update_check=1"
    : "/hermes/status";
  try {
    const res = await backplaneFetch(path, { method: "GET" });
    const data = (await res.json().catch(() => null)) as
      | HermesStatusResponse
      | { error?: string; detail?: string }
      | null;
    if (!res.ok) {
      return { ok: false, error: responseError(res, data ?? null) };
    }
    return { ok: true, ...((data as HermesStatusResponse) ?? {}) };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

// ---------------------------------------------------------------------------
// /hermes/gateway/restart  +  /hermes/update
// ---------------------------------------------------------------------------

export type LifecycleActionName = "gateway-restart" | "hermes-update";

export interface SpawnActionResponse {
  ok: boolean;
  error?: string;
  pid?: number;
  name?: LifecycleActionName;
}

async function postAction(
  path: string,
  name: LifecycleActionName,
): Promise<SpawnActionResponse> {
  try {
    const res = await backplaneFetch(path, { method: "POST" });
    const data = (await res.json().catch(() => null)) as
      | SpawnActionResponse
      | { error?: string; detail?: string }
      | null;
    if (!res.ok) {
      return { ok: false, name, error: responseError(res, data ?? null) };
    }
    const body = (data ?? {}) as SpawnActionResponse;
    return { ok: true, name, pid: body.pid };
  } catch (e) {
    return { ok: false, name, error: String((e as Error)?.message || e) };
  }
}

export function restartHermesGateway(): Promise<SpawnActionResponse> {
  return postAction("/hermes/gateway/restart", "gateway-restart");
}

export function updateHermes(): Promise<SpawnActionResponse> {
  return postAction("/hermes/update", "hermes-update");
}

// ---------------------------------------------------------------------------
// /hermes/actions/{name}/status
// ---------------------------------------------------------------------------

export interface ActionStatusResponse {
  ok: boolean;
  error?: string;
  name?: LifecycleActionName;
  running?: boolean;
  exit_code?: number | null;
  pid?: number | null;
  lines?: string[];
}

export async function getActionStatus(
  name: LifecycleActionName,
  lines = 200,
  signal?: AbortSignal,
): Promise<ActionStatusResponse> {
  try {
    const q = new URLSearchParams({ lines: String(lines) });
    const url =
      `/hermes/actions/${encodeURIComponent(name)}/status?${q.toString()}`;
    const res = await backplaneFetch(url, { method: "GET", signal });
    const data = (await res.json().catch(() => null)) as
      | ActionStatusResponse
      | { error?: string; detail?: string }
      | null;
    if (!res.ok) {
      return { ok: false, name, error: responseError(res, data ?? null) };
    }
    return { ok: true, ...((data as ActionStatusResponse) ?? {}) };
  } catch (e) {
    return { ok: false, name, error: String((e as Error)?.message || e) };
  }
}
