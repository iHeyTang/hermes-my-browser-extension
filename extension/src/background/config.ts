/**
 * Background SW configuration constants — endpoints, timing, defaults.
 * Centralised so timing/endpoints can be tuned in one place.
 */

export const BRIDGE_URL = "ws://127.0.0.1:9393";

/**
 * Side-panel file uploads hit this first (`POST /attach` raw body). Started by
 * `python -m bridge.server` (default port 9394, env `MY_BROWSER_ATTACH_HTTP_PORT`).
 */
export const ATTACHMENT_HTTP_BASE = "http://127.0.0.1:9394";

export const RECONNECT_MS = 3000;

// MV3 SWs idle out after 30s of no activity. Since Chrome 116, WebSocket
// message activity resets that timer, so a ~20s heartbeat keeps both the SW
// and the WS alive indefinitely.
export const HEARTBEAT_MS = 20_000;

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
