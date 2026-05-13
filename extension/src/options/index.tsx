import {
  Bot,
  BrainCircuit,
  Clock,
  Code2,
  FilePlus2,
  Globe,
  Palette,
  RadioTower,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import "~style.css";

import { Button } from "~components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~components/ui/dialog";
import { HermesLogo } from "~components/hermes-logo";
import { Input } from "~components/ui/input";
import { Label } from "~components/ui/label";
import { ScrollArea } from "~components/ui/scroll-area";
import { Separator } from "~components/ui/separator";

import { useResolvedTheme } from "~lib/theme";
import type { UserScript } from "~lib/types";

import { HermesModelConfigTab } from "./HermesModelConfigTab";
import { ScriptEditor } from "./ScriptEditor";
import { ScriptList } from "./ScriptList";
import { OPTIONS_SHELL_HEADER_ROW } from "./optionsPageChrome";
import { SettingsCron } from "./SettingsCron";
import { SettingsGateway } from "./SettingsGateway";
import { SettingsMemory } from "./SettingsMemory";
import { SettingsPreferences } from "./SettingsPreferences";
import { SettingsSkills } from "./SettingsSkills";

interface ListResp {
  ok: boolean;
  scripts?: UserScript[];
}

interface DetailResp {
  ok: boolean;
  script?: UserScript;
  error?: string;
}

/**
 * Sidebar order (two groups):
 *   Extension:  Preference → Userscripts
 *   Hermes:     Gateway → Models → Skills → Memory → Cron
 *
 * Within the Hermes group, items go static → dynamic: Gateway (connection),
 * Models (which LLM), Skills (capabilities), Memory (state), Cron (scheduled
 * actions on top of all of the above).
 */
const OPTIONS_MAIN_TABS = [
  "preference",
  "scripts",
  "gateway",
  "models",
  "skills",
  "memory",
  "cron",
] as const;
type MainTab = (typeof OPTIONS_MAIN_TABS)[number];

const TAB_SET = new Set<string>(OPTIONS_MAIN_TABS);

function mainTabFromLocation(): MainTab {
  const raw =
    typeof window !== "undefined"
      ? window.location.hash.replace(/^#/, "").split("?")[0]
      : "";
  if (raw && TAB_SET.has(raw)) {
    return raw as MainTab;
  }
  if (raw === "settings") {
    return "preference";
  }
  if (raw === "hermes-model") {
    return "models";
  }
  return "scripts";
}

export default function Options() {
  useResolvedTheme();

  const [mainTab, setMainTab] = useState<MainTab>(() => mainTabFromLocation());

  const [scripts, setScripts] = useState<UserScript[]>([]);
  const [editing, setEditing] = useState<UserScript | null>(null);
  const [creating, setCreating] = useState(false);
  const [installUrl, setInstallUrl] = useState("");
  const [installOpen, setInstallOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = (await chrome.runtime.sendMessage({
      action: "userscript.list",
    })) as ListResp;
    if (r?.ok && Array.isArray(r.scripts)) setScripts(r.scripts);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onHash = () => setMainTab(mainTabFromLocation());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  function onMainTabChange(v: string) {
    const next = TAB_SET.has(v) ? (v as MainTab) : "scripts";
    setMainTab(next);
    const base = window.location.pathname + window.location.search;
    if (next === "scripts") {
      window.history.replaceState(null, "", base);
    } else {
      window.history.replaceState(null, "", `${base}#${next}`);
    }
  }

  async function onToggle(id: string, enabled: boolean) {
    await chrome.runtime.sendMessage({
      action: "userscript.setEnabled",
      id,
      enabled,
    });
    void refresh();
  }

  async function onRemove(id: string) {
    if (!confirm("Remove this userscript? This action can't be undone.")) return;
    await chrome.runtime.sendMessage({ action: "userscript.remove", id });
    void refresh();
  }

  async function onEdit(id: string) {
    const s = scripts.find((x) => x.id === id);
    if (!s) return;
    setEditing(s);
  }

  async function onSaveEdit(source: string) {
    if (!editing) return;
    setBusy(true);
    try {
      const r = (await chrome.runtime.sendMessage({
        action: "userscript.save",
        id: editing.id,
        source,
      })) as DetailResp;
      if (!r?.ok) throw new Error(r?.error || "save failed");
      setEditing(null);
      void refresh();
    } finally {
      setBusy(false);
    }
  }

  async function onCreateNew(source: string) {
    setBusy(true);
    setError(null);
    try {
      const r = (await chrome.runtime.sendMessage({
        action: "userscript.installFromSource",
        source,
        enabled: true,
      })) as DetailResp;
      if (!r?.ok) throw new Error(r?.error || "create failed");
      setCreating(false);
      void refresh();
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function onInstallFromUrl() {
    if (!installUrl.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = (await chrome.runtime.sendMessage({
        action: "userscript.installFromUrl",
        url: installUrl.trim(),
        enabled: true,
      })) as DetailResp;
      if (!r?.ok) throw new Error(r?.error || "install failed");
      setInstallOpen(false);
      setInstallUrl("");
      void refresh();
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen min-h-0 w-full bg-background text-foreground">
      <aside className="flex min-h-0 w-56 shrink-0 flex-col border-r border-border bg-muted/25">
        <div
          className={`${OPTIONS_SHELL_HEADER_ROW} gap-2.5 bg-muted/20 px-3`}
        >
          <HermesLogo size={32} className="shrink-0" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight">
              Hermes
            </p>
            <p className="text-[10px] text-muted-foreground">Extension console</p>
          </div>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <nav className="flex flex-col gap-0.5 p-2">
            <Button
              type="button"
              variant={mainTab === "preference" ? "secondary" : "ghost"}
              className="w-full justify-start gap-2 font-normal"
              onClick={() => onMainTabChange("preference")}
            >
              <Palette className="h-4 w-4 shrink-0 opacity-70" />
              Preference
            </Button>
            <Button
              type="button"
              variant={mainTab === "scripts" ? "secondary" : "ghost"}
              className="w-full justify-start gap-2 font-normal"
              onClick={() => onMainTabChange("scripts")}
            >
              <Code2 className="h-4 w-4 shrink-0 opacity-70" />
              Userscripts
            </Button>
            <Separator className="my-1.5" />
            <Button
              type="button"
              variant={mainTab === "gateway" ? "secondary" : "ghost"}
              className="w-full justify-start gap-2 font-normal"
              onClick={() => onMainTabChange("gateway")}
            >
              <RadioTower className="h-4 w-4 shrink-0 opacity-70" />
              Gateway
            </Button>
            <Button
              type="button"
              variant={mainTab === "models" ? "secondary" : "ghost"}
              className="w-full justify-start gap-2 font-normal"
              onClick={() => onMainTabChange("models")}
            >
              <Bot className="h-4 w-4 shrink-0 opacity-70" />
              Models
            </Button>
            <Button
              type="button"
              variant={mainTab === "skills" ? "secondary" : "ghost"}
              className="w-full justify-start gap-2 font-normal"
              onClick={() => onMainTabChange("skills")}
            >
              <Sparkles className="h-4 w-4 shrink-0 opacity-70" />
              Skills
            </Button>
            <Button
              type="button"
              variant={mainTab === "memory" ? "secondary" : "ghost"}
              className="w-full justify-start gap-2 font-normal"
              onClick={() => onMainTabChange("memory")}
            >
              <BrainCircuit className="h-4 w-4 shrink-0 opacity-70" />
              Memory
            </Button>
            <Button
              type="button"
              variant={mainTab === "cron" ? "secondary" : "ghost"}
              className="w-full justify-start gap-2 font-normal"
              onClick={() => onMainTabChange("cron")}
            >
              <Clock className="h-4 w-4 shrink-0 opacity-70" />
              Cron
            </Button>
          </nav>
        </ScrollArea>
        <div className="border-t border-border px-3 py-2">
          <p className="text-[10px] text-muted-foreground/80">v0.3.0</p>
        </div>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {mainTab === "models" ? (
          <HermesModelConfigTab />
        ) : mainTab === "memory" ? (
          <SettingsMemory />
        ) : mainTab === "skills" ? (
          <SettingsSkills />
        ) : mainTab === "cron" ? (
          <SettingsCron />
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {mainTab === "scripts" ? (
              <>
                <header
                  className={`${OPTIONS_SHELL_HEADER_ROW} bg-muted/20 px-4`}
                >
                  <div className="flex min-w-0 flex-col justify-center gap-0.5 leading-tight">
                    <h2 className="text-sm font-semibold tracking-tight">
                      Userscripts
                    </h2>
                    <p className="truncate text-[11px] text-muted-foreground">
                      Create, install, and manage userscripts
                    </p>
                  </div>
                </header>
                <ScrollArea className="min-h-0 flex-1">
                  <div className="space-y-4 p-6">
                    <div className="flex flex-wrap items-center gap-2">
                      <Button onClick={() => setCreating(true)} disabled={busy}>
                        <FilePlus2 className="mr-1" />
                        New script
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => setInstallOpen(true)}
                        disabled={busy}
                      >
                        <Globe className="mr-1" />
                        Install from URL
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => void refresh()}
                        disabled={busy}
                      >
                        <RefreshCw className="mr-1" />
                        Refresh
                      </Button>
                      {error && (
                        <span className="text-xs text-destructive">{error}</span>
                      )}
                    </div>

                    {editing ? (
                      <ScriptEditor
                        title={`Edit: ${editing.meta.name}`}
                        initialSource={editing.source}
                        onSave={onSaveEdit}
                        onCancel={() => setEditing(null)}
                        busy={busy}
                      />
                    ) : creating ? (
                      <ScriptEditor
                        title="New userscript"
                        initialSource=""
                        onSave={onCreateNew}
                        onCancel={() => setCreating(false)}
                        busy={busy}
                      />
                    ) : (
                      <ScriptList
                        scripts={scripts.map((s) => ({
                          id: s.id,
                          meta: {
                            name: s.meta.name,
                            version: s.meta.version,
                            match: s.meta.match,
                            runAt: s.meta.runAt,
                          },
                          enabled: s.enabled,
                          updatedAt: s.updatedAt,
                          lastError: s.lastError,
                        }))}
                        onEdit={(id) => void onEdit(id)}
                        onRemove={(id) => void onRemove(id)}
                        onToggle={(id, enabled) => void onToggle(id, enabled)}
                      />
                    )}
                  </div>
                </ScrollArea>
              </>
            ) : mainTab === "preference" ? (
              <>
                <header
                  className={`${OPTIONS_SHELL_HEADER_ROW} bg-muted/20 px-4`}
                >
                  <div className="flex min-w-0 flex-col justify-center gap-0.5 leading-tight">
                    <h2 className="text-sm font-semibold tracking-tight">
                      Preference
                    </h2>
                    <p className="truncate text-[11px] text-muted-foreground">
                      Extension UI and behavior (unrelated to Gateway / Models)
                    </p>
                  </div>
                </header>
                <ScrollArea className="min-h-0 flex-1">
                  <div className="p-6">
                    <SettingsPreferences />
                  </div>
                </ScrollArea>
              </>
            ) : (
              <>
                <header
                  className={`${OPTIONS_SHELL_HEADER_ROW} bg-muted/20 px-4`}
                >
                  <div className="flex min-w-0 flex-col justify-center gap-0.5 leading-tight">
                    <h2 className="text-sm font-semibold tracking-tight">
                      Gateway
                    </h2>
                    <p
                      className="truncate text-[11px] text-muted-foreground"
                      title="Side panel chat → hermes-agent-gateway (OpenAI-compatible HTTP)"
                    >
                      Side panel chat → hermes-agent-gateway
                    </p>
                  </div>
                </header>
                <ScrollArea className="min-h-0 flex-1">
                  <div className="p-6">
                    <SettingsGateway />
                  </div>
                </ScrollArea>
              </>
            )}
          </div>
        )}
      </main>

      <Dialog open={installOpen} onOpenChange={setInstallOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Install userscript from URL</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="installUrl">Script URL</Label>
            <Input
              id="installUrl"
              value={installUrl}
              onChange={(e) => setInstallUrl(e.target.value)}
              placeholder="https://example.com/some-userscript.user.js"
            />
            {error && (
              <p className="text-xs text-destructive">{error}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setInstallOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button onClick={() => void onInstallFromUrl()} disabled={busy}>
              {busy ? "Installing…" : "Install"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
