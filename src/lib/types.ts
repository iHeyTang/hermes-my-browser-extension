/**
 * Shared TypeScript types: bridge protocol, userscript metadata, chat protocol.
 */

// ---------------------------------------------------------------------------
// Bridge / WebSocket protocol
// ---------------------------------------------------------------------------

export type BridgeRequest = {
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

export type BridgeResponse =
  | { id: string; result: unknown }
  | { id: string; error: { message: string } };

export type ConnectionState = "disconnected" | "connecting" | "connected";

export interface AgentWindowInfo {
  windowId: number;
  tabId: number;
  created?: boolean;
  url?: string | null;
  title?: string | null;
}

// ---------------------------------------------------------------------------
// Run target — internal routing for browser tools (`resolveTargetTab`).
// The side panel **Open** menu (see `NavigateOpenPolicy`) keeps this in
// sync: non-Auto pins agent vs user; Auto leaves it to `navigate` + model
// `open_in` (defaulting to the agent window when still `open_in=auto`).
//
//   "agent"  — dedicated background agent window.
//   "user"   — user's normal Chrome tab/window (`resolveUserTab`).
// ---------------------------------------------------------------------------
export type RunTarget = "agent" | "user";

export interface RunTargetState {
  target: RunTarget;
  /**
   * Pinned user tab when Open is New tab / Same tab (or Auto + user surface).
   * Null when target is "agent". May be stale if the tab was closed;
   * resolvers fall back to the active tab in `userWindowId` when possible.
   */
  userTabId: number | null;
  /**
   * The window the user-side tab belongs to. Used as a hint when
   * `userTabId` is gone so we can prefer the user's own Chrome window
   * (and not, say, the focused agent window) when picking a fallback.
   */
  userWindowId: number | null;
}

/**
 * Side panel **Open** — single user-facing control for where browser tools run.
 *
 * - `auto` — `my_browser_navigate.open_in` from the agent when concrete; if
 *   omitted or `open_in=auto`, follow current `runTarget` (usually the agent
 *   window until a navigate pins the user surface).
 * - Any other value — forces that surface for **all** browser tools and
 *   overrides the agent until switched back to Auto.
 */
export type NavigateOpenPolicy =
  | "auto"
  | "agent"
  | "user_new_tab"
  | "user_same_tab";

// ---------------------------------------------------------------------------
// Userscript metadata
// ---------------------------------------------------------------------------

export type RunAt =
  | "document-start"
  | "document-body"
  | "document-end"
  | "document-idle";

export type ScriptWorld = "MAIN" | "ISOLATED";

export interface UserScriptMetadata {
  name: string;
  namespace?: string;
  version?: string;
  description?: string;
  author?: string;
  homepage?: string;
  icon?: string;
  match: string[];
  include: string[];
  exclude: string[];
  excludeMatch: string[];
  grant: string[];
  require: string[];
  resource: { name: string; url: string }[];
  runAt: RunAt;
  noframes: boolean;
  connect: string[];
  updateURL?: string;
  downloadURL?: string;
  supportURL?: string;
  /** Free-form additional headers we don't have a typed slot for. */
  extra: Record<string, string[]>;
}

export interface UserScript {
  id: string;
  source: string;
  meta: UserScriptMetadata;
  enabled: boolean;
  installedAt: number;
  updatedAt: number;
  /** Source URL from which the script was last fetched (for @updateURL polling). */
  sourceURL?: string;
  /** Last error encountered when registering content scripts for this script. */
  lastError?: string;
}

export interface ResourceCacheEntry {
  scriptId: string;
  /** "" for @require entries, the @resource name otherwise. */
  name: string;
  url: string;
  /** Raw text body. Binary @resource is also stored as base64 data URL in `dataUrl`. */
  text: string;
  /** data: URL form, useful for GM_getResourceURL. */
  dataUrl: string;
  contentType: string;
  fetchedAt: number;
  bytes: number;
}

// ---------------------------------------------------------------------------
// GM_xmlhttpRequest proxy protocol (content-script ↔ background)
// ---------------------------------------------------------------------------

export interface GmXhrRequest {
  type: "gm-xhr";
  requestId: string;
  url: string;
  method: string;
  headers?: Record<string, string>;
  data?: string | null;
  responseType?: "" | "text" | "json" | "arraybuffer" | "blob" | "document";
  timeout?: number;
  user?: string;
  password?: string;
  binary?: boolean;
  /** scriptId requesting the XHR, used for `@connect` whitelist. */
  scriptId?: string;
}

export interface GmXhrAbort {
  type: "gm-xhr-abort";
  requestId: string;
}

export interface GmXhrResponse {
  type: "gm-xhr-response";
  requestId: string;
  phase: "loadstart" | "progress" | "load" | "error" | "abort" | "timeout";
  status?: number;
  statusText?: string;
  responseHeaders?: string;
  responseText?: string;
  /** base64 for binary response types. */
  responseBase64?: string;
  finalUrl?: string;
  loaded?: number;
  total?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Menu commands (GM_registerMenuCommand)
// ---------------------------------------------------------------------------

export interface MenuCommand {
  scriptId: string;
  caption: string;
  /** opaque id assigned by the runtime, returned to the script. */
  id: number;
}

// ---------------------------------------------------------------------------
// Chat — local-only types used by the side panel client. The actual wire
// format follows OpenAI Chat Completions.
// ---------------------------------------------------------------------------

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
  /** Local-only id for React keying. */
  uiId?: string;
}
