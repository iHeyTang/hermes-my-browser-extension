/**
 * Multi-session storage schema for the side panel chat.
 *
 * The canonical session log lives in Hermes Agent's ``state.db`` via
 * the backplane's ``/hermes/sessions/*`` HTTP routes (see ``store.ts``).
 * This file keeps the React-facing types and the ``chrome.storage.local``
 * keys for the small surface that *isn't* canonical:
 *
 *   - ``sessions.activeId``      — which open tab is currently displayed
 *   - ``sessions.openTabIds``    — ordered open-tab list in the panel header
 *   - ``sessions.local-meta``    — per-session UI-only flags
 *                                   (pinned / archived / titleManual)
 *
 * The legacy keys below (``sessions.index`` / ``sessions.message.<id>`` /
 * ``chat.history``) are kept around solely so the one-shot migration in
 * ``migrate.ts`` can read them and push the data to Hermes. New code
 * should never touch them.
 *
 * The active session id is mirrored to the legacy
 * ``settings.chat.sessionId`` key so the existing Settings page and
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

/**
 * UI-only per-session flags that don't have a counterpart in Hermes.
 * Stored together in one ``chrome.storage.local`` key
 * (``sessions.local-meta``) keyed by session id, so a save is one storage
 * op regardless of how many sessions changed.
 */
export interface SessionLocalMeta {
  pinned?: boolean;
  archived?: boolean;
  titleManual?: boolean;
}

/** Centralised storage keys so all callers stay in sync. */
export const SESSION_KEYS = {
  /** Legacy local-mirrored index; only read by ``migrate.ts``. */
  index: "sessions.index",
  /** Legacy per-session message log; only read by ``migrate.ts``. */
  message: (id: string) => `sessions.message.${id}`,
  /**
   * IDs of the sessions currently shown as tabs in the side panel header,
   * in display order. A subset of the live Hermes session list. Closing
   * a tab strips an id from this list but leaves the underlying Hermes
   * session intact — permanent deletion happens through the History
   * drawer.
   */
  openTabIds: "sessions.openTabIds",
  /** Source of truth for which session is currently displayed. */
  activeId: "sessions.activeId",
  /** Mirror of `activeId` — kept in sync for backward compatibility. */
  legacyActiveId: "settings.chat.sessionId",
  /** Pre-multi-session schema; only read by ``migrate.ts``. */
  legacyHistory: "chat.history",
  /** v0.3 → multi-session migration completion flag. */
  migrated: "sessions.migrated",
  /** Multi-session local → Hermes migration completion flag. */
  migratedToHermes: "sessions.migrated.hermes",
} as const;

/** chrome.storage key for the local-only UI-meta sidecar. */
export const LOCAL_META_KEY = "sessions.local-meta" as const;
