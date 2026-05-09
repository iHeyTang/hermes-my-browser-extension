/**
 * Multi-session storage schema for the side panel chat.
 *
 * Each session has a stable id (used 1:1 as the `X-Hermes-Session-Id`
 * header) and is persisted in two parts:
 *
 *   - `sessions.index`           — array of lightweight metadata records
 *                                   (id, title, timestamps, flags). Loaded
 *                                   eagerly to render the sidebar.
 *   - `sessions.message.<id>`    — full message history for one session.
 *                                   Loaded on demand when the user opens
 *                                   that session.
 *
 * The active session id is mirrored to the legacy
 * `settings.chat.sessionId` key so the existing Settings page and
 * background pieces (chat-cors helper, etc.) keep working unchanged.
 */

import type { ChatMessage } from "~lib/types";

export interface SessionMeta {
  id: string;
  /** User-visible title; empty means "auto-generate from first user msg". */
  title: string;
  createdAt: number;
  /** Last activity time (last message append, last rename). */
  updatedAt: number;
  pinned?: boolean;
  archived?: boolean;
  /** Cached count so the sidebar doesn't have to load history just to count. */
  messageCount?: number;
  /** Set once the user manually renames; suppresses auto-title regeneration. */
  titleManual?: boolean;
}

export type SessionMessage = ChatMessage;

/** Centralised storage keys so all callers stay in sync. */
export const SESSION_KEYS = {
  /** All sessions ever created — i.e. the "History". */
  index: "sessions.index",
  message: (id: string) => `sessions.message.${id}`,
  /**
   * IDs of the sessions currently shown as tabs in the side panel header,
   * in display order. A subset of `sessions.index`. Closing a tab strips
   * an id from this list but leaves the underlying SessionMeta intact —
   * permanent deletion happens through the History drawer.
   */
  openTabIds: "sessions.openTabIds",
  /** Source of truth for which session is currently displayed. */
  activeId: "sessions.activeId",
  /** Mirror of `activeId` — kept in sync for backward compatibility. */
  legacyActiveId: "settings.chat.sessionId",
  /** Pre-multi-session schema; migrated once on upgrade. */
  legacyHistory: "chat.history",
  migrated: "sessions.migrated",
} as const;

/** Cap retained per-session messages to the previous (`chat.history`) limit. */
export const PER_SESSION_MESSAGE_LIMIT = 200;
