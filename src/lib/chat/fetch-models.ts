/**
 * GET /v1/models — OpenAI-compatible listing.
 *
 * Routed through the backplane (which reverse-proxies to the Hermes
 * gateway at 127.0.0.1:8642/v1/models). The backplane handles
 * upstream auth via `API_SERVER_KEY`; the only key callers need to
 * supply is the backplane key, which `backplaneFetch` injects from
 * storage.
 */

import { backplaneFetch } from "../backplane-client";

export type FetchHermesModelsResult =
  | { ok: true; ids: string[] }
  | { ok: false; message: string };

export async function fetchHermesModelIds(
  signal?: AbortSignal,
): Promise<FetchHermesModelsResult> {
  try {
    const res = await backplaneFetch("/v1/models", {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        message: `${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      };
    }
    const json: unknown = await res.json();
    const ids: string[] = [];
    if (
      json &&
      typeof json === "object" &&
      Array.isArray((json as { data?: unknown }).data)
    ) {
      for (const item of (json as { data: unknown[] }).data) {
        if (
          item &&
          typeof item === "object" &&
          typeof (item as { id?: unknown }).id === "string"
        ) {
          ids.push((item as { id: string }).id);
        }
      }
    } else if (
      json &&
      typeof json === "object" &&
      Array.isArray((json as { models?: unknown }).models)
    ) {
      for (const item of (json as { models: unknown[] }).models) {
        if (typeof item === "string") ids.push(item);
        else if (
          item &&
          typeof item === "object" &&
          typeof (item as { id?: unknown }).id === "string"
        ) {
          ids.push((item as { id: string }).id);
        }
      }
    }
    const seen = new Set<string>();
    const unique = ids.filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    return { ok: true, ids: unique };
  } catch (e) {
    return {
      ok: false,
      message: String((e as Error)?.message || e),
    };
  }
}
