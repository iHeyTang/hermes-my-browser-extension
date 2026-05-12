/**
 * Hermes model management client.
 *
 * Primary surface: ``GET/POST /hermes/main-provider-settings`` (main model +
 * credentials as one business resource). Other ``/hermes/*`` routes cover
 * catalog, auxiliary slots, env status, and attach uploads.
 */

import {
  ATTACHMENT_HTTP_BASE,
} from "../background/config";

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
  /** Slugs whose configured provider credentials are available in the current runtime. */
  env_ready_provider_ids?: string[];
  /** Canonical provider list exposed by Hermes. */
  canonical_providers?: HermesCanonicalProviderEntry[];
  canonical_loaded?: boolean;
  /** Provider credential variable names by provider slug. */
  provider_env_vars?: Record<string, string[]>;
  warning?: string;
}

/** Nested credential slice from ``GET /hermes/main-provider-settings``. */
export interface HermesMainProviderSettingsCredentials {
  provider: string;
  keys: string[];
  values: Record<string, string>;
}

/** ``GET /hermes/main-provider-settings`` — main model + credentials for one business view. */
export interface HermesMainProviderSettingsResponse extends HermesAgentMainModelResponse {
  credentials?: HermesMainProviderSettingsCredentials;
}

/** Per-provider model list resolved from `/api/model/options`. */
export interface HermesProviderModelsResponse {
  ok: boolean;
  error?: string;
  provider?: string;
  models?: HermesCatalogModelEntry[];
  /** Source tag kept for compatibility with existing callers. */
  source?: string;
  cli_loaded?: boolean;
  /** Optional field kept for backward-compatible typing. */
  pricing_loaded?: boolean;
}

function stripSlash(b: string): string {
  return b.endsWith("/") ? b.slice(0, -1) : b;
}

function responseError(res: Response, data: { error?: string } | null | undefined): string {
  return (data && typeof data.error === "string" && data.error) || `${res.status} ${res.statusText}`;
}

export async function getHermesMainProviderSettings(
  credentialsForProvider?: string,
): Promise<HermesMainProviderSettingsResponse> {
  const p = credentialsForProvider?.trim();
  const q =
    p && p !== "auto"
      ? `?provider=${encodeURIComponent(p)}`
      : "";
  try {
    const url = `${stripSlash(ATTACHMENT_HTTP_BASE)}/hermes/main-provider-settings${q}`;
    const res = await fetch(url, { method: "GET" });
    const data = (await res.json()) as HermesMainProviderSettingsResponse;
    if (!res.ok || data.ok === false) {
      return {
        ok: false,
        error: responseError(res, data),
      };
    }
    const cred = data.credentials ?? {
      provider: "",
      keys: [],
      values: {},
    };
    return {
      ...data,
      ok: true,
      credentials: {
        provider: cred.provider,
        keys: cred.keys ?? [],
        values: cred.values ?? {},
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: String((e as Error)?.message || e),
    };
  }
}

/** @deprecated Prefer ``getHermesMainProviderSettings`` — thin wrapper without ``credentials``. */
export async function getHermesAgentMainModel(): Promise<HermesAgentMainModelResponse> {
  const r = await getHermesMainProviderSettings();
  if (!r.ok) {
    return { ok: false, error: r.error };
  }
  return {
    ok: true,
    config_path: r.config_path,
    config_exists: r.config_exists,
    provider: r.provider,
    model: r.model,
    base_url: r.base_url,
    error: r.error,
  };
}

export async function setHermesAgentMainModel(patch: {
  provider?: string;
  model?: string;
  base_url?: string | null;
}): Promise<HermesAgentMainModelResponse> {
  try {
    const url = `${stripSlash(ATTACHMENT_HTTP_BASE)}/hermes/main-model`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = (await res.json()) as HermesAgentMainModelResponse;
    if (!res.ok || data.ok === false) {
      return {
        ok: false,
        error: responseError(res, data),
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

/** Save main model (``config.yaml``) and optional plugin credentials in one request. */
export async function saveHermesMainProviderSettings(body: {
  provider?: string;
  model?: string;
  base_url?: string | null;
  credentials?: Record<string, string> | null;
}): Promise<HermesAgentMainModelResponse> {
  try {
    const url = `${stripSlash(ATTACHMENT_HTTP_BASE)}/hermes/main-provider-settings`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as HermesAgentMainModelResponse;
    if (!res.ok || data.ok === false) {
      return {
        ok: false,
        error: responseError(res, data),
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
  try {
    const url = `${stripSlash(ATTACHMENT_HTTP_BASE)}/hermes/model-catalog${q}`;
    const res = await fetch(url, { method: "GET" });
    const data = (await res.json()) as HermesModelCatalogResponse;
    if (!res.ok || data.ok === false) {
      return {
        ok: false,
        error: responseError(res, data),
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

/** Model ids for one provider from `/api/model/options`. */
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
  try {
    const url = `${stripSlash(ATTACHMENT_HTTP_BASE)}/hermes/auxiliary-models`;
    const res = await fetch(url, { method: "GET" });
    const data = (await res.json()) as AuxiliaryModelsResponse;
    if (!res.ok || data.ok === false) {
      return {
        ok: false,
        error: responseError(res, data),
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
  try {
    const url = `${stripSlash(ATTACHMENT_HTTP_BASE)}/hermes/auxiliary-models`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = (await res.json()) as AuxiliaryModelsResponse;
    if (!res.ok || data.ok === false) {
      return {
        ok: false,
        error: responseError(res, data),
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
  const providerId = provider.trim();
  try {
    const p = encodeURIComponent(providerId);
    const q = refresh ? "&refresh=1" : "";
    const url = `${stripSlash(ATTACHMENT_HTTP_BASE)}/hermes/provider-models?provider=${p}${q}`;
    const res = await fetch(url, { method: "GET" });
    const data = (await res.json()) as HermesProviderModelsResponse;
    if (!res.ok || data.ok === false) {
      return {
        ok: false,
        error: responseError(res, data),
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
