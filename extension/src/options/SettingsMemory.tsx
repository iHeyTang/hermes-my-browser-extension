import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "~components/ui/button";
import { ScrollArea } from "~components/ui/scroll-area";
import {
  getHermesMemoryList,
  type HermesMemoryEntries,
  type HermesMemoryTarget,
} from "~lib/hermes-memory";
import { useT, type TranslateFn } from "~lib/i18n";
import { cn } from "~lib/utils";

import { OPTIONS_SHELL_HEADER_ROW } from "./optionsPageChrome";

function targetLabel(t: TranslateFn, target: HermesMemoryTarget): string {
  return target === "user"
    ? t("options.memory.target.user")
    : t("options.memory.target.memory");
}

function targetDesc(t: TranslateFn, target: HermesMemoryTarget): string {
  return target === "user"
    ? t("options.memory.desc.user")
    : t("options.memory.desc.memory");
}

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
  const { t } = useT();
  const ratio = usageRatio(entry);
  const color = usageColor(ratio);

  return (
    <section className="space-y-3 rounded-md border border-border bg-card p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold tracking-tight">
            {targetLabel(t, entry.target)}
          </h3>
          <p className="text-[11px] text-muted-foreground">
            {targetDesc(t, entry.target)}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs tabular-nums text-muted-foreground">
            {t("options.memory.chars", {
              count: entry.char_count.toLocaleString(),
              limit: entry.char_limit.toLocaleString(),
            })}
          </p>
          <p className="text-[10px] text-muted-foreground/70">
            {t("options.memory.entries", { count: entry.entries.length })}
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
        <p className="text-xs text-muted-foreground">
          {t("options.memory.empty")}
        </p>
      ) : (
        <ol className="space-y-2">
          {entry.entries.map((rec, i) => (
            <li
              key={i}
              className={cn(
                "rounded border p-3 text-xs leading-relaxed",
                rec.flagged
                  ? "border-destructive/40 bg-destructive/[0.04]"
                  : "border-border/60 bg-muted/30",
              )}
            >
              <div className="mb-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                <span className="rounded bg-muted px-1.5 py-0.5 tabular-nums">
                  #{i + 1}
                </span>
                <span className="tabular-nums">
                  {t("options.memory.charsLen", { count: rec.text.length })}
                </span>
                {rec.flagged && (
                  <span
                    title={t("options.memory.flagTooltip", {
                      flag: rec.flagged,
                    })}
                    className="rounded bg-destructive/15 px-1.5 py-0.5 font-medium text-destructive"
                  >
                    ⚠ {rec.flagged}
                  </span>
                )}
              </div>
              <p className="whitespace-pre-wrap break-words">{rec.text}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Read-only view of Hermes curated memory (MEMORY.md + USER.md). */
export function SettingsMemory() {
  const { t } = useT();
  const [items, setItems] = useState<HermesMemoryEntries[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const r = await getHermesMemoryList();
    setLoading(false);
    if (!r.ok) {
      setError(r.error || t("options.memory.failedToLoad"));
      setItems([]);
      return;
    }
    setItems(r.targets);
  }, [t]);

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
            {t("options.memory.title")}
          </h2>
          <p
            className="truncate text-[11px] text-muted-foreground"
            title={t("options.memory.subtitle.tooltip")}
          >
            {t("options.memory.subtitle")}
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
          {t("options.memory.refresh")}
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
