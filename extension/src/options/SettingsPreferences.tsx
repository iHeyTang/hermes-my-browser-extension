import { useEffect, useState } from "react";

import { Input } from "~components/ui/input";
import { Label } from "~components/ui/label";
import { Switch } from "~components/ui/switch";
import {
  type LanguagePreference,
  useStoredLanguagePreference,
  useT,
} from "~lib/i18n";
import {
  type ThemePreference,
  useStoredThemePreference,
} from "~lib/theme";
import { cn } from "~lib/utils";

const SHOW_STREAM_DETAILS_KEY = "settings.sidepanel.showStreamDetails";
const NEWTAB_ENABLED_KEY = "settings.newtab.enabled";
const NEWTAB_FALLBACK_KEY = "settings.newtab.fallbackUrl";

/** Extension UI preferences (theme, language, etc.) — not gateway or Hermes CLI. */
export function SettingsPreferences() {
  const { t } = useT();
  const [themePref, setThemePref] = useStoredThemePreference();
  const [langPref, setLangPref] = useStoredLanguagePreference();
  const [showStreamDetails, setShowStreamDetails] = useState(false);
  // Mirrors `NEWTAB_DEFAULT_ENABLED` in src/newtab/index.tsx — both files
  // need the same default so a fresh install shows the same state in the
  // toggle and the actual newtab page.
  const [newtabEnabled, setNewtabEnabled] = useState(true);
  const [newtabFallback, setNewtabFallback] = useState("");

  const themeOptions: { value: ThemePreference; label: string; description: string }[] =
    [
      {
        value: "auto",
        label: t("options.preference.theme.auto"),
        description: t("options.preference.theme.auto.desc"),
      },
      {
        value: "light",
        label: t("options.preference.theme.light"),
        description: t("options.preference.theme.light.desc"),
      },
      {
        value: "dark",
        label: t("options.preference.theme.dark"),
        description: t("options.preference.theme.dark.desc"),
      },
    ];

  const languageOptions: {
    value: LanguagePreference;
    label: string;
    description: string;
  }[] = [
    {
      value: "auto",
      label: t("options.preference.language.auto"),
      description: t("options.preference.language.auto.desc"),
    },
    {
      value: "en",
      label: t("options.preference.language.en"),
      description: t("options.preference.language.en.desc"),
    },
    {
      value: "zh-CN",
      label: t("options.preference.language.zh-CN"),
      description: t("options.preference.language.zh-CN.desc"),
    },
  ];

  const themeDescription = themeOptions.find((o) => o.value === themePref)
    ?.description;
  const languageDescription = languageOptions.find((o) => o.value === langPref)
    ?.description;

  useEffect(() => {
    let cancelled = false;
    void chrome.storage.local
      .get([SHOW_STREAM_DETAILS_KEY, NEWTAB_ENABLED_KEY, NEWTAB_FALLBACK_KEY])
      .then((r) => {
        if (cancelled) return;
        const stream = r[SHOW_STREAM_DETAILS_KEY];
        if (typeof stream === "boolean") setShowStreamDetails(stream);
        const ntEnabled = r[NEWTAB_ENABLED_KEY];
        if (typeof ntEnabled === "boolean") setNewtabEnabled(ntEnabled);
        const ntFallback = r[NEWTAB_FALLBACK_KEY];
        if (typeof ntFallback === "string") setNewtabFallback(ntFallback);
      });
    // Watch all three keys so external writes (e.g. a future debug command
    // flipping the toggle from a script) stay in sync with the visible
    // controls. Matches the pattern used by the existing showStreamDetails
    // pref before this section grew.
    const listener: Parameters<
      typeof chrome.storage.onChanged.addListener
    >[0] = (changes, area) => {
      if (area !== "local") return;
      const stream = changes[SHOW_STREAM_DETAILS_KEY];
      if (stream && typeof stream.newValue === "boolean") {
        setShowStreamDetails(stream.newValue);
      }
      const ntEnabled = changes[NEWTAB_ENABLED_KEY];
      if (ntEnabled && typeof ntEnabled.newValue === "boolean") {
        setNewtabEnabled(ntEnabled.newValue);
      }
      const ntFallback = changes[NEWTAB_FALLBACK_KEY];
      if (ntFallback && typeof ntFallback.newValue === "string") {
        setNewtabFallback(ntFallback.newValue);
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
          <Label className="shrink-0">{t("options.preference.language")}</Label>
          <div
            className="inline-flex w-fit max-w-full flex-wrap gap-1 rounded-md bg-muted/40 p-1"
            role="radiogroup"
            aria-label={t("options.preference.language")}
          >
            {languageOptions.map((opt) => {
              const active = langPref === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => void setLangPref(opt.value)}
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
          {languageDescription && (
            <p className="text-xs text-muted-foreground">{languageDescription}</p>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-col gap-1.5">
          <Label className="shrink-0">{t("options.preference.theme")}</Label>
          <div
            className="inline-flex w-fit max-w-full flex-wrap gap-1 rounded-md bg-muted/40 p-1"
            role="radiogroup"
            aria-label={t("options.preference.theme")}
          >
            {themeOptions.map((opt) => {
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
            {t("options.preference.stream.label")}
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
              {t("options.preference.stream.desc")}
            </p>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="prefs-newtab-enabled" className="shrink-0">
            {t("options.preference.newtab.label")}
          </Label>
          <div className="flex items-center gap-3">
            <Switch
              id="prefs-newtab-enabled"
              checked={newtabEnabled}
              onCheckedChange={(next) => {
                setNewtabEnabled(next);
                void chrome.storage.local.set({
                  [NEWTAB_ENABLED_KEY]: next,
                });
              }}
            />
            <p className="text-xs text-muted-foreground">
              {t("options.preference.newtab.desc")}
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label
            htmlFor="prefs-newtab-fallback"
            className={cn(
              "shrink-0 text-xs",
              newtabEnabled && "text-muted-foreground/60",
            )}
          >
            {t("options.preference.newtab.fallback")}
          </Label>
          <Input
            id="prefs-newtab-fallback"
            value={newtabFallback}
            onChange={(e) => {
              const next = e.target.value;
              setNewtabFallback(next);
              void chrome.storage.local.set({
                [NEWTAB_FALLBACK_KEY]: next,
              });
            }}
            placeholder={t("options.preference.newtab.fallback.placeholder")}
            className="font-mono text-xs"
            disabled={newtabEnabled}
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-[11px] text-muted-foreground">
            {t("options.preference.newtab.fallback.desc")}
          </p>
        </div>
      </section>
    </div>
  );
}
