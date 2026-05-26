/**
 * Bookmark operations exposed to the agent over the bridge.
 *
 * Thin wrappers over `chrome.bookmarks.*`. These run in the service-worker
 * context — the only place the `bookmarks` permission grants API access.
 * Content scripts and a page's MAIN world cannot see `chrome.bookmarks` at
 * all, which is why the agent's `eval` can't reach this and dedicated
 * handlers are required.
 *
 * Every function returns plain JSON-serialisable data so `handlers.ts` can
 * hand the result straight back over the WebSocket.
 */

type BookmarkNode = chrome.bookmarks.BookmarkTreeNode;

/** Strip a `BookmarkTreeNode` tree down to the fields the agent needs. */
function serialize(node: BookmarkNode): Record<string, unknown> {
  const out: Record<string, unknown> = { id: node.id, title: node.title };
  if (node.url) out.url = node.url;
  if (node.parentId !== undefined) out.parentId = node.parentId;
  if (node.index !== undefined) out.index = node.index;
  if (node.dateAdded !== undefined) out.dateAdded = node.dateAdded;
  if (node.dateGroupModified !== undefined) {
    out.dateGroupModified = node.dateGroupModified;
  }
  // A folder carries `children`; a leaf bookmark has a `url` and none.
  if (node.children) out.children = node.children.map(serialize);
  return out;
}

/** Guard so a missing permission fails loud instead of `undefined is not...`. */
function ensureApi(): void {
  if (typeof chrome === "undefined" || !chrome.bookmarks) {
    throw new Error(
      'chrome.bookmarks is unavailable — the extension needs the "bookmarks" ' +
        "permission. Fully reload the extension after updating the manifest.",
    );
  }
}

/**
 * Read bookmarks. `query` → title/URL search; `id` → that node's subtree;
 * neither → the whole tree (one root node with everything nested under it).
 */
export async function listBookmarks(
  params: { query?: string; id?: string } = {},
): Promise<{ nodes: Record<string, unknown>[] }> {
  ensureApi();
  const query = typeof params.query === "string" ? params.query.trim() : "";
  const id = typeof params.id === "string" ? params.id.trim() : "";
  let nodes: BookmarkNode[];
  if (query) {
    nodes = await chrome.bookmarks.search(query);
  } else if (id) {
    nodes = await chrome.bookmarks.getSubTree(id);
  } else {
    nodes = await chrome.bookmarks.getTree();
  }
  return { nodes: nodes.map(serialize) };
}

/** Create a bookmark (with `url`) or a folder (without). */
export async function createBookmark(
  params: { parentId?: string; title?: string; url?: string; index?: number } = {},
): Promise<{ node: Record<string, unknown> }> {
  ensureApi();
  const arg: chrome.bookmarks.BookmarkCreateArg = {};
  if (typeof params.parentId === "string" && params.parentId) {
    arg.parentId = params.parentId;
  }
  if (typeof params.title === "string") arg.title = params.title;
  if (typeof params.url === "string" && params.url) arg.url = params.url;
  if (typeof params.index === "number") arg.index = params.index;
  const node = await chrome.bookmarks.create(arg);
  return { node: serialize(node) };
}

/** Rename a node and/or re-point a bookmark's URL. */
export async function updateBookmark(
  params: { id?: string; title?: string; url?: string } = {},
): Promise<{ node: Record<string, unknown> }> {
  ensureApi();
  const id = typeof params.id === "string" ? params.id.trim() : "";
  if (!id) throw new Error("bookmarks.update: id is required");
  const changes: chrome.bookmarks.BookmarkChangesArg = {};
  if (typeof params.title === "string") changes.title = params.title;
  if (typeof params.url === "string") changes.url = params.url;
  if (changes.title === undefined && changes.url === undefined) {
    throw new Error("bookmarks.update: pass title and/or url");
  }
  const node = await chrome.bookmarks.update(id, changes);
  return { node: serialize(node) };
}

/** Relocate a node to another folder and/or position. */
export async function moveBookmark(
  params: { id?: string; parentId?: string; index?: number } = {},
): Promise<{ node: Record<string, unknown> }> {
  ensureApi();
  const id = typeof params.id === "string" ? params.id.trim() : "";
  if (!id) throw new Error("bookmarks.move: id is required");
  const dest: chrome.bookmarks.BookmarkDestinationArg = {};
  if (typeof params.parentId === "string" && params.parentId) {
    dest.parentId = params.parentId;
  }
  if (typeof params.index === "number") dest.index = params.index;
  if (dest.parentId === undefined && dest.index === undefined) {
    throw new Error("bookmarks.move: pass parentId and/or index");
  }
  const node = await chrome.bookmarks.move(id, dest);
  return { node: serialize(node) };
}

/**
 * Delete a node. `chrome.bookmarks.remove` refuses a non-empty folder, so
 * `recursive` switches to `removeTree` for an explicit folder-and-contents
 * delete.
 */
export async function removeBookmark(
  params: { id?: string; recursive?: boolean } = {},
): Promise<{ removed: string }> {
  ensureApi();
  const id = typeof params.id === "string" ? params.id.trim() : "";
  if (!id) throw new Error("bookmarks.remove: id is required");
  if (params.recursive) {
    await chrome.bookmarks.removeTree(id);
  } else {
    await chrome.bookmarks.remove(id);
  }
  return { removed: id };
}
