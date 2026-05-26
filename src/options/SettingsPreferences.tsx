import { useEffect, useState } from "react";

import { Input } from "~components/ui/input";
import { Label } from "~components/ui/label";
import { Switch } from "~components/ui/switch";
import {
  type LanguagePreference,
  useStoredLanguagePreference,
  useT,
} from "~lib/i18n";
import type { MessageKey } from "~lib/i18n";
import {
  BUILTIN_IDS,
  useQuickActionsController,
  type BuiltinId,
  type CustomQuickAction,
} from "~lib/quick-actions";

const BUILTIN_LABEL_I18N: Record<BuiltinId, MessageKey> = {
  translate: "composer.quick.translate.label",
  summarize: "composer.quick.summarize.label",
  polish: "composer.quick.polish.label",
  explain: "composer.quick.explain.label",
};

const BUILTIN_TOOLTIP_I18N: Record<BuiltinId, MessageKey> = {
  translate: "composer.quick.translate.tooltip",
  summarize: "composer.quick.summarize.tooltip",
  polish: "composer.quick.polish.tooltip",
  explain: "composer.quick.explain.tooltip",
};
import {
  type ThemePreference,
  useStoredThemePreference,
} from "~lib/theme";
import { cn } from "~lib/utils";

const SHOW_STREAM_DETAILS_KEY = "settings.sidepanel.showStreamDetails";
const NEWTAB_ENABLED_KEY = "settings.newtab.enabled";
const NEWTAB_FALLBACK_KEY = "settings.newtab.fallbackUrl";
const NEWTAB_WALLPAPER_KEY = "settings.newtab.wallpaper.enabled";

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
  // Default `true` matches the new-tab page's runtime default (see
  // `useWallpaper`). The two need to agree so a fresh install shows the
  // toggle in the same position the page is actually behaving in.
  const [wallpaperEnabled, setWallpaperEnabled] = useState(true);

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
      .get([
        SHOW_STREAM_DETAILS_KEY,
        NEWTAB_ENABLED_KEY,
        NEWTAB_FALLBACK_KEY,
        NEWTAB_WALLPAPER_KEY,
      ])
      .then((r) => {
        if (cancelled) return;
        const stream = r[SHOW_STREAM_DETAILS_KEY];
        if (typeof stream === "boolean") setShowStreamDetails(stream);
        const ntEnabled = r[NEWTAB_ENABLED_KEY];
        if (typeof ntEnabled === "boolean") setNewtabEnabled(ntEnabled);
        const ntFallback = r[NEWTAB_FALLBACK_KEY];
        if (typeof ntFallback === "string") setNewtabFallback(ntFallback);
        const wp = r[NEWTAB_WALLPAPER_KEY];
        if (typeof wp === "boolean") setWallpaperEnabled(wp);
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
      const wp = changes[NEWTAB_WALLPAPER_KEY];
      if (wp && typeof wp.newValue === "boolean") {
        setWallpaperEnabled(wp.newValue);
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

        <div className="flex flex-col gap-2">
          <Label
            htmlFor="prefs-newtab-wallpaper"
            className={cn(
              "shrink-0",
              !newtabEnabled && "text-muted-foreground/60",
            )}
          >
            {t("options.preference.newtab.wallpaper.label")}
          </Label>
          <div className="flex items-center gap-3">
            <Switch
              id="prefs-newtab-wallpaper"
              checked={wallpaperEnabled}
              disabled={!newtabEnabled}
              onCheckedChange={(next) => {
                setWallpaperEnabled(next);
                void chrome.storage.local.set({
                  [NEWTAB_WALLPAPER_KEY]: next,
                });
              }}
            />
            <p className="text-xs text-muted-foreground">
              {t("options.preference.newtab.wallpaper.desc")}
            </p>
          </div>
        </div>
      </section>

      <QuickActionsSection />
    </div>
  );
}

/**
 * Composer quick-actions editor. Lets the user toggle the four builtin
 * chips on/off and add/edit/delete custom prompt templates. Custom rows
 * have an inline editor — saving writes through `useQuickActionsController`,
 * which syncs across the extension via `chrome.storage.onChanged`.
 */
function QuickActionsSection() {
  const { t } = useT();
  const {
    config,
    setBuiltinEnabled,
    addCustom,
    updateCustom,
    removeCustom,
    resetToDefaults,
  } = useQuickActionsController();
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const [draftTooltip, setDraftTooltip] = useState("");
  const [draftTemplate, setDraftTemplate] = useState("");

  function resetDraft() {
    setDraftId(null);
    setDraftLabel("");
    setDraftTooltip("");
    setDraftTemplate("");
  }

  function beginAdd() {
    setDraftId("__new__");
    setDraftLabel("");
    setDraftTooltip("");
    setDraftTemplate("");
  }

  function beginEdit(c: CustomQuickAction) {
    setDraftId(c.id);
    setDraftLabel(c.label);
    setDraftTooltip(c.tooltip ?? "");
    setDraftTemplate(c.template);
  }

  async function saveDraft() {
    const label = draftLabel.trim();
    const template = draftTemplate.trim();
    if (!label || !template) return;
    const tooltip = draftTooltip.trim();
    if (draftId === "__new__") {
      await addCustom({ label, tooltip, template });
    } else if (draftId) {
      await updateCustom(draftId, { label, tooltip, template });
    }
    resetDraft();
  }

  const disabledBuiltins = new Set<BuiltinId>(config.builtinDisabled);
  const isEditing = draftId !== null;

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-1.5">
        <Label className="shrink-0">
          {t("options.preference.quickActions.label")}
        </Label>
        <p className="text-xs text-muted-foreground">
          {t("options.preference.quickActions.desc")}
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t("options.preference.quickActions.builtins")}
        </p>
        <ul className="space-y-1.5">
          {BUILTIN_IDS.map((id) => {
            const enabled = !disabledBuiltins.has(id);
            return (
              <li
                key={id}
                className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-muted/20 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-foreground">
                    {t(BUILTIN_LABEL_I18N[id])}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {t(BUILTIN_TOOLTIP_I18N[id])}
                  </p>
                </div>
                <Switch
                  checked={enabled}
                  onCheckedChange={(next) => {
                    void setBuiltinEnabled(id, next);
                  }}
                />
              </li>
            );
          })}
        </ul>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("options.preference.quickActions.custom")}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void resetToDefaults()}
              className="rounded border border-border/60 bg-background px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {t("options.preference.quickActions.reset")}
            </button>
            <button
              type="button"
              onClick={beginAdd}
              disabled={isEditing}
              className={cn(
                "rounded border px-2 py-0.5 text-[11px] font-medium transition-colors",
                isEditing
                  ? "cursor-not-allowed border-border/40 bg-muted/30 text-muted-foreground/60"
                  : "border-foreground/20 bg-foreground/5 text-foreground hover:bg-foreground/10",
              )}
            >
              {t("options.preference.quickActions.add")}
            </button>
          </div>
        </div>

        {config.custom.length === 0 && draftId !== "__new__" && (
          <p className="text-[11px] text-muted-foreground">
            {t("options.preference.quickActions.empty")}
          </p>
        )}

        <ul className="space-y-2">
          {config.custom.map((c) =>
            draftId === c.id ? (
              <li key={c.id}>
                <QuickActionForm
                  label={draftLabel}
                  tooltip={draftTooltip}
                  template={draftTemplate}
                  onLabelChange={setDraftLabel}
                  onTooltipChange={setDraftTooltip}
                  onTemplateChange={setDraftTemplate}
                  onSave={() => void saveDraft()}
                  onCancel={resetDraft}
                />
              </li>
            ) : (
              <li
                key={c.id}
                className="flex items-start justify-between gap-3 rounded-md border border-border/50 bg-muted/20 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-foreground">
                    {c.label}
                  </p>
                  <p className="line-clamp-2 break-all text-[11px] text-muted-foreground">
                    {c.template}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => beginEdit(c)}
                    disabled={isEditing}
                    className={cn(
                      "rounded px-2 py-0.5 text-[11px] transition-colors",
                      isEditing
                        ? "cursor-not-allowed text-muted-foreground/40"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    {t("options.preference.quickActions.action.edit")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        confirm(
                          t("options.preference.quickActions.delete.confirm"),
                        )
                      ) {
                        void removeCustom(c.id);
                      }
                    }}
                    disabled={isEditing}
                    className={cn(
                      "rounded px-2 py-0.5 text-[11px] transition-colors",
                      isEditing
                        ? "cursor-not-allowed text-muted-foreground/40"
                        : "text-destructive/80 hover:bg-destructive/10 hover:text-destructive",
                    )}
                  >
                    {t("options.preference.quickActions.action.delete")}
                  </button>
                </div>
              </li>
            ),
          )}
          {draftId === "__new__" && (
            <li>
              <QuickActionForm
                label={draftLabel}
                tooltip={draftTooltip}
                template={draftTemplate}
                onLabelChange={setDraftLabel}
                onTooltipChange={setDraftTooltip}
                onTemplateChange={setDraftTemplate}
                onSave={() => void saveDraft()}
                onCancel={resetDraft}
              />
            </li>
          )}
        </ul>
      </div>
    </section>
  );
}

