/**
 * Low-level CRUD over `chrome.storage.local` for the multi-session schema.
 * All callers go through this module so we can change persistence backends
 * (e.g. mirror to the Hermes plugin via the WS bridge) in one place later.
 */

import { shortId } from "~lib/utils";

import {
  PER_SESSION_MESSAGE_LIMIT,
  SESSION_KEYS,
  type SessionMessage,
  type SessionMeta,
} from "./types";

export async function loadIndex(): Promise<SessionMeta[]> {
  const r = await chrome.storage.local.get([SESSION_KEYS.index]);
  const v = r[SESSION_KEYS.index];
  return Array.isArray(v) ? (v as SessionMeta[]) : [];
}

export async function saveIndex(index: SessionMeta[]): Promise<void> {
  await chrome.storage.local.set({ [SESSION_KEYS.index]: index });
}

/**
 * UI-only fields that must NOT survive to disk: rendered markdown that may
 * change format across builds (`streamVerbose`). Raw inputs that feed that
 * markdown (`hermesToolProgress`, `assistantTimeline`) ARE persisted —
 * they have stable schemas (toolCallId / status / etc.) and let the panel
 * still show the agent's tool trace and interleaved text/tool order on
 * reopen.
 *
 * `streaming` is intentionally NOT stripped any more: the agent loop now
 * runs in the service worker, so when the panel reopens mid-stream the
 * spinner should appear immediately (before the SW snapshot arrives) and
 * the `handleSnapshot` reconciliation will either keep it (still
 * streaming), clear it with the accumulated text (finished), or mark
 * it `[interrupted]` (SW was killed). Without persisting the flag we'd
 * flicker spinnerless on reopen.
 *
 * `uiId` could in principle be regenerated on load, but we keep it stable
 * across reloads so React keys + per-bubble state (e.g. an expanded chip)
 * don't reset every time the panel rehydrates.
 */
const VOLATILE_MESSAGE_FIELDS = ["streamVerbose"] as const;

function stripVolatile(msg: SessionMessage): SessionMessage {
  const out: Record<string, unknown> = { ...msg };
  for (const k of VOLATILE_MESSAGE_FIELDS) delete out[k];
  return out as unknown as SessionMessage;
}

export async function loadMessages(id: string): Promise<SessionMessage[]> {
  if (!id) return [];
  const key = SESSION_KEYS.message(id);
  const r = await chrome.storage.local.get([key]);
  const v = r[key];
  if (!Array.isArray(v)) return [];
  // Sanitize anything older builds may have persisted (verbose markdown
  // with `### Tools` headings, stale streaming flags, etc.).
  return (v as SessionMessage[]).map(stripVolatile);
}

export async function saveMessages(
  id: string,
  messages: SessionMessage[],
): Promise<void> {
  if (!id) return;
  const key = SESSION_KEYS.message(id);
  const trimmed = messages.slice(-PER_SESSION_MESSAGE_LIMIT).map(stripVolatile);
  await chrome.storage.local.set({ [key]: trimmed });
}

export async function dropMessages(id: string): Promise<void> {
  if (!id) return;
  await chrome.storage.local.remove(SESSION_KEYS.message(id));
}

export async function loadActiveId(): Promise<string> {
  const r = await chrome.storage.local.get([
    SESSION_KEYS.activeId,
    SESSION_KEYS.legacyActiveId,
  ]);
  const modern = r[SESSION_KEYS.activeId];
  if (typeof modern === "string" && modern) return modern;
  const legacy = r[SESSION_KEYS.legacyActiveId];
  return typeof legacy === "string" ? legacy : "";
}

/**
 * Persist the active session id. We mirror it to `settings.chat.sessionId`
 * so existing surfaces (Options → Settings, the chat client) keep reading
 * the same value.
 */
export async function saveActiveId(id: string): Promise<void> {
  await chrome.storage.local.set({
    [SESSION_KEYS.activeId]: id,
    [SESSION_KEYS.legacyActiveId]: id,
  });
}

export async function loadOpenTabIds(): Promise<string[]> {
  const r = await chrome.storage.local.get([SESSION_KEYS.openTabIds]);
  const v = r[SESSION_KEYS.openTabIds];
  return Array.isArray(v) ? (v as string[]).filter((x) => typeof x === "string") : [];
}

export async function saveOpenTabIds(ids: string[]): Promise<void> {
  await chrome.storage.local.set({ [SESSION_KEYS.openTabIds]: ids });
}

/** Build a fresh metadata record. Caller is responsible for inserting it. */
export function newSessionMeta(
  opts: { id?: string; title?: string } = {},
): SessionMeta {
  const now = Date.now();
  return {
    id: opts.id ?? shortId("sess"),
    title: opts.title ?? "",
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
  };
}

/**
 * Heuristic for the auto-generated session title. Takes the first user
 * message, normalises whitespace, and truncates with an ellipsis.
 */
export function deriveTitleFromMessages(
  messages: SessionMessage[],
  fallback = "New chat",
): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser?.content) return fallback;
  const cleaned = firstUser.content.replace(/\s+/g, " ").trim();
  if (!cleaned) return fallback;
  const max = 40;
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max - 1) + "…";
}
