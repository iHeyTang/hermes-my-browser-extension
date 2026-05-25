/**
 * Hermes model management client.
 *
 * Primary surface: ``GET/POST /hermes/main-provider-settings`` (main model +
 * credentials as one business resource). Other ``/hermes/*`` routes cover
 * catalog, auxiliary slots, env status, and attach uploads.
 */

import {
  BACKPLANE_HTTP_BASE,
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
  provider?: string;
  model?: string;
  /** Mine-only additive: resolved from ``model.base_url`` in ``config.yaml``. */
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
  /** Present only when the request itself failed (``ok === false``). */
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
    const url = `${stripSlash(BACKPLANE_HTTP_BASE)}/hermes/main-provider-settings${q}`;
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

export async function setHermesAgentMainModel(patch: {
  provider?: string;
  model?: string;
  base_url?: string | null;
}): Promise<HermesAgentMainModelResponse> {
  // Route through the mine-only ``/hermes/main-provider-settings`` POST
  // because the upstream-aligned ``/hermes/model/set`` doesn't accept
  // ``base_url``, and callers rely on passing ``base_url: null`` here
  // to clear a stale ``model.base_url`` when swapping providers. The
  // response shape (``HermesAgentMainModelResponse`` superset, no
  // ``credentials`` when none requested) matches what this function
  // contracted before the alignment refactor.
  return saveHermesMainProviderSettings(patch);
}

/** Save main model (``config.yaml``) and optional plugin credentials in one request. */
export async function saveHermesMainProviderSettings(body: {
  provider?: string;
  model?: string;
  base_url?: string | null;
  credentials?: Record<string, string> | null;
}): Promise<HermesAgentMainModelResponse> {
  try {
    const url = `${stripSlash(BACKPLANE_HTTP_BASE)}/hermes/main-provider-settings`;
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

/** Curated provider → models, mirrors upstream GET /api/model/options.
 *
 * **Wire-shape change**: when the backplane can import
 * ``hermes_cli.inventory.build_models_payload`` (which it can whenever
 * Hermes is the host process), this endpoint now returns upstream's
 * shape: ``{providers: ProviderRow[], model: string, provider: string}``
 * — NOT the richer ``{catalog_source, updated_at, metadata, providers
 * (dict), provider_ids, ...}`` shape this client used to expect.
 *
 * The ``HermesModelCatalogResponse`` type below still types the legacy
 * shape for backward-compat. Consumers should migrate to the upstream
 * shape; type assertions will surface where adaptation is needed.
 * The ``refresh`` query param is accepted but only honored by the
 * local-catalog fallback (which runs when the backplane is loaded
 * outside a Hermes venv — i.e., effectively never in the extension).
 */
export async function getHermesModelCatalog(
  refresh = false,
): Promise<HermesModelCatalogResponse> {
  const q = refresh ? "?refresh=1" : "";
  try {
    const url = `${stripSlash(BACKPLANE_HTTP_BASE)}/hermes/model/options${q}`;
    const res = await fetch(url, { method: "GET" });
    const data = (await res.json()) as HermesModelCatalogResponse;
    if (!res.ok) {
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
 * One row in the auxiliary-task list. Matches upstream
 * ``GET /api/model/auxiliary``'s per-slot shape exactly.
 */
export interface AuxiliaryTask {
  task: AuxiliarySlotName;
  provider: string;
  model: string;
  base_url: string;
}

export interface AuxiliaryMainModelSummary {
  provider: string;
  model: string;
}

export interface AuxiliaryModelsResponse {
  ok: boolean;
  /** Present only when the request itself failed (``ok === false``). */
  error?: string;
  /**
   * Each auxiliary task slot in display order. Matches upstream
   * ``GET /api/model/auxiliary``'s ``tasks`` array.
   */
  tasks?: AuxiliaryTask[];
  /** Main model summary, so callers can render aux + main side-by-side. */
  main?: AuxiliaryMainModelSummary;
}

export async function getHermesAuxiliaryModels(): Promise<AuxiliaryModelsResponse> {
  // Path mirrors upstream GET /api/model/auxiliary. Body shape stays
  // mostly the same; mine-only additive fields (per-task ``api_key``,
  // top-level ``config_path`` / ``config_exists``) still come through.
  try {
    const url = `${stripSlash(BACKPLANE_HTTP_BASE)}/hermes/model/auxiliary`;
    const res = await fetch(url, { method: "GET" });
    const data = (await res.json()) as AuxiliaryModelsResponse;
    if (!res.ok) {
      return { ok: false, error: responseError(res, data) };
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
}): Promise<AuxiliaryModelsResponse> {
  // Backplane consolidates main + auxiliary writes into a single
  // POST /hermes/model/set with ``scope: "auxiliary"``. The write
  // returns a minimal envelope; we follow up with GET
  // /hermes/model/auxiliary to refresh the full state the caller expects.
  try {
    const setUrl = `${stripSlash(BACKPLANE_HTTP_BASE)}/hermes/model/set`;
    const setRes = await fetch(setUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "auxiliary", ...patch }),
    });
    if (!setRes.ok) {
      const data = (await setRes.json().catch(() => null)) as
        | { error?: string }
        | null;
      return { ok: false, error: responseError(setRes, data) };
    }
    return await getHermesAuxiliaryModels();
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
    const url = `${stripSlash(BACKPLANE_HTTP_BASE)}/hermes/provider-models?provider=${p}${q}`;
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
