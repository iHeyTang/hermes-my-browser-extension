/**
 * Read-only client for the bridge `/hermes/skills` route.
 *
 * Mirrors the discovery rules used by Hermes Agent (`SKILL.md` walk of
 * `$HERMES_HOME/skills` plus `skills.external_dirs`, with platform and
 * disabled-list filtering) so the options page can show which skills the
 * current agent actually has access to.
 */

import { ATTACHMENT_HTTP_BASE } from "../background/config";

/**
 * Where a skill came from:
 *  - `bundled` — shipped inside the Hermes Agent install (`.bundled_manifest`)
 *  - `hub`     — installed via Skills Hub (`.hub/lock.json`)
 *  - `agent`   — authored by the curator agent (`created_by: "agent"` in `.usage.json`)
 *  - `manual`  — user dropped it into `$HERMES_HOME/skills/` by hand
 *  - `external`/`plugin` — discovered outside `$HERMES_HOME/skills`
 */
export type HermesSkillOrigin =
  | "bundled"
  | "hub"
  | "agent"
  | "manual"
  | "external"
  | "plugin"
  | string;

/**
 * How `created_at` / `updated_at` were resolved:
 *  - `usage` — from `.usage.json` (authored / mutated by Hermes Agent)
 *  - `hub`   — from `.hub/lock.json`
 *  - `fs`    — fallback: SKILL.md birthtime / mtime
 */
export type HermesSkillTimestampSource = "usage" | "hub" | "fs" | string;

export interface HermesSkillEntry {
  name: string;
  description: string;
  category: string | null;
  tags: string[];
  path: string;
  source: "local" | "external" | string;
  origin: HermesSkillOrigin;
  platforms: string[] | null;
  compatible: boolean;
  disabled: boolean;
  active: boolean;
  version: string | null;
  created_at: string | null;
  updated_at: string | null;
  timestamp_source: HermesSkillTimestampSource;
}

export interface HermesSkillsTotals {
  total: number;
  active: number;
  disabled: number;
  incompatible: number;
}

export interface HermesSkillsResponse {
  ok: boolean;
  skills: HermesSkillEntry[];
  platform: string;
  sys_platform: string;
  skills_dirs: string[];
  totals: HermesSkillsTotals;
  origin_counts: Partial<Record<HermesSkillOrigin, number>>;
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

const EMPTY_TOTALS: HermesSkillsTotals = {
  total: 0,
  active: 0,
  disabled: 0,
  incompatible: 0,
};

export async function getHermesSkills(): Promise<HermesSkillsResponse> {
  try {
    const url = `${stripSlash(ATTACHMENT_HTTP_BASE)}/hermes/skills`;
    const res = await fetch(url, { method: "GET" });
    const data = (await res.json()) as HermesSkillsResponse;
    if (!res.ok || data.ok === false) {
      return {
        ok: false,
        skills: [],
        platform: "",
        sys_platform: "",
        skills_dirs: [],
        totals: { ...EMPTY_TOTALS },
        origin_counts: {},
        error: responseError(res, data),
      };
    }
    return {
      ok: true,
      skills: data.skills ?? [],
      platform: data.platform ?? "",
      sys_platform: data.sys_platform ?? "",
      skills_dirs: data.skills_dirs ?? [],
      totals: data.totals ?? { ...EMPTY_TOTALS },
      origin_counts: data.origin_counts ?? {},
    };
  } catch (e) {
    return {
      ok: false,
      skills: [],
      platform: "",
      sys_platform: "",
      skills_dirs: [],
      totals: { ...EMPTY_TOTALS },
      origin_counts: {},
      error: String((e as Error)?.message || e),
    };
  }
}

// ---------------------------------------------------------------------------
// Skill directory browsing — backs the "view files" affordance on the
// options page. Bridge enforces path-traversal safety and a size cap; the
// frontend just renders whatever encoding marker comes back.
// ---------------------------------------------------------------------------

export interface HermesSkillFileEntry {
  /** POSIX-style relative path under the skill's directory. */
  path: string;
  size: number;
  modified_at: string | null;
}

export interface HermesSkillFilesResponse {
  ok: boolean;
  name?: string;
  /** Absolute path of the skill directory on disk (informational). */
  root?: string;
  files: HermesSkillFileEntry[];
  /** True when the walk hit `MAX_SKILL_FILES` and stopped early. */
  truncated?: boolean;
  error?: string;
}

/**
 * `binary` and `too-large` mark non-renderable bodies: `content` is `null`
 * and the UI shows a size-only placeholder instead of trying to render.
 */
export type HermesSkillFileEncoding = "utf-8" | "binary" | "too-large";

export interface HermesSkillFileResponse {
  ok: boolean;
  name?: string;
  path?: string;
  size?: number;
  encoding?: HermesSkillFileEncoding;
  /** Decoded text for `utf-8`; `null` for the other encodings. */
  content?: string | null;
  /** Byte cap for `too-large` responses; ignore otherwise. */
  limit?: number;
  error?: string;
}

export async function getHermesSkillFiles(
  name: string,
): Promise<HermesSkillFilesResponse> {
  try {
    const url = `${stripSlash(ATTACHMENT_HTTP_BASE)}/hermes/skills/${encodeURIComponent(name)}/files`;
    const res = await fetch(url, { method: "GET" });
    const data = (await res.json()) as HermesSkillFilesResponse;
    if (!res.ok || data.ok === false) {
      return { ok: false, files: [], error: responseError(res, data) };
    }
    return {
      ok: true,
      name: data.name,
      root: data.root,
      files: data.files ?? [],
      truncated: !!data.truncated,
    };
  } catch (e) {
    return {
      ok: false,
      files: [],
      error: String((e as Error)?.message || e),
    };
  }
}

export async function getHermesSkillFile(
  name: string,
  path: string,
): Promise<HermesSkillFileResponse> {
  try {
    const url =
      `${stripSlash(ATTACHMENT_HTTP_BASE)}/hermes/skills/${encodeURIComponent(name)}/file` +
      `?path=${encodeURIComponent(path)}`;
    const res = await fetch(url, { method: "GET" });
    const data = (await res.json()) as HermesSkillFileResponse;
    if (!res.ok || data.ok === false) {
      return { ok: false, error: responseError(res, data) };
    }
    return data;
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}
