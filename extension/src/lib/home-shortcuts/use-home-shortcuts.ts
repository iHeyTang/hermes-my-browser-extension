/**
 * React hook for the new-tab "Home shortcuts" strip.
 *
 * Design (see also the discussion in the design doc / chat):
 *   - The set of shortcuts IS a single dedicated Chrome bookmark folder
 *     under "Other Bookmarks" (parentId="2"). Each shortcut is a normal
 *     bookmark inside that folder. The folder is the only persistent
 *     state — no separate chrome.storage records to keep in sync.
 *   - The folder ID is cached in `chrome.storage.local` so we don't pay
 *     the tree-walk on every new tab open, but the cache is treated as
 *     a hint: every read re-validates with `chrome.bookmarks.get(id)`
 *     and re-creates the folder if the user deleted it from Chrome's
 *     bookmark manager.
 *   - Cross-device sync, undo from the bookmark manager, and "agent can
 *     edit my homepage shortcuts" all come for free because we live
 *     inside the bookmarks subsystem.
 *
 * Naming: the folder is titled with a unicode marker so it stands out
 * in the bookmark manager but isn't easily mistaken for the user's own
 * folders. User can rename in the bookmark manager — we look it up by
 * cached ID, not by title.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const FOLDER_ID_CACHE_KEY = "newtab.shortcutsFolderId";
const FOLDER_PARENT_ID = "2"; // "Other Bookmarks"
const FOLDER_TITLE = "✱ Hermes Home";

/**
 * Time budget for the one-shot `<title>` scrape we do when the user adds a
 * shortcut without typing a name. Short on purpose — the bookmark is
 * already created and visible with a hostname placeholder; this is purely
 * a "make it pretty" enrichment, and we'd rather fall back to the host
 * than make the user wait.
 */
const TITLE_FETCH_TIMEOUT_MS = 5000;

export interface HomeShortcut {
  id: string;
  title: string;
  url: string;
  /** Order index from the bookmarks API; persisted as bookmark order. */
  index: number;
}

export interface HomeShortcutsController {
  ready: boolean;
  items: HomeShortcut[];
  error: string | null;
  add: (input: { title: string; url: string }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  /** Move the shortcut at `fromIndex` to `toIndex` within the folder. */
  reorder: (fromIndex: number, toIndex: number) => Promise<void>;
  refresh: () => Promise<void>;
}

function isBookmark(
  n: chrome.bookmarks.BookmarkTreeNode,
): n is chrome.bookmarks.BookmarkTreeNode & { url: string } {
  return typeof n.url === "string" && n.url.length > 0;
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Strip the trailing site-name / tagline / description that most pages
 * append after a separator, leaving just the primary title segment.
 *
 * Conventions we handle (segments separated by ` X `, with spaces):
 *   - "GitHub · Build and ship software on a single…"  → "GitHub"
 *   - "Page Title | Site Name"                         → "Page Title"
 *   - "标题 - 网站名"                                   → "标题"
 *   - "Site Name :: Tagline"                            → "Site Name"
 *
 * Heuristic: take everything before the **earliest** separator we find.
 * For root URLs (the typical shortcut target) the leading segment is
 * almost always the part the user actually wants to see on a card.
 * Strings without a recognised separator pass through unchanged.
 *
 * If the leading segment is empty (e.g. " - Real Title") we keep the
 * original — better a noisy label than a blank one.
 */
function trimToPrimaryTitle(title: string): string {
  const SEPARATORS = [
    " | ",
    " · ",
    " - ",
    " – ", // en dash
    " — ", // em dash
    " :: ",
    " » ",
    " › ",
    " // ",
  ];
  let earliest = -1;
  for (const sep of SEPARATORS) {
    const i = title.indexOf(sep);
    if (i >= 0 && (earliest < 0 || i < earliest)) earliest = i;
  }
  if (earliest <= 0) return title;
  const head = title.slice(0, earliest).trim();
  return head || title;
}

/**
 * Best-effort fetch of the page's `<title>`. The extension's
 * `host_permissions: <all_urls>` lets us read responses across origins
 * (CORS doesn't apply to extension-origin fetches with host permission),
 * so most public sites work. Returns null on timeout, non-HTML response,
 * fetch failure, or missing title — callers should keep whatever
 * fallback they had (hostname is a good one). We deliberately do not
 * follow client-side rendered SPAs that overwrite the title via JS;
 * fixing that would require a real renderer.
 */
async function fetchPageTitle(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const handle = setTimeout(() => ctrl.abort(), TITLE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      credentials: "omit",
      redirect: "follow",
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml/i.test(ct)) return null;
    const html = await res.text();
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!m) return null;
    const decoded = m[1]
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
    if (!decoded) return null;
    return trimToPrimaryTitle(decoded);
  } catch {
    return null;
  } finally {
    clearTimeout(handle);
  }
}

