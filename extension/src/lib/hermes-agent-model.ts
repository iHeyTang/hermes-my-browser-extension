/**
 * Hermes CLI main model — ~/.hermes/config.yaml `model:` (same as `hermes model`).
 * Model catalog — curated lists from Hermes docs JSON + ~/.hermes/cache (bridge HTTP).
 */

import { ATTACHMENT_HTTP_BASE } from "../background/config";

export interface HermesAgentMainModelResponse {
  ok: boolean;
  config_path?: string;
  config_exists?: boolean;
  provider?: string;
  model?: string;
  base_url?: string | null;
  error?: string;
}

export interface HermesCatalogModelEntry {
  id: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface HermesCatalogProviderBlock {
  metadata?: Record<string, unknown>;
  models: HermesCatalogModelEntry[];
}

/** Same entries as `hermes model` TUI (`hermes_cli.models.CANONICAL_PROVIDERS`). */
export interface HermesCanonicalProviderEntry {
  slug: string;
  label: string;
  tui_desc: string;
}

export interface HermesModelCatalogResponse {
  ok: boolean;
  error?: string;
  catalog_source?: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
  providers?: Record<string, HermesCatalogProviderBlock>;
  provider_ids?: string[];
  config_provider_ids?: string[];
  /** Slugs whose Hermes profile env vars are non-empty in the bridge process (e.g. plugin ``.env``). */
  env_ready_provider_ids?: string[];
  /** Present when bridge runs with Hermes Agent on PYTHONPATH. */
  canonical_providers?: HermesCanonicalProviderEntry[];
  canonical_loaded?: boolean;
  /** Hermes ``ProviderProfile.env_vars`` per slug (from ``providers`` plugins). */
  provider_env_vars?: Record<string, string[]>;
  warning?: string;
}

/** Bridge process: which profile env vars are set (no secret values). */
export interface HermesProviderEnvVarStatus {
  name: string;
  set: boolean;
  length: number;
}

export interface HermesProviderEnvStatusResponse {
  ok: boolean;
  error?: string;
  provider?: string;
  env_vars?: HermesProviderEnvVarStatus[];
}

export interface HermesDotenvGetResponse {
  ok: boolean;
  error?: string;
  values?: Record<string, string>;
}

export interface HermesDotenvPostResponse {
  ok: boolean;
  error?: string;
  updated?: string[];
}

/** Per-provider list from bridge — `hermes_cli.models.curated_models_for_provider`. */
export interface HermesProviderModelsResponse {
  ok: boolean;
  error?: string;
  provider?: string;
  models?: HermesCatalogModelEntry[];
  /** `hermes_cli` | `manifest` | `none` | `skipped` */
  source?: string;
  cli_loaded?: boolean;
  /** True when Hermes CLI returned live pricing (e.g. OpenRouter / Nous / AI Gateway). */
  pricing_loaded?: boolean;
}

function stripSlash(b: string): string {
  return b.endsWith("/") ? b.slice(0, -1) : b;
}

export async function getHermesAgentMainModel(): Promise<HermesAgentMainModelResponse> {
  const url = `${stripSlash(ATTACHMENT_HTTP_BASE)}/hermes/main-model`;
  try {
    const res = await fetch(url, { method: "GET" });
    const data = (await res.json()) as HermesAgentMainModelResponse;
    if (!res.ok || data.ok === false) {
      return {
        ok: false,
        error:
          (data && typeof data.error === "string" && data.error) ||
          `${res.status} ${res.statusText}`,
      };
    }
    return { ...data, ok: true };
  } catch (e) {
    return {
      ok: false,
      error: String((e as Error)?.message || e),
    };
  }
}

export async function setHermesAgentMainModel(patch: {
  provider?: string;
  model?: string;
  base_url?: string | null;
}): Promise<HermesAgentMainModelResponse> {
  const url = `${stripSlash(ATTACHMENT_HTTP_BASE)}/hermes/main-model`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = (await res.json()) as HermesAgentMainModelResponse;
    if (!res.ok || data.ok === false) {
      return {
        ok: false,
        error:
          (data && typeof data.error === "string" && data.error) ||
          `${res.status} ${res.statusText}`,
      };
    }
    return { ...data, ok: true };
  } catch (e) {
    return {
      ok: false,
      error: String((e as Error)?.message || e),
    };
  }
}

/** Curated provider → models (TUI / `hermes model` lists). */
export async function getHermesModelCatalog(
  refresh = false,
): Promise<HermesModelCatalogResponse> {
  const q = refresh ? "?refresh=1" : "";
  const url = `${stripSlash(ATTACHMENT_HTTP_BASE)}/hermes/model-catalog${q}`;
  try {
    const res = await fetch(url, { method: "GET" });
    const data = (await res.json()) as HermesModelCatalogResponse;
    if (!res.ok || data.ok === false) {
      return {
        ok: false,
        error:
          (data && typeof data.error === "string" && data.error) ||
          `${res.status} ${res.statusText}`,
      };
    }
    return { ...data, ok: true };
  } catch (e) {
    return {
      ok: false,
      error: String((e as Error)?.message || e),
    };
  }
}

