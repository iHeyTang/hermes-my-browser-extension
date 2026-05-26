import { useEffect, useState } from "react";

/**
 * Theme handling for Hermes UI surfaces.
 *
 * The extension never paints custom backgrounds — every panel inherits the
 * shadcn HSL tokens defined in `style.css`, which flip between a light and
 * dark palette. This module decides which palette to apply.
 *
 * Preferences:
 *   - `auto`  → follow the browser / OS `prefers-color-scheme` (default).
 *   - `light` / `dark` → user-pinned override.
 *
 * Legacy `page` (follow active tab) is read as `auto` and overwritten in storage.
 */

export type ThemePreference = "auto" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_PREF_STORAGE_KEY = "settings.ui.theme";
export const DEFAULT_THEME_PREFERENCE: ThemePreference = "auto";

function normalizeStoredTheme(v: unknown): ThemePreference {
  if (v === "light" || v === "dark" || v === "auto") return v;
  if (v === "page") return "auto";
  return DEFAULT_THEME_PREFERENCE;
}

export async function loadThemePreference(): Promise<ThemePreference> {
  try {
    const r = await chrome.storage.local.get([THEME_PREF_STORAGE_KEY]);
    const v = r[THEME_PREF_STORAGE_KEY];
    const normalized = normalizeStoredTheme(v);
    if (v === "page") {
      await chrome.storage.local.set({
        [THEME_PREF_STORAGE_KEY]: normalized,
      });
    }
    return normalized;
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

export async function saveThemePreference(pref: ThemePreference): Promise<void> {
  await chrome.storage.local.set({ [THEME_PREF_STORAGE_KEY]: pref });
}

export function useStoredThemePreference() {
  const [pref, setPref] = useState<ThemePreference>(DEFAULT_THEME_PREFERENCE);

  useEffect(() => {
    let mounted = true;
    void loadThemePreference().then((p) => {
      if (mounted) setPref(p);
    });
    const onChanged = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: chrome.storage.AreaName,
    ) => {
      if (area !== "local") return;
      const c = changes[THEME_PREF_STORAGE_KEY];
      if (!c || c.newValue === undefined) return;
      const n = normalizeStoredTheme(c.newValue);
      setPref(n);
      if (c.newValue === "page") {
        void saveThemePreference("auto");
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      mounted = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  const update = async (p: ThemePreference) => {
    setPref(p);
    await saveThemePreference(p);
  };

  return [pref, update] as const;
}

/** Reactive `prefers-color-scheme` reader. Tracks browser/OS changes. */
export function useBrowserTheme(): ResolvedTheme {
  const [theme, setTheme] = useState<ResolvedTheme>(() => {
    if (typeof window === "undefined" || !window.matchMedia) return "light";
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const m = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setTheme(m.matches ? "dark" : "light");
    m.addEventListener("change", onChange);
    return () => m.removeEventListener("change", onChange);
  }, []);

  return theme;
}

/**
 * Reads the palette currently applied to `<html>` and re-renders whenever
 * it flips. Use this from leaf components (e.g. CodeMirror) that just need
 * to pick a matching theme — the entry point is already responsible for
 * calling {@link useResolvedTheme} to set the class.
 */
export function useDocumentTheme(): ResolvedTheme {
  const read = (): ResolvedTheme => {
    if (typeof document === "undefined") return "light";
    const cl = document.documentElement.classList;
    if (cl.contains("dark")) return "dark";
    if (cl.contains("light")) return "light";
    if (typeof window !== "undefined" && window.matchMedia) {
      return window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
    return "light";
  };

  const [theme, setTheme] = useState<ResolvedTheme>(read);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const update = () => setTheme(read());
    update();

    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    const m =
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : null;
    m?.addEventListener("change", update);

    return () => {
      observer.disconnect();
      m?.removeEventListener("change", update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return theme;
}

function applyThemeClass(theme: ResolvedTheme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("light", theme === "light");
}

/**
 * Resolves the theme to apply for this surface. Side-effect: syncs the
 * `dark` / `light` class on `<html>` so CSS variables update accordingly.
 */
export function useResolvedTheme(): {
  theme: ResolvedTheme;
  preference: ThemePreference;
} {
  const [pref] = useStoredThemePreference();
  const browser = useBrowserTheme();

  const resolved: ResolvedTheme =
    pref === "light" ? "light" : pref === "dark" ? "dark" : browser;

  useEffect(() => {
    applyThemeClass(resolved);
  }, [resolved]);

  return { theme: resolved, preference: pref };
}
