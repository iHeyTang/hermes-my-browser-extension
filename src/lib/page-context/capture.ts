/**
 * Active-tab page-context capture for the side panel.
 *
 * We inject a small extractor into the active tab via
 * `chrome.scripting.executeScript`, walk the DOM in roughly Reader-mode
 * order (article → main → biggest content-bearing ancestor → body),
 * strip noise tags (script/style/nav/aside/footer), and cap the
 * resulting text. Going through the DOM instead of a raw fetch is what
 * lets SPAs work — the static HTML is often a near-empty shell and only
 * carries meaningful content *after* JS execution.
 *
 * Non-HTML resources (PDF, image, JSON, …) are out of scope here: the
 * DOM extractor will return whatever Chrome's built-in viewer happens
 * to expose, which is rarely useful. Users who want to attach such a
 * resource should drag/drop it into the composer instead — the manual
 * attachment pipeline handles that case.
 *
 * On failure (chrome://, devtools, web-store, no body, denied permission)
 * we return a structured error so the UI can show a friendly tooltip
 * instead of crashing the send path.
 */

export interface PageContext {
  url: string;
  title: string;
  /** Trimmed page text, capped to `maxChars`. */
  content: string;
  /** Original (untrimmed) length in characters, useful for "truncated" hints. */
  originalLength: number;
  /** True if `content` was truncated to `maxChars`. */
  truncated: boolean;
  /** Best-effort canonical or favicon URL (may be empty). */
  favicon?: string;
  capturedAt: number;
}

export interface CapturePageError {
  error: string;
  /** Best-effort tab title/url so the UI can still show what was attempted. */
  tabTitle?: string;
  tabUrl?: string;
}

/**
 * Result of `capturePageContext` — a DOM-walked HTML snapshot or a
 * structured error explaining why capture wasn't possible.
 */
export type CaptureResult =
  | { kind: "page"; page: PageContext }
  | { kind: "error"; error: CapturePageError };

const DEFAULT_MAX_CHARS = 16000;

const SCRIPTABLE_PROTOCOL = /^(https?|file|ftp):/i;

/**
 * Synchronous check for "is this URL one we can definitely NOT inject into?".
 * Returns a human-readable reason string when the page is off-limits, or
 * `null` when extraction is at least worth attempting.
 *
 * This lets callers gate their UI (disable a Pin button, hide a chip,
 * surface a tooltip…) without paying for the round-trip into
 * `chrome.scripting.executeScript` only to surface the same error after
 * the user has already clicked. The runtime path inside
 * `capturePageContext` uses the same helper so the upfront message and
 * the post-click message stay in lock-step.
 */
export function getPageRestrictedReason(
  url: string | undefined | null,
): string | null {
  if (!url) return "No active tab to attach.";
  if (!SCRIPTABLE_PROTOCOL.test(url)) {
    return "This page can't be read by extensions (e.g. chrome://, extension pages, devtools).";
  }
  try {
    const u = new URL(url);
    const host = u.hostname;
    if (
      host === "chromewebstore.google.com" ||
      (host === "chrome.google.com" && u.pathname.startsWith("/webstore"))
    ) {
      return "The Chrome Web Store can't be read by extensions.";
    }
  } catch {
    return "This page's URL can't be parsed.";
  }
  return null;
}

/**
 * Find the active browsing tab in the user's last-focused Chrome window.
 *
 * Returns `null` when there is no candidate (e.g. the only open window is
 * the side panel's host with no normal tab). The caller should treat the
 * absence as "no page to read" rather than an error.
 */
export async function getActiveBrowserTab(): Promise<chrome.tabs.Tab | null> {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    return tab ?? null;
  } catch {
    return null;
  }
}

/**
 * Extract page content from the given tab.
 *
 * Throws on injection failure (restricted URL, no permission, etc.) so the
 * caller can branch on `error instanceof Error`.
 */
export async function extractPageContent(
  tabId: number,
  maxChars = DEFAULT_MAX_CHARS,
): Promise<{
  url: string;
  title: string;
  content: string;
  originalLength: number;
  truncated: boolean;
}> {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractInPage,
    args: [maxChars],
  });
  const out = res?.result as
    | {
        url: string;
        title: string;
        content: string;
        originalLength: number;
        truncated: boolean;
      }
    | undefined;
  if (!out) {
    throw new Error("Page extractor returned no result");
  }
  return out;
}

/**
 * High-level helper: locate the active tab and read its DOM content.
 *
 * Returns one of:
 *   - `{ kind: "page", page }`   — DOM-walked into a PageContext
 *   - `{ kind: "error", error }` — restricted URL or capture failure
 */
