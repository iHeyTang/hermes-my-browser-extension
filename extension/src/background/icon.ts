/**
 * Toolbar icon painter.
 *
 * Earlier revisions used a `"ON" / "..." / ""` badge-text overlay, but that
 * eats most of the 16-px toolbar slot. We now composite a small circular
 * status dot — green / amber / red — onto the bottom-right corner of the
 * Hermes glyph using an `OffscreenCanvas`, and clear the text badge entirely.
 *
 * Plasmo content-hashes asset filenames at build time, so we can't reach the
 * logo via `chrome.runtime.getURL("assets/icon128.png")`. We instead inline
 * the source PNG with the `data-base64:` scheme; the bytes ship with the SW
 * bundle and are decoded once on first use, then reused for every state
 * change.
 */

import logoUrl from "data-base64:~assets/hermes-logo-light.png";

import type { ConnectionState } from "~lib/types";

const DOT_COLOR: Record<ConnectionState, string> = {
  connected: "#22c55e", // green
  connecting: "#f59e0b", // amber
  disconnected: "#ef4444", // red
};

const TITLE: Record<ConnectionState, string> = {
  connected: "Hermes Browser Extension — connected",
  connecting: "Hermes Browser Extension — connecting…",
  disconnected: "Hermes Browser Extension — disconnected",
};

// Sizes Chrome asks for in the toolbar / extensions menu. We render each
// explicitly so the dot stays crisp instead of being interpolated from a
// single source.
const ICON_SIZES = [16, 32, 48, 128] as const;

let basePromise: Promise<ImageBitmap | null> | null = null;

function loadBase(): Promise<ImageBitmap | null> {
  if (!basePromise) {
    basePromise = (async () => {
      try {
        const blob = await (await fetch(logoUrl)).blob();
        return await createImageBitmap(blob);
      } catch (e) {
        console.warn("[hermes-icon] failed to decode logo:", e);
        return null;
      }
    })();
  }
  return basePromise;
}

/**
 * Composite the Hermes glyph + a coloured status dot at every size Chrome
 * needs. Returns `null` when canvas/bitmap APIs are unavailable so callers
 * can fall back to the legacy badge-text path.
 */
async function composeIcons(
  state: ConnectionState,
): Promise<Record<string, ImageData> | null> {
  if (typeof OffscreenCanvas === "undefined") return null;
  const base = await loadBase();
  if (!base) return null;

  const out: Record<string, ImageData> = {};
  for (const size of ICON_SIZES) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    // Hermes glyph fills the slot. The source PNG already has a small
    // visual inset, so we don't add one here.
    ctx.drawImage(base, 0, 0, size, size);

    // Status dot: a circle with a thin halo so it stays visible against
    // both light and dark Chrome toolbars. Sized as a fraction of the
    // canvas so it looks consistent at 16 px and 128 px alike. The 0.18
    // ratio (with a 3-px floor) is a tuned sweet spot — readable in the
    // toolbar slot, not so large it eats the glyph in the extensions menu.
    const r = Math.max(3, Math.round(size * 0.18));
    const halo = Math.max(1, Math.round(size * 0.05));
    const cx = size - r - halo;
    const cy = size - r - halo;

    // Halo: a translucent white ring punches the dot out of the glyph
    // outline so the colour reads cleanly even when it lands on the
    // character's hair.
    ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
    ctx.beginPath();
    ctx.arc(cx, cy, r + halo, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = DOT_COLOR[state];
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    out[String(size)] = ctx.getImageData(0, 0, size, size);
  }
  return out;
}

/**
 * Last-resort fallback for browsers/contexts without `OffscreenCanvas`.
 * Keeps the original badge-colour-as-status approach but uses a single
 * dot character so it stays roughly circular instead of spelling "ON".
 */
function applyBadgeFallback(state: ConnectionState) {
  const text = state === "disconnected" ? "" : "●";
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action
    .setBadgeBackgroundColor({ color: DOT_COLOR[state] })
    .catch(() => {});
  chrome.action.setBadgeTextColor?.({ color: DOT_COLOR[state] }).catch(() => {});
}

export function applyIcon(state: ConnectionState): void {
  try {
    chrome.action.setTitle({ title: TITLE[state] }).catch(() => {});
    // Always clear the legacy text badge first so a stale "ON" doesn't
    // linger if the icon rebuild below races / fails.
    chrome.action.setBadgeText({ text: "" }).catch(() => {});

    void (async () => {
      const imageData = await composeIcons(state);
      if (!imageData) {
        applyBadgeFallback(state);
        return;
      }
      try {
        await chrome.action.setIcon({ imageData });
      } catch (e) {
        console.warn("[hermes-icon] setIcon failed; falling back:", e);
        applyBadgeFallback(state);
      }
    })();
  } catch {
    // chrome.action may be unavailable mid-shutdown; ignore.
  }
}
