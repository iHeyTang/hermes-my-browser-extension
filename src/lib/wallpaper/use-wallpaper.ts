/**
 * Daily wallpaper for the new-tab page.
 *
 * Source: Bing's "Image of the day" feed (`HPImageArchive.aspx`). Picked
 * because it requires no API key, no signup, and rotates exactly once a
 * day on the server side — so we don't have to decide what "today" means
 * or how to fetch a new image.
 *
 * Caching strategy:
 *   - The fetched record is keyed in `chrome.storage.local` by the local
 *     calendar date. As long as a record for today exists we skip the
 *     network entirely; this means N simultaneously open newtabs all
 *     share one fetch per day.
 *   - On a stale cache or first run we hit Bing. If that fails (offline,
 *     blocked) we fall back to whatever cache we still have so the user
 *     doesn't lose the wallpaper they had yesterday.
 *   - We deliberately do NOT cache the image bytes — just the URL. The
 *     browser's HTTP cache handles repeat image loads cheaply, and
 *     storing ~1MB of base64 in chrome.storage.local every day would
 *     bloat the profile.
 *
 * Off-mode: the `settings.newtab.wallpaper.enabled` toggle short-circuits
 * the whole hook before any network call.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const BING_HOST = "https://www.bing.com";
const BING_API_BASE = "/HPImageArchive.aspx?format=js&n=1";
export const WALLPAPER_ENABLED_KEY = "settings.newtab.wallpaper.enabled";
const CACHE_KEY = "wallpaper.cache";
/**
 * Bing's `HPImageArchive` endpoint exposes up to 8 days of history
 * (idx 0 = today, 7 = a week ago). Cycling past that wraps back to 0.
 */
const BING_MAX_IDX = 7;

export interface Wallpaper {
  /** Absolute https URL of the day's image (UHD variant when available). */
  url: string;
  /** Short title from Bing (e.g. place name). */
  title: string;
  /** Bing's full "{Title} (©photographer/source)" credit string. */
  copyright: string;
  /** Link Bing wants us to surface for attribution. */
  copyrightLink: string;
  /** Local-date key the entry was fetched for — used to invalidate. */
  date: string;
  /** Which Bing `idx` (0..7) this image came from; 0 = today. */
  idx: number;
}

export interface WallpaperController {
  /** True once the hook has decided whether to render anything. */
  ready: boolean;
  /** Mirrors `settings.newtab.wallpaper.enabled`; defaults true. */
  enabled: boolean;
  wallpaper: Wallpaper | null;
  /**
   * Swap to the next image in Bing's recent history (wraps at
   * `BING_MAX_IDX`). Same-day clicks burn through the available 8 images
   * before looping back; a new calendar day resets to idx 0 regardless of
   * where the user left off.
   */
  cycle: () => Promise<void>;
  /**
   * True while a cycle fetch is in flight. UI can use this to gate
   * double-clicks and show a loading hint.
   */
  cycling: boolean;
  /**
   * Overall tonal mode of the current wallpaper, derived from a
   * downsampled luminance sample of the image. `null` while no
   * wallpaper or while still measuring. Floating text (greeting,
   * subtitle, TopBar logo) that sits directly over the wallpaper
   * should pick its colour off this so it stays legible regardless
   * of whether today's photo is a snowy ridgeline or a midnight city.
   */
  mode: "light" | "dark" | null;
}

/**
 * Sample the average perceived luminance of an image. Downsamples to a
 * 50×30 tile via OffscreenCanvas so we don't read pixel-by-pixel on a
 * 4K photo. Returns a 0-1 value; null on any failure (CORS-tainted
 * canvas in tests, OffscreenCanvas unavailable, network error).
 *
 * We `fetch` the bytes ourselves and route through `createImageBitmap`
 * rather than going via an `<img>` + canvas. That way we never have to
 * worry about whether Bing sends CORS headers — the extension's
 * `<all_urls>` host permission unblocks the fetch, and the blob path
 * never taints the canvas.
 *
 * Weights are the ITU-R BT.601 coefficients (0.299/0.587/0.114) — the
 * "perceived brightness" formula that matches how a human eye weighs
 * red/green/blue. Plain RGB averaging undershoots green-heavy photos.
 */
async function measureLuminance(url: string): Promise<number | null> {
  try {
    if (typeof OffscreenCanvas === "undefined") return null;
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) return null;
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    const W = 50;
    const H = 30;
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, W, H);
    const data = ctx.getImageData(0, 0, W, H).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return sum / (W * H * 255);
  } catch {
    return null;
  }
}

function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Bing returns slightly different copy / image selection per market.
 * We follow the browser UI language so a zh-CN Chrome gets Chinese
 * captions and the en-US one gets English. Any non-Chinese language
 * falls back to en-US.
 */
function bingMarket(): string {
  try {
    const lang = chrome.i18n.getUILanguage?.() ?? "";
    if (lang.toLowerCase().startsWith("zh")) return "zh-CN";
  } catch {
    // chrome.i18n may be unavailable in some test contexts — fall through.
  }
  return "en-US";
}

interface BingResponse {
  images?: Array<{
    urlbase?: string;
    url?: string;
    title?: string;
    copyright?: string;
    copyrightlink?: string;
  }>;
}

