/**
 * One-shot migration from ``chrome.storage.local`` to Hermes (state.db
 * via the backplane's ``/hermes/sessions/*`` routes).
 *
 * Runs at most once per install — we drop a ``sessions.migrated.hermes``
 * flag on completion. The pre-Hermes data is left untouched on disk as a
 * one-version rollback safety net; we can prune it in a later release
 * once we trust the new path.
 *
 * Two legacy shapes are handled:
 *
 *   1. **v0.3 single-session** — one ``chat.history`` ChatMessage[] plus
 *      ``settings.chat.sessionId``. Wrapped into one synthesised session
 *      named "Imported chat".
 *
 *   2. **Multi-session ``chrome.storage.local``** — ``sessions.index``
 *      (SessionMeta[]) plus ``sessions.message.<id>``. Each id is
 *      forwarded as-is so cross-references (active id, open tabs) keep
 *      working post-migration.
 *
 * For both, UI-only flags (pinned / archived / titleManual) are copied
 * into the new ``sessions.local-meta`` sidecar.
 *
 * Idempotency strategy: ``createHermesSession`` is INSERT-OR-IGNORE at
 * the SessionDB level, so re-creating a session row is safe. Messages
 * are NOT idempotent on append. We guard with a pre-flight
 * ``getHermesMessages`` per session and SKIP any session that already
 * has messages on the server — that protects against double-append if
 * the migration crashed partway and is being retried.
 *
 * Network failures bail without setting the flag, so the next panel
 * open retries. We log to console but don't surface a UI error here —
 * the broader app still works (it'll just see an empty session list
 * until migration completes).
 */

import { shortId } from "~lib/utils";

import {
  appendHermesMessage,
  createHermesSession,
  getHermesMessages,
} from "../hermes-sessions";
import { deriveTitleFromMessages } from "./store";
import {
  LOCAL_META_KEY,
  SESSION_KEYS,
  type SessionLocalMeta,
  type SessionMessage,
  type SessionMeta,
} from "./types";

const SOURCE_TAG = "browser-extension";

/**
 * Map a SessionMessage (= ChatMessage) into the AppendMessageInput shape.
 * Mirrors ``sessionMessageToHermes`` in store.ts but kept inline so
 * migrate.ts has no implicit dependency on store internals.
 */
function toAppendInput(msg: SessionMessage): {
  role: string;
  content?: string;
} {
  return { role: msg.role, content: msg.content ?? "" };
}

async function migrateOneSession(
  meta: SessionMeta,
  messages: SessionMessage[],
): Promise<{ ok: boolean; reason?: string }> {
  // Create (or no-op) the row first.
  const create = await createHermesSession({
    id: meta.id,
    source: SOURCE_TAG,
    title: meta.title?.trim() ? meta.title : undefined,
  });
  if (create.ok === false) {
    return { ok: false, reason: `createHermesSession: ${create.error}` };
  }

  // If Hermes already has messages for this id, treat the row as
  // already-migrated to avoid double-appending on a retry.
  const existing = await getHermesMessages(meta.id);
  if (existing.ok === true) {
    if (existing.messages.length > 0) {
      return { ok: true, reason: "already-migrated" };
    }
  } else if (existing.status !== 404) {
    return { ok: false, reason: `getHermesMessages: ${existing.error}` };
  }

  for (const msg of messages) {
    const appended = await appendHermesMessage(meta.id, toAppendInput(msg));
    if (appended.ok === false) {
      return { ok: false, reason: `appendHermesMessage: ${appended.error}` };
    }
  }
  return { ok: true };
}

async function gatherSidecar(
  metas: SessionMeta[],
): Promise<Record<string, SessionLocalMeta>> {
  const out: Record<string, SessionLocalMeta> = {};
  for (const m of metas) {
    const slot: SessionLocalMeta = {};
    if (m.pinned) slot.pinned = true;
    if (m.archived) slot.archived = true;
    if (m.titleManual) slot.titleManual = true;
    if (Object.keys(slot).length > 0) out[m.id] = slot;
  }
  return out;
}

async function readLegacyMessageStore(
  ids: string[],
): Promise<Record<string, SessionMessage[]>> {
  if (ids.length === 0) return {};
  const keys = ids.map((id) => SESSION_KEYS.message(id));
  const r = await chrome.storage.local.get(keys);
  const out: Record<string, SessionMessage[]> = {};
  for (const id of ids) {
    const v = r[SESSION_KEYS.message(id)];
    out[id] = Array.isArray(v) ? (v as SessionMessage[]) : [];
  }
  return out;
}

export async function migrateLegacyChatHistory(): Promise<void> {
  const r = await chrome.storage.local.get([
    SESSION_KEYS.migratedToHermes,
    SESSION_KEYS.index,
    SESSION_KEYS.legacyHistory,
    SESSION_KEYS.legacyActiveId,
  ]);

  if (r[SESSION_KEYS.migratedToHermes]) return;

  // Path A: multi-session local schema. Push every session row + messages
  // to Hermes.
  let metas: SessionMeta[] = Array.isArray(r[SESSION_KEYS.index])
    ? (r[SESSION_KEYS.index] as SessionMeta[])
    : [];

  // Path B: pre-v0.3 single-session schema. Wrap into a one-session
  // metas[] so the same code path handles both.
  if (metas.length === 0 && Array.isArray(r[SESSION_KEYS.legacyHistory])) {
    const legacyMsgs = r[SESSION_KEYS.legacyHistory] as SessionMessage[];
    if (legacyMsgs.length > 0) {
      const legacyId =
        typeof r[SESSION_KEYS.legacyActiveId] === "string" &&
        r[SESSION_KEYS.legacyActiveId]
          ? (r[SESSION_KEYS.legacyActiveId] as string)
          : shortId("sess");
      const now = Date.now();
      metas = [
        {
          id: legacyId,
          title: deriveTitleFromMessages(legacyMsgs, "Imported chat"),
          createdAt: now,
          updatedAt: now,
          messageCount: legacyMsgs.length,
        },
      ];
      // Stage the single-session message store under the multi-session
      // key shape so the next step's bulk read finds it.
      await chrome.storage.local.set({
        [SESSION_KEYS.message(legacyId)]: legacyMsgs,
      });
    }
  }

  if (metas.length === 0) {
    // Nothing to migrate — mark done so we don't re-check every load.
    await chrome.storage.local.set({
      [SESSION_KEYS.migratedToHermes]: true,
    });
    return;
  }

  const messagesBySid = await readLegacyMessageStore(metas.map((m) => m.id));

  const failures: { id: string; reason: string }[] = [];
  for (const meta of metas) {
    const res = await migrateOneSession(meta, messagesBySid[meta.id] ?? []);
    if (!res.ok) {
      failures.push({ id: meta.id, reason: res.reason || "unknown" });
    }
  }

  if (failures.length > 0) {
    // Partial failure — log + bail without setting the flag so the next
    // panel open retries. Sessions that DID migrate are idempotent on
    // retry (createHermesSession is INSERT OR IGNORE, and we skip
    // sessions whose Hermes row already has messages).
    console.warn(
      "[hermes-sessions] migration partial; will retry on next load",
      failures,
    );
    return;
  }

  // All session bodies migrated; push the local-only sidecar over too.
  const sidecar = await gatherSidecar(metas);
  if (Object.keys(sidecar).length > 0) {
    await chrome.storage.local.set({ [LOCAL_META_KEY]: sidecar });
  }

  await chrome.storage.local.set({
    [SESSION_KEYS.migratedToHermes]: true,
  });
}
