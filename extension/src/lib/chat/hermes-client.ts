/**
 * Minimal OpenAI-compatible Chat Completions client targeting the Hermes
 * gateway HTTP API (`gateway/platforms/api_server.py`).
 *
 * Streams server-sent events via fetch+ReadableStream. Calls the per-message
 * `onChunk` callback with each `delta.content` string. Resolves to the final
 * accumulated text once the stream completes (or `[DONE]` arrives).
 */

import type { ChatMessage } from "~lib/types";

/** Merged state for one streamed function tool call (OpenAI-style deltas). */
export interface StreamedToolCall {
  index: number;
  id?: string;
  name: string;
  arguments: string;
}

/**
 * One `event: hermes.tool.progress` frame from the Hermes gateway. The gateway
 * emits these as a separate SSE channel from `delta.content` (see
 * `gateway/platforms/api_server.py:_emit`) so frontends can show a live tool
 * trace without polluting the assistant's final answer. `status` is
 * `"running"` on tool start and `"completed"` on finish — pair them by
 * `toolCallId`.
 */
export interface HermesToolProgress {
  tool: string;
  toolCallId: string;
  status: "running" | "completed";
  label?: string;
  emoji?: string;
}

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
  /** Full merged tool-call rows after each SSE chunk that carries tool deltas. */
  onToolCallsState?: (calls: StreamedToolCall[]) => void;
  /** Model reasoning / thinking tokens when the gateway forwards them. */
  onReasoningChunk?: (delta: string) => void;
  /**
   * Hermes-specific tool-progress events from the gateway's
   * `event: hermes.tool.progress` SSE channel. Use this for live trace UI
   * — `delta.tool_calls` on the standard chat-completions channel is empty
   * in Hermes's agent mode.
   */
  onHermesToolProgress?: (event: HermesToolProgress) => void;
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
  const toolCallsAcc = new Map<
    number,
    { index: number; id?: string; name: string; arguments: string }
  >();

  function mergeToolCallDeltas(
    toolDeltas: unknown,
  ): StreamedToolCall[] | null {
    if (!Array.isArray(toolDeltas) || toolDeltas.length === 0) return null;
    for (const raw of toolDeltas) {
      if (!raw || typeof raw !== "object") continue;
      const tc = raw as Record<string, unknown>;
      const idx = typeof tc.index === "number" ? tc.index : 0;
      const prev = toolCallsAcc.get(idx) ?? {
        index: idx,
        name: "",
        arguments: "",
      };
      if (typeof tc.id === "string" && tc.id) prev.id = tc.id;
      const fn = tc.function as Record<string, unknown> | undefined;
      if (fn) {
        if (typeof fn.name === "string" && fn.name) prev.name = fn.name;
        if (typeof fn.arguments === "string" && fn.arguments)
          prev.arguments += fn.arguments;
      }
      toolCallsAcc.set(idx, prev);
    }
    return Array.from(toolCallsAcc.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({ ...v }));
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const parsed = parseEvent(frame);
      if (parsed != null) {
        const { event, data } = parsed;
        if (data === "[DONE]") return assembled;
        if (event === "hermes.tool.progress") {
          try {
            const obj = JSON.parse(data);
            if (
              obj &&
              typeof obj === "object" &&
              typeof obj.tool === "string" &&
              typeof obj.toolCallId === "string" &&
              (obj.status === "running" || obj.status === "completed")
            ) {
              handlers.onHermesToolProgress?.({
                tool: obj.tool,
                toolCallId: obj.toolCallId,
                status: obj.status,
                label: typeof obj.label === "string" ? obj.label : undefined,
                emoji: typeof obj.emoji === "string" ? obj.emoji : undefined,
              });
            }
          } catch {
            // Non-JSON progress payload; ignore.
          }
        } else {
          try {
            const obj = JSON.parse(data);
            const delta = obj?.choices?.[0]?.delta;
            if (delta?.content) {
              const c = delta.content;
              const piece = typeof c === "string" ? c : "";
              if (piece) {
                assembled += piece;
                handlers.onChunk?.(piece);
              }
            }
            const rc = delta?.reasoning_content;
            if (typeof rc === "string" && rc.length > 0) {
              handlers.onReasoningChunk?.(rc);
            }
            if (delta?.tool_calls) {
              const merged = mergeToolCallDeltas(delta.tool_calls);
              if (merged && merged.length > 0) {
                handlers.onToolCallsState?.(merged);
              }
            }
          } catch {
            // Non-JSON chunk; ignore.
          }
        }
      }
      idx = buffer.indexOf("\n\n");
    }
  }
  return assembled;
}

function parseEvent(
  block: string,
): { event: string; data: string } | null {
  // SSE frame: one or more `data: ...` lines (concatenated with '\n'), plus
  // an optional `event: <name>` line. `id:` is ignored. Default event name
  // for streams without an explicit `event:` is `"message"` per the SSE spec.
  let event = "message";
  let payload = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("data:")) {
      payload += line.slice(5).trimStart() + "\n";
    } else if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    }
  }
  payload = payload.replace(/\n$/, "");
  return payload.length ? { event, data: payload } : null;
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
