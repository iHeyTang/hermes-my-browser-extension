/**
 * Single fetch entry point for talking to the local backplane plugin
 * (`http://127.0.0.1:9394`).
 *
 * Auth: reads the user's `HERMES_BACKPLANE_KEY` mirror from
 * `chrome.storage.local` (`settings.backplane.key`) and injects it as
 * `Authorization: Bearer …` when present. When empty, no auth header
 * is sent — backplane accepts unauthenticated requests on loopback,
 * matching the pre-key behaviour.
 *
 * Use this for every route under `/hermes/*`, `/integrations/*`, and
 * `/v1/*` (chat completions, runs, models, approval — backplane
 * reverse-proxies those to the Hermes gateway internally).
 */

import {
  BACKPLANE_HTTP_BASE,
  BACKPLANE_KEY_STORAGE_KEY,
} from "../background/config";

async function readBackplaneKey(): Promise<string> {
  try {
    const r = await chrome.storage.local.get(BACKPLANE_KEY_STORAGE_KEY);
    const v = r[BACKPLANE_KEY_STORAGE_KEY];
    return typeof v === "string" ? v.trim() : "";
  } catch {
    return "";
  }
}

function resolveUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const slash = path.startsWith("/") ? "" : "/";
  return `${BACKPLANE_HTTP_BASE}${slash}${path}`;
}

export async function backplaneFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = resolveUrl(path);
  const key = await readBackplaneKey();
  const headers = new Headers(init.headers || {});
  if (key && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${key}`);
  }
  return fetch(url, { ...init, headers });
}

/**
 * Synchronous URL builder for cases where `fetch` is called from a
 * non-async context (rare — only useful when you can't `await` to
 * read the key). Caller is responsible for adding the Authorization
 * header separately.
 */
export function backplaneUrl(path: string): string {
  return resolveUrl(path);
}
