/**
 * Typed client for the backplane `/hermes/sessions/*` routes.
 *
 * These wrap Hermes Agent's own SessionDB (the canonical conversation log
 * shared across CLI, gateway, and the dashboard) via the backplane plugin.
 * Available whenever Hermes is running — no `hermes dashboard` needed,
 * since the backplane reads SessionDB directly from-process rather than
 * proxying the dashboard's optional uvicorn app.
 *
 * Style mirrors `hermes-memory.ts` / `hermes-cron.ts`: each call returns
 * a discriminated `{ ok: true, ... } | { ok: false, error }` so callers
 * never have to mix throwing and result types in the same branch.
 */

import { BACKPLANE_HTTP_BASE } from "../background/config";

/**
 * Hermes session row as returned by the backplane. Timestamps are seconds
 * since epoch as floats (SessionDB's native shape); use `secToMs` below
 * if you need milliseconds for `Date` / UI rendering.
 */
export interface HermesSession {
  id: string;
  source: string;
  /** Model id that last touched this session — may be null on fresh rows. */
  model: string | null;
  title: string | null;
  started_at: number;
  ended_at: number | null;
  /** Cached count maintained by SessionDB on every append_message. */
  message_count: number;
  /** First 60 chars of the first user message; null when not yet known. */
  preview?: string | null;
  /** Timestamp of the most recent message; falls back to started_at. */
  last_active?: number;
  /** Computed by the backplane: `ended_at IS NULL && last_active within 5min`. */
  is_active?: boolean;
}

/**
 * One row from the `messages` table. The shape is what SessionDB.get_messages
 * returns, with two JSON columns (`tool_calls`, `reasoning_details`) already
 * decoded. Most fields are nullable in storage and stay that way here —
 * the extension is responsible for picking what to render.
 */
export interface HermesMessage {
  id: number;
  session_id: string;
  role: string;
  /** Plain text or a multimodal parts array (when stored as JSON). */
  content: string | unknown[] | null;
  tool_name: string | null;
  tool_calls: unknown[] | null;
  tool_call_id: string | null;
  timestamp: number;
  token_count: number | null;
  finish_reason: string | null;
  reasoning: string | null;
  reasoning_content: string | null;
  reasoning_details: unknown | null;
  platform_message_id: string | null;
}

export interface ListSessionsResponse {
  ok: true;
  sessions: HermesSession[];
  total: number;
  limit: number;
  offset: number;
}

export interface GetSessionResponse {
  ok: true;
  session: HermesSession;
}

export interface GetMessagesResponse {
  ok: true;
  session_id: string;
  messages: HermesMessage[];
}

export interface CreateSessionResponse {
  ok: true;
  session: HermesSession;
  /** Set when an optional title in the create call collided with an existing one. */
  title_error?: string;
}

export interface AppendMessageResponse {
  ok: true;
  session_id: string;
  message_id: number;
  message: HermesMessage | null;
}

export interface UpdateSessionResponse {
  ok: true;
  session: HermesSession;
}

export interface DeleteSessionResponse {
  ok: true;
  session_id: string;
}

export interface HermesError {
  ok: false;
  /** HTTP status echoed for callers that want to map 404/409/503 differently. */
  status: number;
  error: string;
  /** Title-update failure subkind (`title_conflict` | `invalid_title`). */
  kind?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function stripSlash(b: string): string {
  return b.endsWith("/") ? b.slice(0, -1) : b;
}

function urlFor(suffix: string): string {
  return `${stripSlash(BACKPLANE_HTTP_BASE)}${suffix}`;
}

async function request<T>(
  url: string,
  init: RequestInit = {},
): Promise<T | HermesError> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    // Network-layer failure (backplane down, no Hermes running). Use 0 as
    // the sentinel status so callers can branch on "couldn't reach" vs
    // "reached and got a 4xx/5xx".
    return {
      ok: false,
      status: 0,
      error: String((e as Error)?.message || e),
    };
  }
  // Backplane always returns JSON; we still tolerate a bad body so a
  // transient 502 from some upstream doesn't crash the caller.
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* ignore — handled below */
  }
  if (!res.ok) {
    const body = (data ?? {}) as { error?: string; kind?: string };
    return {
      ok: false,
      status: res.status,
      error: body.error || `${res.status} ${res.statusText}`,
      kind: body.kind,
    };
  }
  return data as T;
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface ListSessionsParams {
  limit?: number;
  offset?: number;
  /** Keep only sessions whose ``source`` equals this value. */
  source?: string;
  /**
   * Drop sessions whose ``source`` matches any entry. Used by the
   * browser extension to hide non-conversational sources (e.g. ``cron``)
   * from the chat-history sidebar.
   */
  excludeSources?: string[];
}

