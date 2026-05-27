import { useEffect, useState, type ReactNode } from "react";

import { Label } from "~components/ui/label";
import { Switch } from "~components/ui/switch";
import { Input } from "~components/ui/input";
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
import {
  type ThemePreference,
  useStoredThemePreference,
} from "~lib/theme";
import { cn } from "~lib/utils";

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

const SHOW_STREAM_DETAILS_KEY = "settings.chat.showStreamDetails";
const NEWTAB_WALLPAPER_KEY = "settings.newtab.wallpaper.enabled";

/** Extension UI preferences (theme, language, etc.) — not gateway or Hermes CLI. */
export function SettingsPreferences() {
  const { t } = useT();
  const [themePref, setThemePref] = useStoredThemePreference();
  const [langPref, setLangPref] = useStoredLanguagePreference();
  const [showStreamDetails, setShowStreamDetails] = useState(false);
  // Default `true` matches the new-tab page's runtime default (see
  // `useWallpaper`).
  const [wallpaperEnabled, setWallpaperEnabled] = useState(true);

  const languageOptions: { value: LanguagePreference; label: string }[] = [
    { value: "auto", label: t("options.preference.language.auto") },
    { value: "en", label: t("options.preference.language.en") },
    { value: "zh-CN", label: t("options.preference.language.zh-CN") },
  ];

  const themeOptions: { value: ThemePreference; label: string }[] = [
    { value: "auto", label: t("options.preference.theme.auto") },
    { value: "light", label: t("options.preference.theme.light") },
    { value: "dark", label: t("options.preference.theme.dark") },
  ];

  useEffect(() => {
    let cancelled = false;
    void chrome.storage.local
      .get([SHOW_STREAM_DETAILS_KEY, NEWTAB_WALLPAPER_KEY])
      .then((r) => {
        if (cancelled) return;
        const stream = r[SHOW_STREAM_DETAILS_KEY];
        if (typeof stream === "boolean") setShowStreamDetails(stream);
        const wp = r[NEWTAB_WALLPAPER_KEY];
        if (typeof wp === "boolean") setWallpaperEnabled(wp);
      });
    const listener: Parameters<
      typeof chrome.storage.onChanged.addListener
    >[0] = (changes, area) => {
      if (area !== "local") return;
      const stream = changes[SHOW_STREAM_DETAILS_KEY];
      if (stream && typeof stream.newValue === "boolean") {
        setShowStreamDetails(stream.newValue);
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
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <Section title={t("options.preference.section.appearance")}>
        <SegmentedRow
          label={t("options.preference.language")}
          ariaLabel={t("options.preference.language")}
          value={langPref}
          options={languageOptions}
          onChange={(v) => void setLangPref(v)}
        />
        <SegmentedRow
          label={t("options.preference.theme")}
          ariaLabel={t("options.preference.theme")}
          value={themePref}
          options={themeOptions}
          onChange={(v) => void setThemePref(v)}
        />
      </Section>

      <Section title={t("options.preference.section.newtab")}>
        <SwitchRow
          id="prefs-newtab-wallpaper"
          label={t("options.preference.newtab.wallpaper.label")}
          checked={wallpaperEnabled}
          onChange={(next) => {
            setWallpaperEnabled(next);
            void chrome.storage.local.set({ [NEWTAB_WALLPAPER_KEY]: next });
          }}
        />
      </Section>

      <Section title={t("options.preference.section.chat")}>
        <SwitchRow
          id="prefs-show-stream-details"
          label={t("options.preference.stream.label")}
          hint={t("options.preference.stream.desc")}
          checked={showStreamDetails}
          onChange={(next) => {
            setShowStreamDetails(next);
            void chrome.storage.local.set({
              [SHOW_STREAM_DETAILS_KEY]: next,
            });
          }}
        />
      </Section>

      <QuickActionsSection />
    </div>
  );
}

/* ---------- shared layout primitives ---------- */

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3 border-b border-border/40 pb-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h3>
        {hint && (
          <p className="truncate text-[11px] text-muted-foreground/80">
            {hint}
          </p>
        )}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function SwitchRow({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-1">
      <div className="min-w-0 flex-1">
        <Label
          htmlFor={id}
          className={cn(
            "text-sm font-normal",
            disabled && "text-muted-foreground/60",
          )}
        >
          {label}
        </Label>
        {hint && (
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            {hint}
          </p>
        )}
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </div>
  );
}

function SegmentedRow<T extends string>({
  label,
  ariaLabel,
  value,
  options,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <Label className="text-sm font-normal">{label}</Label>
      <div
        className="inline-flex gap-0.5 rounded-md bg-muted/40 p-0.5"
        role="radiogroup"
        aria-label={ariaLabel}
      >
        {options.map((opt) => {
          const active = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(opt.value)}
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
    </div>
  );
}

/* ---------- quick actions ---------- */

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
    <Section
      title={t("options.preference.quickActions.label")}
      hint={t("options.preference.quickActions.desc")}
    >
      <div className="space-y-2">
        <p className="text-[11px] font-medium text-muted-foreground">
          {t("options.preference.quickActions.builtins")}
        </p>
        <ul className="divide-y divide-border/40 rounded-md border border-border/50">
          {BUILTIN_IDS.map((id) => {
            const enabled = !disabledBuiltins.has(id);
            return (
              <li
                key={id}
                className="flex items-center justify-between gap-3 px-3 py-2"
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
          <p className="text-[11px] font-medium text-muted-foreground">
            {t("options.preference.quickActions.custom")}
          </p>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void resetToDefaults()}
              className="rounded px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
          <p className="rounded-md border border-dashed border-border/50 px-3 py-3 text-center text-[11px] text-muted-foreground">
            {t("options.preference.quickActions.empty")}
          </p>
        )}

        {(config.custom.length > 0 || draftId === "__new__") && (
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
                  className="flex items-start justify-between gap-3 rounded-md border border-border/50 px-3 py-2"
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
        )}
      </div>
    </Section>
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
