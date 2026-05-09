/**
 * URL matching for `@match` (Chrome match-pattern) plus `@include` / `@exclude`
 * (Tampermonkey-style globs and `/regex/` literals).
 *
 * `@match` patterns: `<scheme>://<host>/<path>` with `*` allowed in scheme,
 * host (only as the leftmost label) and path. The literal `<all_urls>` matches
 * any http/https/file/ftp URL.
 *
 * `@include` / `@exclude` patterns:
 *   - `*` is a glob wildcard matching any character sequence.
 *   - `/.../` (or `/.../i`) treats the body as a regular expression.
 *   - Anything else is matched as a glob anchored to the full URL.
 */

const MATCH_RE =
  /^(\*|https?|ftp|file|urn|chrome-extension):\/\/([^/]+)?(\/.*)?$/i;

export function matchPatternToRegExp(pattern: string): RegExp | null {
  if (pattern === "<all_urls>") {
    return /^(https?|file|ftp):\/\/.*/i;
  }
  const m = pattern.match(MATCH_RE);
  if (!m) return null;
  const [, scheme, host = "", path = "/"] = m;

  const schemeRe =
    scheme === "*" ? "(?:https?)" : escapeRegex(scheme);

  let hostRe: string;
  if (host === "*") {
    hostRe = "[^/]+";
  } else if (host.startsWith("*.")) {
    const rest = escapeRegex(host.slice(2));
    hostRe = `(?:[^/]+\\.)?${rest}`;
  } else {
    hostRe = escapeRegex(host);
  }

  const pathRe = escapeRegex(path).replace(/\\\*/g, ".*");

  return new RegExp(`^${schemeRe}://${hostRe}${pathRe}$`, "i");
}

export function globToRegExp(glob: string): RegExp {
  // `/regex/` or `/regex/i` literal
  if (glob.length >= 2 && glob.startsWith("/")) {
    const last = glob.lastIndexOf("/");
    if (last > 0) {
      const body = glob.slice(1, last);
      const flags = glob.slice(last + 1);
      try {
        return new RegExp(body, flags);
      } catch {
        // Fall through to glob handling.
      }
    }
  }
  const re = escapeRegex(glob).replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
  return new RegExp(`^${re}$`, "i");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface MatchSet {
  match: RegExp[];
  include: RegExp[];
  exclude: RegExp[];
  excludeMatch: RegExp[];
}

export function buildMatchSet(args: {
  match?: string[];
  include?: string[];
  exclude?: string[];
  excludeMatch?: string[];
}): MatchSet {
  return {
    match: (args.match || [])
      .map(matchPatternToRegExp)
      .filter((r): r is RegExp => !!r),
    include: (args.include || []).map(globToRegExp),
    exclude: (args.exclude || []).map(globToRegExp),
    excludeMatch: (args.excludeMatch || [])
      .map(matchPatternToRegExp)
      .filter((r): r is RegExp => !!r),
  };
}

export function matchUrl(url: string, set: MatchSet): boolean {
  const positive =
    set.match.some((r) => r.test(url)) ||
    set.include.some((r) => r.test(url));
  if (!positive) return false;
  if (set.exclude.some((r) => r.test(url))) return false;
  if (set.excludeMatch.some((r) => r.test(url))) return false;
  return true;
}