/** Env var presence in bridge process (set + length only). */
/** Read API key values from plugin ``.env`` (localhost only). */
export async function getHermesDotenvValues(
  keys: string[],
): Promise<HermesDotenvGetResponse> {
  const uniq = [...new Set(keys.map((k) => k.trim()).filter(Boolean))];
  if (uniq.length === 0) {
    return { ok: true, values: {} };
  }
  const qs = encodeURIComponent(uniq.join(","));
  const url = `${stripSlash(ATTACHMENT_HTTP_BASE)}/hermes/dotenv?keys=${qs}`;
  try {
    const res = await fetch(url, { method: "GET" });
    const data = (await res.json()) as HermesDotenvGetResponse;
    if (!res.ok || data.ok === false) {
      return {
        ok: false,
        error:
          (data && typeof data.error === "string" && data.error) ||
          `${res.status} ${res.statusText}`,
      };
    }
    return { ...data, ok: true, values: data.values ?? {} };
  } catch (e) {
    return {
      ok: false,
      error: String((e as Error)?.message || e),
    };
  }
}

/** Merge key updates into plugin ``.env`` and bridge ``os.environ``. */
export async function patchHermesDotenv(
  updates: Record<string, string>,
): Promise<HermesDotenvPostResponse> {
  const url = `${stripSlash(ATTACHMENT_HTTP_BASE)}/hermes/dotenv`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates }),
    });
    const data = (await res.json()) as HermesDotenvPostResponse;
    if (!res.ok || data.ok === false) {
      return {
        ok: false,
        error:
          (data && typeof data.error === "string" && data.error) ||
          `${res.status} ${res.statusText}`,
      };
    }
    return { ...data, ok: true };
  } catch (e) {
    return {
      ok: false,
      error: String((e as Error)?.message || e),
    };
  }
}

export async function getHermesProviderEnvStatus(
  provider: string,
): Promise<HermesProviderEnvStatusResponse> {
  const p = encodeURIComponent(provider.trim());
  const url = `${stripSlash(ATTACHMENT_HTTP_BASE)}/hermes/provider-env-status?provider=${p}`;
  try {
    const res = await fetch(url, { method: "GET" });
    const data = (await res.json()) as HermesProviderEnvStatusResponse;
    if (!res.ok || data.ok === false) {
      return {
        ok: false,
        error:
          (data && typeof data.error === "string" && data.error) ||
          `${res.status} ${res.statusText}`,
      };
    }
    return { ...data, ok: true };
  } catch (e) {
    return {
      ok: false,
      error: String((e as Error)?.message || e),
    };
  }
}

/** Model ids for one provider — same logic as `hermes model` after provider selection. */
export const AUXILIARY_SLOT_NAMES = [
  "vision",
  "web_extract",
  "compression",
  "session_search",
  "skills_hub",
  "approval",
  "mcp",
  "title_generation",
] as const;

export type AuxiliarySlotName = (typeof AUXILIARY_SLOT_NAMES)[number];

export const AUXILIARY_SLOT_LABELS: Record<AuxiliarySlotName, string> = {
  vision: "图像理解 (Vision)",
  web_extract: "网页提取 (Web Extract)",
  compression: "上下文压缩 (Compression)",
  session_search: "会话搜索 (Session Search)",
  skills_hub: "技能中心 (Skills Hub)",
  approval: "审批 (Approval)",
  mcp: "MCP",
  title_generation: "标题生成 (Title Generation)",
};

export interface AuxiliarySlot {
  provider: string;
  model: string;
  base_url: string;
  api_key: string;
}

export interface AuxiliaryModelsResponse {
  ok: boolean;
  error?: string;
  config_path?: string;
  config_exists?: boolean;
  slots?: Record<AuxiliarySlotName, AuxiliarySlot>;
}

export async function getHermesAuxiliaryModels(): Promise<AuxiliaryModelsResponse> {
  const url = `${stripSlash(ATTACHMENT_HTTP_BASE)}/hermes/auxiliary-models`;
  try {
    const res = await fetch(url, { method: "GET" });
    const data = (await res.json()) as AuxiliaryModelsResponse;
    if (!res.ok || data.ok === false) {
      return {
        ok: false,
        error:
          (data && typeof data.error === "string" && data.error) ||
          `${res.status} ${res.statusText}`,
      };
    }
    return { ...data, ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

export async function setHermesAuxiliarySlot(patch: {
  slot: AuxiliarySlotName;
  provider?: string;
  model?: string;
  base_url?: string;
  api_key?: string;
}): Promise<AuxiliaryModelsResponse> {
  const url = `${stripSlash(ATTACHMENT_HTTP_BASE)}/hermes/auxiliary-models`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = (await res.json()) as AuxiliaryModelsResponse;
    if (!res.ok || data.ok === false) {
      return {
        ok: false,
        error:
          (data && typeof data.error === "string" && data.error) ||
          `${res.status} ${res.statusText}`,
      };
    }
    return { ...data, ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

export async function getHermesProviderModels(
  provider: string,
  refresh = false,
): Promise<HermesProviderModelsResponse> {
  const p = encodeURIComponent(provider.trim());
  const q = refresh ? "&refresh=1" : "";
  const url = `${stripSlash(ATTACHMENT_HTTP_BASE)}/hermes/provider-models?provider=${p}${refresh ? q : ""}`;
  try {
    const res = await fetch(url, { method: "GET" });
    const data = (await res.json()) as HermesProviderModelsResponse;
    if (!res.ok || data.ok === false) {
      return {
        ok: false,
        error:
          (data && typeof data.error === "string" && data.error) ||
          `${res.status} ${res.statusText}`,
      };
    }
    return { ...data, ok: true };
  } catch (e) {
    return {
      ok: false,
      error: String((e as Error)?.message || e),
    };
  }
}
