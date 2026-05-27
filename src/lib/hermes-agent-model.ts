/**
 * Hermes model management client.
 *
 * Three orthogonal surfaces — no bundling, no aliases:
 *
 *   - ``/hermes/model/info``         main-model state
 *   - ``/hermes/model/set``          main + auxiliary writes
 *   - ``/hermes/model/options``      provider catalog
 *   - ``/hermes/provider-models``    per-provider model list
 *   - ``/hermes/provider-credentials`` plugin .env credentials only
 */

import { backplaneFetch } from "./backplane-client";

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
  /** Resolved ``model.base_url`` from ``config.yaml`` (null when unset). */
  base_url?: string | null;
  auto_context_length?: number;
  config_context_length?: number;
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
  /** Stock base URL the provider ships with — purely informational. */
  default_base_url?: string;
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
  env_ready_provider_ids?: string[];
  canonical_providers?: HermesCanonicalProviderEntry[];
  canonical_loaded?: boolean;
  provider_env_vars?: Record<string, string[]>;
  warning?: string;
}

/** One editable env var on a provider's credentials panel. */
export interface HermesProviderCredentialField {
  /** Env var name. */
  key: string;
  /** Current value from plugin ``.env`` (empty when unset). */
  value: string;
  /**
   * Placeholder shown when the input is empty. Carries the provider's
   * default endpoint for URL fields; empty for secret fields.
   */
  placeholder: string;
  /** ``"url"`` or ``"secret"`` — UI hint for input type/styling. */
  kind: "url" | "secret";
}

/** ``GET /hermes/provider-credentials?provider=…`` response. */
export interface HermesProviderCredentialsResponse {
  ok: boolean;
  error?: string;
  provider: string;
  fields: HermesProviderCredentialField[];
  /** Non-empty when the provider has no env-editable credentials (OAuth-only, etc.). */
  auth_hint: string;
}

/** Per-provider model list resolved from `/hermes/provider-models`. */
export interface HermesProviderModelsResponse {
  ok: boolean;
  error?: string;
  provider?: string;
  models?: HermesCatalogModelEntry[];
  source?: string;
  cli_loaded?: boolean;
  pricing_loaded?: boolean;
}

function responseError(res: Response, data: { error?: string } | null | undefined): string {
  return (data && typeof data.error === "string" && data.error) || `${res.status} ${res.statusText}`;
}

