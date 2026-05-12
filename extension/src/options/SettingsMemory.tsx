import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "~components/ui/button";
import { ScrollArea } from "~components/ui/scroll-area";
import {
  getHermesMemoryList,
  type HermesMemoryEntries,
  type HermesMemoryTarget,
} from "~lib/hermes-memory";
import { cn } from "~lib/utils";

import { OPTIONS_SHELL_HEADER_ROW } from "./optionsPageChrome";

const TARGET_LABELS: Record<HermesMemoryTarget, string> = {
  memory: "MEMORY.md",
  user: "USER.md",
};

const TARGET_DESCS: Record<HermesMemoryTarget, string> = {
  memory:
    "Hermes Agent 的自身观察笔记（环境事实、项目约定、工具特性等）。",
  user: "Hermes Agent 记录的用户偏好与协作习惯。",
};

function usageRatio(entry: HermesMemoryEntries): number {
  if (!entry.char_limit) return 0;
  return Math.min(1, entry.char_count / entry.char_limit);
}

function usageColor(ratio: number): string {
  if (ratio >= 0.9) return "bg-destructive";
  if (ratio >= 0.7) return "bg-amber-500";
  return "bg-primary";
}

function MemoryBlock({ entry }: { entry: HermesMemoryEntries }) {
  const ratio = usageRatio(entry);
  const color = usageColor(ratio);

  return (
    <section className="space-y-3 rounded-md border border-border bg-card p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold tracking-tight">
            {TARGET_LABELS[entry.target]}
          </h3>
          <p className="text-[11px] text-muted-foreground">
            {TARGET_DESCS[entry.target]}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs tabular-nums text-muted-foreground">
            {entry.char_count.toLocaleString()} /{" "}
            {entry.char_limit.toLocaleString()} chars
          </p>
          <p className="text-[10px] text-muted-foreground/70">
            {entry.entries.length} 条
          </p>
        </div>
      </header>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full transition-all", color)}
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </div>

      {entry.path && (
        <p
          className="truncate font-mono text-[10px] text-muted-foreground/70"
          title={entry.path}
        >
          {entry.path}
        </p>
      )}

      {entry.error ? (
        <p className="text-xs text-destructive">{entry.error}</p>
      ) : entry.entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">（暂无记忆条目）</p>
      ) : (
        <ol className="space-y-2">
          {entry.entries.map((text, i) => (
            <li
              key={i}
              className="rounded border border-border/60 bg-muted/30 p-3 text-xs leading-relaxed"
            >
              <div className="mb-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className="rounded bg-muted px-1.5 py-0.5 tabular-nums">
                  #{i + 1}
                </span>
                <span className="tabular-nums">{text.length} chars</span>
              </div>
              <p className="whitespace-pre-wrap break-words">{text}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Read-only view of Hermes curated memory (MEMORY.md + USER.md). */
export function SettingsMemory() {
  const [items, setItems] = useState<HermesMemoryEntries[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const r = await getHermesMemoryList();
    setLoading(false);
    if (!r.ok) {
      setError(r.error || "加载失败");
      setItems([]);
      return;
    }
    setItems(r.targets);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header
        className={`${OPTIONS_SHELL_HEADER_ROW} flex-wrap justify-between gap-3 bg-muted/20 px-4`}
      >
        <div className="flex min-w-0 flex-col justify-center gap-0.5 leading-tight">
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            Memory
          </h2>
          <p
            className="truncate text-[11px] text-muted-foreground"
            title="$HERMES_HOME/memories/{MEMORY,USER}.md"
          >
            Hermes Agent 的持久化记忆（只读浏览）
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

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-6">
          {error && <p className="text-xs text-destructive">{error}</p>}
          {items.map((entry) => (
            <MemoryBlock key={entry.target} entry={entry} />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
