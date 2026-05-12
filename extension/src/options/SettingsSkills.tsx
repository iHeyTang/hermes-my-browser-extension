import { FileText, Loader2, RefreshCw, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "~components/ui/badge";
import { Button } from "~components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~components/ui/dialog";
import { Input } from "~components/ui/input";
import { ScrollArea } from "~components/ui/scroll-area";
import {
  getHermesSkillFile,
  getHermesSkillFiles,
  getHermesSkills,
  type HermesSkillEntry,
  type HermesSkillFileEntry,
  type HermesSkillFileResponse,
  type HermesSkillOrigin,
  type HermesSkillsResponse,
} from "~lib/hermes-skills";
import { cn } from "~lib/utils";

import { OPTIONS_SHELL_HEADER_ROW } from "./optionsPageChrome";

const ALL_KEY = "__all__";
const UNCATEGORIZED_KEY = "__uncategorized__";
const UNCATEGORIZED_LABEL = "未分类";

interface OriginInfo {
  label: string;
  tooltip: string;
  className: string;
}

const ORIGIN_INFO: Record<string, OriginInfo> = {
  bundled: {
    label: "内置",
    tooltip: "随 Hermes Agent 一起分发（.bundled_manifest）",
    className: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  },
  hub: {
    label: "Hub 安装",
    tooltip: "通过 hermes skill install 从 Skills Hub 在线安装（.hub/lock.json）",
    className: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  },
  agent: {
    label: "Agent 创建",
    tooltip:
      "curator agent 在 background-review 中自己写出来的（.usage.json: created_by=\"agent\"）",
    className: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  },
  manual: {
    label: "手动添加",
    tooltip:
      "目录里有但三份 manifest 都不认（用户自行 clone、symlink、或第三方 CLI 装的）",
    className: "bg-muted text-muted-foreground",
  },
  external: {
    label: "外部目录",
    tooltip: "来自 config.yaml 的 skills.external_dirs",
    className: "bg-teal-500/15 text-teal-700 dark:text-teal-300",
  },
};

function originMeta(origin: HermesSkillOrigin): OriginInfo {
  return (
    ORIGIN_INFO[origin] ?? {
      label: origin,
      tooltip: origin,
      className: "bg-muted text-muted-foreground",
    }
  );
}

const ORIGIN_FILTER_ORDER: HermesSkillOrigin[] = [
  "bundled",
  "hub",
  "agent",
  "manual",
  "external",
];

type ActiveBucket = "active" | "inactive";

const ACTIVE_INFO: Record<
  ActiveBucket,
  { label: string; tooltip: string; className: string }
> = {
  active: {
    label: "可用",
    tooltip: "平台兼容且未被禁用",
    className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  },
  inactive: {
    label: "不可用",
    tooltip: "已禁用或平台不兼容",
    className: "bg-muted text-muted-foreground",
  },
};

const ACTIVE_FILTER_ORDER: ActiveBucket[] = ["active", "inactive"];

interface CategoryBucket {
  key: string;
  label: string;
  count: number;
  activeCount: number;
}

function statusBadge(skill: HermesSkillEntry) {
  if (!skill.compatible) {
    return {
      label: "平台不兼容",
      className: "bg-muted text-muted-foreground",
    };
  }
  if (skill.disabled) {
    return {
      label: "已禁用",
      className: "bg-destructive/15 text-destructive",
    };
  }
  return {
    label: "可用",
    className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  };
}

function formatRelative(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diffSec = Math.round((Date.now() - t) / 1000);
  if (diffSec < 60) return "刚刚";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  if (diffSec < 86400 * 30) return `${Math.floor(diffSec / 86400)} 天前`;
  if (diffSec < 86400 * 365) return `${Math.floor(diffSec / (86400 * 30))} 个月前`;
  return `${Math.floor(diffSec / (86400 * 365))} 年前`;
}

function formatAbsolute(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

const TS_SOURCE_LABEL: Record<string, string> = {
  usage: "Hermes 使用记录",
  hub: "Hub 安装记录",
  fs: "文件系统时间",
};

function SkillRow({
  skill,
  onView,
}: {
  skill: HermesSkillEntry;
  onView: (skill: HermesSkillEntry) => void;
}) {
  const badge = statusBadge(skill);
  const origin = originMeta(skill.origin);
  const muted = !skill.active;

  const updatedRel = formatRelative(skill.updated_at);

  const hoverParts: string[] = [];
  if (skill.description) hoverParts.push(skill.description);
  if (skill.platforms?.length) hoverParts.push(`platforms: ${skill.platforms.join(", ")}`);
  if (skill.tags.length) hoverParts.push(`tags: ${skill.tags.join(", ")}`);
  hoverParts.push(`添加: ${formatAbsolute(skill.created_at)}`);
  hoverParts.push(`更新: ${formatAbsolute(skill.updated_at)}`);
  hoverParts.push(
    `时间来源: ${TS_SOURCE_LABEL[skill.timestamp_source] ?? skill.timestamp_source}`,
  );
  hoverParts.push("点击查看目录内容");
  const hoverTitle = hoverParts.join("\n");

  return (
    <li
      title={hoverTitle || undefined}
      onClick={() => onView(skill)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onView(skill);
        }
      }}
      role="button"
      tabIndex={0}
      className={cn(
        "flex cursor-pointer items-start gap-3 border-b border-border/40 px-2 py-2 transition-colors last:border-b-0 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none",
        muted && "opacity-60",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-xs font-medium tracking-tight">
            {skill.name}
          </span>
          {skill.version && (
            <span className="shrink-0 text-[10px] font-normal text-muted-foreground/80">
              v{skill.version}
            </span>
          )}
        </div>
        <div className="flex min-w-0 items-baseline gap-2">
          {skill.description ? (
            <p className="line-clamp-2 min-w-0 flex-1 text-[11px] leading-snug text-muted-foreground">
              {skill.description}
            </p>
          ) : (
            <span className="flex-1" />
          )}
          {updatedRel && (
            <span
              className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70"
              title={`更新于 ${formatAbsolute(skill.updated_at)}`}
            >
              {updatedRel}
            </span>
          )}
        </div>
      </div>
      <span
        className={cn(
          "mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
          origin.className,
        )}
        title={origin.tooltip}
      >
        {origin.label}
      </span>
      <span
        className={cn(
          "mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
          badge.className,
        )}
      >
        {badge.label}
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Skill directory viewer dialog.
//
// Two panes: file list (sorted, with SKILL.md pinned to the top) and the
// selected file's body. Auto-selects SKILL.md on open so the user lands on
// the canonical entry point instead of an empty right pane.
// ---------------------------------------------------------------------------

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Sort entries with `SKILL.md` first (the canonical entry point), then by
 * directory depth (shallower first), then alphabetically. Matches what
 * you'd want when scanning a skill — overview file, top-level docs,
 * deeper references.
 */
function sortSkillFiles(files: HermesSkillFileEntry[]): HermesSkillFileEntry[] {
  return [...files].sort((a, b) => {
    if (a.path === "SKILL.md") return -1;
    if (b.path === "SKILL.md") return 1;
    const depthA = a.path.split("/").length;
    const depthB = b.path.split("/").length;
    if (depthA !== depthB) return depthA - depthB;
    return a.path.localeCompare(b.path);
  });
}

interface SkillViewerDialogProps {
  skill: HermesSkillEntry | null;
  onClose: () => void;
}

function SkillViewerDialog({ skill, onClose }: SkillViewerDialogProps) {
  const [files, setFiles] = useState<HermesSkillFileEntry[]>([]);
  const [root, setRoot] = useState<string>("");
  const [truncated, setTruncated] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileBody, setFileBody] = useState<HermesSkillFileResponse | null>(
    null,
  );
  const [loadingFile, setLoadingFile] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const open = !!skill;

  // Load the file list whenever a new skill is opened. Reset everything so
  // re-opening a different skill doesn't show the previous skill's body in
  // the right pane while the new list is in flight.
  useEffect(() => {
    if (!skill) return;
    setFiles([]);
    setRoot("");
    setTruncated(false);
    setListError(null);
    setSelectedPath(null);
    setFileBody(null);
    setFileError(null);
    setLoadingList(true);
    let cancelled = false;
    void (async () => {
      const r = await getHermesSkillFiles(skill.name);
      if (cancelled) return;
      setLoadingList(false);
      if (!r.ok) {
        setListError(r.error || "加载失败");
        return;
      }
      const sorted = sortSkillFiles(r.files);
      setFiles(sorted);
      setRoot(r.root || "");
      setTruncated(!!r.truncated);
      // Auto-select the canonical entry file so the right pane has
      // something to show immediately.
      if (sorted.length > 0) setSelectedPath(sorted[0].path);
    })();
    return () => {
      cancelled = true;
    };
  }, [skill]);

  // Fetch the selected file's body. Encoding metadata flows straight from
  // the bridge — utf-8 renders inline; binary / too-large render a
  // placeholder instead so we never try to display garbage.
  useEffect(() => {
    if (!skill || !selectedPath) {
      setFileBody(null);
      return;
    }
    setLoadingFile(true);
    setFileError(null);
    let cancelled = false;
    void (async () => {
      const r = await getHermesSkillFile(skill.name, selectedPath);
      if (cancelled) return;
      setLoadingFile(false);
      if (!r.ok) {
        setFileError(r.error || "读取失败");
        setFileBody(null);
        return;
      }
      setFileBody(r);
    })();
    return () => {
      cancelled = true;
    };
  }, [skill, selectedPath]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className={cn(
          // Wide modal for the two-pane layout. Plain `max-w-lg` (the
          // primitive default) is far too narrow for a code viewer.
          "flex h-[80vh] max-h-[800px] w-[90vw] max-w-5xl flex-col gap-0 p-0",
        )}
      >
        <DialogHeader className="border-b border-border bg-muted/30 px-4 py-3">
          <DialogTitle className="text-sm font-semibold">
            {skill?.name ?? ""}
            {skill?.version && (
              <span className="ml-2 text-[10px] font-normal text-muted-foreground/80">
                v{skill.version}
              </span>
            )}
          </DialogTitle>
          <DialogDescription
            className="truncate text-[11px] text-muted-foreground"
            title={root}
          >
            {root || skill?.path}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          {/* ── File list ── */}
          <aside className="flex min-h-0 w-64 shrink-0 flex-col border-r border-border bg-muted/15">
            <div className="border-b border-border/50 px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/70">
              文件 ({files.length})
              {truncated && (
                <span className="ml-1 text-amber-600 dark:text-amber-400">
                  · 仅显示前 {files.length} 个
                </span>
              )}
            </div>
            <ScrollArea className="min-h-0 flex-1">
              {loadingList ? (
                <div className="flex items-center justify-center py-6 text-xs text-muted-foreground">
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  加载中…
                </div>
              ) : listError ? (
                <p className="px-3 py-3 text-xs text-destructive">{listError}</p>
              ) : files.length === 0 ? (
                <p className="px-3 py-3 text-xs text-muted-foreground">
                  （无文件）
                </p>
              ) : (
                <ul className="flex flex-col">
                  {files.map((f) => {
                    const isSel = f.path === selectedPath;
                    return (
                      <li key={f.path}>
                        <button
                          type="button"
                          onClick={() => setSelectedPath(f.path)}
                          title={`${f.path} · ${formatFileSize(f.size)}`}
                          className={cn(
                            "flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] transition-colors",
                            isSel
                              ? "bg-muted text-foreground"
                              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                          )}
                        >
                          <FileText className="h-3 w-3 shrink-0 opacity-70" />
                          <span className="min-w-0 flex-1 truncate font-mono">
                            {f.path}
                          </span>
                          <span className="shrink-0 text-[9px] tabular-nums opacity-70">
                            {formatFileSize(f.size)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </ScrollArea>
          </aside>

          {/* ── File body ── */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex items-center justify-between border-b border-border/50 bg-muted/10 px-3 py-1.5 text-[11px]">
              <span className="truncate font-mono text-muted-foreground">
                {selectedPath || "—"}
              </span>
              {fileBody?.size != null && (
                <span className="ml-2 shrink-0 tabular-nums text-muted-foreground/70">
                  {formatFileSize(fileBody.size)}
                </span>
              )}
            </div>
            <ScrollArea className="min-h-0 flex-1 bg-background">
              {loadingFile ? (
                <div className="flex items-center justify-center py-6 text-xs text-muted-foreground">
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  读取中…
                </div>
              ) : fileError ? (
                <p className="px-4 py-3 text-xs text-destructive">{fileError}</p>
              ) : fileBody?.encoding === "binary" ? (
                <p className="px-4 py-3 text-xs text-muted-foreground">
                  二进制文件 · {formatFileSize(fileBody.size ?? 0)}
                </p>
              ) : fileBody?.encoding === "too-large" ? (
                <p className="px-4 py-3 text-xs text-muted-foreground">
                  文件过大（{formatFileSize(fileBody.size ?? 0)}），超过预览上限
                  {fileBody.limit ? `（${formatFileSize(fileBody.limit)}）` : ""}
                  。
                </p>
              ) : fileBody?.content != null ? (
                <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-[11px] leading-relaxed">
                  {fileBody.content}
                </pre>
              ) : (
                <p className="px-4 py-3 text-xs text-muted-foreground">
                  （选择左侧文件以查看内容）
                </p>
              )}
            </ScrollArea>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function buildCategoryBuckets(skills: HermesSkillEntry[]): CategoryBucket[] {
  const map = new Map<string, { count: number; activeCount: number }>();
  for (const s of skills) {
    const key = s.category ?? UNCATEGORIZED_KEY;
    const cur = map.get(key) ?? { count: 0, activeCount: 0 };
    cur.count += 1;
    if (s.active) cur.activeCount += 1;
    map.set(key, cur);
  }
  const keys = Array.from(map.keys()).sort((a, b) => {
    if (a === UNCATEGORIZED_KEY) return 1;
    if (b === UNCATEGORIZED_KEY) return -1;
    return a.localeCompare(b);
  });
  return keys.map((k) => ({
    key: k,
    label: k === UNCATEGORIZED_KEY ? UNCATEGORIZED_LABEL : k,
    count: map.get(k)!.count,
    activeCount: map.get(k)!.activeCount,
  }));
}

const EMPTY_RESPONSE: HermesSkillsResponse = {
  ok: true,
  skills: [],
  platform: "",
  sys_platform: "",
  skills_dirs: [],
  totals: { total: 0, active: 0, disabled: 0, incompatible: 0 },
  origin_counts: {},
};

/** Read-only view of Hermes skills available to the current agent. */
export function SettingsSkills() {
  const [data, setData] = useState<HermesSkillsResponse>(EMPTY_RESPONSE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>(ALL_KEY);
  const [originFilter, setOriginFilter] = useState<Set<HermesSkillOrigin>>(
    () => new Set(),
  );
  const [activeFilter, setActiveFilter] = useState<Set<ActiveBucket>>(
    () => new Set(),
  );
  const [viewingSkill, setViewingSkill] = useState<HermesSkillEntry | null>(
    null,
  );

  const toggleOrigin = useCallback((o: HermesSkillOrigin) => {
    setOriginFilter((prev) => {
      const next = new Set(prev);
      if (next.has(o)) next.delete(o);
      else next.add(o);
      return next;
    });
  }, []);

  const toggleActive = useCallback((a: ActiveBucket) => {
    setActiveFilter((prev) => {
      const next = new Set(prev);
      if (next.has(a)) next.delete(a);
      else next.add(a);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const r = await getHermesSkills();
    setLoading(false);
    if (!r.ok) {
      setError(r.error || "加载失败");
      setData(EMPTY_RESPONSE);
      return;
    }
    setData(r);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const buckets = useMemo(() => buildCategoryBuckets(data.skills), [data.skills]);

  // Facet base: category-filtered only. Origin/active chip counts come from
  // here so chips don't disappear or jitter as the user toggles facets on
  // each other. The final `filtered` applies all facets + the text query.
  const categoryPool = useMemo(() => {
    if (category === ALL_KEY) return data.skills;
    return data.skills.filter(
      (s) => (s.category ?? UNCATEGORIZED_KEY) === category,
    );
  }, [data.skills, category]);

  const originCounts = useMemo(() => {
    const out: Partial<Record<HermesSkillOrigin, number>> = {};
    for (const s of categoryPool) {
      out[s.origin] = (out[s.origin] ?? 0) + 1;
    }
    return out;
  }, [categoryPool]);

  const activeCounts = useMemo(() => {
    let a = 0;
    let i = 0;
    for (const s of categoryPool) {
      if (s.active) a += 1;
      else i += 1;
    }
    return { active: a, inactive: i } as Record<ActiveBucket, number>;
  }, [categoryPool]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return categoryPool.filter((s) => {
      if (originFilter.size > 0 && !originFilter.has(s.origin)) return false;
      if (activeFilter.size > 0) {
        const bucket: ActiveBucket = s.active ? "active" : "inactive";
        if (!activeFilter.has(bucket)) return false;
      }
      if (!q) return true;
      if (s.name.toLowerCase().includes(q)) return true;
      if (s.description.toLowerCase().includes(q)) return true;
      if (s.category && s.category.toLowerCase().includes(q)) return true;
      if (s.tags.some((t) => t.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [categoryPool, query, originFilter, activeFilter]);

  const visibleOrigins = useMemo(
    () => ORIGIN_FILTER_ORDER.filter((o) => (originCounts[o] ?? 0) > 0),
    [originCounts],
  );

  const visibleActives = useMemo(
    () => ACTIVE_FILTER_ORDER.filter((a) => activeCounts[a] > 0),
    [activeCounts],
  );

  const hasAnyChipFilter = originFilter.size + activeFilter.size > 0;

  const currentBucket = useMemo(
    () => buckets.find((b) => b.key === category),
    [buckets, category],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header
        className={`${OPTIONS_SHELL_HEADER_ROW} flex-wrap justify-between gap-3 bg-muted/20 px-4`}
      >
        <div className="flex min-w-0 flex-col justify-center gap-0.5 leading-tight">
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            Skills
          </h2>
          <p
            className="truncate text-[11px] text-muted-foreground"
            title={data.skills_dirs.join("\n") || "$HERMES_HOME/skills"}
          >
            当前 Agent 可用技能（{data.totals.active} / {data.totals.total}）
            {data.platform && `  ·  platform=${data.platform}`}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 text-xs shrink-0"
          disabled={loading}
          onClick={() => void refresh()}
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          刷新
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ── Category sidebar ── */}
        <aside className="flex min-h-0 w-56 shrink-0 flex-col border-r border-border bg-muted/15">
          {/* "All" entry stays outside the ScrollArea so its w-full reliably
              expands the aside to its declared width even before data lands —
              Radix ScrollArea's viewport wraps children in display:table,
              which breaks width inheritance during the loading state. */}
          <div className="border-b border-border/50">
            <CategoryButton
              active={category === ALL_KEY}
              label="全部"
              count={data.totals.total}
              activeCount={data.totals.active}
              onClick={() => setCategory(ALL_KEY)}
            />
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <nav className="flex flex-col">
              {buckets.length > 0 && (
                <p className="px-3 pt-2 pb-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  分类
                </p>
              )}
              {buckets.map((b) => (
                <CategoryButton
                  key={b.key}
                  active={category === b.key}
                  label={b.label}
                  count={b.count}
                  activeCount={b.activeCount}
                  onClick={() => setCategory(b.key)}
                />
              ))}
            </nav>
          </ScrollArea>
        </aside>

        {/* ── Right panel ── */}
        <ScrollArea className="min-h-0 min-w-0 flex-1">
          <div className="space-y-4 p-6">
            {error && <p className="text-xs text-destructive">{error}</p>}

            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold tracking-tight">
                  {category === ALL_KEY
                    ? "全部"
                    : currentBucket?.label ?? category}
                </h3>
                <p className="text-[11px] text-muted-foreground">
                  共 {currentBucket?.count ?? data.totals.total} 条 · 可用{" "}
                  {currentBucket?.activeCount ?? data.totals.active}
                </p>
              </div>
            </div>

            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="按名称、描述、tag 或分类搜索…"
                className="h-8 pl-7 pr-7 text-xs"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label="清除搜索"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>

            {(visibleActives.length > 0 || visibleOrigins.length > 0) && (
              <div className="flex flex-wrap items-center gap-1.5">
                {visibleActives.map((a) => {
                  const meta = ACTIVE_INFO[a];
                  const on = activeFilter.has(a);
                  const count = activeCounts[a];
                  return (
                    <button
                      key={a}
                      type="button"
                      onClick={() => toggleActive(a)}
                      title={meta.tooltip}
                      className={cn(
                        "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                        on
                          ? `${meta.className} border-current`
                          : "border-border text-muted-foreground hover:bg-muted",
                      )}
                    >
                      <span>{meta.label}</span>
                      <span className="tabular-nums opacity-70">{count}</span>
                    </button>
                  );
                })}
                {visibleActives.length > 0 && visibleOrigins.length > 0 && (
                  <span className="mx-0.5 text-muted-foreground/50">·</span>
                )}
                {visibleOrigins.map((o) => {
                  const meta = originMeta(o);
                  const on = originFilter.has(o);
                  const count = originCounts[o] ?? 0;
                  return (
                    <button
                      key={o}
                      type="button"
                      onClick={() => toggleOrigin(o)}
                      title={meta.tooltip}
                      className={cn(
                        "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                        on
                          ? `${meta.className} border-current`
                          : "border-border text-muted-foreground hover:bg-muted",
                      )}
                    >
                      <span>{meta.label}</span>
                      <span className="tabular-nums opacity-70">{count}</span>
                    </button>
                  );
                })}
                {hasAnyChipFilter && (
                  <button
                    type="button"
                    onClick={() => {
                      setOriginFilter(new Set());
                      setActiveFilter(new Set());
                    }}
                    className="rounded-full px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    清除
                  </button>
                )}
              </div>
            )}

            {filtered.length === 0 && !loading && !error ? (
              <p className="text-xs text-muted-foreground">没有匹配的 skill。</p>
            ) : (
              <ul className="overflow-hidden rounded-md border border-border/60">
                {filtered.map((s) => (
                  <SkillRow
                    key={`${s.category ?? ""}/${s.name}`}
                    skill={s}
                    onView={setViewingSkill}
                  />
                ))}
              </ul>
            )}
          </div>
        </ScrollArea>
      </div>
      <SkillViewerDialog
        skill={viewingSkill}
        onClose={() => setViewingSkill(null)}
      />
    </div>
  );
}

function CategoryButton({
  active,
  label,
  count,
  activeCount,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  activeCount: number;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        "h-auto min-h-0 w-full flex-row items-center justify-between gap-2 rounded-none border-0 px-3 py-2 text-left font-normal shadow-none",
        active
          ? "bg-muted text-foreground hover:bg-muted"
          : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
      )}
      onClick={onClick}
    >
      <span className="truncate font-mono text-[11px]">{label}</span>
      <Badge
        variant="outline"
        className="h-4 shrink-0 px-1 text-[9px] leading-none tabular-nums"
        title={`可用 ${activeCount} / 总数 ${count}`}
      >
        {count}
      </Badge>
    </Button>
  );
}
