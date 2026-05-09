/**
 * `@require` / `@resource` cache.
 *
 * Stored in IndexedDB so we can survive >5 MB total without bumping into
 * `chrome.storage.local`'s per-extension quota. The runtime fetches the
 * cached entries via `getResourceText` / `getResourceURL` IPC.
 */

import type { ResourceCacheEntry, UserScript } from "~lib/types";

const DB_NAME = "hermes-userscript-cache";
const DB_VERSION = 1;
const STORE = "resources";
const MAX_FETCH_BYTES = 16 * 1024 * 1024; // 16 MB hard ceiling per resource

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("scriptId", "scriptId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function entryKey(scriptId: string, name: string) {
  return `${scriptId}::${name}`;
}

export async function getCachedResource(
  scriptId: string,
  name: string,
): Promise<ResourceCacheEntry | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const req = store.get(entryKey(scriptId, name));
    req.onsuccess = () => {
      const v = req.result as
        | (ResourceCacheEntry & { key: string })
        | undefined;
      resolve(v ? stripKey(v) : null);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function listCachedForScript(
  scriptId: string,
): Promise<ResourceCacheEntry[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const req = store.index("scriptId").getAll(scriptId);
    req.onsuccess = () =>
      resolve(
        (req.result as Array<ResourceCacheEntry & { key: string }>).map(
          stripKey,
        ),
      );
    req.onerror = () => reject(req.error);
  });
}

async function putEntry(entry: ResourceCacheEntry): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    store.put({ ...entry, key: entryKey(entry.scriptId, entry.name) });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function dropScriptResources(scriptId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.index("scriptId").openCursor(scriptId);
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        cur.delete();
        cur.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Fetch every `@require` / `@resource` declared by the script and persist them.
 * Best-effort: a single failed entry is logged but does not abort the rest.
 *
 * Cache keys:
 *  - `@require` entries are stored under name = `require:<url>`. Multiple
 *    `@require` lines therefore round-trip cleanly even when their URLs share
 *    a base path.
 *  - `@resource` entries are stored under their declared `<name>`.
 */
export async function cacheScriptResources(script: UserScript): Promise<void> {
  const tasks: Array<Promise<void>> = [];
  for (const url of script.meta.require) {
    tasks.push(fetchAndStore(script.id, requireName(url), url));
  }
  for (const r of script.meta.resource) {
    tasks.push(fetchAndStore(script.id, r.name, r.url));
  }
  await Promise.all(tasks.map((t) => t.catch(() => undefined)));
}

export function requireName(url: string): string {
  return `require:${url}`;
}

async function fetchAndStore(
  scriptId: string,
  name: string,
  url: string,
): Promise<void> {
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_FETCH_BYTES) {
    throw new Error(
      `Resource ${url} exceeds ${MAX_FETCH_BYTES} bytes (got ${buf.byteLength})`,
    );
  }
  const contentType = res.headers.get("content-type") || "text/plain";
  const text = decodeText(buf, contentType);
  const dataUrl = await arrayBufferToDataUrl(buf, contentType);
  await putEntry({
    scriptId,
    name,
    url,
    text,
    dataUrl,
    contentType,
    fetchedAt: Date.now(),
    bytes: buf.byteLength,
  });
}

function decodeText(buf: ArrayBuffer, _contentType: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(buf);
  } catch {
    return "";
  }
}

async function arrayBufferToDataUrl(
  buf: ArrayBuffer,
  contentType: string,
): Promise<string> {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

function stripKey<T extends { key: string }>(v: T): Omit<T, "key"> {
  const { key: _key, ...rest } = v;
  return rest;
}
