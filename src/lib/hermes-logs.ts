/**
 * Client for the backplane's ``/hermes/logs`` route (mirror of upstream
 * dashboard's ``/api/logs``). Tail + filter Hermes Agent log files
 * (``agent.log`` / ``errors.log`` / ``gateway.log``) for the Options
 * Status sidebar's Logs tab.
 *
 * Read-only — no mutation, no follow/streaming (the page polls).
 */

import { backplaneFetch } from "./backplane-client";

export type HermesLogFile = "agent" | "errors" | "gateway";

export type HermesLogLevel =
  | "ALL"
  | "DEBUG"
  | "INFO"
  | "WARNING"
  | "ERROR";

export interface HermesLogsResponse {
  ok: boolean;
  error?: string;
  file?: string;
  lines: string[];
}

export interface HermesLogsMetaResponse {
  ok: boolean;
  error?: string;
  files: string[];
  components: string[];
}

export interface HermesLogsQuery {
  file?: HermesLogFile;
  lines?: number;
  level?: HermesLogLevel;
  component?: string;
  search?: string;
}

function responseError(
  res: Response,
  body: { error?: string; detail?: string } | null | undefined,
): string {
  return (
    (body && (body.error || body.detail)) ||
    `${res.status} ${res.statusText}`
  );
}

export async function getHermesLogs(
  query: HermesLogsQuery = {},
): Promise<HermesLogsResponse> {
  try {
    const qs = new URLSearchParams();
    if (query.file) qs.set("file", query.file);
    if (query.lines != null) qs.set("lines", String(query.lines));
    if (query.level && query.level !== "ALL") qs.set("level", query.level);
    if (query.component && query.component !== "all") {
      qs.set("component", query.component);
    }
    if (query.search) qs.set("search", query.search);
    const path = `/hermes/logs${qs.toString() ? `?${qs.toString()}` : ""}`;
    const res = await backplaneFetch(path, { method: "GET" });
    const data = (await res.json().catch(() => null)) as
      | { file?: string; lines?: string[]; error?: string; detail?: string }
      | null;
    if (!res.ok) {
      return { ok: false, lines: [], error: responseError(res, data) };
    }
    return {
      ok: true,
      file: data?.file,
      lines: Array.isArray(data?.lines) ? data!.lines : [],
    };
  } catch (e) {
    return { ok: false, lines: [], error: String((e as Error)?.message || e) };
  }
}

export async function getHermesLogsMeta(): Promise<HermesLogsMetaResponse> {
  try {
    const res = await backplaneFetch("/hermes/logs/meta", { method: "GET" });
    const data = (await res.json().catch(() => null)) as
      | { files?: string[]; components?: string[]; error?: string; detail?: string }
      | null;
    if (!res.ok) {
      return {
        ok: false,
        files: [],
        components: [],
        error: responseError(res, data),
      };
    }
    return {
      ok: true,
      files: Array.isArray(data?.files) ? data!.files : [],
      components: Array.isArray(data?.components) ? data!.components : [],
    };
  } catch (e) {
    return {
      ok: false,
      files: [],
      components: [],
      error: String((e as Error)?.message || e),
    };
  }
}
