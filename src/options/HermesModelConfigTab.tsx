import {
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  Star,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  getHermesMainProviderSettings,
  getHermesModelCatalog,
  getHermesProviderModels,
  saveHermesMainProviderSettings,
  setHermesAgentMainModel,
  setHermesAuxiliarySlot,
  type AuxiliaryModelsResponse,
  type AuxiliarySlotName,
  type AuxiliaryTask,
  type HermesCatalogModelEntry,
  type HermesModelCatalogResponse,
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
  };
  return m[k] ?? k.replace(/_/g, " ");
}

/** Stable order for ``metadata`` chips (pricing near context). */
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
        return (
          <span key={k} title={k}>
            <span className="font-medium text-foreground/65">{labelMetaKey(k)}</span>
            <span className="text-muted-foreground/90"> {formatScalarForMeta(v)}</span>
          </span>
        );
      })}
    </div>
  );
}

export function HermesModelConfigTab() {
  const { t } = useT();
  // ── Shared / catalog state ─────────────────────────────────────────────
  const [catalog, setCatalog] = useState<HermesModelCatalogResponse | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);

  // ── Sidebar selection ──────────────────────────────────────────────────
  const [section, setSection] = useState<SidebarSection>("model-config");

  // ── Main-model state (disk / draft) ───────────────────────────────────
  const [mainLoading, setMainLoading] = useState(true);
  const [mainError, setMainError] = useState<string | null>(null);
  const [diskProvider, setDiskProvider] = useState("auto");
  const [diskModel, setDiskModel] = useState("");
  const [diskBaseUrl, setDiskBaseUrl] = useState("");
  /**
   * Resolved context-length triple (auto / config-override / effective)
   * + model capability flags from ``agent.models_dev``. Comes back on
   * the same ``/hermes/main-provider-settings`` response — kept in
   * its own state so the "Default model" card can render context +
   * capability chips alongside the model name without prop-drilling
   * the whole HermesAgentMainModelResponse through nested panels.
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

  // ── Provider panel state (edit) ───────────────────────────────────────
  const [hProvider, setHProvider] = useState("auto");
  const [hModel, setHModel] = useState("");
  const [hBaseUrl, setHBaseUrl] = useState("");
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
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  /** Env var names allowed for the current provider (from bridge / Hermes profile). */
  const [credentialKeys, setCredentialKeys] = useState<string[]>([]);
  const [keysLoading, setKeysLoading] = useState(false);
  const [keysError, setKeysError] = useState<string | null>(null);
  /** After initial combined GET, skip one redundant credentials refetch for the same provider. */
  const skipNextCredentialsFetch = useRef(false);

  // ── Model-Config panel saving state ───────────────────────────────────
  const [mcSaving, setMcSaving] = useState(false);
  const [mcError, setMcError] = useState<string | null>(null);
  const [mcSaved, setMcSaved] = useState(false);

  // ── Derived ───────────────────────────────────────────────────────────
  const canonicalLabelBySlug = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of catalog?.canonical_providers ?? []) {
      if (p.slug) m.set(p.slug, (p.tui_desc || p.label || p.slug).trim());
    }
    return m;
  }, [catalog?.canonical_providers]);

  const orderedSidebarProviders = useMemo(() => {
    const catalogIds =
      catalog?.provider_ids && catalog.provider_ids.length > 0
        ? [...catalog.provider_ids]
        : [];
    const diskP = (diskProvider || "auto").trim() || "auto";
    const hp = hProvider.trim();
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (slug: string) => {
      const s = slug.trim();
      if (!s || seen.has(s)) return;
      seen.add(s);
      out.push(s);
    };
    if (diskP !== "auto") push(diskP);
    for (const id of catalog?.config_provider_ids ?? []) push(id);
    for (const id of catalogIds) {
      if (id !== "auto" && id !== "custom") push(id);
    }
    if (hp && hp !== "auto" && hp !== "custom") push(hp);
    push("auto");
    push("custom");
    return out;
  }, [catalog?.config_provider_ids, catalog?.provider_ids, diskProvider, hProvider]);

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

  function providerOptionLabel(id: string): string {
    if (id === "auto") return "Auto-pick provider based on configured keys";
    if (id === "custom") return "Custom OpenAI-compatible endpoint (set the API URL below)";
    const tui = canonicalLabelBySlug.get(id);
    if (tui) return tui;
    if (configSlugSet.has(id)) return `${id} (already in your Hermes config)`;
    if (envReadySlugSet.has(id)) return `${id} (key set in plugin .env)`;
    return id;
  }

  /**
   * Models from all "active" providers: explicitly configured ones +
   * the current main-model provider (which may not be in config_provider_ids
   * when providers: {} is empty but model.provider is set).
   */
  const allCatalogModels = useMemo(() => {
    const candidates = new Set<string>([
      ...(catalog?.config_provider_ids ?? []),
      ...(catalog?.env_ready_provider_ids ?? []),
    ]);
    if (diskProvider && diskProvider !== "auto" && diskProvider !== "custom") {
      candidates.add(diskProvider);
    }
    // Also include providers used in aux slots
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
    hProvider.trim() !== "auto" &&
    providerCliLoading;

  // ── Load provider models when provider panel changes ──────────────────
  const loadProviderModels = useCallback(async (refresh: boolean) => {
    const p = hProvider.trim();
    if (!p || p === "auto") {
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
    if (!p || p === "auto") {
      setProviderCliModels([]);
      setProviderCliMeta(null);
      setProviderCliLoading(false);
      return;
    }
    setProviderCliModels([]);
    setProviderCliMeta(null);
    void loadProviderModels(false);
  }, [mainLoading, hProvider, loadProviderModels]);

  // ── Load API keys when provider changes (bridge resolves allowed keys) ─
  useEffect(() => {
    const p = hProvider.trim();
    if (!p || p === "auto") {
      setCredentialKeys([]);
      setKeyDrafts({});
      setKeysLoading(false);
      setKeysError(null);
      return;
    }
    let cancelled = false;
    setKeysLoading(true);
    setKeysError(null);
    if (skipNextCredentialsFetch.current) {
      skipNextCredentialsFetch.current = false;
      setKeysLoading(false);
      return;
    }
    void getHermesMainProviderSettings(p).then((r) => {
      if (cancelled) return;
      setKeysLoading(false);
      if (!r.ok) {
        setKeysError(r.error || "Failed to read keys");
        setCredentialKeys([]);
        setKeyDrafts({});
        return;
      }
      const c = r.credentials;
      setCredentialKeys([...(c?.keys ?? [])]);
      setKeyDrafts({ ...(c?.values ?? {}) });
    });
    return () => {
      cancelled = true;
    };
  }, [hProvider]);

  // ── Initial load ──────────────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      setMainLoading(true);
      setMainError(null);
      try {
        const [main, auxResp, cat] = await Promise.all([
          getHermesMainProviderSettings(),
          getHermesAuxiliaryModels(),
          getHermesModelCatalog(false),
        ]);
        if (cat.ok) setCatalog(cat);
        if (main.ok) {
          const dp = (main.provider || "auto").trim() || "auto";
          const dm = (main.model || "").trim();
          const bu = (main.base_url || "").trim();
          setHProvider(dp);
          setHModel(dm);
          setDiskProvider(dp);
          setDiskModel(dm);
          setDiskBaseUrl(bu);
          setHBaseUrl(bu);
          setMainContext({
            auto: main.auto_context_length ?? 0,
            config: main.config_context_length ?? 0,
            effective: main.effective_context_length ?? 0,
          });
          setMainCapabilities(main.capabilities ?? {});
          setMainError(typeof main.error === "string" && main.error ? main.error : null);
          const c = main.credentials;
          if (c && (c.keys?.length ?? 0) > 0) {
            setCredentialKeys([...(c.keys ?? [])]);
            setKeyDrafts({ ...(c.values ?? {}) });
            skipNextCredentialsFetch.current = true;
          }
        } else {
          setMainError(main.error || "Failed to read Hermes config");
        }
        if (auxResp.ok) {
          setAuxSlots(tasksToMap(auxResp));
        } else {
          setAuxError(auxResp.error || null);
        }
      } catch (e) {
        setMainError(String((e as Error)?.message || e));
      } finally {
        setMainLoading(false);
        setCatalogLoading(false);
      }
    })();
  }, []);

  // ── Refresh catalog + provider models ─────────────────────────────────
  async function refreshCatalogFromRemote() {
    setCatalogRefreshing(true);
    try {
      const c = await getHermesModelCatalog(true);
      if (c.ok) setCatalog(c);
      await loadProviderModels(true);
      const p = hProvider.trim();
      if (p && p !== "auto") {
        const dv = await getHermesMainProviderSettings(p);
        if (dv.ok && dv.credentials) {
          setCredentialKeys([...(dv.credentials.keys ?? [])]);
          setKeyDrafts({ ...(dv.credentials.values ?? {}) });
        }
      }
    } finally {
      setCatalogRefreshing(false);
    }
  }

  // ── Provider panel: save model + base URL + credentials (single bridge call) ─
  async function saveProviderSettings() {
    setHSaving(true);
    setHError(null);
    setKeysError(null);
    try {
      const body: {
        provider: string;
        model: string;
        base_url: string | null;
        credentials?: Record<string, string>;
      } = {
        provider: hProvider.trim() || "auto",
        model: hModel.trim(),
        base_url: hBaseUrl.trim() || null,
      };
      if (credentialKeys.length > 0) {
        const credentials: Record<string, string> = {};
        for (const k of credentialKeys) credentials[k] = keyDrafts[k] ?? "";
        body.credentials = credentials;
      }
      const r = await saveHermesMainProviderSettings(body);
      if (!r.ok) {
        setHError(r.error || "Save failed");
        return;
      }
      void loadProviderModels(true);
      const dp = (r.provider || hProvider || "auto").trim() || "auto";
      const dm = (r.model ?? hModel).trim();
      const dbu = (r.base_url ?? hBaseUrl).trim();
      setDiskProvider(dp);
      setDiskModel(dm);
      setDiskBaseUrl(dbu);
      setMainContext({
        auto: r.auto_context_length ?? 0,
        config: r.config_context_length ?? 0,
        effective: r.effective_context_length ?? 0,
      });
      setMainCapabilities(r.capabilities ?? {});
      setHSaved(true);
      setTimeout(() => setHSaved(false), 1500);
    } finally {
      setHSaving(false);
    }
  }

  function selectProviderSection(slug: string) {
    setSection(slug);
    setHProvider(slug);
    const sp = (slug || "auto").trim() || "auto";
    const dp = (diskProvider || "auto").trim() || "auto";
    if (sp === dp) {
      setHModel(diskModel);
      setHBaseUrl(diskBaseUrl);
    } else {
      setHModel("");
      setHBaseUrl("");
    }
  }

  // ── Model Config: set default model ──────────────────────────────────
  async function setDefaultModel(provider: string, modelId: string) {
    const p = provider.trim();
    const id = modelId.trim();
    if (!id) return;
    setMcSaving(true);
    setMcError(null);
    try {
      const r = await setHermesAgentMainModel({
        provider: p || "auto",
        model: id,
        base_url: null,
      });
      if (!r.ok) {
        setMcError(r.error || "Failed to set default model");
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
      setHProvider(dp);
      setHModel(dm);
      setHBaseUrl(dbu);
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
                  ? `Default: ${diskModel}`
                  : "Set default and auxiliary models"}
              </span>
            </Button>

            {/* Provider list — small section label inside the list, not a full h-14 shell row */}
            <ScrollArea className="min-h-0 flex-1">
              <nav className="flex flex-col">
                <p className="px-3 pt-2 pb-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  Providers
                </p>
                {orderedSidebarProviders.map((slug) => {
                  const active = section === slug;
                  const isDisk = slug === diskProvider && slug !== "auto";
                  const showConfiguredBadge = configuredSlugSet.has(slug);
                  return (
                    <Button
                      key={slug}
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={cn(
                        "h-auto min-h-0 w-full flex-col items-stretch gap-1 rounded-none border-0 px-3 py-2.5 text-left font-normal shadow-none",
                        active
                          ? "bg-muted text-foreground hover:bg-muted"
                          : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                      )}
                      onClick={() => selectProviderSection(slug)}
                    >
                      <span className="flex flex-wrap items-center gap-1">
                        <span className="font-mono text-[11px]">{slug}</span>
                        {isDisk ? (
                          <Badge variant="default" className="h-4 px-1 text-[9px] leading-none">
                            Default
                          </Badge>
                        ) : null}
                        {showConfiguredBadge ? (
                          <Badge variant="outline" className="h-4 px-1 text-[9px] leading-none">
                            Configured
                          </Badge>
                        ) : null}
                      </span>
                      <span className="line-clamp-2 text-left text-[10px] leading-snug text-muted-foreground">
                        {providerOptionLabel(slug)}
                      </span>
                    </Button>
                  );
                })}
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
                onSetAuxSlot={setAuxSlot}
                onClearAuxSlot={clearAuxSlot}
              />
            ) : (
              <ProviderPanel
                hProvider={hProvider}
                hModel={hModel}
                hBaseUrl={hBaseUrl}
                hSaving={hSaving}
                hSaved={hSaved}
                hError={hError}
                credentialKeys={credentialKeys}
                keyDrafts={keyDrafts}
                keysLoading={keysLoading}
                keysError={keysError}
                catalog={catalog}
                showHermesModelLoading={showHermesModelLoading}
                modelEntriesForProvider={modelEntriesForProvider}
                providerCliMeta={providerCliMeta}
                providerOptionLabel={providerOptionLabel}
                onHModelChange={setHModel}
                onHBaseUrlChange={setHBaseUrl}
                onKeyDraftChange={(k, v) =>
                  setKeyDrafts((prev) => ({ ...prev, [k]: v }))
                }
                onSave={() => void saveProviderSettings()}
              />
            )}
          </ScrollArea>
        </div>
      )}
    </div>
  );
}

