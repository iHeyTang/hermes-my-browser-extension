/**
 * Minimal OpenAI-compatible Chat Completions client targeting the Hermes
 * gateway HTTP API (`gateway/platforms/api_server.py`).
 *
 * Streams server-sent events via fetch+ReadableStream. Calls the per-message
 * `onChunk` callback with each `delta.content` string. Resolves to the final
 * accumulated text once the stream completes (or `[DONE]` arrives).
 */

import type { ChatMessage } from "~lib/types";

export interface HermesClientOptions {
  apiBase: string;
  apiKey?: string;
  model: string;
  sessionId?: string;
  /** Forwarded to fetch as AbortSignal; lets the side panel cancel mid-stream. */
  signal?: AbortSignal;
}

export interface StreamHandlers {
  onChunk?: (delta: string) => void;
  onToolCall?: (call: { name: string; arguments: string }) => void;
  onSession?: (sessionId: string) => void;
}

/**
 * Stream a Chat Completions request. Returns the assembled assistant text on
 * success. Throws on non-2xx HTTP or stream-level errors.
 */
export async function streamChat(
  messages: ChatMessage[],
  opts: HermesClientOptions,
  handlers: StreamHandlers = {},
): Promise<string> {
  const url = `${stripTrailingSlash(opts.apiBase)}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  // The gateway rejects X-Hermes-Session-Id with 403 when no API key is
  // configured server-side, so only opt in to session continuity when the
  // caller has supplied an API key (matching the server's auth-required
  // path).  Stateless chat still works without a key.
  if (opts.sessionId && opts.apiKey) {
    headers["X-Hermes-Session-Id"] = opts.sessionId;
  }

  const body = JSON.stringify({
    model: opts.model,
    stream: true,
    messages: messages.map((m) => ({
      role: m.role,
      // OpenAI Chat Completions accepts either a plain string OR an
      // array of typed content parts. We pick the array shape only when
      // the caller has attached at least one image data URL — that keeps
      // text-only requests on the simpler/older shape that every
      // OpenAI-compatible gateway is guaranteed to understand.
      content:
        m.imageDataUrls && m.imageDataUrls.length > 0
          ? [
              ...(m.content ? [{ type: "text", text: m.content }] : []),
              ...m.imageDataUrls.map((url) => ({
                type: "image_url",
                image_url: { url },
              })),
            ]
          : m.content,
      ...(m.name ? { name: m.name } : {}),
    })),
  });

  const res = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: opts.signal,
  });
  if (!res.ok) {
    const text = await safeText(res);
    throw new HermesHttpError(res.status, text || res.statusText, url);
  }
  const sessionHeader =
    res.headers.get("X-Hermes-Session-Id") ||
    res.headers.get("x-hermes-session-id");
  if (sessionHeader && handlers.onSession) handlers.onSession(sessionHeader);

  if (!res.body) throw new Error("Hermes returned no response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let assembled = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const text = parseEvent(event);
      if (text != null) {
        if (text === "[DONE]") return assembled;
        try {
          const obj = JSON.parse(text);
          const delta = obj?.choices?.[0]?.delta;
          if (delta?.content) {
            assembled += delta.content;
            handlers.onChunk?.(delta.content);
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc?.function?.name && handlers.onToolCall) {
                handlers.onToolCall({
                  name: tc.function.name,
                  arguments: tc.function.arguments || "",
                });
              }
            }
          }
        } catch {
          // Non-JSON chunk; ignore.
        }
      }
      idx = buffer.indexOf("\n\n");
    }
  }
  return assembled;
}

function parseEvent(block: string): string | null {
  // SSE frame is one or more `data: ...` lines separated by '\n', possibly
  // with leading `event:` / `id:` lines we ignore.
  let payload = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("data:")) {
      payload += line.slice(5).trimStart() + "\n";
    }
  }
  payload = payload.replace(/\n$/, "");
  return payload.length ? payload : null;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Typed error so callers can render an actionable message based on the HTTP
 * status. The Hermes gateway uses 401 for missing/invalid Bearer key and 403
 * for CORS rejection or session-continuity-without-key violations.
 */
export class HermesHttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly url: string;

  constructor(status: number, body: string, url: string) {
    super(`Hermes ${status}: ${body || "(empty)"}`);
    this.name = "HermesHttpError";
    this.status = status;
    this.body = body;
    this.url = url;
  }

  /** Human-friendly hint for the side panel's error banner. */
  hint(): string {
    if (this.status === 401) {
      return (
        "The Hermes gateway requires an API key. Open Settings and paste " +
        "the value of API_SERVER_KEY from ~/.hermes/.env."
      );
    }
    if (this.status === 403) {
      return (
        "CORS blocked by the gateway. Server-side fix (one shell command):\n" +
        "  printf '\\nAPI_SERVER_CORS_ORIGINS=*\\n' >> ~/.hermes/.env && " +
        "hermes gateway restart\n" +
        "(API server binds to 127.0.0.1 only, so '*' is safe.)"
      );
    }
    if (this.status === 404) {
      return (
        "Endpoint not found. Verify the API base URL in Settings — it should " +
        "end in /v1, e.g. http://127.0.0.1:8642/v1"
      );
    }
    if (this.status >= 500) {
      return "Hermes gateway error — check ~/.hermes/logs/gateway.log.";
    }
    return "";
  }
}
