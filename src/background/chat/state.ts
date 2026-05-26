/**
 * Per-session runtime state for the in-flight chat stream.
 *
 * Two storage layers:
 *   - In-memory `runtime` map — fast path; readers (port snapshots, engine
 *     mutations) hit this directly.
 *   - `chrome.storage.session` — throttled write-through so the side panel
 *     can recover the partial assistant message after closing+reopening
 *     mid-stream. Session storage is fast (memory-backed) and clears on
 *     browser restart, which matches the lifecycle we want for "in-flight"
 *     turns.
 *
 * The engine writes the *whole* state object on every flush; readers always
 * see a coherent snapshot. We rely on session storage atomicity here.
 */

import type { ChatRuntimeState } from "./types";

const STORAGE_KEY_PREFIX = "chat.runtime.";
/**
 * Drops one storage write per stream chunk down to ~5/s on hot streams. The
 * panel still gets every delta over the live port; persistence is just a
 * safety net for "panel was closed while streaming".
 */
const PERSIST_THROTTLE_MS = 200;

const runtime = new Map<string, ChatRuntimeState>();
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

function storageKey(sessionId: string): string {
  return `${STORAGE_KEY_PREFIX}${sessionId}`;
}

export function getState(sessionId: string): ChatRuntimeState | null {
  return runtime.get(sessionId) ?? null;
}

export function setState(state: ChatRuntimeState): void {
  state.updatedAt = Date.now();
  runtime.set(state.sessionId, state);
  schedulePersist(state.sessionId);
}

/**
 * Read-modify-write under a single map lookup. The reducer returns a partial
 * patch (or `null` to skip the write). Always reschedules persistence so
 * even a no-op patch can poke the throttle if needed — pass `null` to avoid
 * the write entirely.
 */
export function mutateState(
  sessionId: string,
  reduce: (cur: ChatRuntimeState) => Partial<ChatRuntimeState> | null,
): ChatRuntimeState | null {
  const cur = runtime.get(sessionId);
  if (!cur) return null;
  const patch = reduce(cur);
  if (!patch) return cur;
  const next: ChatRuntimeState = {
    ...cur,
    ...patch,
    updatedAt: Date.now(),
  };
  runtime.set(sessionId, next);
  schedulePersist(sessionId);
  return next;
}

export function clearState(sessionId: string): void {
  runtime.delete(sessionId);
  const t = persistTimers.get(sessionId);
  if (t) {
    clearTimeout(t);
    persistTimers.delete(sessionId);
  }
  void chrome.storage.session.remove(storageKey(sessionId)).catch(() => {});
}

function schedulePersist(sessionId: string): void {
  if (persistTimers.has(sessionId)) return;
  const timer = setTimeout(() => {
    persistTimers.delete(sessionId);
    void flushPersist(sessionId);
  }, PERSIST_THROTTLE_MS);
  persistTimers.set(sessionId, timer);
}

/** Force-write current state for one session. Always called at stream end. */
export async function flushPersist(sessionId: string): Promise<void> {
  const t = persistTimers.get(sessionId);
  if (t) {
    clearTimeout(t);
    persistTimers.delete(sessionId);
  }
  const state = runtime.get(sessionId);
  if (!state) return;
  try {
    await chrome.storage.session.set({ [storageKey(sessionId)]: state });
  } catch (e) {
    console.warn("[chat-engine] persist failed:", e);
  }
}

/**
 * Reload runtime state from session storage on SW startup. If the SW was
 * killed while a stream was in flight (fetch died with it), mark those
 * sessions as `streaming: false` with an error so the panel can render
 * them as interrupted rather than spinning forever.
 */
export async function hydrateFromStorage(): Promise<void> {
  try {
    // `get(null)` returns every key; the @types/chrome typing doesn't
    // expose that overload uniformly across versions, so we cast through
    // `unknown` to avoid pinning ourselves to one type-package release.
    const all = (await (
      chrome.storage.session.get as unknown as (
        k: null,
      ) => Promise<Record<string, unknown>>
    )(null)) as Record<string, unknown>;
    const restored: Record<string, ChatRuntimeState> = {};
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(STORAGE_KEY_PREFIX)) continue;
      const s = value as ChatRuntimeState | undefined;
      if (!s || typeof s.sessionId !== "string" || !s.sessionId) continue;
      if (s.streaming) {
        s.streaming = false;
        s.error = s.error ?? {
          message: "Background restarted while streaming.",
        };
        restored[storageKey(s.sessionId)] = s;
      }
      runtime.set(s.sessionId, s);
    }
    // Write back any state we modified so a subsequent SW restart doesn't
    // see stale `streaming: true` flags.
    if (Object.keys(restored).length > 0) {
      await chrome.storage.session.set(restored);
    }
  } catch (e) {
    console.warn("[chat-engine] hydrate failed:", e);
  }
}
