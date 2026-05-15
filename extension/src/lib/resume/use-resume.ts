/**
 * The "Pick up where you left off" hook — recent chat sessions the user
 * can resume, recency-sorted and capped.
 *
 * It used to also surface a "Recent browsing" rail of pages from
 * `chrome.history`. That was removed: browsing history couldn't honestly
 * carry "unfinished work", and the resume rail is cleaner as chats only.
 */

import { useMemo } from "react";

import type { SessionMeta } from "../sessions/types";

export interface ResumeItem {
  kind: "session";
  id: string;
  title: string;
  /** Last-activity timestamp (epoch ms) — drives the recency sort. */
  ts: number;
  messageCount: number;
}

export interface ResumeController {
  ready: boolean;
  items: ResumeItem[];
}

const MAX_ITEMS = 24;

/**
 * @param sessions  the session index from `useSessions().sessions`
 */
export function useResume(sessions: SessionMeta[]): ResumeController {
  const items = useMemo<ResumeItem[]>(
    () =>
      sessions
        .filter((s) => !s.archived && (s.messageCount ?? 0) > 0)
        .map((s) => ({
          kind: "session" as const,
          id: s.id,
          title: s.title?.trim() || "Untitled chat",
          ts: s.updatedAt ?? 0,
          messageCount: s.messageCount ?? 0,
        }))
        .sort((a, b) => b.ts - a.ts)
        .slice(0, MAX_ITEMS),
    [sessions],
  );

  // No async gather anymore — sessions arrive synchronously as a prop, so
  // the rail is "ready" immediately; it just renders nothing while empty.
  return { ready: true, items };
}
