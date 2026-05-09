/**
 * One-shot migration from the v0.3 single-session schema to multi-session.
 *
 *   Before:
 *     - `chat.history`              ChatMessage[]    (single conversation)
 *     - `settings.chat.sessionId`   string           (single id)
 *
 *   After:
 *     - `sessions.index`            SessionMeta[]
 *     - `sessions.message.<id>`     ChatMessage[]
 *     - `sessions.activeId`         string  (mirrored to settings.chat.sessionId)
 *
 * Idempotent: drops a `sessions.migrated=true` flag once the work is done
 * so subsequent loads are no-ops. The old `chat.history` key is deliberately
 * left in place — keeping a one-version safety net in case a user rolls
 * back the extension. We can remove it in a later release.
 */

import { shortId } from "~lib/utils";

import {
  loadIndex,
  newSessionMeta,
  saveActiveId,
  saveIndex,
  saveMessages,
  saveOpenTabIds,
  deriveTitleFromMessages,
} from "./store";
import {
  SESSION_KEYS,
  type SessionMessage,
  type SessionMeta,
} from "./types";

export async function migrateLegacyChatHistory(): Promise<void> {
  const r = await chrome.storage.local.get([
    SESSION_KEYS.migrated,
    SESSION_KEYS.index,
    SESSION_KEYS.legacyHistory,
    SESSION_KEYS.legacyActiveId,
  ]);

  if (r[SESSION_KEYS.migrated]) return;

  // Already running on the new schema (e.g. fresh install). Mark as
  // migrated so we don't re-check on every panel open.
  if (Array.isArray(r[SESSION_KEYS.index])) {
    await chrome.storage.local.set({ [SESSION_KEYS.migrated]: true });
    return;
  }

  const legacy = r[SESSION_KEYS.legacyHistory];
  if (!Array.isArray(legacy) || legacy.length === 0) {
    await chrome.storage.local.set({
      [SESSION_KEYS.migrated]: true,
      [SESSION_KEYS.index]: [],
    });
    return;
  }

  const messages = legacy as SessionMessage[];
  const legacyId =
    typeof r[SESSION_KEYS.legacyActiveId] === "string" &&
    r[SESSION_KEYS.legacyActiveId]
      ? (r[SESSION_KEYS.legacyActiveId] as string)
      : shortId("sess");

  const meta: SessionMeta = newSessionMeta({
    id: legacyId,
    title: deriveTitleFromMessages(messages, "Imported chat"),
  });
  meta.messageCount = messages.length;
  meta.updatedAt = Date.now();

  // Don't clobber a partially-migrated state if loadIndex returned items.
  const existing = await loadIndex();
  const merged = existing.some((s) => s.id === meta.id)
    ? existing
    : [meta, ...existing];

  await saveMessages(meta.id, messages);
  await saveIndex(merged);
  await saveActiveId(meta.id);
  // Open the migrated session as the only tab so the user lands on it.
  await saveOpenTabIds([meta.id]);
  await chrome.storage.local.set({ [SESSION_KEYS.migrated]: true });
}