export async function listHermesSessions(
  params: ListSessionsParams = {},
): Promise<ListSessionsResponse | HermesError> {
  const q = new URLSearchParams();
  if (params.limit != null) q.set("limit", String(params.limit));
  if (params.offset != null) q.set("offset", String(params.offset));
  if (params.source) q.set("source", params.source);
  if (params.excludeSources && params.excludeSources.length > 0) {
    // Comma-joined; the backplane accepts both repeated keys and
    // comma-separated lists. Keeps the URL shorter when the list is
    // long.
    q.set("exclude_sources", params.excludeSources.join(","));
  }
  const qs = q.toString();
  return request<ListSessionsResponse>(
    urlFor(`/hermes/sessions${qs ? `?${qs}` : ""}`),
  );
}

export async function getHermesSession(
  id: string,
): Promise<GetSessionResponse | HermesError> {
  return request<GetSessionResponse>(
    urlFor(`/hermes/sessions/${encodeURIComponent(id)}`),
  );
}

export async function getHermesMessages(
  id: string,
): Promise<GetMessagesResponse | HermesError> {
  return request<GetMessagesResponse>(
    urlFor(`/hermes/sessions/${encodeURIComponent(id)}/messages`),
  );
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export interface CreateSessionInput {
  /** Caller-supplied id; the backplane mints a uuid4 hex when omitted. */
  id?: string;
  source?: string;
  model?: string;
  parent_session_id?: string;
  system_prompt?: string;
  user_id?: string;
  title?: string;
}

export async function createHermesSession(
  input: CreateSessionInput = {},
): Promise<CreateSessionResponse | HermesError> {
  return request<CreateSessionResponse>(
    urlFor(`/hermes/sessions`),
    jsonInit("POST", input),
  );
}

/**
 * Input shape for `appendHermesMessage`. Only `role` is required; every
 * other field maps directly to SessionDB.append_message kwargs. Unknown
 * keys are silently dropped server-side, so it's safe to widen this
 * record over time.
 */
export interface AppendMessageInput {
  role: string;
  content?: string | unknown[];
  tool_name?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  token_count?: number;
  finish_reason?: string;
  reasoning?: string;
  reasoning_content?: string;
  reasoning_details?: unknown;
  platform_message_id?: string;
}

export async function appendHermesMessage(
  sessionId: string,
  input: AppendMessageInput,
): Promise<AppendMessageResponse | HermesError> {
  return request<AppendMessageResponse>(
    urlFor(`/hermes/sessions/${encodeURIComponent(sessionId)}/messages`),
    jsonInit("POST", input),
  );
}

export interface UpdateSessionInput {
  /** Empty / whitespace-only string clears the title (Hermes semantics). */
  title?: string;
}

export async function updateHermesSession(
  sessionId: string,
  input: UpdateSessionInput,
): Promise<UpdateSessionResponse | HermesError> {
  return request<UpdateSessionResponse>(
    urlFor(`/hermes/sessions/${encodeURIComponent(sessionId)}`),
    jsonInit("PATCH", input),
  );
}

export async function deleteHermesSession(
  sessionId: string,
): Promise<DeleteSessionResponse | HermesError> {
  return request<DeleteSessionResponse>(
    urlFor(`/hermes/sessions/${encodeURIComponent(sessionId)}`),
    jsonInit("DELETE"),
  );
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/**
 * Convert SessionDB's float-seconds timestamp to the milliseconds the
 * existing UI expects. Returns 0 for nullish input so callers can treat
 * the result as a `Date` argument without crashing.
 */
export function secToMs(seconds: number | null | undefined): number {
  if (seconds == null || !Number.isFinite(seconds)) return 0;
  return Math.round(seconds * 1000);
}
