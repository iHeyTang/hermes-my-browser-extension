/**
 * Schema for in-page action recording — user demonstrations captured on a
 * tab and exported as JSON for the user (or agent) to interpret.
 */

export const LEARN_STORAGE_KEYS = {
  meta: "learn.recording.meta",
  buffer: "learn.traceBuffer",
} as const;

export type LearnEventType =
  | "navigate"
  | "click"
  | "input"
  | "change"
  | "submit";

export interface LearnSelectorHints {
  css?: string;
  idAttr?: string;
  dataTestId?: string;
  name?: string;
  role?: string;
  ariaLabel?: string;
  tag?: string;
  textSnippet?: string;
}

export interface LearnTraceEvent {
  t: number;
  type: LearnEventType;
  url: string;
  title?: string;
  frameUrl?: string;
  selectors?: LearnSelectorHints;
  value?: string;
  valueRedacted?: boolean;
  href?: string;
}

export interface LearnRecordingMeta {
  active: boolean;
  tabId: number | null;
  startedAt: number;
}

export interface LearnTrace {
  version: 1;
  startedAt: number;
  endedAt: number;
  tabId: number | null;
  eventCount: number;
  events: LearnTraceEvent[];
}
