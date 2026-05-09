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
// Run target — where browser-control tool calls (navigate / click / type /
// screenshot / eval / get_html / get_text) are dispatched.
//
//   "agent"  — the dedicated background agent window (default; the legacy
//              v0.3.0 behaviour). Nothing the user sees in their own
//              browser is touched. The "Open in my browser →" chip on
//              finished assistant bubbles is the honest way to inspect
//              whatever page the agent ended up on.
//   "user"   — the tab the user was on when they flipped the toggle (or
//              the closest equivalent if it was closed since). Lets the
//              user delegate the agent to drive the page they're already
//              looking at.
//
// We deliberately don't expose a "mirror" mode that would replay every
// agent navigate into the user's tab. Mirroring only copies URLs, but
// page state (form values, scroll, in-memory JS state, login cookies
// scoped to the tab's session, SPA route state…) is *local* to the tab
// the agent is driving and cannot be reconstructed by navigating a
// different tab to the same URL. A mirror mode would therefore look
// like "watching the agent" while actually showing you a stale
// look-alike, which is worse than no mirror at all.
// ---------------------------------------------------------------------------
export type RunTarget = "agent" | "user";

export interface RunTargetState {
  target: RunTarget;
  /**
   * The tab the user pinned at the moment they switched to "user" mode.
   * May be null when target is "agent". May point at a tab that has
   * since been closed; resolvers fall back to the current active
   * non-agent tab in that case.
   */
  userTabId: number | null;
  /**
   * The window the user-side tab belongs to. Used as a hint when
   * `userTabId` is gone so we can prefer the user's own Chrome window
   * (and not, say, the focused agent window) when picking a fallback.
   */
  userWindowId: number | null;
}

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
  /**
   * Image data URLs to splice onto this message as OpenAI multimodal
   * `image_url` content parts. Send-time only — never persisted into a
   * session's message log (that would balloon `chrome.storage.local`).
   * The chat client serialises `content` as the multimodal array form
   * when this is present and non-empty; otherwise the plain string
   * shape is used so we keep wire-compat with text-only models.
   */
  imageDataUrls?: string[];
}
