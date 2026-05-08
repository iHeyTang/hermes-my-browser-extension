/**
 * WebSocket bridge connection lifecycle: connect, disconnect, retries,
 * heartbeat, and protocol dispatch.
 *
 * Mutates `state.ws`, `state.reconnectTimer`, `state.heartbeatTimer`
 * directly so other modules (icon, popup messaging) can read connection
 * status from the same object.
 */

import { BRIDGE_URL, RECONNECT_MS, HEARTBEAT_MS } from "./config.js";
import { state, syncState } from "./state.js";
import { closeAgentWindow } from "./agent-window.js";
import { HANDLERS } from "./handlers.js";

// ---------------------------------------------------------------------------
// Connect / disconnect / retry
// ---------------------------------------------------------------------------

export function connect() {
  if (
    state.ws &&
    (state.ws.readyState === WebSocket.OPEN ||
      state.ws.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  let ws;
  try {
    ws = new WebSocket(BRIDGE_URL);
  } catch (e) {
    console.warn("[hermes-bridge] WebSocket constructor threw:", e);
    state.ws = null;
    syncState();
    scheduleReconnect();
    return;
  }
  state.ws = ws;

  // ws is CONNECTING here; getCurrentState() will report "connecting" as
  // long as desiredConnected is true. Push the state out now so the popup
  // and icon flip immediately rather than waiting for onopen/onclose.
  syncState();

  ws.onopen = () => {
    console.log("[hermes-bridge] Connected to bridge");
    ws.send(JSON.stringify({ role: "ui" }));
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    startHeartbeat();
    syncState();
  };

  ws.onmessage = (event) => {
    handleCommand(event.data);
  };

  ws.onclose = (event) => {
    console.log("[hermes-bridge] Bridge disconnected:", event.code, event.reason);
    state.ws = null;
    stopHeartbeat();
    // If the user still wants a connection, we stay in "connecting" while
    // we wait for the next retry — no more flicker to disconnected.
    if (state.desiredConnected) scheduleReconnect();
    syncState();
  };

  ws.onerror = (err) => {
    console.warn("[hermes-bridge] WebSocket error:", err);
  };
}

export async function disconnect() {
  // Clear desired state first so getCurrentState() returns "disconnected"
  // as soon as we tear the socket down, instead of briefly reporting
  // "connecting" because the WS is mid-close.
  state.desiredConnected = false;
  await chrome.storage.local.set({ desiredConnected: false });
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  stopHeartbeat();

  if (state.ws) {
    try { state.ws.close(1000, "user disconnect"); } catch {}
    state.ws = null;
  }
  await closeAgentWindow();
  syncState();
}

export function scheduleReconnect() {
  if (state.reconnectTimer || !state.desiredConnected) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    if (state.desiredConnected) connect();
  }, RECONNECT_MS);
}

// ---------------------------------------------------------------------------
// Heartbeat — keeps SW + WebSocket alive past MV3's 30s idle timeout.
// ---------------------------------------------------------------------------

export function startHeartbeat() {
  stopHeartbeat();
  state.heartbeatTimer = setInterval(() => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    try {
      state.ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
    } catch (e) {
      console.warn("[hermes-bridge] Heartbeat send failed, recycling WS:", e);
      try { state.ws.close(); } catch {}
    }
  }, HEARTBEAT_MS);
}

export function stopHeartbeat() {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

export async function handleCommand(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    console.warn("[hermes-bridge] Invalid JSON from bridge:", raw);
    return;
  }

  // Heartbeat frames (from us or bounced back) — ignore.
  if (msg.type === "ping" || msg.type === "pong") return;

  const { id, method, params } = msg;
  if (!id || !method) {
    console.warn("[hermes-bridge] Malformed command (missing id/method):", msg);
    return;
  }

  const handler = HANDLERS[method];
  if (!handler) {
    sendError(id, `Unknown method: ${method}`);
    return;
  }

  try {
    const result = await handler(params || {});
    sendResult(id, result);
  } catch (e) {
    sendError(id, String((e && e.message) || e));
  }
}

function sendResult(id, result) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify({ id, result }));
}

function sendError(id, message) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify({ id, error: { message } }));
}
