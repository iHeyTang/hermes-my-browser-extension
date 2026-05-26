/**
 * GET {apiBase}/models — OpenAI-compatible listing used by Hermes gateway.
 */

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

export type FetchHermesModelsResult =
  | { ok: true; ids: string[] }
  | { ok: false; message: string };

export async function fetchHermesModelIds(
  apiBase: string,
  apiKey?: string,
  signal?: AbortSignal,
): Promise<FetchHermesModelsResult> {
  const base = stripTrailingSlash(apiBase.trim() || "");
  if (!base) {
    return { ok: false, message: "API base URL is empty." };
  }
  const url = `${base}/models`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
  try {
    const res = await fetch(url, { method: "GET", headers, signal });
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
