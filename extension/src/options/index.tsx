import { FilePlus2, Globe, RefreshCw } from "lucide-react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~components/ui/tabs";

import { useResolvedTheme } from "~lib/theme";
import type { UserScript } from "~lib/types";

import { ScriptEditor } from "./ScriptEditor";
import { ScriptList } from "./ScriptList";
import { Settings } from "./Settings";

interface ListResp {
  ok: boolean;
  scripts?: UserScript[];
}

interface DetailResp {
  ok: boolean;
  script?: UserScript;
  error?: string;
}

export default function Options() {
  useResolvedTheme();

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
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-4xl p-6">
        <header className="mb-6 flex items-center gap-3">
          <HermesLogo size={36} className="shrink-0" />
          <h1 className="text-xl font-semibold tracking-tight">
            Hermes Browser Extension — Options
          </h1>
          <span className="text-xs text-muted-foreground">v0.3.0</span>
        </header>

        <Tabs defaultValue="scripts">
          <TabsList>
            <TabsTrigger value="scripts">Userscripts</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="scripts" className="mt-4 space-y-4">
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
          </TabsContent>

          <TabsContent value="settings" className="mt-4">
            <Settings />
          </TabsContent>
        </Tabs>
      </div>

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