/**
 * Returns true when `title` is the kind of placeholder we ourselves
 * write (the URL or the hostname for that URL). Used to decide whether
 * to overwrite with a freshly-scraped page title without ever touching
 * a name the user actually typed.
 */
function isAutogeneratedTitle(title: string, url: string): boolean {
  const t = title.trim();
  if (!t) return true;
  if (t === url) return true;
  if (t === hostFromUrl(url)) return true;
  // Trailing-slash variations of the URL.
  if (t === url.replace(/\/$/, "")) return true;
  return false;
}

async function readCachedFolderId(): Promise<string | null> {
  const r = await chrome.storage.local.get(FOLDER_ID_CACHE_KEY);
  const v = r[FOLDER_ID_CACHE_KEY];
  return typeof v === "string" && v ? v : null;
}

async function writeCachedFolderId(id: string): Promise<void> {
  await chrome.storage.local.set({ [FOLDER_ID_CACHE_KEY]: id });
}

/**
 * Returns a valid folder id, creating the folder if the cached id is
 * missing or stale (user deleted the folder from Chrome's bookmark
 * manager). Idempotent: calling twice with no intervening deletes returns
 * the same id.
 */
async function ensureFolder(): Promise<string> {
  const cached = await readCachedFolderId();
  if (cached) {
    try {
      const [node] = await chrome.bookmarks.get(cached);
      if (node && !isBookmark(node)) return node.id;
    } catch {
      // Cached id no longer points at anything — fall through and recreate.
    }
  }
  // Prefer adopting an existing folder with our title before creating a
  // duplicate. This makes "delete cache + reload" idempotent instead of
  // spawning a second "✱ Hermes Home" folder every time.
  try {
    const matches = await chrome.bookmarks.search({ title: FOLDER_TITLE });
    const existing = matches.find(
      (m) => !isBookmark(m) && m.parentId === FOLDER_PARENT_ID,
    );
    if (existing) {
      await writeCachedFolderId(existing.id);
      return existing.id;
    }
  } catch {
    // Best-effort.
  }
  const created = await chrome.bookmarks.create({
    parentId: FOLDER_PARENT_ID,
    title: FOLDER_TITLE,
  });
  await writeCachedFolderId(created.id);
  return created.id;
}

async function readFolderChildren(folderId: string): Promise<HomeShortcut[]> {
  const children = await chrome.bookmarks.getChildren(folderId);
  return children
    .filter(isBookmark)
    .map((n) => ({
      id: n.id,
      title: n.title || n.url,
      url: n.url,
      index: typeof n.index === "number" ? n.index : 0,
    }))
    .sort((a, b) => a.index - b.index);
}

