/**
 * Read-only client for the bridge `/hermes/memories` routes.
 *
 * Surfaces the curated memory files Hermes Agent writes under
 * `$HERMES_HOME/memories/{MEMORY,USER}.md` so the options page can display
 * them. There is no write API on purpose — only Hermes Agent should mutate
 * those files (it holds the fcntl lock and runs the injection scanner).
 */

import { ATTACHMENT_HTTP_BASE } from "../background/config";

export type HermesMemoryTarget = "memory" | "user";

/**
 * One memory entry plus the upstream safety scanner's verdict.
 * `flagged` is `null` for clean entries and a short classification
 * string (e.g. `"prompt_injection"`, `"exfil_curl"`, `"ssh_backdoor"`)
 * for entries Hermes itself would refuse to inject into a prompt —
 * comes from ``tools/memory_tool._scan_memory_content``.
 */
export interface HermesMemoryEntry {
  text: string;
  flagged: string | null;
}

export interface HermesMemoryEntries {
  ok: boolean;
  target: HermesMemoryTarget;
  path: string;
  entries: HermesMemoryEntry[];
  char_count: number;
  char_limit: number;
  /** Number of `entries` with a non-null `flagged` classification. */
  flagged_count: number;
  error?: string;
}

export interface HermesMemoryListResponse {
  ok: boolean;
  targets: HermesMemoryEntries[];
  error?: string;
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

function emptyEntries(target: HermesMemoryTarget, error: string): HermesMemoryEntries {
  return {
    ok: false,
    target,
    path: "",
    entries: [],
    char_count: 0,
    char_limit: 0,
    flagged_count: 0,
    error,
  };
}

export async function getHermesMemoryList(): Promise<HermesMemoryListResponse> {
  try {
    const url = `${stripSlash(ATTACHMENT_HTTP_BASE)}/hermes/memories`;
    const res = await fetch(url, { method: "GET" });
    const data = (await res.json()) as HermesMemoryListResponse;
    if (!res.ok || data.ok === false) {
      return { ok: false, targets: [], error: responseError(res, data) };
    }
    return { ok: true, targets: data.targets ?? [] };
  } catch (e) {
    return { ok: false, targets: [], error: String((e as Error)?.message || e) };
  }
}

export async function getHermesMemoryTarget(
  target: HermesMemoryTarget,
): Promise<HermesMemoryEntries> {
  try {
    const url = `${stripSlash(ATTACHMENT_HTTP_BASE)}/hermes/memories/${target}`;
    const res = await fetch(url, { method: "GET" });
    const data = (await res.json()) as HermesMemoryEntries;
    if (!res.ok || data.ok === false) {
      return emptyEntries(target, responseError(res, data));
    }
    return {
      ok: true,
      target,
      path: data.path ?? "",
      entries: data.entries ?? [],
      char_count: data.char_count ?? 0,
      char_limit: data.char_limit ?? 0,
      flagged_count: data.flagged_count ?? 0,
    };
  } catch (e) {
    return emptyEntries(target, String((e as Error)?.message || e));
  }
}
