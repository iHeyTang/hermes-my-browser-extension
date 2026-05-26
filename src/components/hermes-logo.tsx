// Plasmo's `data-base64:` scheme inlines the asset as a base64 data URI at
// build time. We use it (rather than `chrome.runtime.getURL`) because Plasmo
// renames bundled assets with content hashes, so a literal path like
// `assets/hermes-logo-light.png` would 404 in the production build.
import logoLightBg from "data-base64:~assets/hermes-logo-light.png";
import logoDarkBg from "data-base64:~assets/hermes-logo-dark.png";

import { cn } from "~lib/utils";
import { useDocumentTheme } from "~lib/theme";

/**
 * Brand mark for Hermes Agent surfaces. Two PNG variants live under
 * `extension/assets/`:
 *
 *   - `hermes-logo-light.png` — black-on-transparent (visible on light bg)
 *   - `hermes-logo-dark.png`  — white-on-transparent (visible on dark bg)
 *
 * The component picks the variant that contrasts with the surface it is
 * rendered on. By default we follow the `<html>` palette class so the logo
 * flips automatically alongside every other shadcn token. Pass `variant`
 * explicitly for surfaces that don't track the document theme (e.g. a logo
 * placed on top of a fixed-colour gradient).
 */
interface HermesLogoProps {
  /** CSS size override; ignored when `width`/`height` are set via className. */
  size?: number;
  /** Force a specific variant regardless of the resolved theme. */
  variant?: "auto" | "light-bg" | "dark-bg";
  className?: string;
  alt?: string;
}

export function HermesLogo({
  size = 24,
  variant = "auto",
  className,
  alt = "Hermes Agent",
}: HermesLogoProps) {
  const theme = useDocumentTheme();
  // `light-bg` means "render so it looks good on a light surface" — i.e.
  // pick the dark-glyph artwork. We expose the prop in the surface-oriented
  // direction because that's how callers tend to think about it.
  const useDarkGlyph =
    variant === "light-bg" ||
    (variant !== "dark-bg" && theme === "light");
  const src = useDarkGlyph ? logoLightBg : logoDarkBg;
  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      // `select-none` + `pointer-events-none` so the image never steals
      // clicks from the surrounding button/header.
      className={cn(
        "select-none pointer-events-none object-contain",
        className,
      )}
      draggable={false}
    />
  );
}
