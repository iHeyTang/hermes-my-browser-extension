/**
 * WebSocket bridge connection lifecycle: connect, disconnect, retries,
 * heartbeat, and protocol dispatch.
 *
 * Mutates `state.ws`/`state.reconnectTimer`/`state.heartbeatTimer` directly so
 * other modules can read connection status from the same object.
 *
 * Protocol multiplexing — the bridge is bidirectional:
 *   - Inbound from Hermes Python side: `{id, method, params}` requests we
 *     execute via the `HANDLERS` registry; we reply `{id, result|error}`.
 *   - Outbound *from us* (SW): `sendRequest(method, params)` allocates a
 *     fresh id, sends the request, and resolves a Promise once the matching
 *     `{id, result|error}` arrives. The WS bridge no longer carries
 *     attachment messages — uploads / deletes both hit the HTTP backplane
 *     plugin directly (`POST/DELETE /hermes/attachments`).
 *
 *   `handleCommand` demuxes on whether the frame carries `method`:
 *     - present  → inbound request, dispatch handler
 *     - absent   → response to one of our outbound requests, resolve pending
 */

import { closeAgentWindow } from "./agent-window";
import {
  BRIDGE_URL,
  HEARTBEAT_MS,
  HEARTBEAT_TIMEOUT_MS,
  RECONNECT_MS,
} from "./config";
import { HANDLERS } from "./handlers";
import { state, syncState } from "./state";

// ---------------------------------------------------------------------------
// Read-side liveness
//
// `lastSeenAt` is the wall-clock time of the most recent frame the SW
// received from the bridge — any frame, including pongs and normal relay
// traffic. The heartbeat tick consults this to detect a half-open WS:
// `readyState` alone can lie for many minutes when the bridge silently
// dies (process killed, NAT idle-out, OS hung), because the protocol
// doesn't surface that to the browser until the OS-level TCP timeout
// finally fires. See `getCurrentState()` in `state.ts` — its accuracy
// depends on this check actively pruning stale OPEN sockets.
// ---------------------------------------------------------------------------

let lastSeenAt = 0;

// ---------------------------------------------------------------------------
// Outbound request bookkeeping
//
// `pendingRequests` keys an opaque request id to its resolve/reject pair so
// the demuxer in `handleCommand` can wake the correct caller. We monotonically
// increment `nextRequestId` to keep ids unique across reconnects (the SW can
// be restarted by Chrome while the page is still up; collisions are still
// avoided because the Map is reset on SW restart anyway).
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
}

const pendingRequests: Map<string, PendingRequest> = new Map();
let nextRequestId = 0;

function allocRequestId(): string {
  nextRequestId += 1;
  return `ext_${Date.now().toString(36)}_${nextRequestId.toString(36)}`;
}

function rejectAllPending(reason: string) {
  for (const [, p] of pendingRequests) {
    if (p.timeoutHandle) clearTimeout(p.timeoutHandle);
    p.reject(new Error(reason));
  }
  pendingRequests.clear();
}

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

  let ws: WebSocket;
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
  syncState();

  ws.onopen = () => {
    ws.send(JSON.stringify({ role: "ui" }));
    // Seed liveness here: the bridge just accepted our connection, so the
    // peer is provably alive at this instant. Without seeding, the first
    // heartbeat tick would compute staleness against `lastSeenAt = 0` and
    // false-positive-recycle immediately.
    lastSeenAt = Date.now();
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    startHeartbeat();
    syncState();
  };

  ws.onmessage = (event) => {
    // Stamp liveness for ANY inbound frame (pongs, normal relay traffic,
    // attachment cleanup replies, …). The heartbeat tick reads this to
    // decide whether the bridge has gone quiet. Doing it here — before
    // dispatch — means even frames we drop in `handleCommand` (e.g. pongs)
    // still count as proof of life.
    lastSeenAt = Date.now();
    void handleCommand(event.data as string);
  };

  ws.onclose = (ev) => {
    if (ev.code !== 1000) {
      const hint =
        ev.code === 1006
          ? "Code 1006 usually means the TCP connection failed (nothing listening on the port, or the bridge process exited immediately). Restart Hermes after updating the plugin, or run: `python -m bridge.server` from the plugin repo using the Hermes venv Python."
          : "If the bridge is not running, start Hermes with this plugin or run `python -m bridge.server` (Hermes venv) from the plugin repo.";
      console.warn(
        "[hermes-bridge] WebSocket closed:",
        {
          code: ev.code,
          reason: ev.reason || undefined,
          wasClean: ev.wasClean,
          url: BRIDGE_URL,
        },
        "—",
        hint,
      );
    }
    state.ws = null;
    stopHeartbeat();
    // Reset liveness so the next `connect()` doesn't read a stale stamp
    // from the previous socket (which would skip the seed in `onopen` and
    // confuse the first heartbeat tick).
    lastSeenAt = 0;
    // Anyone awaiting an in-flight outbound request needs to know the wire
    // dropped so they can surface a useful error instead of timing out.
    rejectAllPending("Bridge connection closed");
    if (state.desiredConnected) scheduleReconnect();
    syncState();
  };

  ws.onerror = () => {
    // Browsers omit the failure reason here; see onclose for code/reason/hint.
    console.warn("[hermes-bridge] WebSocket error (details usually follow in onclose)");
  };
}

