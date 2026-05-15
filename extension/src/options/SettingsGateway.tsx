import { Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~components/ui/button";
import { Input } from "~components/ui/input";
import { Label } from "~components/ui/label";
import { Separator } from "~components/ui/separator";
import { fetchHermesModelIds } from "~lib/chat/fetch-models";
import { useT } from "~lib/i18n";

import { DEFAULT_HERMES_API_BASE, DEFAULT_HERMES_MODEL } from "../background/config";

const KEYS = {
  apiBase: "settings.chat.apiBase",
  apiKey: "settings.chat.apiKey",
  model: "settings.chat.model",
};

/** Side-panel chat → hermes-agent-gateway (OpenAI-compatible HTTP). */
export function SettingsGateway() {
  const { t } = useT();
  const [apiBase, setApiBase] = useState(DEFAULT_HERMES_API_BASE);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(DEFAULT_HERMES_MODEL);
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void (async () => {
      const r = await chrome.storage.local.get([
        KEYS.apiBase,
        KEYS.apiKey,
        KEYS.model,
      ]);
      if (typeof r[KEYS.apiBase] === "string") setApiBase(r[KEYS.apiBase]);
      if (typeof r[KEYS.apiKey] === "string") setApiKey(r[KEYS.apiKey]);
      if (typeof r[KEYS.model] === "string") setModel(r[KEYS.model]);
    })();
  }, []);

  async function save() {
    await chrome.storage.local.set({
      [KEYS.apiBase]: apiBase.trim() || DEFAULT_HERMES_API_BASE,
      [KEYS.apiKey]: apiKey.trim(),
      [KEYS.model]: model.trim() || DEFAULT_HERMES_MODEL,
    });
    try {
      await chrome.runtime.sendMessage({ action: "chatCors.refresh" });
    } catch {
      /* ignore */
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  async function refreshModels() {
    setModelsLoading(true);
    setModelsError(null);
    const ac = new AbortController();
    const timeoutId = window.setTimeout(() => ac.abort(), 20_000);
    try {
      const r = await fetchHermesModelIds(apiBase, apiKey, ac.signal);
      if (r.ok === false) {
        setModelIds([]);
        setModelsError(r.message);
      } else {
        setModelIds(r.ids);
        if (r.ids.length === 0) {
          setModelsError(t("options.gateway.model.noModels"));
        } else {
          setModelsError(null);
        }
      }
    } catch (e) {
      setModelIds([]);
      setModelsError(String((e as Error)?.message || e));
    } finally {
      window.clearTimeout(timeoutId);
      setModelsLoading(false);
    }
  }

  return (
    <div className="space-y-10">
      <p className="text-xs text-muted-foreground">
        {t("options.gateway.intro.lead")}{" "}
        <span className="font-medium text-foreground">
          {t("options.gateway.intro.gatewayName")}
        </span>{" "}
        {t("options.gateway.intro.protocol")}{" "}
        {t("options.gateway.intro.configureHint")}{" "}
        <span className="font-medium text-foreground">
          {t("options.gateway.intro.modelsTab")}
        </span>{" "}
        {t("options.gateway.intro.tab")}
      </p>

      <section className="space-y-3">
        <h3 className="text-sm font-medium text-foreground">
          {t("options.gateway.section.chat")}
        </h3>
        <div className="space-y-1.5">
          <Label htmlFor="apiBase">{t("options.gateway.apiBase.label")}</Label>
          <Input
            id="apiBase"
            value={apiBase}
            onChange={(e) => setApiBase(e.target.value)}
            placeholder={DEFAULT_HERMES_API_BASE}
          />
          <p className="text-xs text-muted-foreground">
            {t("options.gateway.apiBase.help")}
          </p>
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="model">{t("options.gateway.model.label")}</Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px]"
              disabled={modelsLoading}
              onClick={() => void refreshModels()}
              title={t("options.gateway.model.fromGateway.tooltip")}
            >
              {modelsLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              {t("options.gateway.model.fromGateway")}
            </Button>
          </div>
          <Input
            id="model"
            list="settings-model-datalist"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={DEFAULT_HERMES_MODEL}
            className="font-mono text-xs"
            autoComplete="off"
          />
          <datalist id="settings-model-datalist">
            {modelIds.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
          {modelsError && (
            <p className="text-[11px] text-destructive">{modelsError}</p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="apiKey">{t("options.gateway.apiKey.label")}</Label>
          <Input
            id="apiKey"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={t("options.gateway.apiKey.placeholder")}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {t("options.gateway.sessions.help.before")}{" "}
          <span className="font-medium text-foreground">
            {t("options.gateway.sessions.help.sessions")}
          </span>{" "}
          {t("options.gateway.sessions.help.after")}{" "}
          <code className="font-mono">X-Hermes-Session-Id</code>{" "}
          {t("options.gateway.sessions.help.headerSuffix")}
        </p>
        <div className="flex items-center gap-2">
          <Button onClick={() => void save()}>{t("options.gateway.save")}</Button>
          {saved && (
            <span className="text-xs text-[hsl(var(--success))]">
              {t("options.gateway.saved")}
            </span>
          )}
        </div>
      </section>

      <Separator />

      <section className="space-y-2 text-sm">
        <h3 className="text-sm font-medium text-foreground">
          {t("options.gateway.bridge.title")}
        </h3>
        <p className="text-muted-foreground">
          {t("options.gateway.bridge.fixed.before")}{" "}
          <code className="font-mono text-foreground">ws://127.0.0.1:9393</code>
          {t("options.gateway.bridge.fixed.after")}{" "}
          <code className="font-mono text-foreground">
            MY_BROWSER_BRIDGE_PORT
          </code>{" "}
          {t("options.gateway.bridge.fixed.suffix")}
        </p>
      </section>
    </div>
  );
}
