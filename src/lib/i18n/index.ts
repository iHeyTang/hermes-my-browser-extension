import { useCallback, useEffect, useMemo, useState } from "react";

import { en, type MessageKey, type Messages } from "./en";
import { zhCN } from "./zh-CN";

/**
 * Runtime i18n for the extension UI.
 *
 * Storage and React-hook conventions mirror `~lib/theme.ts`:
 *   - `auto`     → match `navigator.language` (default).
 *   - `en`       → English.
 *   - `zh-CN`    → Simplified Chinese.
 *
 * `useT()` returns a `t(key, params?)` function bound to the active locale.
 * Components re-render automatically when the user picks a new language.
 */

export type LanguagePreference = "auto" | "en" | "zh-CN";
export type ResolvedLanguage = "en" | "zh-CN";

export const LANG_PREF_STORAGE_KEY = "settings.ui.language";
export const DEFAULT_LANGUAGE_PREFERENCE: LanguagePreference = "auto";

const CATALOG: Record<ResolvedLanguage, Messages> = {
  en,
  "zh-CN": zhCN,
};

function normalizeStoredLang(v: unknown): LanguagePreference {
  if (v === "en" || v === "zh-CN" || v === "auto") return v;
  return DEFAULT_LANGUAGE_PREFERENCE;
}

/** Resolve the browser's preferred UI language to one of our catalogs. */
function detectBrowserLanguage(): ResolvedLanguage {
  if (typeof navigator === "undefined") return "en";
  const candidates = [
    ...(navigator.languages ?? []),
    navigator.language,
  ].filter(Boolean);
  for (const raw of candidates) {
    const tag = String(raw).toLowerCase();
    if (tag.startsWith("zh")) return "zh-CN";
    if (tag.startsWith("en")) return "en";
  }
  return "en";
}

export function resolveLanguage(pref: LanguagePreference): ResolvedLanguage {
  if (pref === "en" || pref === "zh-CN") return pref;
  return detectBrowserLanguage();
}

export async function loadLanguagePreference(): Promise<LanguagePreference> {
  try {
    const r = await chrome.storage.local.get([LANG_PREF_STORAGE_KEY]);
    return normalizeStoredLang(r[LANG_PREF_STORAGE_KEY]);
  } catch {
    return DEFAULT_LANGUAGE_PREFERENCE;
  }
}

export async function saveLanguagePreference(
  pref: LanguagePreference,
): Promise<void> {
  await chrome.storage.local.set({ [LANG_PREF_STORAGE_KEY]: pref });
}

export function useStoredLanguagePreference() {
  const [pref, setPref] = useState<LanguagePreference>(
    DEFAULT_LANGUAGE_PREFERENCE,
  );

  useEffect(() => {
    let mounted = true;
    void loadLanguagePreference().then((p) => {
      if (mounted) setPref(p);
    });
    const onChanged = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: chrome.storage.AreaName,
    ) => {
      if (area !== "local") return;
      const c = changes[LANG_PREF_STORAGE_KEY];
      if (!c || c.newValue === undefined) return;
      setPref(normalizeStoredLang(c.newValue));
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      mounted = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  const update = useCallback(async (p: LanguagePreference) => {
    setPref(p);
    await saveLanguagePreference(p);
  }, []);

  return [pref, update] as const;
}

/**
 * Browser language tracker — re-renders when the user changes their browser
 * language while `auto` is selected. Browsers don't always emit a clean event
 * for this, so we just snapshot on mount.
 */
function useBrowserLanguage(): ResolvedLanguage {
  const [lang] = useState<ResolvedLanguage>(() => detectBrowserLanguage());
  return lang;
}

function interpolate(template: string, params?: Record<string, unknown>) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = params[k];
    return v === undefined || v === null ? `{${k}}` : String(v);
  });
}

export type TranslateFn = (
  key: MessageKey,
  params?: Record<string, unknown>,
) => string;

/**
 * Returns the active locale and a memoized `t()` for use in components.
 * Use this in every surface (sidepanel / options / newtab / chat) — it
 * resolves storage + browser language and re-renders on change.
 */
export function useT(): {
  t: TranslateFn;
  language: ResolvedLanguage;
  preference: LanguagePreference;
} {
  const [pref] = useStoredLanguagePreference();
  const browser = useBrowserLanguage();

  const language: ResolvedLanguage =
    pref === "en" || pref === "zh-CN" ? pref : browser;

  const t = useMemo<TranslateFn>(() => {
    const catalog = CATALOG[language] ?? en;
    return (key, params) => {
      const template = catalog[key] ?? en[key] ?? key;
      return interpolate(template, params);
    };
  }, [language]);

  return { t, language, preference: pref };
}

export type { MessageKey } from "./en";
