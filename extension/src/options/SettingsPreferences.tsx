import { useEffect, useState } from "react";

import { Label } from "~components/ui/label";
import { Switch } from "~components/ui/switch";
import { cn } from "~lib/utils";
import {
  type ThemePreference,
  useStoredThemePreference,
} from "~lib/theme";

const THEME_OPTIONS: {
  value: ThemePreference;
  label: string;
  description: string;
}[] = [
  {
    value: "auto",
    label: "跟随浏览器",
    description: "使用浏览器 / 系统的浅色或深色偏好（prefers-color-scheme）。",
  },
  {
    value: "light",
    label: "浅色",
    description: "始终使用浅色界面。",
  },
  {
    value: "dark",
    label: "深色",
    description: "始终使用深色界面。",
  },
];

const SHOW_STREAM_DETAILS_KEY = "settings.sidepanel.showStreamDetails";

/** Extension UI preferences (theme, etc.) — not gateway or Hermes CLI. */
export function SettingsPreferences() {
  const [themePref, setThemePref] = useStoredThemePreference();
  const [showStreamDetails, setShowStreamDetails] = useState(false);
  const themeDescription = THEME_OPTIONS.find((o) => o.value === themePref)
    ?.description;

  useEffect(() => {
    let cancelled = false;
    void chrome.storage.local.get(SHOW_STREAM_DETAILS_KEY).then((r) => {
      if (cancelled) return;
      const v = r[SHOW_STREAM_DETAILS_KEY];
      if (typeof v === "boolean") setShowStreamDetails(v);
    });
    const listener: Parameters<
      typeof chrome.storage.onChanged.addListener
    >[0] = (changes, area) => {
      if (area !== "local") return;
      const ch = changes[SHOW_STREAM_DETAILS_KEY];
      if (ch && typeof ch.newValue === "boolean") {
        setShowStreamDetails(ch.newValue);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  return (
    <div className="space-y-4">
      <section className="space-y-3">
        <div className="flex flex-col gap-1.5">
          <Label className="shrink-0">Theme</Label>
          <div
            className="inline-flex w-fit max-w-full flex-wrap gap-1 rounded-md bg-muted/40 p-1"
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
                      ? "bg-background text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          {themeDescription && (
            <p className="text-xs text-muted-foreground">{themeDescription}</p>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="prefs-show-stream-details" className="shrink-0">
            侧栏流式展示
          </Label>
          <div className="flex items-center gap-3">
            <Switch
              id="prefs-show-stream-details"
              checked={showStreamDetails}
              onCheckedChange={(next) => {
                setShowStreamDetails(next);
                void chrome.storage.local.set({
                  [SHOW_STREAM_DETAILS_KEY]: next,
                });
              }}
            />
            <p className="text-xs text-muted-foreground">
              开启后，在侧栏对话里展示模型返回的工具调用与推理类流式片段（与侧栏内开关同步）。
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