export async function disconnect() {
  state.desiredConnected = false;
  await chrome.storage.local.set({ desiredConnected: false });
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  stopHeartbeat();
  rejectAllPending("Bridge disconnected by user");

  if (state.ws) {
    try {
      state.ws.close(1000, "user disconnect");
    } catch {
      // Ignore.
    }
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
    // Read-side staleness check. If the bridge hasn't sent us a single
    // frame (pong, relay traffic, anything) within HEARTBEAT_TIMEOUT_MS,
    // assume the connection is half-open and tear it down so the normal
    // onclose → scheduleReconnect path kicks in. This is what makes
    // `getCurrentState()` honest: without it, `readyState === OPEN` can
    // outlive a dead bridge by minutes.
    const idleMs = Date.now() - lastSeenAt;
    if (lastSeenAt > 0 && idleMs > HEARTBEAT_TIMEOUT_MS) {
      console.warn(
        "[hermes-bridge] No frame from bridge in %dms (> %dms); recycling WS",
        idleMs,
        HEARTBEAT_TIMEOUT_MS,
      );
      try {
        state.ws.close(4001, "heartbeat stale");
      } catch {
        // Ignore.
      }
      return;
    }
    try {
      state.ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
    } catch (e) {
      console.warn("[hermes-bridge] Heartbeat send failed, recycling WS:", e);
      try {
        state.ws.close();
      } catch {
        // Ignore.
      }
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
//
// Frames arriving on the WS are demuxed by shape:
//   - `{type: "ping"|"pong"}`        → heartbeat, ignored
//   - `{id, method, params}`         → inbound request from Python; run handler
//   - `{id, result}` / `{id, error}` → response to one of *our* outbound
//                                      requests; resolve the matching pending
// Anything else gets logged + dropped so we don't crash on a malformed peer.
// ---------------------------------------------------------------------------

interface BridgeFrame {
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
  type?: string;
  result?: unknown;
  error?: { message?: string } | string;
}

async function handleCommand(raw: string) {
  let msg: BridgeFrame;
  try {
    msg = JSON.parse(raw);
  } catch {
    console.warn("[hermes-bridge] Invalid JSON from bridge:", raw);
    return;
  }

  if (msg.type === "ping" || msg.type === "pong") return;

  const { id, method, params } = msg;

  // Outbound-response branch: reply to something we asked Python earlier.
  if (id && !method && (msg.result !== undefined || msg.error !== undefined)) {
    const pending = pendingRequests.get(id);
    if (!pending) {
      // Late reply (timed out or SW restarted between send and recv) — drop.
      return;
    }
    pendingRequests.delete(id);
    if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
    if (msg.error !== undefined) {
      const errMsg =
        typeof msg.error === "string"
          ? msg.error
          : msg.error?.message || "Bridge returned an error";
      pending.reject(new Error(errMsg));
    } else {
      pending.resolve(msg.result);
    }
    return;
  }

  if (!id || !method) {
    console.warn("[hermes-bridge] Malformed command:", msg);
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
    sendError(id, String((e as Error)?.message || e));
  }
}

function sendResult(id: string, result: unknown) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify({ id, result }));
}

function sendError(id: string, message: string) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify({ id, error: { message } }));
}

// ---------------------------------------------------------------------------
// Outbound: SW-initiated requests to the Python side.
//
// Used for attachment delete / session cleanup over the bridge.
// Generic enough to host any future extension→Python flows.
// ---------------------------------------------------------------------------

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Fire a request at the Python side and wait for its reply.
 *
 * Resolves with the `result` payload or rejects with an Error whose message
 * is either the bridge's `error.message`, a timeout, or a connection-lost
 * notice. Caller is responsible for serialising large payloads (e.g. base64
 * for binary attachments) before passing them in `params`.
 */
export function sendRequest<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      reject(
        new Error(
          "Bridge is not connected. Open the side panel and click the " +
            "status pill to connect first.",
        ),
      );
      return;
    }
    const id = allocRequestId();
    const timeoutHandle =
      timeoutMs > 0
        ? setTimeout(() => {
            if (pendingRequests.delete(id)) {
              reject(new Error(`Bridge request "${method}" timed out`));
            }
          }, timeoutMs)
        : null;
    pendingRequests.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timeoutHandle,
    });
    try {
      state.ws.send(JSON.stringify({ id, method, params }));
    } catch (e) {
      pendingRequests.delete(id);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(
        new Error(
          `Failed to send bridge request: ${(e as Error)?.message || String(e)}`,
        ),
      );
    }
  });
}

/** Synchronous check used by the side panel before offering attachment UI. */
export function isBridgeConnected(): boolean {
  return !!state.ws && state.ws.readyState === WebSocket.OPEN;
}
