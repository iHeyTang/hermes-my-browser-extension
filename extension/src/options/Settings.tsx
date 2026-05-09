import { useEffect, useState } from "react";

import { Button } from "~components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~components/ui/card";
import { Input } from "~components/ui/input";
import { Label } from "~components/ui/label";
import { cn } from "~lib/utils";
import {
  type ThemePreference,
  useStoredThemePreference,
} from "~lib/theme";

import { DEFAULT_HERMES_API_BASE, DEFAULT_HERMES_MODEL } from "../background/config";

const KEYS = {
  apiBase: "settings.chat.apiBase",
  apiKey: "settings.chat.apiKey",
  model: "settings.chat.model",
};

const THEME_OPTIONS: {
  value: ThemePreference;
  label: string;
  description: string;
}[] = [
  {
    value: "auto",
    label: "Auto",
    description: "Follow the browser's color scheme (recommended).",
  },
  {
    value: "page",
    label: "Match active page",
    description:
      "Side panel only — sample the active tab's background and mirror it. Falls back to Auto for pages we can't inspect (e.g. chrome://).",
  },
  {
    value: "light",
    label: "Light",
    description: "Always use the light palette.",
  },
  {
    value: "dark",
    label: "Dark",
    description: "Always use the dark palette.",
  },
];

export function Settings() {
  const [apiBase, setApiBase] = useState(DEFAULT_HERMES_API_BASE);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(DEFAULT_HERMES_MODEL);
  const [saved, setSaved] = useState(false);
  const [themePref, setThemePref] = useStoredThemePreference();
  const themeDescription = THEME_OPTIONS.find((o) => o.value === themePref)
    ?.description;

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
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-1.5">
            <Label className="shrink-0">Theme</Label>
            <div
              className="flex w-full min-w-0 flex-wrap gap-1 rounded-md border bg-muted/40 p-1"
              role="radiogroup"
              aria-label="Theme"
            >
              {THEME_OPTIONS.map((opt) => {
                const active = themePref === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => void setThemePref(opt.value)}
                    className={cn(
                      "rounded px-3 py-1 text-xs font-medium transition-colors",
                      active
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            {themeDescription && (
              <p className="text-xs text-muted-foreground">
                {themeDescription}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Hermes chat (side panel)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="apiBase">API base URL</Label>
            <Input
              id="apiBase"
              value={apiBase}
              onChange={(e) => setApiBase(e.target.value)}
              placeholder={DEFAULT_HERMES_API_BASE}
            />
            <p className="text-xs text-muted-foreground">
              The Hermes gateway exposes an OpenAI-compatible endpoint. Default
              port 8642.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="model">Model</Label>
            <Input
              id="model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={DEFAULT_HERMES_MODEL}
            />
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
            Multiple chat sessions are managed from the side panel sidebar
            (the <span className="font-medium text-foreground">Sessions</span>{" "}
            button at the top). Each session keeps its own history and is
            sent to the gateway as{" "}
            <code className="font-mono">X-Hermes-Session-Id</code>.
          </p>
          <div className="flex items-center gap-2">
            <Button onClick={save}>Save</Button>
            {saved && (
              <span className="text-xs text-[hsl(var(--success))]">Saved.</span>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Bridge</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div>
            WebSocket bridge URL is fixed at{" "}
            <code className="font-mono">ws://127.0.0.1:9393</code>. Override
            via the <code className="font-mono">MY_BROWSER_BRIDGE_PORT</code>{" "}
            env on the Hermes side and rebuild this extension if you need a
            different port.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
