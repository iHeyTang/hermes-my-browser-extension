/**
 * Background SW configuration constants — endpoints, timing, defaults.
 * Centralised so timing/endpoints can be tuned in one place.
 */

/**
 * WebSocket hub for `my_browser_*` tool calls. Hosted by the
 * `hermes-plugin-browser-tools` plugin (env `HERMES_BROWSER_TOOLS_PORT`,
 * default 9393).
 */
export const BRIDGE_URL = "ws://127.0.0.1:9393";

/**
 * Local HTTP base for the `hermes-plugin-http-backplane` plugin (env
 * `HERMES_BACKPLANE_PORT`, default 9394). Hosts three lanes:
 *   - `/extension/*`          — extension-private (file uploads etc.)
 *   - `/hermes/*`             — proxies to Hermes core (cron, models, …)
 *   - `/integrations/<name>/*` — third-party plugin routes
 */
export const BACKPLANE_HTTP_BASE = "http://127.0.0.1:9394";

/**
 * @deprecated Renamed to BACKPLANE_HTTP_BASE. Kept as alias so any
 * out-of-tree consumer keeps working through the split; remove in a
 * follow-up release once all callers have migrated.
 */
export const ATTACHMENT_HTTP_BASE = BACKPLANE_HTTP_BASE;

export const RECONNECT_MS = 3000;

// MV3 SWs idle out after 30s of no activity. Since Chrome 116, WebSocket
// message activity resets that timer, so a ~20s heartbeat keeps both the SW
// and the WS alive indefinitely.
export const HEARTBEAT_MS = 20_000;

/**
 * Maximum interval the SW will tolerate between inbound frames before
 * deciding the bridge has gone silent and the WebSocket is half-open.
 * Three heartbeats with no traffic of any kind triggers a recycle: close
 * the WS (which flips `readyState` to CLOSED, fires onclose, and lets the
 * normal reconnect path take over). Tighter than the OS TCP keepalive
 * default (hours) and loose enough that transient slowness doesn't false
 * positive. See `bridge.ts:startHeartbeat`.
 */
export const HEARTBEAT_TIMEOUT_MS = HEARTBEAT_MS * 3;

export const KEEPALIVE_ALARM = "hermes-keepalive";
export const KEEPALIVE_PERIOD_MIN = 0.5;

export interface AgentWindowConfig {
  url: string;
  width: number;
  height: number;
  type: "normal" | "popup" | "panel";
  focused: boolean;
}

export const DEFAULT_AGENT_WINDOW: AgentWindowConfig = {
  url: "about:blank",
  width: 1280,
  height: 800,
  type: "normal",
  focused: false,
};

// Default Hermes gateway HTTP base. Side panel chat client speaks the OpenAI
// Chat Completions protocol exposed by hermes-agent's gateway/platforms/api_server.
export const DEFAULT_HERMES_API_BASE = "http://127.0.0.1:8642/v1";

export const DEFAULT_HERMES_MODEL = "hermes-agent";

// Userscript update polling cadence. Chrome alarms minimum is 0.5 min.
export const USERSCRIPT_UPDATE_ALARM = "hermes-userscript-update";
export const USERSCRIPT_UPDATE_PERIOD_MIN = 60 * 6; // every 6 hours
