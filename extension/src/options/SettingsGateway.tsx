import { Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~components/ui/button";
import { Input } from "~components/ui/input";
import { Label } from "~components/ui/label";
import { Separator } from "~components/ui/separator";
import { fetchHermesModelIds } from "~lib/chat/fetch-models";

import { DEFAULT_HERMES_API_BASE, DEFAULT_HERMES_MODEL } from "../background/config";

const KEYS = {
  apiBase: "settings.chat.apiBase",
  apiKey: "settings.chat.apiKey",
  model: "settings.chat.model",
};

/** Side-panel chat → hermes-agent-gateway (OpenAI-compatible HTTP). */
export function SettingsGateway() {
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
    const t = window.setTimeout(() => ac.abort(), 20_000);
    try {
      const r = await fetchHermesModelIds(apiBase, apiKey, ac.signal);
      if (r.ok === false) {
        setModelIds([]);
        setModelsError(r.message);
      } else {
        setModelIds(r.ids);
        if (r.ids.length === 0) {
          setModelsError("Gateway returned no models.");
        } else {
          setModelsError(null);
        }
      }
    } catch (e) {
      setModelIds([]);
      setModelsError(String((e as Error)?.message || e));
    } finally {
      window.clearTimeout(t);
      setModelsLoading(false);
    }
  }

  return (
    <div className="space-y-10">
      <p className="text-xs text-muted-foreground">
        侧边栏对话使用的{" "}
        <span className="font-medium text-foreground">
          hermes-agent-gateway
        </span>{" "}
        （OpenAI 兼容 HTTP）。Hermes CLI 模型与密钥请在{" "}
        <span className="font-medium text-foreground">Models</span> 中配置。
      </p>

      <section className="space-y-3">
        <h3 className="text-sm font-medium text-foreground">
          Side panel chat (gateway HTTP)
        </h3>
        <div className="space-y-1.5">
          <Label htmlFor="apiBase">API base URL</Label>
          <Input
            id="apiBase"
            value={apiBase}
            onChange={(e) => setApiBase(e.target.value)}
            placeholder={DEFAULT_HERMES_API_BASE}
          />
          <p className="text-xs text-muted-foreground">
            仅影响侧边栏直连网关（默认端口 8642）。与 Models 页中的 Hermes
            配置不同。
          </p>
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="model">Chat model id</Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px]"
              disabled={modelsLoading}
              onClick={() => void refreshModels()}
              title="GET /v1/models from the API base above"
            >
              {modelsLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              From gateway
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
          <Label htmlFor="apiKey">API key (optional)</Label>
          <Input
            id="apiKey"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="leave empty if your gateway doesn't require auth"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          多会话在侧边栏{" "}
          <span className="font-medium text-foreground">Sessions</span>{" "}
          中管理；请求会带{" "}
          <code className="font-mono">X-Hermes-Session-Id</code>。
        </p>
        <div className="flex items-center gap-2">
          <Button onClick={() => void save()}>Save</Button>
          {saved && (
            <span className="text-xs text-[hsl(var(--success))]">Saved.</span>
          )}
        </div>
      </section>

      <Separator />

      <section className="space-y-2 text-sm">
        <h3 className="text-sm font-medium text-foreground">Bridge</h3>
        <p className="text-muted-foreground">
          WebSocket 桥接固定为{" "}
          <code className="font-mono text-foreground">ws://127.0.0.1:9393</code>
          。若需改端口，在 Hermes 侧设置{" "}
          <code className="font-mono text-foreground">
            MY_BROWSER_BRIDGE_PORT
          </code>{" "}
          并重新构建扩展。
        </p>
      </section>
    </div>
  );
}
