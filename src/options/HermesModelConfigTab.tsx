import {
  ChevronDown,
  ChevronRight,
  Crown,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  X,
  Zap,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "~components/ui/badge";
import { Button } from "~components/ui/button";
import { Input } from "~components/ui/input";
import { Label } from "~components/ui/label";
import { ScrollArea } from "~components/ui/scroll-area";
import { useT } from "~lib/i18n";

import { OPTIONS_SHELL_HEADER_ROW } from "./optionsPageChrome";
import {
  AUXILIARY_SLOT_LABELS,
  AUXILIARY_SLOT_NAMES,
  getHermesAuxiliaryModels,
  getHermesMainModelInfo,
  getHermesModelCatalog,
  getHermesProviderCredentials,
  getHermesProviderModels,
  saveHermesProviderCredentials,
  setHermesAgentMainModel,
  setHermesAuxiliarySlot,
  type AuxiliaryModelsResponse,
  type AuxiliarySlotName,
  type AuxiliaryTask,
  type HermesCatalogModelEntry,
  type HermesModelCatalogResponse,
  type HermesProviderCredentialField,
} from "~lib/hermes-agent-model";
import { cn } from "~lib/utils";

/** Sidebar selection: special "model-config" panel or a provider slug. */
type SidebarSection = "model-config" | string;

/**
 * Format a context-length token count for display: ``200K``, ``1M``,
 * ``128K``. Returns empty string when the count is missing or zero —
 * callers use that as the "hide the chip" signal.
 */
function formatContextLength(n: number): string {
  if (!n || n <= 0) return "";
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${Math.round(n / 1000)}K`;
  }
  return String(n);
}

/** Build a name-indexed view of the upstream `tasks` array for render code. */
function tasksToMap(
  resp: AuxiliaryModelsResponse,
): Record<AuxiliarySlotName, AuxiliaryTask> | null {
  const arr = resp.tasks;
  if (!arr || arr.length === 0) return null;
  const map: Partial<Record<AuxiliarySlotName, AuxiliaryTask>> = {};
  for (const t of arr) map[t.task] = t;
  return map as Record<AuxiliarySlotName, AuxiliaryTask>;
}

function formatScalarForMeta(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "";
    if (Number.isInteger(v)) return String(v);
    const t = v.toFixed(8).replace(/\.?0+$/, "");
    return t === "-0" ? "0" : t;
  }
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v))
    return v.map(formatScalarForMeta).filter(Boolean).join(", ");
  return "";
}

function labelMetaKey(k: string): string {
  const m: Record<string, string> = {
    context_window: "Context",
    max_context_tokens: "Context cap",
    max_output_tokens: "Output cap",
    max_tokens: "tokens",
    input_price_per_mtok: "Input",
    output_price_per_mtok: "Output",
    input_price: "Input price",
    output_price: "Output price",
    pricing: "Pricing",
    pricing_tier: "Pricing tier",
    modality: "Modality",
    modalities: "Modality",
    parameters: "Parameters",
    tags: "Capabilities",
  };
  return m[k] ?? k.replace(/_/g, " ");
}

/** Stable order for ``metadata`` chips (context first, then pricing, then tags). */
const META_DISPLAY_KEY_ORDER: string[] = [
  "context_window",
  "max_context_tokens",
  "max_output_tokens",
  "max_tokens",
  "input_price_per_mtok",
  "output_price_per_mtok",
  "input_price",
  "output_price",
  "pricing",
  "pricing_tier",
  "modality",
  "modalities",
  "parameters",
  "tags",
];

function metaDisplayKeyRank(k: string): number {
  const i = META_DISPLAY_KEY_ORDER.indexOf(k);
  return i === -1 ? 1000 : i;
}

function hasDisplayableMeta(meta: Record<string, unknown> | undefined): boolean {
  if (!meta || typeof meta !== "object") return false;
  return Object.keys(meta).some((k) => {
    const v = meta[k];
    if (v === null || v === undefined) return false;
    if (typeof v === "string") return v.trim() !== "";
    if (typeof v === "boolean" || typeof v === "number") return true;
    if (Array.isArray(v)) return v.length > 0;
    return false;
  });
}

/** Renders ``entry.metadata`` plus catalog top-level fields the bridge may fold in. */
function ModelEntryMetadataLine({
  meta,
}: {
  meta: Record<string, unknown> | undefined;
}) {
  if (!hasDisplayableMeta(meta)) return null;
  const m = meta as Record<string, unknown>;
  const pairs = Object.entries(m).filter(
    ([, v]) => formatScalarForMeta(v) !== "",
  );
  if (!pairs.length) return null;
  pairs.sort(([a], [b]) => metaDisplayKeyRank(a) - metaDisplayKeyRank(b) || a.localeCompare(b));
  const TOKEN_COUNT_KEYS = new Set([
    "context_window",
    "max_context_tokens",
    "max_output_tokens",
    "max_tokens",
  ]);
  return (
    <div className="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[10px] leading-snug text-muted-foreground">
      {pairs.map(([k, v]) => {
        if (k === "input_price_per_mtok" || k === "output_price_per_mtok") {
          const label = k === "input_price_per_mtok" ? "Input" : "Output";
          return (
            <span key={k} title={k}>
              <span className="font-medium text-foreground/65">{label}</span>
              <span className="text-muted-foreground/90">
                {" "}
                {formatScalarForMeta(v)} $/M
              </span>
            </span>
          );
        }
        const valueText = TOKEN_COUNT_KEYS.has(k)
          ? formatTokenCount(v)
          : formatScalarForMeta(v);
        return (
          <span key={k} title={k}>
            <span className="font-medium text-foreground/65">{labelMetaKey(k)}</span>
            <span className="text-muted-foreground/90"> {valueText}</span>
          </span>
        );
      })}
    </div>
  );
}

/** Format token-count integers with K/M suffix (200000 → "200K"). Falls
 * back to the generic formatter for non-numeric or non-positive values
 * so we never silently swallow odd input.
 */
function formatTokenCount(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    return formatScalarForMeta(v);
  }
  if (v >= 1_000_000) {
    const m = v / 1_000_000;
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (v >= 1_000) {
    const k = v / 1_000;
    return Number.isInteger(k) ? `${k}K` : `${k.toFixed(0)}K`;
  }
  return String(v);
}

export function HermesModelConfigTab() {
  const { t } = useT();
  // ── Shared / catalog state ─────────────────────────────────────────────
  const [catalog, setCatalog] = useState<HermesModelCatalogResponse | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);

  // ── Sidebar selection ──────────────────────────────────────────────────
  const [section, setSection] = useState<SidebarSection>("model-config");

  // ── Main-model state (disk only — no draft) ───────────────────────────
  const [mainLoading, setMainLoading] = useState(true);
  const [mainError, setMainError] = useState<string | null>(null);
  const [diskProvider, setDiskProvider] = useState("auto");
  const [diskModel, setDiskModel] = useState("");
  const [diskBaseUrl, setDiskBaseUrl] = useState("");
  /**
   * Resolved context-length triple + capabilities from
   * ``/hermes/model/info``. Owned independently of the catalog and
   * credentials fetches — those three surfaces are orthogonal now.
   */
  const [mainContext, setMainContext] = useState<{
    auto: number;
    config: number;
    effective: number;
  }>({ auto: 0, config: 0, effective: 0 });
  const [mainCapabilities, setMainCapabilities] = useState<{
    supports_tools?: boolean;
    supports_vision?: boolean;
    supports_reasoning?: boolean;
    context_window?: number | null;
    max_output_tokens?: number | null;
    model_family?: string | null;
  }>({});

  // ── Auxiliary-model state (8 named slots) ────────────────────────────
  // Bridge returns ``tasks: AuxiliaryTask[]`` matching upstream
  // `/api/model/auxiliary`. We index it by `task` name locally for fast
  // lookup in the per-slot render code — this is a *local view* of the
  // upstream-aligned response, not a wire-shape compat shim.
  const [auxSlots, setAuxSlots] = useState<Record<AuxiliarySlotName, AuxiliaryTask> | null>(null);
  const [auxError, setAuxError] = useState<string | null>(null);
  const [auxSavingSlot, setAuxSavingSlot] = useState<AuxiliarySlotName | null>(null);
  const [auxSavedSlot, setAuxSavedSlot] = useState<AuxiliarySlotName | null>(null);

  // ── Provider panel state ──────────────────────────────────────────────
  // Sidebar selection drives this; empty means "no provider picked yet".
  const [hProvider, setHProvider] = useState("");
  const [hSaving, setHSaving] = useState(false);
  const [hSaved, setHSaved] = useState(false);
  const [hError, setHError] = useState<string | null>(null);
  const [providerCliModels, setProviderCliModels] = useState<HermesCatalogModelEntry[]>([]);
  const [providerCliLoading, setProviderCliLoading] = useState(false);
  const [providerCliMeta, setProviderCliMeta] = useState<{
    source?: string;
    cli_loaded?: boolean;
    pricing_loaded?: boolean;
  } | null>(null);
  /**
   * Per-provider credential cache. Keyed by slug. Once a provider's
   * fields/hint have been fetched they live here for the rest of the
   * session — switching sidebar selection just re-reads from cache and
   * the panel renders instantly (no spinner). ``saveProviderCredentials``
   * and ``refreshCatalogFromRemote`` overwrite the relevant slug's entry
   * so writes don't leave stale data behind.
   */
  const [credentialsCache, setCredentialsCache] = useState<
    Record<
      string,
      { fields: HermesProviderCredentialField[]; authHint: string }
    >
  >({});
  /** Edit drafts for the *current* hProvider only — reset on switch. */
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  /** True only when the *current* hProvider is not yet in the cache. */
  const [keysLoading, setKeysLoading] = useState(false);
  const [keysError, setKeysError] = useState<string | null>(null);

  const currentCredentials = hProvider ? credentialsCache[hProvider] : undefined;
  const credentialFields = currentCredentials?.fields ?? [];
  const credentialAuthHint = currentCredentials?.authHint ?? "";

  // ── Model-Config panel state ──────────────────────────────────────────
  const [mcSaving, setMcSaving] = useState(false);
  const [mcError, setMcError] = useState<string | null>(null);
  const [mcSaved, setMcSaved] = useState(false);
  // Editable fields used only when configuring a `custom` main model.
  const [customDraftModel, setCustomDraftModel] = useState("");
  const [customDraftBaseUrl, setCustomDraftBaseUrl] = useState("");

  // ── Derived ───────────────────────────────────────────────────────────
  const canonicalLabelBySlug = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of catalog?.canonical_providers ?? []) {
      if (p.slug) m.set(p.slug, (p.tui_desc || p.label || p.slug).trim());
    }
    return m;
  }, [catalog?.canonical_providers]);

  const configSlugSet = useMemo(
    () => new Set(catalog?.config_provider_ids ?? []),
    [catalog?.config_provider_ids],
  );

  const envReadySlugSet = useMemo(
    () => new Set(catalog?.env_ready_provider_ids ?? []),
    [catalog?.env_ready_provider_ids],
  );

  const configuredSlugSet = useMemo(() => {
    const s = new Set<string>();
    for (const x of catalog?.config_provider_ids ?? []) s.add(x);
    for (const x of catalog?.env_ready_provider_ids ?? []) s.add(x);
    return s;
  }, [catalog?.config_provider_ids, catalog?.env_ready_provider_ids]);

  /**
   * Sidebar split into two ordered groups:
   *   - configured: providers the user has actually set up
   *     (config.yaml entries ∪ env-ready keys)
   *   - available: every other canonical slug
   *
   * No "auto" entry — auto is a main-model resolution policy, not a
   * provider you configure. It lives in Model Config only.
   *
   * ``custom`` (the BYO OpenAI-compatible escape hatch) is **not**
   * unconditionally included — it's noise for the 99% of users who
   * don't run their own gateway. We only put it in the list when:
   *   - it's the user's current main provider (``diskProvider === "custom"``)
   *   - or the user explicitly opened its editor (``hProvider === "custom"``)
   * The "+ Custom endpoint" affordance under the list is the entry
   * point for first-time activation. ``customVisible`` is also
   * exported so the JSX can decide whether to render that affordance.
   */
  const sidebarGroups = useMemo(() => {
    const hp = hProvider.trim();
    const all: string[] = [];
    const seen = new Set<string>();
    const push = (slug: string) => {
      const s = slug.trim();
      if (!s || seen.has(s) || s === "auto") return;
      seen.add(s);
      all.push(s);
    };
    for (const id of catalog?.config_provider_ids ?? []) push(id);
    for (const id of catalog?.env_ready_provider_ids ?? []) push(id);
    for (const id of catalog?.provider_ids ?? []) {
      if (id !== "custom") push(id);
    }
    if (hp && hp !== "custom") push(hp);
    const customVisible = diskProvider === "custom" || hp === "custom";
    if (customVisible) push("custom");

    const configured = all.filter((s) => configuredSlugSet.has(s));
    const available = all.filter((s) => !configuredSlugSet.has(s));
    return { configured, available, customVisible };
  }, [
    catalog?.config_provider_ids,
    catalog?.env_ready_provider_ids,
    catalog?.provider_ids,
    configuredSlugSet,
    diskProvider,
    hProvider,
  ]);

  function providerOptionLabel(id: string): string {
    if (id === "custom") return "Custom OpenAI-compatible endpoint";
    const tui = canonicalLabelBySlug.get(id);
    if (tui) return tui;
    if (configSlugSet.has(id)) return `${id} (already in your Hermes config)`;
    if (envReadySlugSet.has(id)) return `${id} (key saved in ~/.hermes/.env)`;
    return id;
  }

  /**
   * Providers the user explicitly configured *in this extension* (or
   * directly in ``~/.hermes/config.yaml``), plus whichever provider
   * is currently selected as the main / aux model. Deliberately
   * excludes ambient-authenticated rows (Copilot's built-in OAuth,
   * Anthropic's ``~/.claude`` OAuth, AWS SDK creds, …) — those work
   * for Hermes the runtime but aren't "configured here", so listing
   * them surprises users who never touched the panel.
   */
  const allCatalogModels = useMemo(() => {
    const candidates = new Set<string>([
      ...(catalog?.config_provider_ids ?? []),
      ...(catalog?.env_ready_provider_ids ?? []),
    ]);
    if (diskProvider && diskProvider !== "auto" && diskProvider !== "custom") {
      candidates.add(diskProvider);
    }
    if (auxSlots) {
      for (const slot of AUXILIARY_SLOT_NAMES) {
        const p = auxSlots[slot]?.provider?.trim();
        if (p && p !== "auto" && p !== "custom") candidates.add(p);
      }
    }
    const result: { provider: string; entry: HermesCatalogModelEntry }[] = [];
    for (const pid of candidates) {
      const block = catalog?.providers?.[pid];
      if (!block?.models?.length) continue;
      for (const m of block.models) {
        if (typeof m.id === "string" && m.id.trim()) {
          result.push({ provider: pid, entry: m });
        }
      }
    }
    return result;
  }, [catalog, diskProvider, auxSlots]);

  const modelEntriesForProvider = useMemo((): HermesCatalogModelEntry[] => {
    const p = hProvider.trim();
    if (providerCliModels.length > 0) return providerCliModels;
    const block = catalog?.providers?.[p];
    if (!block?.models?.length) return [];
    return block.models.filter((m) => typeof m.id === "string" && m.id.trim());
  }, [providerCliModels, catalog?.providers, hProvider]);

  const showHermesModelLoading =
    !mainLoading &&
    hProvider.trim() !== "" &&
    providerCliLoading;

  // ── Load provider models when provider panel changes ──────────────────
  const loadProviderModels = useCallback(async (refresh: boolean) => {
    const p = hProvider.trim();
    if (!p) {
      setProviderCliModels([]);
      setProviderCliMeta(null);
      setProviderCliLoading(false);
      return;
    }
    setProviderCliLoading(true);
    try {
      const r = await getHermesProviderModels(p, refresh);
      if (r.ok && r.models && r.models.length > 0) {
        setProviderCliModels(r.models.filter((m) => typeof m.id === "string" && m.id.trim()));
        setProviderCliMeta({
          source: r.source,
          cli_loaded: r.cli_loaded,
          pricing_loaded: r.pricing_loaded,
        });
      } else {
        setProviderCliModels([]);
        setProviderCliMeta({
          source: r.source,
          cli_loaded: r.cli_loaded,
          pricing_loaded: r.pricing_loaded,
        });
      }
    } catch {
      setProviderCliModels([]);
      setProviderCliMeta({ source: "error", cli_loaded: false, pricing_loaded: false });
    } finally {
      setProviderCliLoading(false);
    }
  }, [hProvider]);

  useEffect(() => {
    if (mainLoading) return;
    const p = hProvider.trim();
    if (!p) {
      setProviderCliModels([]);
      setProviderCliMeta(null);
      setProviderCliLoading(false);
      return;
    }
    setProviderCliModels([]);
    setProviderCliMeta(null);
    void loadProviderModels(false);
  }, [mainLoading, hProvider, loadProviderModels]);

  // ── Resolve credentials for the active provider ───────────────────────
  // Cache-first: if we've fetched this slug before in the current session,
  // restore drafts from cache and render instantly with no loading state.
  // Only fetch when it's genuinely the first look at this provider.
  useEffect(() => {
    const p = hProvider.trim();
    setKeysError(null);
    if (!p) {
      setKeyDrafts({});
      setKeysLoading(false);
      return;
    }
    const cached = credentialsCache[p];
    if (cached) {
      const drafts: Record<string, string> = {};
      for (const f of cached.fields) drafts[f.key] = f.value;
      setKeyDrafts(drafts);
      setKeysLoading(false);
      return;
    }
    let cancelled = false;
    setKeyDrafts({});
    setKeysLoading(true);
    void getHermesProviderCredentials(p).then((r) => {
      if (cancelled) return;
      setKeysLoading(false);
      if (!r.ok) {
        setKeysError(r.error || "Failed to read credentials");
        return;
      }
      setCredentialsCache((prev) => ({
        ...prev,
        [p]: { fields: r.fields, authHint: r.auth_hint },
      }));
      const drafts: Record<string, string> = {};
      for (const f of r.fields) drafts[f.key] = f.value;
      setKeyDrafts(drafts);
    });
    return () => {
      cancelled = true;
    };
    // We intentionally don't depend on credentialsCache — a fetched
    // entry would otherwise re-trigger this effect and clobber the
    // user's drafts. Cache reads happen the next time hProvider flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hProvider]);

  // ── Initial load — three independent fetches, no bundling ─────────────
  useEffect(() => {
    let cancelled = false;
    setMainLoading(true);
    setMainError(null);
    void getHermesMainModelInfo().then((main) => {
      if (cancelled) return;
      setMainLoading(false);
      if (!main.ok) {
        setMainError(main.error || "Failed to read main model");
        return;
      }
      const dp = (main.provider || "auto").trim() || "auto";
      const dm = (main.model || "").trim();
      const bu = (main.base_url || "").trim();
      setDiskProvider(dp);
      setDiskModel(dm);
      setDiskBaseUrl(bu);
      setCustomDraftModel(dp === "custom" ? dm : "");
      setCustomDraftBaseUrl(dp === "custom" ? bu : "");
      setMainContext({
        auto: main.auto_context_length ?? 0,
        config: main.config_context_length ?? 0,
        effective: main.effective_context_length ?? 0,
      });
      setMainCapabilities(main.capabilities ?? {});
    });
    void getHermesModelCatalog(false).then((cat) => {
      if (cancelled) return;
      setCatalogLoading(false);
      if (cat.ok) setCatalog(cat);
    });
    void getHermesAuxiliaryModels().then((auxResp) => {
      if (cancelled) return;
      if (auxResp.ok) {
        setAuxSlots(tasksToMap(auxResp));
      } else {
        setAuxError(auxResp.error || null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Refresh catalog + provider models ─────────────────────────────────
  async function refreshCatalogFromRemote() {
    setCatalogRefreshing(true);
    try {
      const c = await getHermesModelCatalog(true);
      if (c.ok) setCatalog(c);
      await loadProviderModels(true);
      const p = hProvider.trim();
      if (p) {
        const dv = await getHermesProviderCredentials(p);
        if (dv.ok) {
          setCredentialsCache((prev) => ({
            ...prev,
            [p]: { fields: dv.fields, authHint: dv.auth_hint },
          }));
          const drafts: Record<string, string> = {};
          for (const f of dv.fields) drafts[f.key] = f.value;
          setKeyDrafts(drafts);
        }
      }
    } finally {
      setCatalogRefreshing(false);
    }
  }

  /**
   * Save credentials for the current provider. This writes ONLY to the
   * plugin ``.env``. It never touches ``config.yaml: model.*`` — setting
   * the main model is exclusively the Model Config panel's job (the ⭐
   * action, or the custom-main editor).
   */
  async function saveProviderCredentials() {
    const p = hProvider.trim();
    if (!p || credentialFields.length === 0) return;
    setHSaving(true);
    setHError(null);
    setKeysError(null);
    try {
      const values: Record<string, string> = {};
      for (const f of credentialFields) values[f.key] = keyDrafts[f.key] ?? "";
      const r = await saveHermesProviderCredentials(p, values);
      if (!r.ok) {
        setHError(r.error || "Save failed");
        return;
      }
      // Overwrite the cached snapshot so a subsequent provider switch
      // re-reads the saved values instead of pre-save state.
      setCredentialsCache((prev) => {
        const cached = prev[p];
        if (!cached) return prev;
        return {
          ...prev,
          [p]: {
            ...cached,
            fields: cached.fields.map((f) => ({ ...f, value: values[f.key] ?? "" })),
          },
        };
      });
      void loadProviderModels(true);
      setHSaved(true);
      setTimeout(() => setHSaved(false), 1500);
    } finally {
      setHSaving(false);
    }
  }

  function selectProviderSection(slug: string) {
    setSection(slug);
    setHProvider(slug);
  }

  // ── Model Config: assign a catalog model to the Main slot ──────────────
  async function setDefaultModel(provider: string, modelId: string) {
    const p = provider.trim();
    const id = modelId.trim();
    if (!id) return;
    setMcSaving(true);
    setMcError(null);
    try {
      // Clearing base_url on every canonical-provider switch keeps a
      // stale ``model.base_url`` from leaking into the new provider.
      // The custom-main editor below has its own write path that
      // explicitly sets base_url; that's the only place it gets set.
      const r = await setHermesAgentMainModel({
        provider: p || "auto",
        model: id,
        base_url: null,
      });
      if (!r.ok) {
        setMcError(r.error || "Failed to set main model");
        return;
      }
      const dp = (r.provider || p || "auto").trim() || "auto";
      const dm = (r.model ?? id).trim();
      const dbu = (r.base_url ?? "").trim();
      setDiskProvider(dp);
      setDiskModel(dm);
      setDiskBaseUrl(dbu);
      setMainContext({
        auto: r.auto_context_length ?? 0,
        config: r.config_context_length ?? 0,
        effective: r.effective_context_length ?? 0,
      });
      setMainCapabilities(r.capabilities ?? {});
      setMcSaved(true);
      setTimeout(() => setMcSaved(false), 1500);
    } finally {
      setMcSaving(false);
    }
  }

  /** Set the main model to a `custom` endpoint with an explicit base URL. */
  async function setCustomMainModel() {
    const id = customDraftModel.trim();
    const bu = customDraftBaseUrl.trim();
    if (!id || !bu) return;
    setMcSaving(true);
    setMcError(null);
    try {
      const r = await setHermesAgentMainModel({
        provider: "custom",
        model: id,
        base_url: bu,
      });
      if (!r.ok) {
        setMcError(r.error || "Failed to set custom main model");
        return;
      }
      setDiskProvider("custom");
      setDiskModel(id);
      setDiskBaseUrl(bu);
      setMainContext({
        auto: r.auto_context_length ?? 0,
        config: r.config_context_length ?? 0,
        effective: r.effective_context_length ?? 0,
      });
      setMainCapabilities(r.capabilities ?? {});
      setMcSaved(true);
      setTimeout(() => setMcSaved(false), 1500);
    } finally {
      setMcSaving(false);
    }
  }

  // ── Model Config: set / clear auxiliary slot ──────────────────────────
  // Upstream `/api/model/set` uses `task` (not `slot`) as the slot id.
  async function setAuxSlot(task: AuxiliarySlotName, provider: string, model: string) {
    setAuxSavingSlot(task);
    setAuxError(null);
    try {
      const r = await setHermesAuxiliarySlot({ task, provider: provider.trim(), model: model.trim() });
      if (!r.ok) {
        setAuxError(r.error || "Save failed");
        return;
      }
      const next = tasksToMap(r);
      if (next) setAuxSlots(next);
      setAuxSavedSlot(task);
      setTimeout(() => setAuxSavedSlot(null), 1500);
    } finally {
      setAuxSavingSlot(null);
    }
  }

  async function clearAuxSlot(task: AuxiliarySlotName) {
    setAuxSavingSlot(task);
    setAuxError(null);
    try {
      const r = await setHermesAuxiliarySlot({ task, provider: "", model: "" });
      if (!r.ok) {
        setAuxError(r.error || "Clear failed");
        return;
      }
      const next = tasksToMap(r);
      if (next) setAuxSlots(next);
    } finally {
      setAuxSavingSlot(null);
    }
  }

  /** Reset main back to ``auto`` — same shape as ``clearAuxSlot``, used
   * by the ModelSlotRow's ✕ button on the Main row.
   */
  async function clearMainModel() {
    setMcSaving(true);
    setMcError(null);
    try {
      const r = await setHermesAgentMainModel({
        provider: "auto",
        model: "",
        base_url: null,
      });
      if (!r.ok) {
        setMcError(r.error || "Clear failed");
        return;
      }
      setDiskProvider((r.provider || "auto").trim() || "auto");
      setDiskModel((r.model ?? "").trim());
      setDiskBaseUrl((r.base_url ?? "").trim());
      setMainContext({
        auto: r.auto_context_length ?? 0,
        config: r.config_context_length ?? 0,
        effective: r.effective_context_length ?? 0,
      });
      setMainCapabilities(r.capabilities ?? {});
    } finally {
      setMcSaving(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header
        className={`${OPTIONS_SHELL_HEADER_ROW} flex-wrap justify-between gap-3 bg-muted/20 px-4`}
      >
        <div className="flex min-w-0 flex-col justify-center gap-0.5 leading-tight">
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            {t("options.models.title")}
          </h2>
          <p className="truncate text-[11px] text-muted-foreground">
            {catalogLoading
              ? t("options.models.catalog.loading")
              : catalog?.ok
                ? catalog.updated_at
                  ? t("options.models.catalog.updatedAt", {
                      time: catalog.updated_at,
                    })
                  : t("options.models.catalog.ready")
                : t("options.models.catalog.unavailable")}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 text-xs shrink-0"
          disabled={catalogRefreshing}
          onClick={() => void refreshCatalogFromRemote()}
        >
          {catalogRefreshing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {t("options.models.refreshCatalog")}
        </Button>
      </header>

      {mainLoading ? (
        <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
          {t("options.models.loadingSettings")}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* ── Sidebar ── */}
          <aside className="flex min-h-0 w-56 shrink-0 flex-col border-r border-border bg-muted/15">
            {/* Model Config entry */}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                "h-auto min-h-0 w-full flex-col items-stretch gap-1 rounded-none border-0 border-b border-border/50 px-3 py-2.5 text-left font-normal shadow-none",
                section === "model-config"
                  ? "bg-muted text-foreground hover:bg-muted"
                  : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
              )}
              onClick={() => setSection("model-config")}
            >
              <span className="text-[11px] font-semibold">Model config</span>
              <span className="line-clamp-1 text-left text-[10px] leading-snug text-muted-foreground">
                {diskModel
                  ? `Main: ${diskModel}`
                  : "Set main and auxiliary models"}
              </span>
            </Button>

            {/* Provider list — small section label inside the list, not a full h-14 shell row */}
            <ScrollArea className="min-h-0 flex-1">
              <nav className="flex flex-col">
                {sidebarGroups.configured.length > 0 && (
                  <>
                    <p className="px-3 pt-2 pb-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                      Configured
                    </p>
                    {sidebarGroups.configured.map((slug) => (
                      <SidebarProviderItem
                        key={slug}
                        slug={slug}
                        active={section === slug}
                        label={providerOptionLabel(slug)}
                        onClick={() => selectProviderSection(slug)}
                      />
                    ))}
                    <div className="my-1 mx-3 border-t border-border/40" />
                  </>
                )}
                {sidebarGroups.available.length > 0 && (
                  <>
                    <p className="px-3 pt-2 pb-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                      Available
                    </p>
                    {sidebarGroups.available.map((slug) => (
                      <SidebarProviderItem
                        key={slug}
                        slug={slug}
                        active={section === slug}
                        label={providerOptionLabel(slug)}
                        onClick={() => selectProviderSection(slug)}
                      />
                    ))}
                  </>
                )}
                {/*
                 * "+ Custom endpoint" affordance — collapsed entry
                 * point for the BYO OpenAI-compatible gateway editor.
                 * Hidden once activated (the editor appears as a
                 * regular sidebar item via ``customVisible``), so it
                 * never duplicates with itself.
                 */}
                {!sidebarGroups.customVisible && (
                  <button
                    type="button"
                    onClick={() => selectProviderSection("custom")}
                    className="mt-2 mx-3 mb-3 inline-flex items-center gap-1 self-start rounded-full px-2 py-0.5 text-[10px] text-muted-foreground/70 transition-colors hover:bg-muted/40 hover:text-foreground"
                  >
                    <span aria-hidden>+</span>
                    <span>Custom endpoint</span>
                  </button>
                )}
              </nav>
            </ScrollArea>
          </aside>

          {/* ── Right panel ── */}
          <ScrollArea className="min-h-0 min-w-0 flex-1">
            {section === "model-config" ? (
              <ModelConfigPanel
                catalog={catalog}
                diskProvider={diskProvider}
                diskModel={diskModel}
                diskBaseUrl={diskBaseUrl}
                mainContext={mainContext}
                mainCapabilities={mainCapabilities}
                auxSlots={auxSlots}
                auxError={auxError}
                auxSavingSlot={auxSavingSlot}
                auxSavedSlot={auxSavedSlot}
                mcSaving={mcSaving}
                mcError={mcError}
                mcSaved={mcSaved}
                allCatalogModels={allCatalogModels}
                canonicalLabelBySlug={canonicalLabelBySlug}
                onSetDefault={setDefaultModel}
                onClearMain={clearMainModel}
                onSetAuxSlot={setAuxSlot}
                onClearAuxSlot={clearAuxSlot}
              />
            ) : (
              <ProviderPanel
                hProvider={hProvider}
                hSaving={hSaving}
                hSaved={hSaved}
                hError={hError}
                credentialFields={credentialFields}
                credentialAuthHint={credentialAuthHint}
                keyDrafts={keyDrafts}
                keysLoading={keysLoading}
                keysError={keysError}
                catalog={catalog}
                showHermesModelLoading={showHermesModelLoading}
                modelEntriesForProvider={modelEntriesForProvider}
                providerCliMeta={providerCliMeta}
                providerOptionLabel={providerOptionLabel}
                onKeyDraftChange={(k, v) =>
                  setKeyDrafts((prev) => ({ ...prev, [k]: v }))
                }
                onSave={() => void saveProviderCredentials()}
                onRefreshModels={() => void loadProviderModels(true)}
                customDraftModel={customDraftModel}
                customDraftBaseUrl={customDraftBaseUrl}
                customSaving={mcSaving}
                customError={mcError}
                onCustomDraftModelChange={setCustomDraftModel}
                onCustomDraftBaseUrlChange={setCustomDraftBaseUrl}
                onSetCustomMain={setCustomMainModel}
              />
            )}
          </ScrollArea>
        </div>
      )}
    </div>
  );
}

function SidebarProviderItem({
  slug,
  active,
  label,
  onClick,
}: {
  slug: string;
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        "h-auto min-h-0 w-full flex-col items-stretch gap-1 rounded-none border-0 px-3 py-2.5 text-left font-normal shadow-none",
        active
          ? "bg-muted text-foreground hover:bg-muted"
          : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
      )}
      onClick={onClick}
    >
      <span className="line-clamp-2 text-[11px] font-medium">{label}</span>
      <span className="font-mono text-[10px] text-muted-foreground">{slug}</span>
    </Button>
  );
}

/**
 * Inline chip row under the "Main model" card. Surfaces:
 *
 *   - **Context-length chip**: shows `effective` formatted as ``200K``;
 *     when the user has a ``model.context_length`` override in
 *     ``config.yaml``, badges it as "override" + tooltips the
 *     auto-detected value so they can see what they're overriding.
 *   - **Capability chips**: one per supported feature (vision /
 *     reasoning / tools). Absent fields (model unknown to
 *     ``models.dev``) just don't render — better than showing greyed-out
 *     "Unknown" boxes that imply the feature is missing.
 *   - **Model family**: small muted label at the end when known.
 *
 * All fields are best-effort: missing data hides the chip entirely so
 * the card stays clean for models without metadata coverage.
 */
function MainModelChips({
  context,
  capabilities,
}: {
  context: { auto: number; config: number; effective: number };
  capabilities: ModelConfigPanelProps["mainCapabilities"];
}) {
  const ctxLabel = formatContextLength(context.effective);
  const hasOverride = context.config > 0;
  const hasContext = ctxLabel.length > 0;
  const family = capabilities.model_family?.trim();
  const caps: Array<{ key: string; label: string; tooltip: string }> = [];
  if (capabilities.supports_vision)
    caps.push({
      key: "vision",
      label: "Vision",
      tooltip: "Supports image input (per models.dev)",
    });
  if (capabilities.supports_reasoning)
    caps.push({
      key: "reasoning",
      label: "Reasoning",
      tooltip: "Supports reasoning tokens (o1 / extended-thinking models)",
    });
  if (capabilities.supports_tools)
    caps.push({
      key: "tools",
      label: "Tools",
      tooltip: "Supports OpenAI-style function calling",
    });
  if (capabilities.max_output_tokens && capabilities.max_output_tokens > 0) {
    caps.push({
      key: "max_out",
      label: `Output ${formatContextLength(capabilities.max_output_tokens)}`,
      tooltip: `Maximum output of ${capabilities.max_output_tokens} tokens per call`,
    });
  }
  if (!hasContext && caps.length === 0 && !family) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {hasContext && (
        <span
          title={
            hasOverride
              ? `config.yaml override: ${context.config.toLocaleString()}\nAuto-detected: ${
                  context.auto > 0 ? context.auto.toLocaleString() : "unknown"
                }`
              : `Auto-detected (agent.model_metadata)`
          }
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
            hasOverride
              ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
              : "border-border bg-background text-muted-foreground",
          )}
        >
          {hasOverride ? "Context (override)" : "Context"}
          <span className="tabular-nums text-foreground/80">{ctxLabel}</span>
        </span>
      )}
      {caps.map((c) => (
        <span
          key={c.key}
          title={c.tooltip}
          className="inline-flex items-center rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
        >
          {c.label}
        </span>
      ))}
      {family && (
        <span
          title="Model family per models.dev"
          className="inline-flex items-center rounded-full border border-border/60 bg-muted/30 px-2 py-0.5 text-[10px] text-muted-foreground/80"
        >
          {family}
        </span>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Model Config Panel
// ─────────────────────────────────────────────────────────────────────────────

interface ModelConfigPanelProps {
  catalog: HermesModelCatalogResponse | null;
  diskProvider: string;
  diskModel: string;
  diskBaseUrl: string;
  /**
   * Context-length triple from ``/hermes/model/info``. ``auto`` is what
   * ``agent.model_metadata.get_model_context_length`` resolved; ``config``
   * is the user's ``model.context_length`` override from ``config.yaml``;
   * ``effective`` is what the agent will actually use. All-zero means
   * the model is unknown to models.dev — UI just hides the chip.
   */
  mainContext: { auto: number; config: number; effective: number };
  mainCapabilities: {
    supports_tools?: boolean;
    supports_vision?: boolean;
    supports_reasoning?: boolean;
    context_window?: number | null;
    max_output_tokens?: number | null;
    model_family?: string | null;
  };
  auxSlots: Record<AuxiliarySlotName, AuxiliaryTask> | null;
  auxError: string | null;
  auxSavingSlot: AuxiliarySlotName | null;
  auxSavedSlot: AuxiliarySlotName | null;
  mcSaving: boolean;
  mcError: string | null;
  mcSaved: boolean;
  allCatalogModels: { provider: string; entry: HermesCatalogModelEntry }[];
  canonicalLabelBySlug: Map<string, string>;
  onSetDefault: (provider: string, modelId: string) => Promise<void>;
  onClearMain: () => Promise<void>;
  onSetAuxSlot: (slot: AuxiliarySlotName, provider: string, model: string) => Promise<void>;
  onClearAuxSlot: (slot: AuxiliarySlotName) => Promise<void>;
}

function ModelConfigPanel({
  catalog,
  diskProvider,
  diskModel,
  diskBaseUrl,
  mainContext,
  mainCapabilities,
  auxSlots,
  auxError,
  auxSavingSlot,
  auxSavedSlot,
  mcSaving,
  mcError,
  mcSaved,
  allCatalogModels,
  canonicalLabelBySlug,
  onSetDefault,
  onClearMain,
  onSetAuxSlot,
  onClearAuxSlot,
}: ModelConfigPanelProps) {
  const [search, setSearch] = useState("");
  const [auxExpanded, setAuxExpanded] = useState(false);

  const saving = mcSaving || auxSavingSlot !== null;

  function providerLabel(slug: string): string {
    if (!slug || slug === "auto") return "Auto";
    const tui = canonicalLabelBySlug.get(slug);
    return tui ? tui : slug;
  }

  const groupedModels = useMemo(() => {
    const q = search.trim().toLowerCase();
    const groups = new Map<string, HermesCatalogModelEntry[]>();
    for (const { provider, entry } of allCatalogModels) {
      if (q) {
        const inId = entry.id.toLowerCase().includes(q);
        const inDesc = (entry.description || "").toLowerCase().includes(q);
        const inProvider = provider.toLowerCase().includes(q);
        if (!inId && !inDesc && !inProvider) continue;
      }
      if (!groups.has(provider)) groups.set(provider, []);
      groups.get(provider)!.push(entry);
    }
    return groups;
  }, [allCatalogModels, search]);

  const hasAny = allCatalogModels.length > 0;
  const configuredAuxCount = auxSlots
    ? AUXILIARY_SLOT_NAMES.filter((s) => auxSlots[s]?.model).length
    : 0;

  return (
    <div className="space-y-6 p-6">
      {(mcError || auxError) && (
        <p className="text-[11px] text-amber-600 dark:text-amber-500">
          {mcError || auxError}
        </p>
      )}

      {/* ── Main model ── */}
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <Crown className="h-4 w-4 text-amber-500" />
          <h3 className="text-sm font-semibold text-foreground">Main model</h3>
          {mcSaved && (
            <span className="text-[11px] text-[hsl(var(--success))]">Saved</span>
          )}
        </div>
        <ModelSlotRow
          label="Main"
          provider={diskProvider}
          model={diskModel}
          unsetHint="Not set — pick a model below"
          isSaving={mcSaving}
          isSaved={mcSaved}
          allCatalogModels={allCatalogModels}
          canonicalLabelBySlug={canonicalLabelBySlug}
          disabled={saving}
          onSet={(p, m) => void onSetDefault(p, m)}
          onClear={() => void onClearMain()}
          detail={
            (diskBaseUrl ||
              mainContext.effective > 0 ||
              Object.keys(mainCapabilities).length > 0) ? (
              <div className="space-y-0.5">
                {diskBaseUrl ? (
                  <p className="break-all font-mono text-[10px] text-muted-foreground">
                    {diskBaseUrl}
                  </p>
                ) : null}
                <MainModelChips
                  context={mainContext}
                  capabilities={mainCapabilities}
                />
              </div>
            ) : null
          }
        />
      </section>

      {/* ── Auxiliary models ── */}
      <section className="space-y-2">
        <button
          type="button"
          className="flex w-full items-center gap-2 text-left"
          onClick={() => setAuxExpanded((v) => !v)}
        >
          {auxExpanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
          <Zap className="h-4 w-4 text-blue-500" />
          <span className="text-sm font-semibold text-foreground">Auxiliary models</span>
          <span className="text-[11px] text-muted-foreground">
            ({configuredAuxCount} / {AUXILIARY_SLOT_NAMES.length} configured)
          </span>
        </button>

        {auxExpanded && (
          <div className="space-y-2 pl-6">
            {auxSlots === null ? (
              <p className="text-xs text-muted-foreground">Auxiliary model configuration unavailable (bridge not connected).</p>
            ) : (
              AUXILIARY_SLOT_NAMES.map((slot) => (
                <ModelSlotRow
                  key={slot}
                  label={AUXILIARY_SLOT_LABELS[slot]}
                  provider={auxSlots[slot]?.provider ?? ""}
                  model={auxSlots[slot]?.model ?? ""}
                  isSaving={auxSavingSlot === slot}
                  isSaved={auxSavedSlot === slot}
                  allCatalogModels={allCatalogModels}
                  canonicalLabelBySlug={canonicalLabelBySlug}
                  disabled={saving}
                  onSet={(p, m) => void onSetAuxSlot(slot, p, m)}
                  onClear={() => void onClearAuxSlot(slot)}
                />
              ))
            )}
          </div>
        )}
      </section>

      {/* ── All models list ── */}
      <section className="space-y-3 border-t border-border pt-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">All available models</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            From configured providers; click <MoreHorizontal className="inline h-3 w-3" /> to assign a model to Main or any auxiliary slot.
          </p>
        </div>

        {!hasAny ? (
          <div className="rounded-lg border border-dashed border-border/80 bg-muted/15 p-4">
            <p className="text-xs text-muted-foreground">
              No models available. Make sure the bridge is connected, or click “Refresh catalog” at the top.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-muted/10">
            {/*
             * Search lives inside the same card as the list — they're
             * one functional unit (filter ↔ result), not two siblings.
             * Border-bottom is the only separator; the Input itself
             * drops its native chrome so it reads as a row inside the
             * card, not a nested control.
             */}
            <div className="border-b border-border/60 bg-background/40">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search model id or provider…"
                className="h-9 border-0 bg-transparent text-xs shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
              />
            </div>
            {groupedModels.size === 0 ? (
              <p className="px-3 py-4 text-xs text-muted-foreground">
                No matching models.
              </p>
            ) : (
              /*
               * Single flat list. Provider names are sticky subheader
               * rows inside the same ``<ul>``, not card containers
               * around their own sub-list — the model is the unit of
               * attention; provider is just an organizational hint.
               */
              <ul className="divide-y divide-border/60">
                {[...groupedModels.entries()].map(([provider, models]) => {
                  return (
                    <Fragment key={provider}>
                      <li className="px-3 py-1 text-[9px] uppercase tracking-wider text-muted-foreground">
                        {canonicalLabelBySlug.get(provider) || provider}
                      </li>
                      {models.map((entry) => {
                        const isDefault =
                          entry.id === diskModel && provider === diskProvider;
                        return (
                          <li
                            key={`${provider}/${entry.id}`}
                            className={cn(
                              "flex items-start gap-2 px-3 py-2 text-xs",
                              isDefault && "bg-amber-50/60 dark:bg-amber-900/10",
                            )}
                          >
                            <div className="min-w-0 flex-1">
                              <p className="break-all font-mono text-[11px] leading-snug">
                                {entry.id}
                              </p>
                              {entry.description?.trim() ? (
                                <p className="mt-0.5 text-[10px] text-muted-foreground">
                                  {entry.description.trim()}
                                </p>
                              ) : null}
                              <ModelEntryMetadataLine meta={entry.metadata} />
                              {isDefault && (
                                <p className="mt-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                                  Current main
                                </p>
                              )}
                            </div>
                            <AssignToSlotMenu
                              disabled={saving}
                              isMain={isDefault}
                              onAssignMain={() => void onSetDefault(provider, entry.id)}
                              onAssignAux={(slot) =>
                                void onSetAuxSlot(slot, provider, entry.id)
                              }
                            />
                          </li>
                        );
                      })}
                    </Fragment>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Model Slot Row — used for Main and every auxiliary slot
// ─────────────────────────────────────────────────────────────────────────────

interface ModelSlotRowProps {
  /** Display label, e.g. "Main", "Vision", "Web Extract". */
  label: string;
  /** Current provider slug. Empty / "auto" → unconfigured. */
  provider: string;
  /** Current model id. Empty → unconfigured. */
  model: string;
  /** Optional richer detail rendered below the provider/model line —
   * used by Main to show context-window chips, base URL, etc. */
  detail?: React.ReactNode;
  /** Shown when no model is set, instead of "Inherits main model". */
  unsetHint?: string;
  isSaving: boolean;
  isSaved: boolean;
  allCatalogModels: { provider: string; entry: HermesCatalogModelEntry }[];
  canonicalLabelBySlug: Map<string, string>;
  disabled: boolean;
  onSet: (provider: string, model: string) => void;
  /** Optional clear — Main has it too (sets back to ``auto``). */
  onClear?: () => void;
}

function ModelSlotRow({
  label,
  provider,
  model,
  detail,
  unsetHint = "Inherits main model",
  isSaving,
  isSaved,
  allCatalogModels,
  canonicalLabelBySlug,
  disabled,
  onSet,
  onClear,
}: ModelSlotRowProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const dropRef = useRef<HTMLDivElement>(null);

  const hasModel = Boolean(model);

  const filteredModels = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allCatalogModels;
    return allCatalogModels.filter(
      ({ provider, entry }) =>
        entry.id.toLowerCase().includes(q) ||
        provider.toLowerCase().includes(q) ||
        (entry.description || "").toLowerCase().includes(q),
    );
  }, [allCatalogModels, search]);

  /** Group filtered models by provider so we can render the same
   * "provider sub-header + model rows" layout the main "All available
   * models" list uses. Picker and main list now share their rendering
   * shape — same source data, same display. */
  const groupedFilteredModels = useMemo(() => {
    const map = new Map<string, HermesCatalogModelEntry[]>();
    for (const { provider: pid, entry } of filteredModels) {
      if (!map.has(pid)) map.set(pid, []);
      map.get(pid)!.push(entry);
    }
    return map;
  }, [filteredModels]);

  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  return (
    <div className="rounded-lg border border-border bg-muted/10 px-3 py-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium text-foreground">{label}</p>
          {hasModel ? (
            <p className="truncate font-mono text-[10px] text-muted-foreground">
              {provider && provider !== "auto" ? `${provider} / ` : ""}
              {model}
            </p>
          ) : (
            <p className="text-[10px] text-muted-foreground">{unsetHint}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isSaved && (
            <span className="text-[10px] text-[hsl(var(--success))]">Saved</span>
          )}
          {hasModel && onClear && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6 rounded-full text-muted-foreground/60 hover:text-destructive"
              disabled={disabled || isSaving}
              title="Clear"
              onClick={onClear}
            >
              {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
            </Button>
          )}
          <div className="relative" ref={dropRef}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[10px]"
              disabled={disabled || isSaving}
              onClick={() => setOpen((v) => !v)}
            >
              {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Select"}
            </Button>
            {open && (
              // ``flex flex-col`` so the search input keeps a fixed
              // height and the model list takes the remaining space.
              // ``max-h-[24rem]`` caps the whole popover; the inner
              // ``min-h-0 overflow-y-auto`` is what actually scrolls.
              // Radix ScrollArea was unreliable here — its viewport
              // wouldn't pick up a definite height inside the
              // absolute-positioned popover, so the scrollbar never
              // appeared even when content overflowed.
              <div className="absolute right-0 top-7 z-50 flex max-h-[24rem] w-[28rem] max-w-[80vw] flex-col rounded-lg border border-border bg-popover shadow-lg">
                <div className="shrink-0 border-b border-border/60 bg-background/40">
                  <Input
                    autoFocus
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search model id, provider, or description…"
                    className="h-9 border-0 bg-transparent text-xs shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
                  />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {filteredModels.length === 0 ? (
                    <p className="px-3 py-4 text-xs text-muted-foreground">No matching models</p>
                  ) : (
                    // Mirror the "All available models" list exactly:
                    // provider sub-header rows + model rows with id +
                    // description + metadata chips. The button trigger
                    // wraps a model row so click anywhere on the row
                    // selects it.
                    <ul className="divide-y divide-border/60">
                      {[...groupedFilteredModels.entries()].map(
                        ([pid, rows]) => (
                          <Fragment key={pid}>
                            <li className="px-3 py-1 text-[9px] uppercase tracking-wider text-muted-foreground">
                              {canonicalLabelBySlug.get(pid) ?? pid}
                            </li>
                            {rows.map((entry) => (
                              <li key={`${pid}/${entry.id}`}>
                                <button
                                  type="button"
                                  className="flex w-full items-start gap-2 px-3 py-2 text-left text-xs hover:bg-muted/60"
                                  onClick={() => {
                                    onSet(pid, entry.id);
                                    setOpen(false);
                                    setSearch("");
                                  }}
                                >
                                  <div className="min-w-0 flex-1">
                                    <p className="break-all font-mono text-[11px] leading-snug">
                                      {entry.id}
                                    </p>
                                    {entry.description?.trim() ? (
                                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                                        {entry.description.trim()}
                                      </p>
                                    ) : null}
                                    <ModelEntryMetadataLine
                                      meta={entry.metadata}
                                    />
                                  </div>
                                </button>
                              </li>
                            ))}
                          </Fragment>
                        ),
                      )}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      {detail ? <div className="mt-1.5">{detail}</div> : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AssignToSlotMenu — the catalog-row action that replaces the old "⭐" button.
// Opens a small popover listing every assignable slot (Main + each aux task);
// picking one assigns the row's model to that slot. Mirrors the
// ``ModelSlotRow`` dropdown shape but going the other direction —
// model → slot instead of slot → model.
// ─────────────────────────────────────────────────────────────────────────────

function AssignToSlotMenu({
  disabled,
  isMain,
  onAssignMain,
  onAssignAux,
}: {
  disabled: boolean;
  /** True when this row's model is already the current Main. Just a
   * visual hint on the trigger; doesn't disable re-assigning. */
  isMain: boolean;
  onAssignMain: () => void;
  onAssignAux: (slot: AuxiliarySlotName) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  return (
    <div className="relative shrink-0" ref={ref}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(
          "h-7 w-7 rounded-full transition-colors",
          isMain
            ? "text-amber-500 hover:bg-amber-100/50 dark:hover:bg-amber-900/20"
            : "text-muted-foreground/60 hover:bg-muted/60 hover:text-foreground",
        )}
        disabled={disabled}
        title={isMain ? "Currently Main — pick another slot to also assign" : "Assign to a slot…"}
        aria-label="Assign to a slot"
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </Button>
      {open && (
        <div className="absolute right-0 top-8 z-50 w-44 rounded-lg border border-border bg-popover shadow-lg">
          <p className="border-b border-border px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            Assign as
          </p>
          <ul className="flex flex-col py-1">
            <li>
              <button
                type="button"
                className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs hover:bg-muted/60"
                onClick={() => {
                  onAssignMain();
                  setOpen(false);
                }}
              >
                <Crown className="h-3 w-3 text-amber-500" />
                Main
              </button>
            </li>
            <li className="my-0.5 mx-2 border-t border-border/50" />
            {AUXILIARY_SLOT_NAMES.map((slot) => (
              <li key={slot}>
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs hover:bg-muted/60"
                  onClick={() => {
                    onAssignAux(slot);
                    setOpen(false);
                  }}
                >
                  <Zap className="h-3 w-3 text-blue-500/70" />
                  {AUXILIARY_SLOT_LABELS[slot]}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: Provider Panel
// ─────────────────────────────────────────────────────────────────────────────

interface ProviderPanelProps {
  hProvider: string;
  hSaving: boolean;
  hSaved: boolean;
  hError: string | null;
  credentialFields: HermesProviderCredentialField[];
  credentialAuthHint: string;
  keyDrafts: Record<string, string>;
  keysLoading: boolean;
  keysError: string | null;
  catalog: HermesModelCatalogResponse | null;
  showHermesModelLoading: boolean;
  modelEntriesForProvider: HermesCatalogModelEntry[];
  providerCliMeta: {
    source?: string;
    cli_loaded?: boolean;
    pricing_loaded?: boolean;
  } | null;
  providerOptionLabel: (id: string) => string;
  onKeyDraftChange: (k: string, v: string) => void;
  onSave: () => void;
  onRefreshModels: () => void;
  // Custom endpoint (BYO OpenAI-compatible) — only used when
  // ``hProvider === "custom"``. Lives here rather than in
  // ``ModelConfigPanel`` so the entire custom-endpoint flow (URL +
  // model id + API key + "Set as default") is in one place. The
  // sidebar's "+ Custom endpoint" affordance is the canonical entry
  // point; the Model Config panel no longer carries this form.
  customDraftModel: string;
  customDraftBaseUrl: string;
  customSaving: boolean;
  customError: string | null;
  onCustomDraftModelChange: (v: string) => void;
  onCustomDraftBaseUrlChange: (v: string) => void;
  onSetCustomMain: () => Promise<void>;
}

function ProviderPanel({
  hProvider,
  hSaving,
  hSaved,
  hError,
  credentialFields,
  credentialAuthHint,
  keyDrafts,
  keysLoading,
  keysError,
  catalog,
  showHermesModelLoading,
  modelEntriesForProvider,
  providerCliMeta,
  providerOptionLabel,
  onKeyDraftChange,
  onSave,
  onRefreshModels,
  customDraftModel,
  customDraftBaseUrl,
  customSaving,
  customError,
  onCustomDraftModelChange,
  onCustomDraftBaseUrlChange,
  onSetCustomMain,
}: ProviderPanelProps) {
  const providerBlock = catalog?.providers?.[hProvider];
  const defaultBaseUrl = providerBlock?.default_base_url?.trim() ?? "";
  return (
    <div className="space-y-4 p-6">
      {catalog?.warning && (
        <p className="text-[11px] text-amber-600 dark:text-amber-500">{catalog.warning}</p>
      )}
      {catalog?.ok && catalog.canonical_loaded === false && (
        <p className="text-[11px] text-amber-600 dark:text-amber-500">
          Provider metadata partially loaded. Make sure Hermes is installed and connected to the extension.
        </p>
      )}
      {(() => {
        const yaml = catalog?.config_provider_ids ?? [];
        const env = catalog?.env_ready_provider_ids ?? [];
        const merged = [...new Set([...yaml, ...env])];
        if (merged.length === 0) return null;
        return (
          <p className="text-[11px] text-muted-foreground">
            Recognized providers (declared in <span className="font-mono">~/.hermes/config.yaml</span> or with a key saved in{" "}
            <span className="font-mono">~/.hermes/.env</span>): {merged.join(", ")}
          </p>
        );
      })()}
      {hError && (
        <p className="text-[11px] text-amber-600 dark:text-amber-500">{hError}</p>
      )}

      {/* Provider credentials section. Writes ONLY to plugin .env —
          setting the main model lives in the Model Config panel. */}
      <section className="space-y-5">
        <div>
          <h3 className="text-sm font-medium text-foreground">Credentials</h3>
          <div className="mt-2 space-y-1 text-sm text-muted-foreground">
            <p className="font-mono text-sm text-foreground">{hProvider}</p>
            <p className="text-xs">{providerOptionLabel(hProvider)}</p>
            {defaultBaseUrl ? (
              <p className="font-mono text-[10px] text-muted-foreground">
                endpoint: {defaultBaseUrl}
              </p>
            ) : null}
          </div>
        </div>
        <div className="space-y-5">
          {hProvider === "custom" && (
            <div className="space-y-2 rounded-lg border border-border bg-muted/10 px-4 py-3">
              <p className="text-[11px] text-muted-foreground">
                Use any OpenAI-compatible endpoint as the main model. The API key (or any
                env var the endpoint expects) goes in the Credentials section below.
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="custom-main-model" className="text-xs">Model name</Label>
                <Input
                  id="custom-main-model"
                  value={customDraftModel}
                  onChange={(e) => onCustomDraftModelChange(e.target.value)}
                  placeholder="e.g. gpt-4o, llama-3.3-70b"
                  className="font-mono text-xs"
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="custom-main-url" className="text-xs">Endpoint URL</Label>
                <Input
                  id="custom-main-url"
                  value={customDraftBaseUrl}
                  onChange={(e) => onCustomDraftBaseUrlChange(e.target.value)}
                  placeholder="https://your-endpoint/v1"
                  className="font-mono text-xs"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              {customError && (
                <p className="text-[11px] text-amber-600 dark:text-amber-500">{customError}</p>
              )}
              <div className="pt-1">
                <Button
                  type="button"
                  size="sm"
                  disabled={customSaving || !customDraftModel.trim() || !customDraftBaseUrl.trim()}
                  onClick={() => void onSetCustomMain()}
                >
                  {customSaving ? "Saving…" : "Set as default"}
                </Button>
              </div>
            </div>
          )}

          {keysError && (
            <p className="text-[11px] text-amber-600 dark:text-amber-500">{keysError}</p>
          )}

          {keysLoading ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading credentials…
            </p>
          ) : credentialFields.length > 0 ? (
            <>
              <div className="space-y-3">
                {credentialFields.map((field) => (
                  <div key={field.key} className="space-y-1.5">
                    <Label
                      htmlFor={`key-${field.key}`}
                      className="font-mono text-[11px] text-muted-foreground"
                    >
                      {field.key}
                    </Label>
                    <Input
                      id={`key-${field.key}`}
                      type={field.kind === "url" ? "url" : "text"}
                      value={keyDrafts[field.key] ?? ""}
                      placeholder={field.placeholder}
                      onChange={(e) => onKeyDraftChange(field.key, e.target.value)}
                      className="font-mono text-xs"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button type="button" disabled={hSaving} onClick={onSave}>
                  {hSaving ? "Saving…" : "Save credentials"}
                </Button>
                {hSaved && (
                  <span className="text-xs text-[hsl(var(--success))]">Saved</span>
                )}
              </div>
            </>
          ) : credentialAuthHint ? (
            <p className="text-xs text-muted-foreground">{credentialAuthHint}</p>
          ) : null}
        </div>
      </section>

      {/* Model list (display only) */}
      {hProvider && (
        <section className="space-y-3 border-t border-border pt-8">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-medium text-foreground">Models</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Models available for the current provider. Use the “Model config” section to set a default or auxiliary model.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 shrink-0 gap-1.5 text-xs"
              disabled={showHermesModelLoading}
              onClick={onRefreshModels}
              title="Refresh model list"
            >
              {showHermesModelLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              Refresh
            </Button>
          </div>
          <div className="space-y-3">
            {showHermesModelLoading ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                Loading models…
              </p>
            ) : modelEntriesForProvider.length > 0 ? (
              <>
                <div className="max-h-[min(50vh,360px)] overflow-y-auto rounded-lg border border-border bg-muted/15">
                  <ul className="flex flex-col divide-y divide-border/60">
                    {modelEntriesForProvider.map((entry) => (
                      <li key={entry.id} className="px-3 py-2.5 text-xs">
                        <p className="break-all font-mono text-[11px] leading-snug">
                          {entry.id}
                        </p>
                        {entry.description?.trim() ? (
                          <p className="mt-0.5 text-[10px] text-muted-foreground">
                            {entry.description.trim()}
                          </p>
                        ) : null}
                        <ModelEntryMetadataLine meta={entry.metadata} />
                      </li>
                    ))}
                  </ul>
                </div>
                {!showHermesModelLoading && providerCliMeta?.source === "manifest" ? (
                  <p className="text-[10px] text-muted-foreground">
                    Reference list shown. Add a key and refresh to fetch the full list.
                  </p>
                ) : null}
                {!showHermesModelLoading && providerCliMeta?.pricing_loaded ? (
                  <p className="text-[10px] text-muted-foreground">
                    Prices are USD per million tokens, converted from the per-token rate returned by the provider's model API. Different routes or model ids may not match the published rate card — trust your actual bill.
                  </p>
                ) : null}
              </>
            ) : (
              <div className="rounded-lg border border-dashed border-border/80 bg-muted/15 p-4">
                <p className="text-xs text-muted-foreground">
                  No models yet. After entering a key here, click “Refresh catalog” at the top.
                </p>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
