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

import { OPTIONS_SHELL_HEADER_ROW } from "./optionsPageChrome";
import {
  AUXILIARY_SLOT_LABELS,
  AUXILIARY_SLOT_NAMES,
  getHermesAgentMainModel,
  getHermesAuxiliaryModels,
  getHermesDotenvValues,
  getHermesModelCatalog,
  getHermesProviderModels,
  patchHermesDotenv,
  setHermesAgentMainModel,
  setHermesAuxiliarySlot,
  type AuxiliarySlot,
  type AuxiliarySlotName,
  type HermesCatalogModelEntry,
  type HermesModelCatalogResponse,
} from "~lib/hermes-agent-model";
import { cn } from "~lib/utils";

/** Sidebar selection: special "model-config" panel or a provider slug. */
type SidebarSection = "model-config" | string;

function formatScalarForMeta(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "是" : "否";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "";
    if (Number.isInteger(v)) return String(v);
    const t = v.toFixed(8).replace(/\.?0+$/, "");
    return t === "-0" ? "0" : t;
  }
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v))
    return v.map(formatScalarForMeta).filter(Boolean).join("、");
  return "";
}

function labelMetaKey(k: string): string {
  const m: Record<string, string> = {
    context_window: "上下文",
    max_context_tokens: "上下文上限",
    max_output_tokens: "输出上限",
    max_tokens: "tokens",
    input_price_per_mtok: "输入",
    output_price_per_mtok: "输出",
    input_price: "输入价",
    output_price: "输出价",
    pricing: "定价",
    pricing_tier: "定价档",
    modality: "模态",
    modalities: "模态",
    parameters: "参数",
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
          const label = k === "input_price_per_mtok" ? "输入" : "输出";
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

  // ── Auxiliary-model state (8 named slots) ────────────────────────────
  const [auxSlots, setAuxSlots] = useState<Record<AuxiliarySlotName, AuxiliarySlot> | null>(null);
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
  const [keysLoading, setKeysLoading] = useState(false);
  const [keysError, setKeysError] = useState<string | null>(null);

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

  const keyNamesForProvider = useMemo(() => {
    const p = hProvider.trim();
    if (!p || p === "auto") return [];
    const pe = catalog?.provider_env_vars?.[p];
    if (pe?.length) return [...pe];
    if (p === "custom") return ["CUSTOM_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
    return [];
  }, [catalog?.provider_env_vars, hProvider]);

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
    if (id === "auto") return "根据已填密钥自动选择服务商";
    if (id === "custom") return "自定义兼容接口，填写下方 API 地址";
    const tui = canonicalLabelBySlug.get(id);
    if (tui) return tui;
    if (configSlugSet.has(id)) return `${id}（已在你的 Hermes 配置中）`;
    if (envReadySlugSet.has(id)) return `${id}（插件 .env 已填密钥）`;
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

  // ── Load API keys when provider changes ───────────────────────────────
  useEffect(() => {
    const names = keyNamesForProvider;
    if (names.length === 0) {
      setKeyDrafts({});
      setKeysLoading(false);
      setKeysError(null);
      return;
    }
    let cancelled = false;
    setKeysLoading(true);
    setKeysError(null);
    void getHermesDotenvValues(names).then((r) => {
      if (cancelled) return;
      setKeysLoading(false);
      if (!r.ok) {
        setKeysError(r.error || "无法读取密钥");
        setKeyDrafts({});
        return;
      }
      setKeyDrafts({ ...(r.values ?? {}) });
    });
    return () => {
      cancelled = true;
    };
  }, [keyNamesForProvider.join("|"), hProvider]);

  // ── Initial load ──────────────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      setMainLoading(true);
      setMainError(null);
      try {
        const [main, auxResp, cat] = await Promise.all([
          getHermesAgentMainModel(),
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
          setMainError(typeof main.error === "string" && main.error ? main.error : null);
        } else {
          setMainError(main.error || "无法读取 Hermes 配置");
        }
        if (auxResp.ok && auxResp.slots) {
          setAuxSlots(auxResp.slots);
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
      if (keyNamesForProvider.length > 0) {
        const dv = await getHermesDotenvValues(keyNamesForProvider);
        if (dv.ok) setKeyDrafts({ ...(dv.values ?? {}) });
      }
    } finally {
      setCatalogRefreshing(false);
    }
  }

  // ── Provider panel: save API keys ─────────────────────────────────────
  async function persistProviderKeys(): Promise<boolean> {
    const names = keyNamesForProvider;
    if (names.length === 0) return true;
    setKeysError(null);
    const updates: Record<string, string> = {};
    for (const k of names) updates[k] = keyDrafts[k] ?? "";
    const r = await patchHermesDotenv(updates);
    if (!r.ok) {
      setKeysError(r.error || "保存密钥失败");
      return false;
    }
    void loadProviderModels(true);
    return true;
  }

  async function saveProviderSettings() {
    setHSaving(true);
    setHError(null);
    setKeysError(null);
    try {
      if (!(await persistProviderKeys())) return;
      const r = await setHermesAgentMainModel({
        provider: hProvider.trim() || "auto",
        model: hModel.trim(),
        base_url: hBaseUrl.trim() || null,
      });
      if (!r.ok) {
        setHError(r.error || "保存失败");
        return;
      }
      const dp = (r.provider || hProvider || "auto").trim() || "auto";
      const dm = (r.model ?? hModel).trim();
      const dbu = (r.base_url ?? hBaseUrl).trim();
      setDiskProvider(dp);
      setDiskModel(dm);
      setDiskBaseUrl(dbu);
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
        setMcError(r.error || "未能设为默认模型");
        return;
      }
      const dp = (r.provider || p || "auto").trim() || "auto";
      const dm = (r.model ?? id).trim();
      const dbu = (r.base_url ?? "").trim();
      setDiskProvider(dp);
      setDiskModel(dm);
      setDiskBaseUrl(dbu);
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
  async function setAuxSlot(slot: AuxiliarySlotName, provider: string, model: string) {
    setAuxSavingSlot(slot);
    setAuxError(null);
    try {
      const r = await setHermesAuxiliarySlot({ slot, provider: provider.trim(), model: model.trim() });
      if (!r.ok) {
        setAuxError(r.error || "保存失败");
        return;
      }
      if (r.slots) setAuxSlots(r.slots);
      setAuxSavedSlot(slot);
      setTimeout(() => setAuxSavedSlot(null), 1500);
    } finally {
      setAuxSavingSlot(null);
    }
  }

  async function clearAuxSlot(slot: AuxiliarySlotName) {
    setAuxSavingSlot(slot);
    setAuxError(null);
    try {
      const r = await setHermesAuxiliarySlot({ slot, provider: "", model: "" });
      if (!r.ok) {
        setAuxError(r.error || "清除失败");
        return;
      }
      if (r.slots) setAuxSlots(r.slots);
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
          <h2 className="text-sm font-semibold tracking-tight text-foreground">Models</h2>
          <p className="truncate text-[11px] text-muted-foreground">
            {catalogLoading
              ? "加载中…"
              : catalog?.ok
                ? catalog.updated_at
                  ? `目录 ${catalog.updated_at}`
                  : "目录已就绪"
                : "目录不可用"}
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
          刷新目录
        </Button>
      </header>

      {mainLoading ? (
        <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
          加载设置中…
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
              <span className="text-[11px] font-semibold">模型配置</span>
              <span className="line-clamp-1 text-left text-[10px] leading-snug text-muted-foreground">
                {diskModel
                  ? `默认: ${diskModel}`
                  : "设置默认及辅助模型"}
              </span>
            </Button>

            {/* Provider list — small section label inside the list, not a full h-14 shell row */}
            <ScrollArea className="min-h-0 flex-1">
              <nav className="flex flex-col">
                <p className="px-3 pt-2 pb-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  服务商
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
                            默认
                          </Badge>
                        ) : null}
                        {showConfiguredBadge ? (
                          <Badge variant="outline" className="h-4 px-1 text-[9px] leading-none">
                            已配置
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
                keyNamesForProvider={keyNamesForProvider}
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

// ─────────────────────────────────────────────────────────────────────────────
// Model Config Panel
// ─────────────────────────────────────────────────────────────────────────────

interface ModelConfigPanelProps {
  catalog: HermesModelCatalogResponse | null;
  diskProvider: string;
  diskModel: string;
  auxSlots: Record<AuxiliarySlotName, AuxiliarySlot> | null;
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
    if (!slug || slug === "auto") return "自动";
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
          <h3 className="text-sm font-semibold text-foreground">默认模型</h3>
          {mcSaved && (
            <span className="text-[11px] text-[hsl(var(--success))]">已保存</span>
          )}
        </div>
        {diskModel ? (
          <div className="rounded-lg border border-border bg-muted/20 px-4 py-3">
            <p className="break-all font-mono text-sm text-foreground">{diskModel}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{providerLabel(diskProvider)}</p>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border/80 bg-muted/10 px-4 py-3">
            <p className="text-xs text-muted-foreground">
              未设置 — 从下方模型列表点击 <Star className="inline h-3 w-3" /> 选择。
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
          <span className="text-sm font-semibold text-foreground">辅助模型</span>
          <span className="text-[11px] text-muted-foreground">
            ({configuredAuxCount} / {AUXILIARY_SLOT_NAMES.length} 已配置)
          </span>
        </button>

        {auxExpanded && (
          <div className="space-y-2 pl-6">
            {auxSlots === null ? (
              <p className="text-xs text-muted-foreground">辅助模型配置不可用（桥接未连接）。</p>
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
          <h3 className="text-sm font-semibold text-foreground">所有可用模型</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            来自已配置服务商；点击 <Star className="inline h-3 w-3 text-amber-500" /> 设为默认模型。
          </p>
        </div>

        {!hasAny ? (
          <div className="rounded-lg border border-dashed border-border/80 bg-muted/15 p-4">
            <p className="text-xs text-muted-foreground">
              暂无可用模型。请确认桥接已连接，或点击顶部「刷新目录」。
            </p>
          </div>
        ) : (
          <>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索模型名称或服务商…"
              className="text-xs"
            />
            {groupedModels.size === 0 ? (
              <p className="text-xs text-muted-foreground">未找到匹配模型。</p>
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
                          已配置
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
                                    当前默认
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
                                title="设为默认模型"
                                aria-label="设为默认模型"
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
  slotData: AuxiliarySlot;
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
            <p className="text-[10px] text-muted-foreground">继承主模型</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isSaved && (
            <span className="text-[10px] text-[hsl(var(--success))]">已保存</span>
          )}
          {hasModel && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6 rounded-full text-muted-foreground/60 hover:text-destructive"
              disabled={disabled || isSaving}
              title="清除"
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
              {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : "选择"}
            </Button>
            {open && (
              <div className="absolute right-0 top-7 z-50 w-72 rounded-lg border border-border bg-popover shadow-lg">
                <div className="border-b border-border p-2">
                  <Input
                    autoFocus
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="搜索模型…"
                    className="h-7 text-xs"
                  />
                </div>
                <ScrollArea className="max-h-56">
                  {filteredModels.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-muted-foreground">无匹配模型</p>
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
  keyNamesForProvider: string[];
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
  keyNamesForProvider,
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
          部分服务商信息未加载完整，请确认 Hermes 已安装并与扩展保持连接。
        </p>
      )}
      {(() => {
        const yaml = catalog?.config_provider_ids ?? [];
        const env = catalog?.env_ready_provider_ids ?? [];
        const merged = [...new Set([...yaml, ...env])];
        if (merged.length === 0) return null;
        return (
          <p className="text-[11px] text-muted-foreground">
            已识别为可用的服务商（<span className="font-mono">config.yaml</span> 声明或插件{" "}
            <span className="font-mono">.env</span> 已填密钥）：{merged.join("、")}
          </p>
        );
      })()}
      {hError && (
        <p className="text-[11px] text-amber-600 dark:text-amber-500">{hError}</p>
      )}

      {/* Provider config section */}
      <section className="space-y-5">
        <div>
          <h3 className="text-sm font-medium text-foreground">服务商配置</h3>
          <div className="mt-2 space-y-1 text-sm text-muted-foreground">
            <p className="font-mono text-sm text-foreground">{hProvider}</p>
            <p className="text-xs">{providerOptionLabel(hProvider)}</p>
          </div>
        </div>
        <div className="space-y-5">
          {(hProvider === "auto" || hProvider === "custom") && (
            <p className="text-xs text-muted-foreground">
              {hProvider === "auto"
                ? "选择具体服务商后可填写密钥并查看完整模型列表。"
                : "填写 API 地址与密钥后即可使用自定义接口。"}
            </p>
          )}

          {hProvider !== "auto" && keyNamesForProvider.length > 0 && (
            <div className="space-y-3">
              <Label className="text-sm text-foreground">API 密钥</Label>
              {keysError && (
                <p className="text-[11px] text-amber-600 dark:text-amber-500">{keysError}</p>
              )}
              {keysLoading ? (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  加载中…
                </p>
              ) : (
                <div className="space-y-3">
                  {keyNamesForProvider.map((name) => (
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
            <Label htmlFor="h-baseurl-main">API 地址（可选）</Label>
            <Input
              id="h-baseurl-main"
              value={hBaseUrl}
              onChange={(e) => onHBaseUrlChange(e.target.value)}
              placeholder="兼容 OpenAI 的服务根地址"
              className="font-mono text-xs"
              autoComplete="off"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button type="button" disabled={hSaving} onClick={onSave}>
              {hSaving ? "保存中…" : "保存设置"}
            </Button>
            {hSaved && (
              <span className="text-xs text-[hsl(var(--success))]">已保存</span>
            )}
          </div>
        </div>
      </section>

      {/* Model list (display only) */}
      {hProvider !== "auto" && (
        <section className="space-y-3 border-t border-border pt-8">
          <div>
            <h3 className="text-sm font-medium text-foreground">模型列表</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              当前服务商可用模型；前往「模型配置」可将模型设为默认或辅助。
            </p>
          </div>
          <div className="space-y-3">
            {showHermesModelLoading ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                加载模型列表…
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
                    当前为参考列表；填写密钥并刷新后通常会显示完整列表。
                  </p>
                ) : null}
                {!showHermesModelLoading && providerCliMeta?.pricing_loaded ? (
                  <p className="text-[10px] text-muted-foreground">
                    价格为当前服务商模型接口列出的美元/百万 token（由每 token 单价换算）；不同路由或模型 id 可能与官网标价不一致，以账单为准。
                  </p>
                ) : null}
              </>
            ) : (
              <div className="space-y-3 rounded-lg border border-dashed border-border/80 bg-muted/15 p-4">
                <p className="text-xs text-muted-foreground">
                  暂无列表。填写密钥后点顶部「刷新目录」，或在「模型配置」手动输入模型名称。
                </p>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Label htmlFor="h-model-fallback" className="text-xs">
                      模型名称
                    </Label>
                    <Input
                      id="h-model-fallback"
                      value={hModel}
                      onChange={(e) => onHModelChange(e.target.value)}
                      placeholder="例如 gpt-4o"
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