/**
 * Inline chip row under the "Default model" card. Surfaces:
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
  /**
   * Context-length triple from the bridge (mirrors upstream
   * ``/api/model/info``). ``auto`` is what
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
  onSetAuxSlot: (slot: AuxiliarySlotName, provider: string, model: string) => Promise<void>;
  onClearAuxSlot: (slot: AuxiliarySlotName) => Promise<void>;
}

function ModelConfigPanel({
  catalog,
  diskProvider,
  diskModel,
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

      {/* ── Default model ── */}
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <Star className="h-4 w-4 text-amber-500" />
          <h3 className="text-sm font-semibold text-foreground">Default model</h3>
          {mcSaved && (
            <span className="text-[11px] text-[hsl(var(--success))]">Saved</span>
          )}
        </div>
        {diskModel ? (
          <div className="rounded-lg border border-border bg-muted/20 px-4 py-3">
            <p className="break-all font-mono text-sm text-foreground">{diskModel}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{providerLabel(diskProvider)}</p>
            <MainModelChips
              context={mainContext}
              capabilities={mainCapabilities}
            />
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border/80 bg-muted/10 px-4 py-3">
            <p className="text-xs text-muted-foreground">
              Not set — pick one from the model list below by clicking <Star className="inline h-3 w-3" />.
            </p>
          </div>
        )}
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
                <AuxSlotRow
                  key={slot}
                  slot={slot}
                  slotData={auxSlots[slot]}
                  isSaving={auxSavingSlot === slot}
                  isSaved={auxSavedSlot === slot}
                  allCatalogModels={allCatalogModels}
                  canonicalLabelBySlug={canonicalLabelBySlug}
                  disabled={saving}
                  onSet={(provider, model) => void onSetAuxSlot(slot, provider, model)}
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
            From configured providers; click <Star className="inline h-3 w-3 text-amber-500" /> to set as default.
          </p>
        </div>

        {!hasAny ? (
          <div className="rounded-lg border border-dashed border-border/80 bg-muted/15 p-4">
            <p className="text-xs text-muted-foreground">
              No models available. Make sure the bridge is connected, or click “Refresh catalog” at the top.
            </p>
          </div>
        ) : (
          <>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search model id or provider…"
              className="text-xs"
            />
            {groupedModels.size === 0 ? (
              <p className="text-xs text-muted-foreground">No matching models.</p>
            ) : (
              <div className="space-y-4">
                {[...groupedModels.entries()].map(([provider, models]) => (
                  <div key={provider} className="space-y-1">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {provider}
                      {canonicalLabelBySlug.get(provider)
                        ? ` — ${canonicalLabelBySlug.get(provider)}`
                        : ""}
                      {catalog?.config_provider_ids?.includes(provider) ||
                      catalog?.env_ready_provider_ids?.includes(provider) ? (
                        <Badge
                          variant="outline"
                          className="ml-1.5 h-3.5 px-1 text-[9px] leading-none"
                        >
                          Configured
                        </Badge>
                      ) : null}
                    </p>
                    <div className="rounded-lg border border-border bg-muted/10">
                      <ul className="flex flex-col divide-y divide-border/60">
                        {models.map((entry) => {
                          const isDefault =
                            entry.id === diskModel && provider === diskProvider;
                          return (
                            <li
                              key={entry.id}
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
                                    Current default
                                  </p>
                                )}
                              </div>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className={cn(
                                  "h-7 w-7 shrink-0 rounded-full transition-colors",
                                  isDefault
                                    ? "text-amber-500 hover:bg-amber-100/50 dark:hover:bg-amber-900/20"
                                    : "text-muted-foreground/50 hover:bg-amber-100/50 hover:text-amber-500 dark:hover:bg-amber-900/20",
                                )}
                                disabled={saving}
                                title="Set as default model"
                                aria-label="Set as default model"
                                onClick={() => void onSetDefault(provider, entry.id)}
                              >
                                <Star className="h-3.5 w-3.5" />
                              </Button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Auxiliary Slot Row
// ─────────────────────────────────────────────────────────────────────────────

interface AuxSlotRowProps {
  slot: AuxiliarySlotName;
  slotData: AuxiliaryTask;
  isSaving: boolean;
  isSaved: boolean;
  allCatalogModels: { provider: string; entry: HermesCatalogModelEntry }[];
  canonicalLabelBySlug: Map<string, string>;
  disabled: boolean;
  onSet: (provider: string, model: string) => void;
  onClear: () => void;
}

function AuxSlotRow({
  slot,
  slotData,
  isSaving,
  isSaved,
  allCatalogModels,
  canonicalLabelBySlug,
  disabled,
  onSet,
  onClear,
}: AuxSlotRowProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const dropRef = useRef<HTMLDivElement>(null);

  const label = AUXILIARY_SLOT_LABELS[slot];
  const hasModel = Boolean(slotData?.model);

  const filteredModels = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allCatalogModels;
    return allCatalogModels.filter(
      ({ provider, entry }) =>
        entry.id.toLowerCase().includes(q) || provider.toLowerCase().includes(q),
    );
  }, [allCatalogModels, search]);

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
              {slotData.provider && slotData.provider !== "auto"
                ? `${slotData.provider} / `
                : ""}
              {slotData.model}
            </p>
          ) : (
            <p className="text-[10px] text-muted-foreground">Inherits main model</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isSaved && (
            <span className="text-[10px] text-[hsl(var(--success))]">Saved</span>
          )}
          {hasModel && (
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
              <div className="absolute right-0 top-7 z-50 w-72 rounded-lg border border-border bg-popover shadow-lg">
                <div className="border-b border-border p-2">
                  <Input
                    autoFocus
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search models…"
                    className="h-7 text-xs"
                  />
                </div>
                <ScrollArea className="max-h-56">
                  {filteredModels.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-muted-foreground">No matching models</p>
                  ) : (
                    <ul className="flex flex-col py-1">
                      {filteredModels.map(({ provider, entry }) => (
                        <li key={`${provider}/${entry.id}`}>
                          <button
                            type="button"
                            className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-muted/60"
                            onClick={() => {
                              onSet(provider, entry.id);
                              setOpen(false);
                              setSearch("");
                            }}
                          >
                            <span className="font-mono text-[11px] text-foreground">{entry.id}</span>
                            <span className="text-[10px] text-muted-foreground">
                              {canonicalLabelBySlug.get(provider) ?? provider}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </ScrollArea>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: Provider Panel
// ─────────────────────────────────────────────────────────────────────────────

interface ProviderPanelProps {
  hProvider: string;
  hModel: string;
  hBaseUrl: string;
  hSaving: boolean;
  hSaved: boolean;
  hError: string | null;
  credentialKeys: string[];
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
  onHModelChange: (v: string) => void;
  onHBaseUrlChange: (v: string) => void;
  onKeyDraftChange: (k: string, v: string) => void;
  onSave: () => void;
}

function ProviderPanel({
  hProvider,
  hModel,
  hBaseUrl,
  hSaving,
  hSaved,
  hError,
  credentialKeys,
  keyDrafts,
  keysLoading,
  keysError,
  catalog,
  showHermesModelLoading,
  modelEntriesForProvider,
  providerCliMeta,
  providerOptionLabel,
  onHModelChange,
  onHBaseUrlChange,
  onKeyDraftChange,
  onSave,
}: ProviderPanelProps) {
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
            Recognized providers (declared in <span className="font-mono">config.yaml</span> or with a key set in the plugin{" "}
            <span className="font-mono">.env</span>): {merged.join(", ")}
          </p>
        );
      })()}
      {hError && (
        <p className="text-[11px] text-amber-600 dark:text-amber-500">{hError}</p>
      )}

      {/* Provider config section */}
      <section className="space-y-5">
        <div>
          <h3 className="text-sm font-medium text-foreground">Provider config</h3>
          <div className="mt-2 space-y-1 text-sm text-muted-foreground">
            <p className="font-mono text-sm text-foreground">{hProvider}</p>
            <p className="text-xs">{providerOptionLabel(hProvider)}</p>
          </div>
        </div>
        <div className="space-y-5">
          {(hProvider === "auto" || hProvider === "custom") && (
            <p className="text-xs text-muted-foreground">
              {hProvider === "auto"
                ? "Pick a specific provider to enter its key and see its full model list."
                : "Set the API URL and key to use the custom endpoint."}
            </p>
          )}

          {hProvider !== "auto" && credentialKeys.length > 0 && (
            <div className="space-y-3">
              <Label className="text-sm text-foreground">API keys</Label>
              {keysError && (
                <p className="text-[11px] text-amber-600 dark:text-amber-500">{keysError}</p>
              )}
              {keysLoading ? (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Loading…
                </p>
              ) : (
                <div className="space-y-3">
                  {credentialKeys.map((name) => (
                    <div key={name} className="space-y-1.5">
                      <Label
                        htmlFor={`key-${name}`}
                        className="font-mono text-[11px] text-muted-foreground"
                      >
                        {name}
                      </Label>
                      <Input
                        id={`key-${name}`}
                        value={keyDrafts[name] ?? ""}
                        onChange={(e) => onKeyDraftChange(name, e.target.value)}
                        className="font-mono text-xs"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="h-baseurl-main">API URL (optional)</Label>
            <Input
              id="h-baseurl-main"
              value={hBaseUrl}
              onChange={(e) => onHBaseUrlChange(e.target.value)}
              placeholder="OpenAI-compatible service base URL"
              className="font-mono text-xs"
              autoComplete="off"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button type="button" disabled={hSaving} onClick={onSave}>
              {hSaving ? "Saving…" : "Save settings"}
            </Button>
            {hSaved && (
              <span className="text-xs text-[hsl(var(--success))]">Saved</span>
            )}
          </div>
        </div>
      </section>

      {/* Model list (display only) */}
      {hProvider !== "auto" && (
        <section className="space-y-3 border-t border-border pt-8">
          <div>
            <h3 className="text-sm font-medium text-foreground">Models</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Models available for the current provider. Use the “Model config” section to set a default or auxiliary model.
            </p>
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
              <div className="space-y-3 rounded-lg border border-dashed border-border/80 bg-muted/15 p-4">
                <p className="text-xs text-muted-foreground">
                  No models yet. After entering a key, click “Refresh catalog” at the top, or type a model name manually in “Model config”.
                </p>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Label htmlFor="h-model-fallback" className="text-xs">
                      Model name
                    </Label>
                    <Input
                      id="h-model-fallback"
                      value={hModel}
                      onChange={(e) => onHModelChange(e.target.value)}
                      placeholder="e.g. gpt-4o"
                      className="font-mono text-xs"
                      autoComplete="off"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