export function useHomeShortcuts(): HomeShortcutsController {
  const [items, setItems] = useState<HomeShortcut[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const folderIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const folderId = folderIdRef.current ?? (await ensureFolder());
      folderIdRef.current = folderId;
      const list = await readFolderChildren(folderId);
      if (!mountedRef.current) return;
      setItems(list);
      setError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      setError((e as Error)?.message || String(e));
    } finally {
      if (mountedRef.current) setReady(true);
    }
  }, []);

  // Initial fetch + bookmark-event subscription. Any change inside our
  // folder (locally, via Chrome sync from another device, or via an
  // agent tool call that hits `chrome.bookmarks.*`) triggers a refresh.
  useEffect(() => {
    mountedRef.current = true;
    void refresh();

    const isOurs = (
      parentIdOrNode: string | chrome.bookmarks.BookmarkTreeNode | undefined,
    ): boolean => {
      const ours = folderIdRef.current;
      if (!ours) return true; // refresh anyway until we know our folder id
      if (!parentIdOrNode) return false;
      if (typeof parentIdOrNode === "string") return parentIdOrNode === ours;
      return parentIdOrNode.parentId === ours;
    };

    const onCreated = (
      _id: string,
      node: chrome.bookmarks.BookmarkTreeNode,
    ) => {
      if (isOurs(node)) void refresh();
    };
    const onRemoved = (
      _id: string,
      info: chrome.bookmarks.BookmarkRemoveInfo,
    ) => {
      // If the removed node is our folder itself, drop the cache and
      // re-create on next refresh.
      if (folderIdRef.current && _id === folderIdRef.current) {
        folderIdRef.current = null;
        void chrome.storage.local.remove(FOLDER_ID_CACHE_KEY);
        void refresh();
        return;
      }
      if (isOurs(info.parentId)) void refresh();
    };
    const onChanged = (id: string) => {
      // We don't know the parent from the changeInfo, so just refresh
      // when any descendant changes; the read is cheap.
      void chrome.bookmarks
        .get(id)
        .then(([n]) => {
          if (n && isOurs(n.parentId)) void refresh();
        })
        .catch(() => {});
    };
    const onMoved = (
      _id: string,
      info: chrome.bookmarks.BookmarkMoveInfo,
    ) => {
      if (isOurs(info.parentId) || isOurs(info.oldParentId)) void refresh();
    };
    const onChildrenReordered = (id: string) => {
      if (id === folderIdRef.current) void refresh();
    };

    chrome.bookmarks.onCreated.addListener(onCreated);
    chrome.bookmarks.onRemoved.addListener(onRemoved);
    chrome.bookmarks.onChanged.addListener(onChanged);
    chrome.bookmarks.onMoved.addListener(onMoved);
    chrome.bookmarks.onChildrenReordered.addListener(onChildrenReordered);

    return () => {
      mountedRef.current = false;
      chrome.bookmarks.onCreated.removeListener(onCreated);
      chrome.bookmarks.onRemoved.removeListener(onRemoved);
      chrome.bookmarks.onChanged.removeListener(onChanged);
      chrome.bookmarks.onMoved.removeListener(onMoved);
      chrome.bookmarks.onChildrenReordered.removeListener(onChildrenReordered);
    };
  }, [refresh]);

  // Retroactive title enrichment: walk the current items and, for any
  // entry whose stored title is still the auto-generated placeholder
  // (the URL or hostname we wrote at add-time), try to fetch the real
  // page `<title>`. We track which ids we've already attempted in a
  // ref so this doesn't refire on every refresh — one attempt per
  // bookmark per page load. Failures are sticky for the session: if a
  // site is offline or blocks the fetch, we don't retry until the
  // newtab is reopened, keeping outbound chatter minimal.
  const enrichAttemptedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!ready) return;
    for (const item of items) {
      if (enrichAttemptedRef.current.has(item.id)) continue;
      if (!isAutogeneratedTitle(item.title, item.url)) continue;
      enrichAttemptedRef.current.add(item.id);
      void (async () => {
        const real = await fetchPageTitle(item.url);
        if (!real || !mountedRef.current) return;
        // Re-read the current title just before writing: the user (or
        // another device via Chrome sync) might have renamed it while
        // our fetch was in flight, and we never want to overwrite a
        // human-set name.
        try {
          const [fresh] = await chrome.bookmarks.get(item.id);
          if (!fresh || !isBookmark(fresh)) return;
          if (!isAutogeneratedTitle(fresh.title, fresh.url)) return;
          await chrome.bookmarks.update(item.id, { title: real });
        } catch {
          // Bookmark removed in the meantime — ignore.
        }
      })();
    }
  }, [ready, items]);

  const add = useCallback<HomeShortcutsController["add"]>(
    async ({ title, url }) => {
      const folderId = folderIdRef.current ?? (await ensureFolder());
      folderIdRef.current = folderId;
      const userProvided = title.trim();
      // Use a clean hostname placeholder when the user didn't type a name,
      // so the card looks reasonable instantly. The async enrichment
      // below will swap in the real page `<title>` if we can scrape it.
      const created = await chrome.bookmarks.create({
        parentId: folderId,
        title: userProvided || hostFromUrl(url),
        url,
      });
      if (!userProvided) {
        void (async () => {
          const real = await fetchPageTitle(url);
          if (!real) return;
          try {
            await chrome.bookmarks.update(created.id, { title: real });
            // onChanged listener picks up the rename and refreshes UI.
          } catch {
            // Bookmark was removed before we got here — ignore.
          }
        })();
      }
    },
    [],
  );

  const remove = useCallback<HomeShortcutsController["remove"]>(async (id) => {
    await chrome.bookmarks.remove(id);
  }, []);

  const rename = useCallback<HomeShortcutsController["rename"]>(
    async (id, title) => {
      await chrome.bookmarks.update(id, { title: title.trim() });
    },
    [],
  );

  const reorder = useCallback<HomeShortcutsController["reorder"]>(
    async (fromIndex, toIndex) => {
      const folderId = folderIdRef.current;
      if (!folderId) return;
      const current = items;
      if (
        fromIndex < 0 ||
        fromIndex >= current.length ||
        toIndex < 0 ||
        toIndex >= current.length ||
        fromIndex === toIndex
      ) {
        return;
      }
      const node = current[fromIndex];
      // chrome.bookmarks.move's `index` is the destination index in the
      // parent BEFORE the move is applied. The API handles same-parent
      // moves correctly with the raw target index in the new ordering.
      await chrome.bookmarks.move(node.id, {
        parentId: folderId,
        index: toIndex > fromIndex ? toIndex + 1 : toIndex,
      });
    },
    [items],
  );

  return { ready, items, error, add, remove, rename, reorder, refresh };
}
