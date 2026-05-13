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

/**
 * Capability flags resolved from ``agent.models_dev.get_model_capabilities``
 * (the same source upstream ``/api/model/info`` uses). All fields are
 * optional because models.dev may not have the model — absence means
 * "unknown", not "unsupported".
 */
export interface HermesModelCapabilities {
  supports_tools?: boolean;
  supports_vision?: boolean;
  supports_reasoning?: boolean;
  context_window?: number | null;
  max_output_tokens?: number | null;
  model_family?: string | null;
}

export interface HermesAgentMainModelResponse {
  ok: boolean;
  config_path?: string;
  config_exists?: boolean;
  provider?: string;
  model?: string;
  base_url?: string | null;
  /**
   * Auto-detected context length via ``agent.model_metadata`` —
   * independent of any ``model.context_length`` override in
   * ``config.yaml``. ``0`` when unknown.
   */
  auto_context_length?: number;
  /** ``model.context_length`` override from ``config.yaml`` (``0`` if unset). */
  config_context_length?: number;
  /** ``config_context_length`` when > 0, else ``auto_context_length``. */
  effective_context_length?: number;
  capabilities?: HermesModelCapabilities;
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
  vision: "Vision",
  web_extract: "Web Extract",
  compression: "Compression",
  session_search: "Session Search",
  skills_hub: "Skills Hub",
  approval: "Approval",
  mcp: "MCP",
  title_generation: "Title Generation",
};

/**
 * One row in the auxiliary-task list. ``task`` matches upstream's slot
 * id; the other fields mirror upstream ``/api/model/auxiliary`` exactly
 * except for ``api_key`` (bridge-only — Hermes upstream stores aux keys
 * in env files, ours lives next to the slot config so the panel can
 * carry them through ``<plugin-root>/.env``).
 */
export interface AuxiliaryTask {
  task: AuxiliarySlotName;
  provider: string;
  model: string;
  base_url: string;
  api_key: string;
}

export interface AuxiliaryMainModelSummary {
  provider: string;
  model: string;
}

export interface AuxiliaryModelsResponse {
  ok: boolean;
  error?: string;
  config_path?: string;
  config_exists?: boolean;
  /**
   * Each auxiliary task slot in display order. Matches upstream
   * ``GET /api/model/auxiliary``'s ``tasks`` array.
   */
  tasks?: AuxiliaryTask[];
  /** Main model summary, so callers can render aux + main side-by-side. */
  main?: AuxiliaryMainModelSummary;
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
  task: AuxiliarySlotName;
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
