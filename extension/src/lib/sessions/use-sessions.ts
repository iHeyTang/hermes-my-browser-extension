/**
 * React hook that owns the session list, the active session id, and the
 * messages of the active session. Persistence is delegated to `store.ts`
 * and runs through `chrome.storage.local`; cross-tab sync is handled via
 * `chrome.storage.onChanged`.
 *
 * Two-layer model (Cursor-style tabs):
 *
 *   - `sessions`     — the full History; every conversation ever created.
 *   - `openTabIds`   — the working set, in order, shown in the side panel
 *                       header. Closing a tab strips it from this list but
 *                       leaves the underlying session intact.
 *   - `activeId`     — which open tab is currently displayed.
 *
 * Permanent deletion (`remove`) drops the session from BOTH lists and
 * deletes its message file; closing a tab (`closeTab`) is non-destructive.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { migrateLegacyChatHistory } from "./migrate";
import {
  deriveTitleFromMessages,
  dropMessages,
  loadActiveId,
  loadIndex,
  loadMessages,
  loadOpenTabIds,
  newSessionMeta,
  saveActiveId,
  saveIndex,
  saveMessages,
  saveOpenTabIds,
} from "./store";
import { SESSION_KEYS, type SessionMessage, type SessionMeta } from "./types";

export interface SessionsController {
  /** True once initial load + migration completes. */
  ready: boolean;
  /** Every session in storage (the History view). */
  sessions: SessionMeta[];
  /** Ordered ids of sessions currently shown as tabs in the header. */
  openTabIds: string[];
  /** Convenience derived view: `openTabIds` resolved to SessionMeta in order. */
  openTabs: SessionMeta[];
  activeId: string;
  activeMessages: SessionMessage[];

  setActiveMessages: React.Dispatch<React.SetStateAction<SessionMessage[]>>;

  /** Returns the active id, creating + opening a new tab if there's none. */
  ensureActive: () => Promise<string>;

  /**
   * Open the session as a tab (prepending if not already open) and activate
   * it. Used when picking a session from History.
   */
  openTab: (id: string) => Promise<void>;

  /**
   * Close the tab without touching the underlying session. If `id` was the
   * active tab, switches to the nearest neighbour (right first, then left,
   * then empty).
   */
  closeTab: (id: string) => Promise<void>;

  /**
   * Bulk variant for the tab right-click menu (Close others / Close to the
   * right / Close all). Atomic: one `setOpenTabIds` and at most one active
   * switch, so it avoids the ref-staleness that a loop of `closeTab` would
   * hit (the open-tabs ref only advances on the next render).
   *
   * If the active tab is in `ids`, picks the nearest surviving neighbour
   * relative to its original index — right first, then left, then empty.
   */
  closeTabs: (ids: string[]) => Promise<void>;

  /**
   * Switch the active tab to one that's already open. (UI: clicking on a
   * tab in the tab bar.)
   */
  switchToTab: (id: string) => Promise<void>;

  /** Create a fresh session, open it as a tab, and activate it. */
  createNew: () => Promise<string>;

  rename: (id: string, title: string) => Promise<void>;

  /**
   * Permanent delete: removes the session from History, the open-tab list,
   * and drops its messages. UX surface: the History drawer's trash button.
   */
  remove: (id: string) => Promise<void>;

  clearActiveMessages: () => Promise<void>;

  /**
   * Bumps `updatedAt` and `messageCount` for a session, and (when the title
   * is still the default and not user-pinned) regenerates it from the
   * current messages.
   */
  touchSession: (id: string, messages: SessionMessage[]) => Promise<void>;
}

const PERSIST_DEBOUNCE_MS = 250;