/** Read the main model's resolved state from ``config.yaml``. */
export async function getHermesMainModelInfo(): Promise<HermesAgentMainModelResponse> {
  try {
    const res = await backplaneFetch(`/hermes/model/info`, { method: "GET" });
    const data = (await res.json()) as HermesAgentMainModelResponse;
    if (!res.ok) {
      return { ok: false, error: responseError(res, data) };
    }
    return { ...data, ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

/** Set the main model. ``base_url`` is optional: pass ``null`` to clear. */
export async function setHermesAgentMainModel(patch: {
  provider: string;
  model: string;
  base_url?: string | null;
}): Promise<HermesAgentMainModelResponse> {
  const body: Record<string, unknown> = {
    scope: "main",
    provider: patch.provider,
    model: patch.model,
  };
  if (Object.prototype.hasOwnProperty.call(patch, "base_url")) {
    body.base_url = patch.base_url;
  }
  try {
    const res = await backplaneFetch(`/hermes/model/set`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as HermesAgentMainModelResponse;
    if (!res.ok) {
      return { ok: false, error: responseError(res, data) };
    }
    return { ...data, ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

/** Read plugin .env credentials for one provider. */
export async function getHermesProviderCredentials(
  provider: string,
): Promise<HermesProviderCredentialsResponse> {
  const slug = provider.trim();
  if (!slug) {
    return {
      ok: false,
      error: "provider required",
      provider: "",
      fields: [],
      auth_hint: "",
    };
  }
  try {
    const res = await backplaneFetch(
      `/hermes/provider-credentials?provider=${encodeURIComponent(slug)}`,
      { method: "GET" },
    );
    const data = (await res.json()) as HermesProviderCredentialsResponse;
    if (!res.ok) {
      return {
        ok: false,
        error: responseError(res, data),
        provider: slug,
        fields: [],
        auth_hint: "",
      };
    }
    return {
      ok: true,
      provider: data.provider ?? slug,
      fields: Array.isArray(data.fields) ? data.fields : [],
      auth_hint: typeof data.auth_hint === "string" ? data.auth_hint : "",
    };
  } catch (e) {
    return {
      ok: false,
      error: String((e as Error)?.message || e),
      provider: slug,
      fields: [],
      auth_hint: "",
    };
  }
}

/** Write plugin .env credentials for one provider. */
export async function saveHermesProviderCredentials(
  provider: string,
  values: Record<string, string>,
): Promise<{ ok: boolean; error?: string; written?: string[] }> {
  const slug = provider.trim();
  if (!slug) return { ok: false, error: "provider required" };
  try {
    const res = await backplaneFetch(`/hermes/provider-credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: slug, values }),
    });
    const data = (await res.json()) as { ok?: boolean; error?: string; written?: string[] };
    if (!res.ok) {
      return { ok: false, error: responseError(res, data) };
    }
    return { ok: true, written: data.written ?? [] };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

/**
 * Wire row as emitted by Hermes's ``inventory.build_models_payload``
 * with ``picker_hints=True`` (what backplane requests). Source values:
 *
 * - ``"user-config"``: explicit ``providers.<name>`` entry in
 *   ``~/.hermes/config.yaml``
 * - ``"built-in"`` / ``"hermes"``: Hermes detected the provider from
 *   a built-in catalog (curated model list) — does NOT necessarily
 *   mean the user authenticated it; could just be visible because
 *   Hermes ships with the slug registered
 * - ``"canonical"``: skeleton placeholder for an unconfigured
 *   provider (only present when ``include_unconfigured=True``)
 *
 * ``authenticated``: true when the row has usable credentials;
 * false for skeleton placeholders. ``is_user_defined``: true for
 * custom-endpoint config entries.
 */
interface WireProviderRow {
  slug: string;
  name?: string;
  is_current?: boolean;
  is_user_defined?: boolean;
  /**
   * Upstream's ``build_models_payload`` ships ``models`` as a plain
   * ``string[]`` of model ids — NOT the ``{id, description, metadata}``
   * objects the rest of this module is typed against. We normalize at
   * the adapter boundary (see ``adaptModelOptions``) so consumers
   * always see ``HermesCatalogModelEntry[]``. Older endpoints / dev
   * fallbacks may still send object form, so accept both here.
   */
  models?: (HermesCatalogModelEntry | string)[];
  total_models?: number;
  source?: string;
  authenticated?: boolean;
  auth_type?: string;
  key_env?: string;
  default_base_url?: string;
}

interface WireModelOptionsResponse {
  providers?: WireProviderRow[];
  model?: string;
  provider?: string;
  /** Canonical (alias-resolved) slugs the user wrote in ``config.yaml: providers:``. */
  configured_provider_slugs?: string[];
  /** Slugs whose API key env vars have non-empty values in the plugin ``.env``. */
  dotenv_configured_provider_slugs?: string[];
  error?: string;
}

function adaptModelOptions(
  wire: WireModelOptionsResponse,
): HermesModelCatalogResponse {
  const rows = Array.isArray(wire.providers) ? wire.providers : [];
  const configuredFromBackplane = new Set<string>(
    Array.isArray(wire.configured_provider_slugs)
      ? wire.configured_provider_slugs.filter(
          (s): s is string => typeof s === "string" && s.length > 0,
        )
      : [],
  );
  const dotenvConfiguredSlugs = new Set<string>(
    Array.isArray(wire.dotenv_configured_provider_slugs)
      ? wire.dotenv_configured_provider_slugs.filter(
          (s): s is string => typeof s === "string" && s.length > 0,
        )
      : [],
  );
  const providersDict: Record<string, HermesCatalogProviderBlock> = {};
  const providerIds: string[] = [];
  const configProviderIds: string[] = [];
  const envReadyProviderIds: string[] = [];
  const canonical: HermesCanonicalProviderEntry[] = [];
  for (const r of rows) {
    const slug = (r.slug || "").trim();
    if (!slug) continue;
    providerIds.push(slug);
    // Normalize ``models`` to ``HermesCatalogModelEntry[]`` regardless
    // of wire shape (upstream sends string[], legacy / fallback may
    // send object[]). Downstream code reads ``m.id`` everywhere.
    const normalizedModels: HermesCatalogModelEntry[] = [];
    for (const m of r.models ?? []) {
      if (typeof m === "string") {
        const id = m.trim();
        if (id) normalizedModels.push({ id });
      } else if (m && typeof m === "object" && typeof m.id === "string") {
        const id = m.id.trim();
        if (id) normalizedModels.push(m);
      }
    }
    providersDict[slug] = {
      models: normalizedModels,
      default_base_url: r.default_base_url ?? "",
    } as HermesCatalogProviderBlock;
    const isUserConfigured =
      configuredFromBackplane.has(slug) ||
      r.source === "user-config" ||
      r.is_user_defined === true;
    if (isUserConfigured) {
      configProviderIds.push(slug);
    } else if (dotenvConfiguredSlugs.has(slug)) {
      // Strict signal: the user pressed "Save credentials" in this
      // extension and the plugin ``.env`` now carries this provider's
      // API key. ``r.authenticated`` is deliberately NOT enough — it
      // also fires when Hermes detects ambient credentials elsewhere
      // (shell env vars, Claude Code OAuth at ``~/.claude``, ``gh``
      // CLI tokens, AWS SDK config, …). Those flag a provider as
      // "usable" but not "configured here", and lumping them under
      // "Configured" surprises users who never touched the panel.
      envReadyProviderIds.push(slug);
    }
    canonical.push({
      slug,
      label: r.name || slug,
      tui_desc: r.name || slug,
    });
  }
  return {
    ok: true,
    providers: providersDict,
    provider_ids: providerIds,
    config_provider_ids: configProviderIds,
    env_ready_provider_ids: envReadyProviderIds,
    canonical_providers: canonical,
    canonical_loaded: true,
  };
}

export async function getHermesModelCatalog(
  refresh = false,
): Promise<HermesModelCatalogResponse> {
  const q = refresh ? "?refresh=1" : "";
  try {
    const url = `/hermes/model/options${q}`;
    const res = await backplaneFetch(url, { method: "GET" });
    const data = (await res.json()) as WireModelOptionsResponse;
    if (!res.ok) {
      return {
        ok: false,
        error: responseError(res, data),
      };
    }
    return adaptModelOptions(data);
  } catch (e) {
    return {
      ok: false,
      error: String((e as Error)?.message || e),
    };
  }
}

/** Auxiliary task slot names — matches upstream `AUXILIARY_SLOTS`. */
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

/** One row in the auxiliary-task list. */
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
  error?: string;
  tasks?: AuxiliaryTask[];
  main?: AuxiliaryMainModelSummary;
}

export async function getHermesAuxiliaryModels(): Promise<AuxiliaryModelsResponse> {
  try {
    const url = `/hermes/model/auxiliary`;
    const res = await backplaneFetch(url, { method: "GET" });
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
  try {
    const setUrl = `/hermes/model/set`;
    const setRes = await backplaneFetch(setUrl, {
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
    const url = `/hermes/provider-models?provider=${p}${q}`;
    const res = await backplaneFetch(url, { method: "GET" });
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