async function fetchBingWallpaper(idx: number = 0): Promise<Wallpaper | null> {
  const safeIdx = Math.max(0, Math.min(BING_MAX_IDX, idx));
  const url =
    `${BING_HOST}${BING_API_BASE}&idx=${safeIdx}` +
    `&mkt=${encodeURIComponent(bingMarket())}`;
  try {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) return null;
    const data = (await res.json()) as BingResponse;
    const img = data?.images?.[0];
    if (!img) return null;
    // Prefer the UHD variant. `urlbase` is the stable prefix without
    // dimension suffix; appending `_UHD.jpg` gets a 3840x2160-ish image
    // that holds up on 4K displays. Fall back to the canned `url` when
    // `urlbase` is missing (defensive — current Bing always provides it).
    const base = img.urlbase ?? "";
    const imgUrl = base
      ? `${BING_HOST}${base}_UHD.jpg`
      : img.url
        ? `${BING_HOST}${img.url}`
        : "";
    if (!imgUrl) return null;
    return {
      url: imgUrl,
      title: (img.title ?? "").trim(),
      copyright: (img.copyright ?? "").trim(),
      copyrightLink: (img.copyrightlink ?? "").trim(),
      date: todayKey(),
      idx: safeIdx,
    };
  } catch {
    return null;
  }
}

export function useWallpaper(): WallpaperController {
  const [enabled, setEnabled] = useState<boolean>(true);
  const [wallpaper, setWallpaper] = useState<Wallpaper | null>(null);
  const [ready, setReady] = useState<boolean>(false);
  const [cycling, setCycling] = useState<boolean>(false);
  const [mode, setMode] = useState<"light" | "dark" | null>(null);

  // Re-measure luminance whenever the wallpaper URL changes (initial
  // load and after a `cycle()`). The async sample runs in parallel
  // with the image's own display load so we don't block the page
  // becoming usable — the only visible effect of the mode landing is
  // floating-text colour switching from its fallback to the adapted
  // value, which is a fine "snap".
  useEffect(() => {
    if (!wallpaper?.url) {
      setMode(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const luma = await measureLuminance(wallpaper.url);
      if (cancelled) return;
      if (luma == null) {
        // eslint-disable-next-line no-console
        console.warn("[wallpaper] luminance measurement failed");
        setMode(null);
        return;
      }
      // 0.5 threshold tuned for Bing photography in particular —
      // landscape / nature shots tend to cluster between 0.35-0.55,
      // so 0.5 splits "more bright than not" vs "more dark than not"
      // about evenly. Logged so the threshold can be re-tuned from
      // real data if a user reports a misclassified wallpaper.
      const next = luma > 0.5 ? "light" : "dark";
      // eslint-disable-next-line no-console
      console.log(
        `[wallpaper] luminance=${luma.toFixed(3)} → mode=${next}`,
      );
      setMode(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [wallpaper?.url]);
  // `cycle` needs the *current* wallpaper to decide which idx to fetch
  // next, but we don't want to put `wallpaper` in its deps array (would
  // make every consumer of `cycle` re-render on each image change).
  // Mirror the latest value in a ref instead.
  const wallpaperRef = useRef<Wallpaper | null>(null);
  useEffect(() => {
    wallpaperRef.current = wallpaper;
  }, [wallpaper]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const r = await chrome.storage.local.get([
          WALLPAPER_ENABLED_KEY,
          CACHE_KEY,
        ]);
        if (cancelled) return;

        const storedEnabled = r[WALLPAPER_ENABLED_KEY];
        const enabledNow =
          typeof storedEnabled === "boolean" ? storedEnabled : true;
        setEnabled(enabledNow);

        if (!enabledNow) {
          setReady(true);
          return;
        }

        const cached = (r[CACHE_KEY] as Wallpaper | undefined) ?? null;
        if (cached && cached.url && cached.date === todayKey()) {
          setWallpaper(cached);
          setReady(true);
          return;
        }

        const fresh = await fetchBingWallpaper();
        if (cancelled) return;

        if (fresh) {
          setWallpaper(fresh);
          void chrome.storage.local.set({ [CACHE_KEY]: fresh });
        } else if (cached?.url) {
          // Network failed but we have an old cache; better than blank.
          // We don't refresh `date` so the next session will try Bing again.
          setWallpaper(cached);
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();

    // Pick up live toggles from the Options page without requiring a
    // newtab reload.
    function onStorageChanged(
      changes: { [key: string]: chrome.storage.StorageChange },
      area: chrome.storage.AreaName,
    ) {
      if (area !== "local") return;
      const change = changes[WALLPAPER_ENABLED_KEY];
      if (!change) return;
      const next = change.newValue;
      if (typeof next === "boolean") setEnabled(next);
    }
    chrome.storage.onChanged.addListener(onStorageChanged);

    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onStorageChanged);
    };
  }, []);

  const cycle = useCallback(async (): Promise<void> => {
    if (cycling) return;
    const current = wallpaperRef.current;
    const currentIdx = current?.idx ?? 0;
    const nextIdx = (currentIdx + 1) % (BING_MAX_IDX + 1);
    setCycling(true);
    try {
      const fresh = await fetchBingWallpaper(nextIdx);
      if (!fresh) return;
      setWallpaper(fresh);
      // Persist so the chosen image survives reloads within the same
      // day. Tomorrow's date check still resets to idx 0 — manual
      // override is a "today only" preference, not a sticky setting.
      void chrome.storage.local.set({ [CACHE_KEY]: fresh });
    } finally {
      setCycling(false);
    }
  }, [cycling]);

  return { ready, enabled, wallpaper, cycle, cycling, mode };
}
