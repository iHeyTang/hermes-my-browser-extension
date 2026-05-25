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

/**
 * Helper-internal envelope: success wraps the wire body in ``value``.
 *
 * Why this shape: backplane endpoints now return upstream-aligned shapes
 * (e.g. ``GET /hermes/sessions/{id}`` returns the session dict directly,
 * not ``{ok, session}``), so we can no longer assume the wire body
 * carries an ``ok`` discriminator. Wrapping at the helper layer keeps
 * callers' control flow (``if (r.ok)``) working regardless of whether
 * the underlying endpoint returns an object, an array, or a scalar.
 */
type Ok<T> = { ok: true; value: T };

/**
 * Explicit type guard for the failure branch of ``request<T>``.
 * TypeScript's structural narrowing on ``!r.ok`` doesn't always
 * propagate through the generic ``Ok<T>``; this user-defined predicate
 * forces the narrow so call sites can ``if (isReqErr(r)) return r;``
 * and then use ``r.value`` in the success branch without casts.
 */
function isReqErr<T>(r: Ok<T> | HermesError): r is HermesError {
  return r.ok === false;
}

async function request<T>(
  url: string,
  init: RequestInit = {},
): Promise<Ok<T> | HermesError> {
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
  return { ok: true, value: data as T };
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
  // Wire body matches upstream GET /api/sessions: {sessions, total, limit, offset}.
  const r = await request<{
    sessions: HermesSession[];
    total: number;
    limit: number;
    offset: number;
  }>(urlFor(`/hermes/sessions${qs ? `?${qs}` : ""}`));
  if (isReqErr(r)) return r;
  return { ok: true, ...r.value };
}

export async function getHermesSession(
  id: string,
): Promise<GetSessionResponse | HermesError> {
  // Wire body matches upstream GET /api/sessions/{id}: the session dict
  // directly (no ``{ok, session}`` envelope).
  const r = await request<HermesSession>(
    urlFor(`/hermes/sessions/${encodeURIComponent(id)}`),
  );
  if (isReqErr(r)) return r;
  return { ok: true, session: r.value };
}

export async function getHermesMessages(
  id: string,
): Promise<GetMessagesResponse | HermesError> {
  // Wire body matches upstream GET /api/sessions/{id}/messages:
  // {session_id, messages}.
  const r = await request<{ session_id: string; messages: HermesMessage[] }>(
    urlFor(`/hermes/sessions/${encodeURIComponent(id)}/messages`),
  );
  if (isReqErr(r)) return r;
  return { ok: true, ...r.value };
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
  // POST /hermes/sessions is mine-only (no upstream equivalent); wire
  // still carries ``{ok, session, title_error?}`` since I haven't
  // re-aligned write paths. Spread keeps it.
  const r = await request<{
    ok?: true;
    session: HermesSession;
    title_error?: string;
  }>(urlFor(`/hermes/sessions`), jsonInit("POST", input));
  if (isReqErr(r)) return r;
  return { ok: true, session: r.value.session, title_error: r.value.title_error };
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
  // Mine-only write path; wire keeps the {ok, session_id, message_id, message} envelope.
  const r = await request<{
    ok?: true;
    session_id: string;
    message_id: number;
    message: HermesMessage | null;
  }>(
    urlFor(`/hermes/sessions/${encodeURIComponent(sessionId)}/messages`),
    jsonInit("POST", input),
  );
  if (isReqErr(r)) return r;
  return {
    ok: true,
    session_id: r.value.session_id,
    message_id: r.value.message_id,
    message: r.value.message,
  };
}

export interface UpdateSessionInput {
  /** Empty / whitespace-only string clears the title (Hermes semantics). */
  title?: string;
}

export async function updateHermesSession(
  sessionId: string,
  input: UpdateSessionInput,
): Promise<UpdateSessionResponse | HermesError> {
  // Mine-only write path; wire keeps {ok, session}.
  const r = await request<{ ok?: true; session: HermesSession }>(
    urlFor(`/hermes/sessions/${encodeURIComponent(sessionId)}`),
    jsonInit("PATCH", input),
  );
  if (isReqErr(r)) return r;
  return { ok: true, session: r.value.session };
}

export async function deleteHermesSession(
  sessionId: string,
): Promise<DeleteSessionResponse | HermesError> {
  // Wire matches upstream DELETE /api/sessions/{id}: just ``{ok: true}``.
  const r = await request<{ ok?: true }>(
    urlFor(`/hermes/sessions/${encodeURIComponent(sessionId)}`),
    jsonInit("DELETE"),
  );
  if (isReqErr(r)) return r;
  return { ok: true };
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