export async function capturePageContext(
  options: { maxChars?: number } = {},
): Promise<CaptureResult> {
  const tab = await getActiveBrowserTab();
  if (!tab || !tab.id) {
    return { kind: "error", error: { error: "No active tab found" } };
  }
  const url = tab.url || tab.pendingUrl || "";
  const title = tab.title || "";
  if (!url) {
    return {
      kind: "error",
      error: {
        error: "Active tab has no URL yet (still loading?)",
        tabTitle: title,
      },
    };
  }
  const restricted = getPageRestrictedReason(url);
  if (restricted) {
    return {
      kind: "error",
      error: { error: restricted, tabTitle: title, tabUrl: url },
    };
  }

  try {
    const extracted = await extractPageContent(
      tab.id,
      options.maxChars ?? DEFAULT_MAX_CHARS,
    );
    return {
      kind: "page",
      page: {
        url: extracted.url || url,
        title: extracted.title || title,
        content: extracted.content,
        originalLength: extracted.originalLength,
        truncated: extracted.truncated,
        favicon: tab.favIconUrl,
        capturedAt: Date.now(),
      },
    };
  } catch (e) {
    return {
      kind: "error",
      error: {
        error: `Failed to read page: ${(e as Error)?.message || String(e)}`,
        tabTitle: title,
        tabUrl: url,
      },
    };
  }
}

/**
 * Format a `PageContext` as a plain-text block for inlining into the user
 * message content. We use clearly-fenced markers so the model can tell where
 * the page content ends and the user's actual question begins.
 */
export function formatPageContextForPrompt(ctx: PageContext): string {
  return formatPageContextsForPrompt([ctx]);
}

/**
 * Format multiple `PageContext`s as a single text block with one
 * `<page-context>` block per page. The intro paragraph is emitted once at
 * the top regardless of count so the prompt stays compact and the model
 * sees a uniform shape whether the user attached one page or many. The
 * caller is expected to inline the returned string into the user message
 * content (no separate `system` role message).
 */
export function formatPageContextsForPrompt(ctxs: PageContext[]): string {
  if (ctxs.length === 0) return "";
  const intro =
    ctxs.length === 1
      ? [
          "The user is viewing the following web page in their browser. Use it",
          "as context when answering. If their question is unrelated to the",
          "page, ignore this block.",
        ]
      : [
          `The user has attached ${ctxs.length} web pages as context. Use them`,
          "when answering. If their question is unrelated to a page, ignore",
          "that block.",
        ];
  const blocks = ctxs.map((ctx, i) => {
    const truncatedNote = ctx.truncated
      ? `\n[note] content truncated from ${ctx.originalLength} to ${ctx.content.length} characters`
      : "";
    const indexAttr = ctxs.length > 1 ? ` index="${i + 1}"` : "";
    return [
      `<page-context${indexAttr}>`,
      `Title: ${ctx.title || "(untitled)"}`,
      `URL: ${ctx.url}`,
      `Captured-At: ${new Date(ctx.capturedAt).toISOString()}${truncatedNote}`,
      "",
      ctx.content,
      "</page-context>",
    ].join("\n");
  });
  return [...intro, "", blocks.join("\n\n")].join("\n");
}

export function isCaptureError(
  v: PageContext | CapturePageError,
): v is CapturePageError {
  return (v as CapturePageError).error !== undefined;
}

// ---------------------------------------------------------------------------
// In-page extractor — runs inside the target tab via executeScript.
//
// IMPORTANT: this function is serialised across the extension/page boundary,
// so it MUST be self-contained (no closures over module-scope variables, no
// imports). Keep it readable but defensive: pages serve all kinds of weird
// DOMs and we don't want to throw on any of them.
// ---------------------------------------------------------------------------

function extractInPage(maxChars: number): {
  url: string;
  title: string;
  content: string;
  originalLength: number;
  truncated: boolean;
} {
  const NOISE_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "NAV",
    "ASIDE",
    "FOOTER",
    "HEADER",
    "FORM",
    "IFRAME",
    "SVG",
    "CANVAS",
  ]);

  const collectVisibleText = (root: Element | null): string => {
    if (!root) return "";
    const clone = root.cloneNode(true) as Element;
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT);
    const drop: Element[] = [];
    let n: Node | null = walker.currentNode;
    while (n) {
      if (n instanceof Element && NOISE_TAGS.has(n.tagName)) {
        drop.push(n);
      }
      n = walker.nextNode();
    }
    for (const el of drop) el.remove();
    const text = (clone as HTMLElement).innerText || clone.textContent || "";
    return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  };

  // Reader-mode-ish heuristic: prefer the largest <article>, then <main>,
  // then any element whose text content dominates the page.
  const pickRoot = (): Element | null => {
    const articles = Array.from(document.querySelectorAll("article"));
    if (articles.length) {
      articles.sort(
        (a, b) =>
          (b.textContent?.length || 0) - (a.textContent?.length || 0),
      );
      return articles[0];
    }
    const main = document.querySelector("main");
    if (main && (main.textContent?.length || 0) > 200) return main;
    // Last resort: pick the descendant of <body> with the most text whose
    // tag is content-y (DIV/SECTION). We cap depth to avoid n^2 blow-ups.
    if (!document.body) return null;
    const candidates = Array.from(
      document.body.querySelectorAll("div, section"),
    ).slice(0, 200);
    let best: Element | null = null;
    let bestLen = 0;
    for (const el of candidates) {
      const len = el.textContent?.length || 0;
      if (len > bestLen && len > 400) {
        best = el;
        bestLen = len;
      }
    }
    return best || document.body;
  };

  const root = pickRoot();
  const fullText = collectVisibleText(root);
  const originalLength = fullText.length;
  const truncated = originalLength > maxChars;
  const content = truncated ? fullText.slice(0, maxChars) : fullText;

  return {
    url: location.href,
    title: document.title || "",
    content,
    originalLength,
    truncated,
  };
}
