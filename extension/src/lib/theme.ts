import { useEffect, useState } from "react";

/**
 * Theme handling for Hermes UI surfaces.
 *
 * The extension never paints custom backgrounds — every panel inherits the
 * shadcn HSL tokens defined in `style.css`, which flip between a light and
 * dark palette. This module decides which palette to apply.
 *
 * Preferences:
 *   - `auto`  → follow the browser's `prefers-color-scheme` (default)
 *   - `page`  → mirror the active tab's background (side panel only;
 *               degrades to `auto` when the active tab can't be inspected,
 *               e.g. on chrome:// pages)
 *   - `light` / `dark` → user-pinned override
 */

export type ThemePreference = "auto" | "page" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_PREF_STORAGE_KEY = "settings.ui.theme";
export const DEFAULT_THEME_PREFERENCE: ThemePreference = "auto";

function isThemePref(v: unknown): v is ThemePreference {
  return v === "auto" || v === "page" || v === "light" || v === "dark";
}

export async function loadThemePreference(): Promise<ThemePreference> {
  try {
    const r = await chrome.storage.local.get([THEME_PREF_STORAGE_KEY]);
    const v = r[THEME_PREF_STORAGE_KEY];
    if (isThemePref(v)) return v;
  } catch {
    // ignore — fall through to default
  }
  return DEFAULT_THEME_PREFERENCE;
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
      if (c && isThemePref(c.newValue)) setPref(c.newValue);
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
 * Best-effort detection of the active tab's effective theme by sampling the
 * computed background colour of `<body>` / `<html>`. Returns `null` when the
 * tab can't be scripted (e.g. chrome://, the Web Store, or the side panel
 * itself), so callers should fall back to the browser preference.
 */
export async function detectActiveTabTheme(): Promise<ResolvedTheme | null> {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (!tab?.id || !tab.url) return null;
    if (!/^(https?|file):/i.test(tab.url)) return null;

    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const linearise = (c: number) => {
          const v = c / 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        };
        const luminance = (col: string): number | null => {
          const m = col.match(/-?\d+(\.\d+)?/g);
          if (!m || m.length < 3) return null;
          const alpha = m.length >= 4 ? Number(m[3]) : 1;
          if (alpha < 0.05) return null;
          const [r, g, b] = m.slice(0, 3).map(Number);
          return 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);
        };
        const candidates: Element[] = [];
        if (document.body) candidates.push(document.body);
        if (document.documentElement) candidates.push(document.documentElement);
        for (const el of candidates) {
          const c = getComputedStyle(el).backgroundColor;
          const l = luminance(c);
          if (l != null) return l < 0.5 ? "dark" : "light";
        }
        // Fallback: page-side `prefers-color-scheme`. Pages can override this
        // via <meta name="color-scheme">, so it's a reasonable signal even
        // when the body background is transparent.
        return matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
      },
    });
    const v = res?.result;
    return v === "dark" || v === "light" ? v : null;
  } catch {
    return null;
  }
}

interface UsePageThemeOptions {
  enabled: boolean;
  fallback: ResolvedTheme;
}

/**
 * Tracks the active tab's theme. Re-probes when the active tab changes,
 * navigates, or the focused window changes. Yields `fallback` while the
 * probe is in flight or when the page can't be inspected.
 */
export function usePageTheme({
  enabled,
  fallback,
}: UsePageThemeOptions): ResolvedTheme {
  const [theme, setTheme] = useState<ResolvedTheme>(fallback);

  useEffect(() => {
    if (!enabled) {
      setTheme(fallback);
      return;
    }
    let cancelled = false;
    let pending: number | null = null;

    const probe = () => {
      if (pending != null) {
        clearTimeout(pending);
      }
      // Debounce a touch — onUpdated fires repeatedly during navigation.
      pending = setTimeout(() => {
        pending = null;
        void detectActiveTabTheme().then((t) => {
          if (cancelled) return;
          setTheme(t ?? fallback);
        });
      }, 80) as unknown as number;
    };

    probe();

    const onActivated = () => probe();
    const onUpdated = (
      _id: number,
      info: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ) => {
      if (!tab.active) return;
      if (info.status === "complete" || info.url) probe();
    };
    const onWindowFocus = () => probe();

    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.windows?.onFocusChanged?.addListener(onWindowFocus);

    return () => {
      cancelled = true;
      if (pending != null) clearTimeout(pending);
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.windows?.onFocusChanged?.removeListener(onWindowFocus);
    };
  }, [enabled, fallback]);

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

interface UseResolvedThemeOptions {
  /** When true, the `page` preference is honoured; otherwise it degrades to `auto`. */
  allowPage?: boolean;
}

/**
 * Resolves the theme to apply for this surface. Side-effect: syncs the
 * `dark` / `light` class on `<html>` so CSS variables update accordingly.
 */
export function useResolvedTheme(
  opts: UseResolvedThemeOptions = {},
): { theme: ResolvedTheme; preference: ThemePreference } {
  const [pref] = useStoredThemePreference();
  const browser = useBrowserTheme();
  const page = usePageTheme({
    enabled: pref === "page" && !!opts.allowPage,
    fallback: browser,
  });

  let resolved: ResolvedTheme;
  if (pref === "light") resolved = "light";
  else if (pref === "dark") resolved = "dark";
  else if (pref === "page" && opts.allowPage) resolved = page;
  else resolved = browser;

  useEffect(() => {
    applyThemeClass(resolved);
  }, [resolved]);

  return { theme: resolved, preference: pref };
}
