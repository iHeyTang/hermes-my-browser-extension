/**
 * Read-only client for the bridge `/hermes/skills` route.
 *
 * Mirrors the discovery rules used by Hermes Agent (`SKILL.md` walk of
 * `$HERMES_HOME/skills` plus `skills.external_dirs`, with platform and
 * disabled-list filtering) so the options page can show which skills the
 * current agent actually has access to.
 */

import { BACKPLANE_HTTP_BASE } from "../background/config";

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
  /** Absolute path to the skill's ``SKILL.md`` (drives the file viewer). */
  path: string;
  origin: HermesSkillOrigin;
  platforms: string[] | null;
  /**
   * Effective enabled state, matching upstream ``/api/skills``: a skill is
   * enabled when it's platform-compatible AND not in
   * ``config.yaml/skills.disabled``. Platform-incompatible skills are
   * filtered out upstream-side and never appear in the list, so this is
   * the only on/off signal the UI needs.
   */
  enabled: boolean;
  version: string | null;
  created_at: string | null;
  updated_at: string | null;
  timestamp_source: HermesSkillTimestampSource;
}

export interface HermesSkillsTotals {
  total: number;
  enabled: number;
  disabled: number;
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
  enabled: 0,
  disabled: 0,
};

/** Per-item rich metadata returned by ``GET /hermes/skills/meta``'s ``items``. */
interface SkillMetaItem {
  name: string;
  path?: string;
  origin?: HermesSkillOrigin;
  platforms?: string[] | null;
  version?: string | null;
  tags?: string[];
  created_at?: string | null;
  updated_at?: string | null;
  timestamp_source?: HermesSkillTimestampSource;
}

export async function getHermesSkills(): Promise<HermesSkillsResponse> {
  // Backplane endpoints are split for upstream parity:
  //   GET /hermes/skills      → strict upstream shape (``name``, ``description``,
  //                              ``category``, ``enabled`` per item; raw list).
  //   GET /hermes/skills/meta → mine-only sidecar with bundle stats
  //                              (``skills_dirs``/``totals``/``origin_counts``)
  //                              plus per-item rich metadata under ``items``.
  // We fetch both in parallel and join by name so the caller-facing
  // ``HermesSkillsResponse`` keeps its richer shape unchanged.
  const base = stripSlash(BACKPLANE_HTTP_BASE);
  try {
    const [listRes, metaRes] = await Promise.all([
      fetch(`${base}/hermes/skills`, { method: "GET" }),
      fetch(`${base}/hermes/skills/meta`, { method: "GET" }),
    ]);
    if (!listRes.ok) {
      const body = (await listRes.json().catch(() => null)) as
        | { error?: string }
        | null;
      return {
        ok: false,
        skills: [],
        platform: "",
        sys_platform: "",
        skills_dirs: [],
        totals: { ...EMPTY_TOTALS },
        origin_counts: {},
        error: responseError(listRes, body),
      };
    }
    const skillsBody = (await listRes.json()) as unknown;
    const baseSkills: Array<Partial<HermesSkillEntry>> = Array.isArray(skillsBody)
      ? (skillsBody as Array<Partial<HermesSkillEntry>>)
      : [];
    // Meta is best-effort: a non-2xx leaves the rich fields blank
    // rather than failing the whole call.
    let skills_dirs: string[] = [];
    let totals: HermesSkillsTotals = { ...EMPTY_TOTALS };
    let origin_counts: Partial<Record<HermesSkillOrigin, number>> = {};
    const metaByName = new Map<string, SkillMetaItem>();
    if (metaRes.ok) {
      const meta = (await metaRes.json().catch(() => null)) as {
        skills_dirs?: string[];
        totals?: HermesSkillsTotals;
        origin_counts?: Partial<Record<HermesSkillOrigin, number>>;
        items?: SkillMetaItem[];
      } | null;
      if (meta) {
        skills_dirs = meta.skills_dirs ?? [];
        totals = meta.totals ?? { ...EMPTY_TOTALS };
        origin_counts = meta.origin_counts ?? {};
        for (const item of meta.items ?? []) {
          if (item && typeof item.name === "string") {
            metaByName.set(item.name, item);
          }
        }
      }
    }
    // Join. Empty defaults match what the rich fields used to be when
    // the backplane returned them inline — UI code can stay unchanged.
    const skills: HermesSkillEntry[] = baseSkills
      .filter((s): s is Partial<HermesSkillEntry> & { name: string } =>
        !!s && typeof s.name === "string"
      )
      .map((s) => {
        const rich: SkillMetaItem = metaByName.get(s.name) ?? { name: s.name };
        return {
          name: s.name,
          description: s.description ?? "",
          category: s.category ?? null,
          enabled: s.enabled ?? true,
          path: rich.path ?? "",
          origin: rich.origin ?? "manual",
          platforms: rich.platforms ?? null,
          version: rich.version ?? null,
          tags: rich.tags ?? [],
          created_at: rich.created_at ?? null,
          updated_at: rich.updated_at ?? null,
          timestamp_source: rich.timestamp_source ?? "fs",
        };
      });
    return {
      ok: true,
      skills,
      // ``platform`` / ``sys_platform`` were never in the backplane's
      // response — they were typed-but-unused legacy fields. Keep them
      // as empty strings for backward-compatible typing.
      platform: "",
      sys_platform: "",
      skills_dirs,
      totals,
      origin_counts,
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
    const url = `${stripSlash(BACKPLANE_HTTP_BASE)}/hermes/skills/${encodeURIComponent(name)}/files`;
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

export interface HermesSkillToggleResponse {
  ok: boolean;
  name?: string;
  enabled?: boolean;
  error?: string;
}

/**
 * Flip a skill's enabled state. Persists through ``config.yaml`` via the
 * bridge, which in turn calls the upstream
 * ``hermes_cli.skills_config.save_disabled_skills`` helper — the same
 * canonical write path Hermes's own dashboard uses.
 *
 * `enabled=false` adds the name to ``config.yaml/skills.disabled``;
 * `enabled=true` removes it. Currently running agents are NOT
 * retroactively affected — the change takes effect on the next session.
 */
export async function postHermesSkillToggle(
  name: string,
  enabled: boolean,
): Promise<HermesSkillToggleResponse> {
  try {
    const url = `${stripSlash(BACKPLANE_HTTP_BASE)}/hermes/skills/toggle`;
    // Method mirrors upstream PUT /api/skills/toggle.
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, enabled }),
    });
    const data = (await res.json()) as HermesSkillToggleResponse;
    if (!res.ok || data.ok === false) {
      return { ok: false, error: responseError(res, data) };
    }
    return { ok: true, name: data.name, enabled: data.enabled };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

export async function getHermesSkillFile(
  name: string,
  path: string,
): Promise<HermesSkillFileResponse> {
  try {
    const url =
      `${stripSlash(BACKPLANE_HTTP_BASE)}/hermes/skills/${encodeURIComponent(name)}/file` +
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