interface QuickActionFormProps {
  label: string;
  tooltip: string;
  template: string;
  onLabelChange: (v: string) => void;
  onTooltipChange: (v: string) => void;
  onTemplateChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

function QuickActionForm({
  label,
  tooltip,
  template,
  onLabelChange,
  onTooltipChange,
  onTemplateChange,
  onSave,
  onCancel,
}: QuickActionFormProps) {
  const { t } = useT();
  const canSave = label.trim().length > 0 && template.trim().length > 0;
  return (
    <div className="space-y-2 rounded-md border border-border/70 bg-background px-3 py-3">
      <div className="flex flex-col gap-1">
        <Label className="text-[11px] text-muted-foreground">
          {t("options.preference.quickActions.field.label")}
        </Label>
        <Input
          value={label}
          onChange={(e) => onLabelChange(e.target.value)}
          placeholder={t(
            "options.preference.quickActions.field.label.placeholder",
          )}
          autoComplete="off"
          spellCheck={false}
          className="h-8 text-xs"
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-[11px] text-muted-foreground">
          {t("options.preference.quickActions.field.tooltip")}
        </Label>
        <Input
          value={tooltip}
          onChange={(e) => onTooltipChange(e.target.value)}
          placeholder={t(
            "options.preference.quickActions.field.tooltip.placeholder",
          )}
          autoComplete="off"
          spellCheck={false}
          className="h-8 text-xs"
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-[11px] text-muted-foreground">
          {t("options.preference.quickActions.field.template")}
        </Label>
        <textarea
          value={template}
          onChange={(e) => onTemplateChange(e.target.value)}
          placeholder={t(
            "options.preference.quickActions.field.template.placeholder",
          )}
          rows={4}
          spellCheck={false}
          className="resize-y rounded-md border border-input bg-background px-2 py-1.5 font-mono text-[11px] leading-snug shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <p className="text-[11px] text-muted-foreground">
          {t("options.preference.quickActions.field.template.help")}
        </p>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {t("options.preference.quickActions.action.cancel")}
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={!canSave}
          className={cn(
            "rounded border px-2 py-0.5 text-[11px] font-medium transition-colors",
            canSave
              ? "border-foreground/20 bg-foreground text-background hover:bg-foreground/85"
              : "cursor-not-allowed border-border/40 bg-muted/30 text-muted-foreground/60",
          )}
        >
          {t("options.preference.quickActions.action.save")}
        </button>
      </div>
    </div>
  );
}