export function useSessions(): SessionsController {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [openTabIds, setOpenTabIds] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [activeMessages, setActiveMessages] = useState<SessionMessage[]>([]);
  const [ready, setReady] = useState(false);

  // Refs avoid stale closures inside async ops + storage listeners.
  const sessionsRef = useRef(sessions);
  const openTabIdsRef = useRef(openTabIds);
  const activeIdRef = useRef(activeId);
  const messagesRef = useRef(activeMessages);

  // Bumped on every session switch (activateOpen / createNew / remove path
  // that flips the active session). Any async work scheduled against a prior
  // epoch — debounced persists, the cross-surface `loadMessages(...).then(
  // setActiveMessages)` in the onChanged listener — checks the epoch before
  // writing, so a stale load can't clobber the post-switch messages.
  const switchEpochRef = useRef(0);

  // Self-write dedupe for the chrome.storage.onChanged activeId path.
  // saveActiveId() inside this hook also fires onChanged here, and that
  // re-entry races with React committing the same change locally — refs
  // may be stale when it fires, leading to messagesRef being saved against
  // the WRONG activeId. Mark our own writes synchronously *before* the
  // chrome.storage write so the listener can swallow its own echo.
  const selfWriteActiveIdRef = useRef<Map<string, number>>(new Map());
  const markSelfWriteActiveId = (id: string) => {
    const c = selfWriteActiveIdRef.current.get(id) ?? 0;
    selfWriteActiveIdRef.current.set(id, c + 1);
  };
  const consumeSelfWriteActiveId = (id: string): boolean => {
    const c = selfWriteActiveIdRef.current.get(id) ?? 0;
    if (c <= 0) return false;
    if (c === 1) selfWriteActiveIdRef.current.delete(id);
    else selfWriteActiveIdRef.current.set(id, c - 1);
    return true;
  };
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  useEffect(() => {
    openTabIdsRef.current = openTabIds;
  }, [openTabIds]);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  useEffect(() => {
    messagesRef.current = activeMessages;
  }, [activeMessages]);

  // Initial load: migrate, then read index + tabs + active.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await migrateLegacyChatHistory();
      const idx = await loadIndex();
      const aid = await loadActiveId();
      const rawTabs = await loadOpenTabIds();

      // Reconcile: drop any tab id whose underlying session no longer
      // exists, and bootstrap with [activeId] if storage is empty but the
      // user has an active session (covers older installs that pre-date
      // the openTabIds key).
      const known = new Set(idx.map((s) => s.id));
      let tabs = rawTabs.filter((id) => known.has(id));
      if (tabs.length === 0 && aid && known.has(aid)) {
        tabs = [aid];
        await saveOpenTabIds(tabs);
      }

      const effectiveActive = tabs.includes(aid) ? aid : tabs[0] ?? "";
      if (effectiveActive !== aid) {
        markSelfWriteActiveId(effectiveActive);
        await saveActiveId(effectiveActive);
      }

      const msgs = effectiveActive ? await loadMessages(effectiveActive) : [];
      if (cancelled) return;

      setSessions(idx);
      setOpenTabIds(tabs);
      setActiveId(effectiveActive);
      setActiveMessages(msgs);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist the index whenever it changes (cheap; only metadata).
  useEffect(() => {
    if (!ready) return;
    void saveIndex(sessions);
  }, [sessions, ready]);

  // Persist openTabIds independently (also cheap).
  useEffect(() => {
    if (!ready) return;
    void saveOpenTabIds(openTabIds);
  }, [openTabIds, ready]);

  // Persist the active-session messages on change, debounced.
  const persistTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!ready || !activeId) return;
    if (persistTimer.current != null) {
      clearTimeout(persistTimer.current);
    }
    const id = activeId;
    const snapshot = activeMessages;
    const epoch = switchEpochRef.current;
    persistTimer.current = setTimeout(() => {
      persistTimer.current = null;
      // A session switch happened while we were debounced — the (id,
      // snapshot) pair captured at schedule time may no longer represent
      // a coherent view of any session. flushCurrentMessages already saved
      // the outgoing session synchronously, so dropping this is safe.
      if (epoch !== switchEpochRef.current) return;
      void saveMessages(id, snapshot);
    }, PERSIST_DEBOUNCE_MS) as unknown as number;
    return () => {
      if (persistTimer.current != null) {
        clearTimeout(persistTimer.current);
        persistTimer.current = null;
      }
    };
  }, [activeMessages, activeId, ready]);

  // Cross-surface sync: another extension page (popup/options) may have
  // mutated the session list, the open tabs, or the active id; reflect
  // those changes here.
  useEffect(() => {
    const onChanged = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: chrome.storage.AreaName,
    ) => {
      if (area !== "local") return;

      if (changes[SESSION_KEYS.index]) {
        const v = changes[SESSION_KEYS.index].newValue;
        if (Array.isArray(v)) setSessions(v as SessionMeta[]);
      }
      if (changes[SESSION_KEYS.openTabIds]) {
        const v = changes[SESSION_KEYS.openTabIds].newValue;
        if (Array.isArray(v)) setOpenTabIds(v as string[]);
      }
      if (changes[SESSION_KEYS.activeId]) {
        const next = String(changes[SESSION_KEYS.activeId].newValue || "");
        // Swallow echoes of this hook's own writes. activateOpen /
        // createNew / remove all mark their own saveActiveId() call before
        // the await; without this the listener races React state commits
        // and can save messagesRef (already advanced to the new session's
        // empty/loaded state) against the OLD activeId, wiping it.
        if (consumeSelfWriteActiveId(next)) {
          // Our own write — local state is the source of truth here.
        } else if (next !== activeIdRef.current) {
          if (activeIdRef.current) {
            void saveMessages(activeIdRef.current, messagesRef.current);
          }
          const epoch = ++switchEpochRef.current;
          setActiveId(next);
          if (next) {
            void loadMessages(next).then((msgs) => {
              // Guard against a subsequent switch having moved on while we
              // were loading — without this, the resolved snapshot would
              // overwrite whatever the user has just typed/sent in the now-
              // current session.
              if (epoch !== switchEpochRef.current) return;
              setActiveMessages(msgs);
            });
          } else {
            setActiveMessages([]);
          }
        }
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  const flushCurrentMessages = useCallback(async () => {
    const id = activeIdRef.current;
    if (!id) return;
    if (persistTimer.current != null) {
      clearTimeout(persistTimer.current);
      persistTimer.current = null;
    }
    const snapshot = messagesRef.current;
    await saveMessages(id, snapshot);
    // The caller is about to switch activeId, which will trigger the persist
    // effect's cleanup and cancel any pending debounced save for the
    // outgoing session. If a port message (stream chunk, abort, snapshot)
    // for the outgoing session arrived DURING our chrome.storage write, its
    // setActiveMessages update has now landed in React state but won't
    // survive the switch — drain pending tasks, then re-save so the latest
    // state (e.g. handleStreamAborted's "[stopped]" tail) actually reaches
    // storage. Yields via setTimeout(0) rather than queueMicrotask because
    // chrome.runtime port messages are dispatched as tasks, not microtasks.
    await new Promise<void>((r) => setTimeout(r, 0));
    if (
      activeIdRef.current === id &&
      messagesRef.current !== snapshot
    ) {
      if (persistTimer.current != null) {
        clearTimeout(persistTimer.current);
        persistTimer.current = null;
      }
      await saveMessages(id, messagesRef.current);
    }
  }, []);

  // Internal: switches active to id (must already be open) and loads its
  // messages. Caller is responsible for ensuring `id` is in openTabIds.
  const activateOpen = useCallback(
    async (id: string) => {
      if (!id) {
        await flushCurrentMessages();
        switchEpochRef.current++;
        setActiveId("");
        setActiveMessages([]);
        markSelfWriteActiveId("");
        await saveActiveId("");
        return;
      }
      if (id === activeIdRef.current) return;
      await flushCurrentMessages();
      // Bump the epoch BEFORE the async load. Any debounced persist or
      // pending cross-surface load tagged with a prior epoch will be
      // dropped on resolution, so a slow loadMessages can't clobber the
      // freshly-typed messages in the new session.
      const myEpoch = ++switchEpochRef.current;
      const next = await loadMessages(id);
      // Another switch raced ahead while we were loading — bail and let
      // it win.
      if (myEpoch !== switchEpochRef.current) return;
      setActiveId(id);
      setActiveMessages(next);
      markSelfWriteActiveId(id);
      await saveActiveId(id);
    },
    [flushCurrentMessages],
  );

  const switchToTab = useCallback(
    async (id: string) => {
      if (!openTabIdsRef.current.includes(id)) return;
      await activateOpen(id);
    },
    [activateOpen],
  );

  const openTab = useCallback(
    async (id: string) => {
      if (!id) return;
      if (!openTabIdsRef.current.includes(id)) {
        // Append at the end so the relative order of pre-existing tabs is
        // preserved (matches Cursor: opening from history pushes to the
        // right).
        setOpenTabIds([...openTabIdsRef.current, id]);
      }
      await activateOpen(id);
    },
    [activateOpen],
  );

  const closeTab = useCallback(
    async (id: string) => {
      const tabs = openTabIdsRef.current;
      const i = tabs.indexOf(id);
      if (i < 0) return;
      const remaining = tabs.slice(0, i).concat(tabs.slice(i + 1));
      setOpenTabIds(remaining);

      // If we just closed the active tab, pick a neighbour. Cursor prefers
      // the tab to the right of the closed one, falling back to the left,
      // then to nothing.
      if (id === activeIdRef.current) {
        const replacement =
          remaining[i] ?? remaining[i - 1] ?? "";
        await activateOpen(replacement);
      }
    },
    [activateOpen],
  );

  const closeTabs = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      const toClose = new Set(ids);
      const tabs = openTabIdsRef.current;
      const remaining = tabs.filter((id) => !toClose.has(id));
      // No-op if nothing changed (e.g. menu invoked on a stale id).
      if (remaining.length === tabs.length) return;
      setOpenTabIds(remaining);

      const activeId = activeIdRef.current;
      if (activeId && toClose.has(activeId)) {
        // Pick the nearest surviving tab relative to the active tab's
        // original index — right first, then left, mirroring single-tab
        // close behaviour.
        const i = tabs.indexOf(activeId);
        let replacement = "";
        for (let j = i + 1; j < tabs.length; j++) {
          if (!toClose.has(tabs[j])) {
            replacement = tabs[j];
            break;
          }
        }
        if (!replacement) {
          for (let j = i - 1; j >= 0; j--) {
            if (!toClose.has(tabs[j])) {
              replacement = tabs[j];
              break;
            }
          }
        }
        await activateOpen(replacement);
      }
    },
    [activateOpen],
  );

  const createNew = useCallback(async (): Promise<string> => {
    await flushCurrentMessages();
    const meta = newSessionMeta();
    switchEpochRef.current++;
    setSessions((prev) => [meta, ...prev]);
    setOpenTabIds([...openTabIdsRef.current, meta.id]);
    setActiveId(meta.id);
    setActiveMessages([]);
    markSelfWriteActiveId(meta.id);
    await saveActiveId(meta.id);
    return meta.id;
  }, [flushCurrentMessages]);

  const ensureActive = useCallback(async (): Promise<string> => {
    if (activeIdRef.current) return activeIdRef.current;
    return createNew();
  }, [createNew]);

  const rename = useCallback(async (id: string, title: string) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === id
          ? {
              ...s,
              title: title.trim(),
              titleManual: true,
              updatedAt: Date.now(),
            }
          : s,
      ),
    );
  }, []);

  const remove = useCallback(
    async (id: string) => {
      const filteredIndex = sessionsRef.current.filter((s) => s.id !== id);
      setSessions(filteredIndex);
      await dropMessages(id);

      // Reap any side-panel attachment files that lived under this session
      // on disk (`~/.hermes/plugins/<plugin>/attachments/<id>/`). Best-
      // effort: silently no-ops when the bridge is disconnected, and
      // Python ignores the call when the directory doesn't exist.
      try {
        await chrome.runtime.sendMessage({
          action: "attachment.deleteSession",
          session_id: id,
        });
      } catch {
        // Ignore — orphaned files cost only disk and the user can clear
        // ~/.hermes/.../attachments/ manually if they ever care.
      }

      // Also drop any tab pointing at the now-deleted session and reflow
      // the active tab if needed.
      const tabs = openTabIdsRef.current;
      if (tabs.includes(id)) {
        const i = tabs.indexOf(id);
        const remaining = tabs.slice(0, i).concat(tabs.slice(i + 1));
        setOpenTabIds(remaining);
        if (id === activeIdRef.current) {
          const replacement =
            remaining[i] ?? remaining[i - 1] ?? "";
          if (replacement) {
            const myEpoch = ++switchEpochRef.current;
            const msgs = await loadMessages(replacement);
            if (myEpoch !== switchEpochRef.current) return;
            setActiveId(replacement);
            setActiveMessages(msgs);
          } else {
            switchEpochRef.current++;
            setActiveId("");
            setActiveMessages([]);
          }
          markSelfWriteActiveId(replacement);
          await saveActiveId(replacement);
        }
      }
    },
    [],
  );

  const clearActiveMessages = useCallback(async () => {
    if (!activeIdRef.current) return;
    setActiveMessages([]);
    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeIdRef.current
          ? { ...s, messageCount: 0, updatedAt: Date.now() }
          : s,
      ),
    );
    await saveMessages(activeIdRef.current, []);
  }, []);

  const touchSession = useCallback(
    async (id: string, messages: SessionMessage[]) => {
      setSessions((prev) => {
        const i = prev.findIndex((s) => s.id === id);
        if (i < 0) return prev;
        const next = prev.slice();
        const cur = next[i];
        const updated: SessionMeta = {
          ...cur,
          updatedAt: Date.now(),
          messageCount: messages.length,
        };
        if (!cur.titleManual && (!cur.title || cur.title === "New chat")) {
          updated.title = deriveTitleFromMessages(messages, cur.title || "");
        }
        next[i] = updated;
        return next;
      });
    },
    [],
  );

  // Resolve openTabIds → SessionMeta[], preserving order, dropping any
  // dangling references defensively (shouldn't happen, but cheap insurance).
  const openTabs = openTabIds
    .map((id) => sessions.find((s) => s.id === id))
    .filter((s): s is SessionMeta => !!s);

  return {
    ready,
    sessions,
    openTabIds,
    openTabs,
    activeId,
    activeMessages,
    setActiveMessages,
    ensureActive,
    openTab,
    closeTab,
    closeTabs,
    switchToTab,
    createNew,
    rename,
    remove,
    clearActiveMessages,
    touchSession,
  };
}
