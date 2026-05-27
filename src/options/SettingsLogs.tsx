/**
 * Logs tab — tail Hermes Agent log files (agent / errors / gateway) with
 * level + component filters, free-text search, and optional 5s auto-poll.
 *
 * Mirrors upstream dashboard's LogsPage but uses the extension's own
 * components (no @nous-research/ui in extension scope). Pulls data from
 * the local backplane's ``/hermes/logs`` route.
 */

import { FileText, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "~components/ui/badge";
import { Button } from "~components/ui/button";
import { Input } from "~components/ui/input";
import { Label } from "~components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~components/ui/select";
import { Switch } from "~components/ui/switch";

import {
  getHermesLogs,
  type HermesLogFile,
  type HermesLogLevel,
} from "~lib/hermes-logs";
import { useT, type TranslateFn } from "~lib/i18n";
import { cn } from "~lib/utils";

import { OPTIONS_SHELL_HEADER_ROW } from "./optionsPageChrome";

const FILES: readonly HermesLogFile[] = ["agent", "errors", "gateway"] as const;
const LEVELS: readonly HermesLogLevel[] = [
  "ALL",
  "DEBUG",
  "INFO",
  "WARNING",
  "ERROR",
] as const;
const COMPONENTS = ["all", "gateway", "agent", "tools", "cli", "cron"] as const;
const LINE_COUNTS = [50, 100, 200, 500] as const;

const AUTO_REFRESH_MS = 5_000;
const SEARCH_DEBOUNCE_MS = 300;

type LineKind = "error" | "warning" | "info" | "debug";

function classifyLine(line: string): LineKind {
  // Match the level token between spaces — same heuristic upstream uses.
  if (/\s(ERROR|CRITICAL|FATAL)\s/.test(line)) return "error";
  if (/\s(WARNING|WARN)\s/.test(line)) return "warning";
  if (/\sDEBUG\s/.test(line)) return "debug";
  return "info";
}

const LINE_COLORS: Record<LineKind, string> = {
  error: "text-destructive",
  warning: "text-amber-600 dark:text-amber-400",
  info: "text-foreground",
  debug: "text-muted-foreground",
};

function fileLabel(t: TranslateFn, file: HermesLogFile): string {
  switch (file) {
    case "agent":
      return t("options.logs.file.agent");
    case "errors":
      return t("options.logs.file.errors");
    case "gateway":
      return t("options.logs.file.gateway");
  }
}

function componentLabel(
  t: TranslateFn,
  component: (typeof COMPONENTS)[number],
): string {
  switch (component) {
    case "all":
      return t("options.logs.component.all");
    case "gateway":
      return t("options.logs.component.gateway");
    case "agent":
      return t("options.logs.component.agent");
    case "tools":
      return t("options.logs.component.tools");
    case "cli":
      return t("options.logs.component.cli");
    case "cron":
      return t("options.logs.component.cron");
  }
}

export function SettingsLogs() {
  const { t } = useT();
  const [file, setFile] = useState<HermesLogFile>("agent");
  const [level, setLevel] = useState<HermesLogLevel>("ALL");
  const [component, setComponent] =
    useState<(typeof COMPONENTS)[number]>("all");
  const [lineCount, setLineCount] = useState<(typeof LINE_COUNTS)[number]>(100);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);

  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const reqRef = useRef(0);

  // Debounce free-text search so each keystroke doesn't re-fetch.
  useEffect(() => {
    const id = window.setTimeout(
      () => setDebouncedSearch(search.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(id);
  }, [search]);

  const fetchLogs = useCallback(async () => {
    const reqId = ++reqRef.current;
    setLoading(true);
    setError(null);
    const r = await getHermesLogs({
      file,
      lines: lineCount,
      level,
      component,
      search: debouncedSearch || undefined,
    });
    if (reqId !== reqRef.current) return; // newer request superseded us
    setLoading(false);
    if (!r.ok) {
      setError(r.error || t("options.logs.failedToLoad"));
      setLines([]);
      return;
    }
    setLines(r.lines);
    // Pin the view to the tail — the user usually wants the freshest line
    // visible without scrolling. defer to next frame so the DOM has the
    // updated content before we read scrollHeight.
    window.requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
  }, [file, lineCount, level, component, debouncedSearch, t]);

  useEffect(() => {
    void fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(() => void fetchLogs(), AUTO_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [autoRefresh, fetchLogs]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header
        className={`${OPTIONS_SHELL_HEADER_ROW} flex-wrap justify-between gap-3 bg-muted/20 px-4`}
      >
        <div className="flex min-w-0 flex-col justify-center gap-0.5 leading-tight">
          <h2 className="text-sm font-semibold tracking-tight">
            {t("options.logs.title")}
          </h2>
          <p className="truncate text-[11px] text-muted-foreground">
            {t("options.logs.subtitle")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <div className="flex items-center gap-2">
            <Label
              htmlFor="logs-auto-refresh"
              className="cursor-pointer text-[11px] text-muted-foreground"
            >
              {t("options.logs.autoRefresh")}
            </Label>
            <Switch
              id="logs-auto-refresh"
              checked={autoRefresh}
              onCheckedChange={setAutoRefresh}
            />
            {autoRefresh && (
              <Badge variant="success" className="gap-1 text-[10px]">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
                {t("options.logs.live")}
              </Badge>
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 text-xs"
            onClick={() => void fetchLogs()}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {t("options.logs.refresh")}
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <FilterField label={t("options.logs.file.label")}>
              <Select
                value={file}
                onValueChange={(v) => setFile(v as HermesLogFile)}
              >
                <SelectTrigger className="h-8 w-32 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FILES.map((f) => (
                    <SelectItem key={f} value={f} className="text-xs">
                      {fileLabel(t, f)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FilterField>

            <FilterField label={t("options.logs.level.label")}>
              <Select
                value={level}
                onValueChange={(v) => setLevel(v as HermesLogLevel)}
              >
                <SelectTrigger className="h-8 w-28 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LEVELS.map((lv) => (
                    <SelectItem key={lv} value={lv} className="text-xs">
                      {lv}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FilterField>

            <FilterField label={t("options.logs.component.label")}>
              <Select
                value={component}
                onValueChange={(v) =>
                  setComponent(v as (typeof COMPONENTS)[number])
                }
              >
                <SelectTrigger className="h-8 w-32 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMPONENTS.map((c) => (
                    <SelectItem key={c} value={c} className="text-xs">
                      {componentLabel(t, c)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FilterField>

            <FilterField label={t("options.logs.lines.label")}>
              <Select
                value={String(lineCount)}
                onValueChange={(v) =>
                  setLineCount(Number(v) as (typeof LINE_COUNTS)[number])
                }
              >
                <SelectTrigger className="h-8 w-24 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LINE_COUNTS.map((n) => (
                    <SelectItem
                      key={n}
                      value={String(n)}
                      className="text-xs"
                    >
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FilterField>

            <FilterField label={t("options.logs.search.label")} grow>
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("options.logs.search.placeholder")}
                className="h-8 text-xs"
              />
            </FilterField>
          </div>

          <section className="overflow-hidden rounded-md border border-border bg-card">
            <header className="flex items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-2">
              <div className="flex items-center gap-2 text-xs">
                <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="font-mono">{file}.log</span>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                {level !== "ALL" && (
                  <Badge variant="outline" className="text-[10px]">
                    {level}
                  </Badge>
                )}
                {component !== "all" && (
                  <Badge variant="outline" className="text-[10px]">
                    {componentLabel(t, component)}
                  </Badge>
                )}
                <span className="tabular-nums">
                  {t("options.logs.lineCount", { count: lines.length })}
                </span>
              </div>
            </header>

            {error && (
              <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            )}

            <div
              ref={scrollRef}
              className="min-h-[400px] max-h-[calc(100vh-280px)] overflow-auto p-3 font-mono text-[11px] leading-5"
            >
              {lines.length === 0 && !loading && !error && (
                <p className="py-8 text-center text-muted-foreground">
                  {t("options.logs.empty")}
                </p>
              )}
              {lines.map((line, i) => {
                const kind = classifyLine(line);
                return (
                  <div
                    key={i}
                    className={cn(
                      LINE_COLORS[kind],
                      "whitespace-pre-wrap break-words rounded px-1 hover:bg-muted/40",
                    )}
                  >
                    {line}
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function FilterField({
  label,
  children,
  grow,
}: {
  label: string;
  children: React.ReactNode;
  grow?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1",
        grow && "min-w-0 flex-1 basis-48",
      )}
    >
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}
