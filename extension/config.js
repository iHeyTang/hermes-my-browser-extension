/**
 * Hermes Browser Bridge — configuration constants.
 *
 * Centralised so timing, endpoints and defaults can be tuned in one place
 * without grepping the rest of the codebase.
 */

// WebSocket bridge endpoint.
export const BRIDGE_URL = "ws://127.0.0.1:9393";

// How long to wait between WS reconnect attempts.
export const RECONNECT_MS = 3000;

// Heartbeat: MV3 service workers idle out after 30s of no activity. Since
// Chrome 116, WebSocket message activity resets that timer, so a ~20s
// heartbeat keeps both the SW and the WS alive indefinitely.
export const HEARTBEAT_MS = 20000;

// Backup wake-up via chrome.alarms in case the SW is terminated anyway
// (e.g. browser-imposed hard limits, network blip dropping the WS while
// the SW was idle). 30s (0.5min) is the minimum allowed period.
export const KEEPALIVE_ALARM = "hermes-keepalive";
export const KEEPALIVE_PERIOD_MIN = 0.5;

// Default settings for the dedicated "agent window" Hermes operates on.
// The user's normal tabs are never touched.
//
// type: "normal" gives a full browser window (tab strip + address bar +
// supports multiple tabs). Use "popup" if you want a minimal single-tab
// window without the tab strip.
export const DEFAULT_AGENT_WINDOW = {
  url: "about:blank",
  width: 1280,
  height: 800,
  type: "normal",
  focused: false, // never steal focus from user
};
