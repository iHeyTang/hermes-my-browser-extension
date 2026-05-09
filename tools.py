"""
Tool implementations for hermes-my-browser-extension.

The agent operates in a *dedicated background Chrome window* (the "agent
window") via stock chrome.* APIs (tabs / scripting / cookies). No
chrome.debugger means no "is debugging this browser" banner, and the
user's active tabs are never touched.

Communication path:

    Hermes  --(WS, intent JSON)-->  bridge/server.py  --(WS)-->  extension/background.js
                                                                          \\__ chrome.tabs / scripting / cookies

Protocol envelope (unchanged from before; bridge is dumb relay):

    request : {"id": "<req_id>", "method": "<verb>", "params": {...}}
    response: {"id": "<req_id>", "result": {...}}  or  {"id": "<req_id>", "error": {"message": "..."}}

Bridge subprocess lifecycle is managed by __init__.py (start_bridge / stop_bridge).
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import secrets
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional

from tools.registry import tool_error, tool_result

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PLUGIN_NAME = "hermes-my-browser-extension"
BRIDGE_PORT = int(os.environ.get("MY_BROWSER_BRIDGE_PORT", "9393"))
BRIDGE_URL = f"ws://127.0.0.1:{BRIDGE_PORT}"

DEFAULT_GATEWAY_API_BASE = os.environ.get(
    "HERMES_API_BASE", "http://127.0.0.1:8642/v1"
)

_req_id = 0


# ---------------------------------------------------------------------------
# Schema definitions — kept minimal; the extension does the real work.
# ---------------------------------------------------------------------------

MY_BROWSER_CONNECT_SCHEMA = {
    "name": "my_browser_connect",
    "description": (
        "Open (or attach to) a dedicated background Chrome window for the agent. "
        "Does not touch the user's other tabs/windows. Optionally start at a URL."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "Optional initial URL for the agent tab. Default: about:blank.",
            },
            "width": {"type": "integer", "description": "Window width (px). Default 1280."},
            "height": {"type": "integer", "description": "Window height (px). Default 800."},
        },
        "required": [],
    },
}

MY_BROWSER_DISCONNECT_SCHEMA = {
    "name": "my_browser_disconnect",
    "description": "Close the agent window and disconnect from the bridge.",
    "parameters": {"type": "object", "properties": {}, "required": []},
}

MY_BROWSER_STATUS_SCHEMA = {
    "name": "my_browser_status",
    "description": "Report bridge connection state and agent window URL/title.",
    "parameters": {"type": "object", "properties": {}, "required": []},
}

MY_BROWSER_NAVIGATE_SCHEMA = {
    "name": "my_browser_navigate",
    "description": "Navigate the agent tab to a URL. Waits for load to complete by default.",
    "parameters": {
        "type": "object",
        "properties": {
            "url": {"type": "string", "description": "Target URL."},
            "wait_for_load": {
                "type": "boolean",
                "description": "Block until the page reports complete (default true).",
                "default": True,
            },
            "timeout_ms": {
                "type": "integer",
                "description": "Max wait time in milliseconds (default 30000).",
                "default": 30000,
            },
        },
        "required": ["url"],
    },
}

MY_BROWSER_SCREENSHOT_SCHEMA = {
    "name": "my_browser_screenshot",
    "description": (
        "Capture a screenshot of the agent tab's viewport. "
        "Does NOT steal focus from the user's active window."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "format": {"type": "string", "enum": ["png", "jpeg"], "default": "png"},
            "quality": {
                "type": "integer",
                "description": "JPEG quality 0-100 (ignored for PNG).",
                "default": 80,
            },
        },
        "required": [],
    },
}

MY_BROWSER_EVAL_SCHEMA = {
    "name": "my_browser_eval",
    "description": (
        "Run a JavaScript snippet in the agent tab and return the result. "
        "The snippet is wrapped in `(async () => { ... })()` so you can use await. "
        "Use `world: \"ISOLATED\"` if the page's strict CSP blocks eval/Function."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "js": {"type": "string", "description": "JavaScript source to execute."},
            "world": {
                "type": "string",
                "enum": ["MAIN", "ISOLATED"],
                "description": "Execution world. MAIN = page context, ISOLATED = extension-side DOM access.",
                "default": "MAIN",
            },
        },
        "required": ["js"],
    },
}

MY_BROWSER_CLICK_SCHEMA = {
    "name": "my_browser_click",
    "description": "Click the first element matching the CSS selector in the agent tab.",
    "parameters": {
        "type": "object",
        "properties": {
            "selector": {"type": "string", "description": "CSS selector."},
        },
        "required": ["selector"],
    },
}

MY_BROWSER_TYPE_SCHEMA = {
    "name": "my_browser_type",
    "description": (
        "Type text into an input/textarea/contenteditable matching the CSS selector. "
        "Fires `input` and `change` events so React/Vue inputs update."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "selector": {"type": "string", "description": "CSS selector for the input."},
            "text": {"type": "string", "description": "Text to type."},
            "clear": {
                "type": "boolean",
                "description": "Clear the field before typing (default true).",
                "default": True,
            },
        },
        "required": ["selector", "text"],
    },
}

MY_BROWSER_GET_HTML_SCHEMA = {
    "name": "my_browser_get_html",
    "description": "Return outerHTML of the agent page (or of an element matching selector).",
    "parameters": {
        "type": "object",
        "properties": {
            "selector": {
                "type": "string",
                "description": "Optional CSS selector. Default returns full document HTML.",
            },
        },
        "required": [],
    },
}

MY_BROWSER_GET_TEXT_SCHEMA = {
    "name": "my_browser_get_text",
    "description": "Return visible innerText of the agent page (or of an element matching selector).",
    "parameters": {
        "type": "object",
        "properties": {
            "selector": {"type": "string", "description": "Optional CSS selector. Default body."},
        },
        "required": [],
    },
}

MY_BROWSER_SESSION_SAVE_SCHEMA = {
    "name": "my_browser_session_save",
    "description": (
        "Save browser cookies (and optionally localStorage from the agent tab) "
        "to a named snapshot file under ~/.hermes/plugins/hermes-my-browser-extension/sessions/."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Snapshot name."},
            "url_filter": {
                "type": "string",
                "description": "Optional URL/domain filter for cookies (default: all cookies).",
            },
            "include_local_storage": {
                "type": "boolean",
                "description": "Also capture localStorage of the agent tab (default true).",
                "default": True,
            },
        },
        "required": ["name"],
    },
}

MY_BROWSER_SESSION_RESTORE_SCHEMA = {
    "name": "my_browser_session_restore",
    "description": "Restore cookies (and optionally localStorage) from a named snapshot.",
    "parameters": {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Snapshot name to restore."},
            "include_local_storage": {
                "type": "boolean",
                "description": "Also restore localStorage on the agent tab (default true).",
                "default": True,
            },
        },
        "required": ["name"],
    },
}

# ---------------------------------------------------------------------------
# Userscript engine — Tampermonkey-compatible scripts owned by the extension.
# All schemas below speak to the extension via the existing bridge relay.
# ---------------------------------------------------------------------------

MY_BROWSER_USERSCRIPT_LIST_SCHEMA = {
    "name": "my_browser_userscript_list",
    "description": (
        "List all userscripts installed in the browser extension, including "
        "their match patterns, run-at, grants and enabled state. Use this "
        "before invoking my_browser_userscript_run to discover what is "
        "available."
    ),
    "parameters": {"type": "object", "properties": {}, "required": []},
}

MY_BROWSER_USERSCRIPT_GET_SCHEMA = {
    "name": "my_browser_userscript_get",
    "description": "Return the source code and full metadata for a single userscript.",
    "parameters": {
        "type": "object",
        "properties": {
            "id": {"type": "string", "description": "Userscript id (from list)."},
        },
        "required": ["id"],
    },
}

MY_BROWSER_USERSCRIPT_INSTALL_SCHEMA = {
    "name": "my_browser_userscript_install",
    "description": (
        "Install a new userscript. Provide either `source` (the full text "
        "including the ==UserScript== header) or `url` (a remote .user.js to "
        "fetch). Returns the parsed metadata + assigned id."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "source": {"type": "string", "description": "Full userscript source."},
            "url": {"type": "string", "description": "Remote .user.js URL."},
            "enabled": {
                "type": "boolean",
                "description": "Enable on install (default true).",
                "default": True,
            },
        },
        "required": [],
    },
}

MY_BROWSER_USERSCRIPT_SAVE_SCHEMA = {
    "name": "my_browser_userscript_save",
    "description": "Replace the source of an existing userscript. Re-parses the metadata block.",
    "parameters": {
        "type": "object",
        "properties": {
            "id": {"type": "string", "description": "Existing userscript id."},
            "source": {"type": "string", "description": "New source text."},
        },
        "required": ["id", "source"],
    },
}

MY_BROWSER_USERSCRIPT_REMOVE_SCHEMA = {
    "name": "my_browser_userscript_remove",
    "description": "Uninstall a userscript and drop its cached @require/@resource entries.",
    "parameters": {
        "type": "object",
        "properties": {
            "id": {"type": "string", "description": "Userscript id."},
        },
        "required": ["id"],
    },
}

MY_BROWSER_USERSCRIPT_SET_ENABLED_SCHEMA = {
    "name": "my_browser_userscript_set_enabled",
    "description": "Enable or disable a userscript without removing it.",
    "parameters": {
        "type": "object",
        "properties": {
            "id": {"type": "string", "description": "Userscript id."},
            "enabled": {
                "type": "boolean",
                "description": "True to enable, false to disable.",
            },
        },
        "required": ["id", "enabled"],
    },
}

MY_BROWSER_USERSCRIPT_RUN_SCHEMA = {
    "name": "my_browser_userscript_run",
    "description": (
        "Force-run a userscript on the agent tab right now, regardless of its "
        "@match patterns. Useful for one-off batch operations driven by the "
        "agent. The script can read its arguments via GM_info.scriptArgs."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "id": {"type": "string", "description": "Userscript id."},
            "args": {
                "description": "Arbitrary JSON value forwarded as GM_info.scriptArgs.",
            },
        },
        "required": ["id"],
    },
}

MY_BROWSER_CHAT_URL_SCHEMA = {
    "name": "my_browser_chat_url",
    "description": (
        "Discover the local Hermes gateway HTTP API base URL (OpenAI-compatible) "
        "that the browser side panel chat consumes. Reads the gateway pid file "
        "and config under ~/.hermes/."
    ),
    "parameters": {"type": "object", "properties": {}, "required": []},
}


# ---------------------------------------------------------------------------
# Gating
# ---------------------------------------------------------------------------

_MY_BROWSER_AVAILABLE: Optional[bool] = None


def _check_my_browser_available() -> bool:
    """Return True if the websockets library is available."""
    global _MY_BROWSER_AVAILABLE
    if _MY_BROWSER_AVAILABLE is not None:
        return _MY_BROWSER_AVAILABLE
    try:
        import websockets  # noqa: F401
        _MY_BROWSER_AVAILABLE = True
    except ImportError:
        _MY_BROWSER_AVAILABLE = False
    return _MY_BROWSER_AVAILABLE


# ---------------------------------------------------------------------------
# Bridge communication
#
# All websocket I/O lives on a dedicated background thread that owns its own
# asyncio event loop. Tool handlers are synchronous and dispatch coroutines
# onto this loop via `run_coroutine_threadsafe`, which works correctly whether
# Hermes invokes handlers from sync code or from inside an already-running
# event loop.
#
# The bridge protocol is *bidirectional*. There are two flavours of frame
# we have to multiplex over the single shared WebSocket:
#
#   1. Outbound requests we (Python tools) send to the extension. These are
#      the existing `my_browser_*` tool calls. We allocate an id, send
#      `{id, method, params}`, and wait for the matching `{id, result|error}`.
#
#   2. Inbound requests the extension initiates against us. So far the only
#      one is `attachment.put` (used when the chat side panel attaches a
#      file: the extension hands us the bytes, we drop them on disk under
#      `~/.hermes/plugins/.../attachments/` and return the path so the agent
#      can use its read_file / pdf / image tools on it).
#
# Multiplexing is done by a single dedicated reader task (`_recv_loop`) that
# pulls every frame off the socket and demuxes:
#
#   - Frames carrying `method` are inbound requests → dispatched to the
#     handler registered in `_inbound_handlers`. The handler's return value
#     is mirrored back as `{id, result}`.
#
#   - Frames carrying just `id` (no `method`) are responses to one of our
#     outbound requests → resolve the matching pending Future.
#
# `_send_lock` still serialises *writes* so we never interleave bytes of
# two outbound payloads on the wire — but it no longer guards reads (the
# reader task owns those exclusively).
# ---------------------------------------------------------------------------

_ws_connection = None
_send_lock: Optional[asyncio.Lock] = None
_recv_task: Optional[asyncio.Task] = None
_pending_responses: Dict[str, asyncio.Future] = {}
_inbound_handlers: Dict[str, Callable[[Dict[str, Any]], Awaitable[Dict[str, Any]]]] = {}

_bg_loop: Optional[asyncio.AbstractEventLoop] = None
_bg_thread: Optional[threading.Thread] = None
_bg_lock = threading.Lock()


def _ensure_bg_loop() -> asyncio.AbstractEventLoop:
    """Return the dedicated bridge I/O event loop, starting it if needed."""
    global _bg_loop, _bg_thread
    with _bg_lock:
        if _bg_loop is not None and _bg_loop.is_running():
            return _bg_loop
        loop = asyncio.new_event_loop()
        thread = threading.Thread(
            target=loop.run_forever,
            name="my-browser-bridge-io",
            daemon=True,
        )
        thread.start()
        _bg_loop = loop
        _bg_thread = thread
        return _bg_loop


def _is_ws_open(ws: Any) -> bool:
    """Compatibility shim across websockets versions (12 / 13 / 14)."""
    if ws is None:
        return False
    state = getattr(ws, "state", None)
    if state is not None:
        return getattr(state, "name", "") == "OPEN"
    closed = getattr(ws, "closed", None)
    if closed is not None:
        return not closed
    return True


def _next_id() -> str:
    global _req_id
    _req_id += 1
    return f"hermes_{_req_id}"


async def _ensure_ws():
    """Open the bridge websocket if it is not already connected.

    Also kicks off the demux reader task on first connect so inbound
    requests start being handled immediately.
    """
    global _ws_connection
    import websockets

    if _is_ws_open(_ws_connection):
        return _ws_connection

    _ws_connection = await websockets.connect(BRIDGE_URL)
    await _ws_connection.send(json.dumps({"role": "agent"}))
    _ensure_recv_task()
    return _ws_connection


def _ensure_recv_task() -> None:
    """Start the demux reader task if it isn't running.

    Idempotent — safe to call after every reconnect; we only spawn a new
    task when the previous one is None or has finished (e.g. after a
    socket-closed exception).
    """
    global _recv_task
    if _recv_task is not None and not _recv_task.done():
        return
    _recv_task = asyncio.create_task(_recv_loop())


async def _recv_loop() -> None:
    """Read every frame off the bridge WS and demux it.

    Frame routing:
      - `{id, result|error}`       → resolve `_pending_responses[id]`
      - `{id, method, params}`     → dispatch to `_inbound_handlers[method]`
      - heartbeat `{type: ping/pong}` → ignored (bridge already strips most)
      - anything else              → logged + dropped

    On connection loss we drain the pending-response futures with a
    ConnectionError so blocked callers don't hang until their per-call
    timeout, then fall through to the outer loop which re-acquires the
    socket via `_ensure_ws()` on the next outbound send.
    """
    while True:
        try:
            ws = _ws_connection
            if ws is None or not _is_ws_open(ws):
                await asyncio.sleep(0.5)
                continue
            raw = await ws.recv()
        except Exception as exc:
            logger.debug("recv_loop: socket read failed (%s); will reset", exc)
            _drain_pending_with_error(f"Bridge connection lost: {exc}")
            # Brief pause before letting the outer loop re-check; the next
            # outbound _send_async will reopen the socket lazily.
            await asyncio.sleep(0.2)
            continue

        if not isinstance(raw, (str, bytes, bytearray)):
            continue
        if isinstance(raw, (bytes, bytearray)):
            try:
                raw = raw.decode("utf-8")
            except UnicodeDecodeError:
                continue
        try:
            msg = json.loads(raw)
        except (ValueError, TypeError):
            continue
        if not isinstance(msg, dict):
            continue
        # Heartbeats: bridge already filters these but be defensive in case
        # someone wires a different relay underneath.
        if msg.get("type") in ("ping", "pong"):
            continue

        method = msg.get("method")
        rid = msg.get("id")
        if method:
            asyncio.create_task(
                _handle_inbound(rid, str(method), msg.get("params") or {})
            )
            continue
        if rid:
            fut = _pending_responses.pop(rid, None)
            if fut is not None and not fut.done():
                fut.set_result(msg)


def _drain_pending_with_error(message: str) -> None:
    for fut in list(_pending_responses.values()):
        if not fut.done():
            fut.set_exception(ConnectionError(message))
    _pending_responses.clear()


async def _handle_inbound(
    rid: Optional[str], method: str, params: Dict[str, Any]
) -> None:
    """Run an extension-initiated request through its handler and reply."""
    ws = _ws_connection
    handler = _inbound_handlers.get(method)
    if handler is None:
        logger.warning("Inbound request for unknown method: %s", method)
        if rid and ws is not None:
            await _safe_ws_send(
                ws,
                json.dumps({"id": rid, "error": {"message": f"Unknown method: {method}"}}),
            )
        return
    try:
        result = await handler(params)
    except Exception as exc:
        logger.exception("Inbound handler %r failed", method)
        if rid and ws is not None:
            await _safe_ws_send(
                ws, json.dumps({"id": rid, "error": {"message": str(exc)}})
            )
        return
    if rid and ws is not None:
        await _safe_ws_send(ws, json.dumps({"id": rid, "result": result}))


async def _safe_ws_send(ws: Any, payload: str) -> None:
    """Best-effort WS send; logs and swallows on a dead socket."""
    try:
        await ws.send(payload)
    except Exception as exc:
        logger.debug("ws.send failed (socket probably closed): %s", exc)


async def _send_async(method: str, params: dict | None, timeout: float) -> dict:
    """Send one intent command and await the matching response.

    The reader task owns recv; here we just register a Future keyed by the
    request id, write the payload, and await the future. `_send_lock`
    serialises writes so two concurrent outbound payloads don't interleave
    bytes on the wire.
    """
    global _send_lock
    if _send_lock is None:
        _send_lock = asyncio.Lock()

    req_id = _next_id()
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    _pending_responses[req_id] = fut

    payload = json.dumps({
        "id": req_id,
        "method": method,
        "params": params or {},
    })

    try:
        async with _send_lock:
            ws = await _ensure_ws()
            await ws.send(payload)
        return await asyncio.wait_for(fut, timeout=timeout)
    finally:
        _pending_responses.pop(req_id, None)


def _send(method: str, params: dict | None = None, timeout: float = 30.0) -> dict:
    """Send one intent command via the bridge (sync API)."""
    loop = _ensure_bg_loop()
    fut = asyncio.run_coroutine_threadsafe(
        _send_async(method, params, timeout), loop
    )
    try:
        return fut.result(timeout=timeout + 5)
    except Exception as exc:
        return {"error": {"message": f"Bridge communication failed: {exc}"}}


async def _close_ws_async() -> None:
    global _ws_connection, _recv_task
    if _recv_task is not None:
        _recv_task.cancel()
        try:
            await _recv_task
        except (asyncio.CancelledError, Exception):
            pass
        _recv_task = None
    _drain_pending_with_error("Bridge closed")
    if _ws_connection is None:
        return
    try:
        await _ws_connection.close()
    except Exception:
        pass
    finally:
        _ws_connection = None


def _close_ws_sync() -> None:
    """Close the bridge websocket (safe to call from any thread)."""
    if _ws_connection is None:
        return
    loop = _ensure_bg_loop()
    try:
        asyncio.run_coroutine_threadsafe(_close_ws_async(), loop).result(timeout=5)
    except Exception:
        pass


def _unwrap(resp: dict) -> tuple[bool, Any]:
    """Split a bridge response into (ok, payload).

    On success: (True, result_dict)
    On error:   (False, error_message_str)
    """
    if "error" in resp:
        msg = resp["error"]
        if isinstance(msg, dict):
            msg = msg.get("message", str(msg))
        return False, str(msg)
    return True, resp.get("result", {})


# ---------------------------------------------------------------------------
# Lifecycle hooks
# ---------------------------------------------------------------------------


def _on_session_start(**kwargs: Any) -> None:
    """Ensure the bridge is running when a new session starts."""
    from . import start_bridge
    start_bridge()


def _on_session_end(**kwargs: Any) -> None:
    """Clean up bridge connection on session end."""
    _close_ws_sync()


# ---------------------------------------------------------------------------
# Tool handlers
# ---------------------------------------------------------------------------


def _handle_my_browser_connect(args: dict, **kw: Any) -> str:
    """Open (or attach to) the dedicated agent window."""
    args = args or {}
    params: Dict[str, Any] = {}
    for k in ("url", "width", "height"):
        if args.get(k) is not None:
            params[k] = args[k]

    resp = _send("connect", params, timeout=15.0)
    ok, body = _unwrap(resp)
    if not ok:
        return tool_error(f"my_browser_connect: {body}")

    return tool_result({
        "success": True,
        "agent_window_id": body.get("windowId"),
        "agent_tab_id": body.get("tabId"),
        "url": body.get("url"),
        "title": body.get("title"),
        "newly_created": body.get("created", False),
        "message": (
            "Agent window ready. " +
            ("Newly created." if body.get("created") else "Reused existing.")
        ),
    })


def _handle_my_browser_disconnect(args: dict, **kw: Any) -> str:
    """Close the agent window and disconnect."""
    resp = _send("disconnect", {}, timeout=10.0)
    ok, body = _unwrap(resp)
    _close_ws_sync()
    if not ok:
        # Soft fail: bridge may already be down. Still report success on our side.
        return tool_result({
            "success": True,
            "message": f"Disconnected (bridge note: {body}).",
        })
    return tool_result({"success": True, "message": "Agent window closed."})


def _handle_my_browser_status(args: dict, **kw: Any) -> str:
    """Report current connection + agent window state."""
    bridge_open = _is_ws_open(_ws_connection)

    if not bridge_open:
        return tool_result({
            "bridge_connected": False,
            "agent_window": None,
            "message": "Bridge not connected. Run my_browser_connect first.",
        })

    resp = _send("status", {}, timeout=5.0)
    ok, body = _unwrap(resp)
    if not ok:
        return tool_error(f"my_browser_status: {body}")
    return tool_result(body)


def _handle_my_browser_navigate(args: dict, **kw: Any) -> str:
    args = args or {}
    url = args.get("url") or ""
    wait_for_load = bool(args.get("wait_for_load", True))
    timeout_ms = int(args.get("timeout_ms") or 30000)
    if not url:
        return tool_error("my_browser_navigate: url is required")
    resp = _send(
        "navigate",
        {"url": url, "wait_for_load": wait_for_load, "timeout_ms": timeout_ms},
        timeout=max(15.0, timeout_ms / 1000.0 + 5.0),
    )
    ok, body = _unwrap(resp)
    if not ok:
        return tool_error(f"my_browser_navigate: {body}")
    return tool_result({
        "success": True,
        "url": body.get("url"),
        "title": body.get("title"),
        "status": body.get("status"),
    })


def _handle_my_browser_screenshot(args: dict, **kw: Any) -> str:
    """Capture viewport of agent tab → save to /tmp → return path."""
    args = args or {}
    fmt = str(args.get("format") or "png").lower()
    quality = int(args.get("quality") or 80)
    resp = _send(
        "screenshot",
        {"format": fmt, "quality": quality},
        timeout=30.0,
    )
    ok, body = _unwrap(resp)
    if not ok:
        return tool_error(f"my_browser_screenshot: {body}")

    data_b64 = body.get("data") or ""
    ext = "jpg" if fmt == "jpeg" else "png"
    path = os.path.join(
        tempfile.gettempdir(),
        f"my_browser_screenshot_{int(time.time())}.{ext}",
    )
    try:
        with open(path, "wb") as f:
            f.write(base64.b64decode(data_b64))
    except Exception as exc:
        return tool_error(f"my_browser_screenshot: failed to write {path}: {exc}")

    return tool_result({
        "success": True,
        "path": path,
        "format": fmt,
        "bytes": os.path.getsize(path),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


def _handle_my_browser_eval(args: dict, **kw: Any) -> str:
    args = args or {}
    js = args.get("js") or ""
    world = args.get("world") or "MAIN"
    if not js:
        return tool_error("my_browser_eval: js is required")
    resp = _send("eval", {"js": js, "world": world}, timeout=30.0)
    ok, body = _unwrap(resp)
    if not ok:
        return tool_error(f"my_browser_eval: {body}")
    return tool_result({"success": True, "value": body.get("value")})


def _handle_my_browser_click(args: dict, **kw: Any) -> str:
    args = args or {}
    selector = args.get("selector") or ""
    if not selector:
        return tool_error("my_browser_click: selector is required")
    resp = _send("click", {"selector": selector}, timeout=15.0)
    ok, body = _unwrap(resp)
    if not ok:
        return tool_error(f"my_browser_click: {body}")
    return tool_result({
        "success": True,
        "selector": selector,
        "tag": body.get("tag"),
    })


def _handle_my_browser_type(args: dict, **kw: Any) -> str:
    args = args or {}
    selector = args.get("selector") or ""
    text = args.get("text", "")
    clear = bool(args.get("clear", True))
    if not selector:
        return tool_error("my_browser_type: selector is required")
    resp = _send(
        "type",
        {"selector": selector, "text": text, "clear": clear},
        timeout=15.0,
    )
    ok, body = _unwrap(resp)
    if not ok:
        return tool_error(f"my_browser_type: {body}")
    return tool_result({
        "success": True,
        "selector": selector,
        "typed": body.get("typed"),
    })


def _handle_my_browser_get_html(args: dict, **kw: Any) -> str:
    args = args or {}
    selector = args.get("selector")
    resp = _send("get_html", {"selector": selector}, timeout=15.0)
    ok, body = _unwrap(resp)
    if not ok:
        return tool_error(f"my_browser_get_html: {body}")
    return tool_result({"success": True, "html": body.get("html")})


def _handle_my_browser_get_text(args: dict, **kw: Any) -> str:
    args = args or {}
    selector = args.get("selector")
    resp = _send("get_text", {"selector": selector}, timeout=15.0)
    ok, body = _unwrap(resp)
    if not ok:
        return tool_error(f"my_browser_get_text: {body}")
    return tool_result({"success": True, "text": body.get("text")})


# ---------------------------------------------------------------------------
# Side-panel attachments — extension-initiated bridge requests.
#
# When the user attaches a file to a chat turn (drag, paste, file picker, or
# auto-attach of the current tab if it isn't HTML), the extension hands us
# the bytes via the `attachment.put` inbound request. We drop them under
# `~/.hermes/plugins/<plugin>/attachments/<panel-session>/<id>_<safe-name>`
# and return the absolute path. The chat prompt then references the path
# so the agent can use whatever read_file / pdf / image tools it has.
#
# Why per-panel-session: the side panel persists chats in chrome.storage,
# each with its own UUID. Grouping uploads by that UUID gives us a cheap
# way to GC: when the user deletes a chat, we delete its directory.
#
# Filename hygiene: we always use a fresh 8-hex prefix and `os.path.basename`
# the user-supplied name, so traversal (`../etc/passwd`, absolute paths)
# can't escape the per-session dir even if the SW sends bad data.
# ---------------------------------------------------------------------------

# 50 MB per file — generous for PDFs but avoids accidental multi-GB pastes
# blowing up SW memory and the WS frame. The extension enforces the same
# cap before sending; this is the second line of defence.
MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

# Strip everything but a conservative subset for the user-visible portion of
# the on-disk filename. We keep ASCII letters, digits, dot, dash, underscore;
# everything else is replaced with `_`. Non-ASCII names still survive because
# the prefixed uid keeps collisions impossible.
_FILENAME_SAFE_RE = re.compile(r"[^A-Za-z0-9._-]+")
_SESSION_ID_SAFE_RE = re.compile(r"[^A-Za-z0-9_-]+")


def _attachments_root() -> Path:
    """Return `~/.hermes/plugins/<plugin>/attachments/`, creating it lazily."""
    try:
        from hermes_constants import get_hermes_home
        root = get_hermes_home() / "plugins" / PLUGIN_NAME / "attachments"
    except Exception:
        root = Path.home() / ".hermes" / "plugins" / PLUGIN_NAME / "attachments"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _attachment_session_dir(session_id: Optional[str]) -> Path:
    """Per-panel-session subdirectory under the attachments root."""
    safe = _SESSION_ID_SAFE_RE.sub("_", str(session_id or "default")).strip("_")
    if not safe:
        safe = "default"
    p = _attachments_root() / safe
    p.mkdir(parents=True, exist_ok=True)
    return p


def _safe_basename(raw: str) -> str:
    """Sanitised, traversal-proof basename for an attachment filename."""
    base = os.path.basename(raw or "").strip()
    if not base or base in (".", ".."):
        return "file"
    cleaned = _FILENAME_SAFE_RE.sub("_", base).strip("._-")
    return cleaned or "file"


async def _handle_attachment_put(params: Dict[str, Any]) -> Dict[str, Any]:
    """Write extension-uploaded bytes under the plugin's attachments dir.

    Params:
      name        — user-visible filename (sanitised before write)
      mime        — best-effort MIME type, surfaced back to the agent
      data_b64    — file payload, base64-encoded
      session_id  — UUID of the side-panel chat session this belongs to

    Returns: { path, name, mime, size }
    """
    name = _safe_basename(str(params.get("name") or "file"))
    mime = str(params.get("mime") or "application/octet-stream")
    data_b64 = str(params.get("data_b64") or "")
    session_id = params.get("session_id")

    try:
        data = base64.b64decode(data_b64, validate=False)
    except Exception as exc:
        raise ValueError(f"invalid base64 payload: {exc}") from exc

    if len(data) > MAX_ATTACHMENT_BYTES:
        raise ValueError(
            f"attachment too large: {len(data)} bytes > "
            f"{MAX_ATTACHMENT_BYTES} bytes (50 MB cap)"
        )

    session_dir = _attachment_session_dir(session_id if isinstance(session_id, str) else None)
    uid = secrets.token_hex(4)
    target = session_dir / f"{uid}_{name}"
    target.write_bytes(data)

    return {
        "path": str(target),
        "name": name,
        "mime": mime,
        "size": len(data),
    }


async def _handle_attachment_delete(params: Dict[str, Any]) -> Dict[str, Any]:
    """Best-effort deletion of a previously-uploaded attachment file.

    Refuses any path that does not resolve under the attachments root, so a
    compromised/buggy extension can't ask us to unlink arbitrary disk paths.
    """
    raw = params.get("path")
    if not isinstance(raw, str) or not raw:
        return {"deleted": False, "reason": "missing path"}
    target = Path(raw).resolve()
    root = _attachments_root().resolve()
    try:
        target.relative_to(root)
    except ValueError:
        raise PermissionError(f"refused: path outside attachments root: {target}")
    if target.exists():
        try:
            if target.is_dir():
                # Drop the whole per-session dir if the caller passed one.
                for child in target.iterdir():
                    if child.is_file():
                        child.unlink()
                target.rmdir()
            else:
                target.unlink()
        except OSError as exc:
            return {"deleted": False, "reason": str(exc)}
        return {"deleted": True}
    return {"deleted": False, "reason": "not found"}


async def _handle_attachment_delete_session(
    params: Dict[str, Any],
) -> Dict[str, Any]:
    """Wipe every attachment uploaded for a given side-panel chat session.

    Wired to the side panel's "delete chat" affordance so the per-session
    attachments directory gets reaped when its owning conversation is.
    Re-uses the path-confined deletion path of `attachment.delete` so the
    same traversal-proof guard applies — a caller can never use this to
    target anything outside the attachments root.
    """
    raw = params.get("session_id")
    if not isinstance(raw, str) or not raw:
        return {"deleted": False, "reason": "missing session_id"}
    safe = _SESSION_ID_SAFE_RE.sub("_", raw).strip("_") or "default"
    target = (_attachments_root() / safe).resolve()
    return await _handle_attachment_delete({"path": str(target)})


# Register the handlers on import so they're live as soon as the bridge
# reader task spins up.
_inbound_handlers["attachment.put"] = _handle_attachment_put
_inbound_handlers["attachment.delete"] = _handle_attachment_delete
_inbound_handlers["attachment.deleteSession"] = _handle_attachment_delete_session


# ---------------------------------------------------------------------------
# Session save / restore — cookies via chrome.cookies, localStorage via JS.
# ---------------------------------------------------------------------------


def _session_dir():
    from hermes_constants import get_hermes_home
    p = get_hermes_home() / "plugins" / PLUGIN_NAME / "sessions"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _handle_my_browser_session_save(args: dict, **kw: Any) -> str:
    args = args or {}
    name = args.get("name") or ""
    url_filter = args.get("url_filter")
    include_local_storage = bool(args.get("include_local_storage", True))
    if not name:
        return tool_error("my_browser_session_save: name is required")

    # Cookies
    cookie_params: Dict[str, Any] = {}
    if url_filter:
        # Caller may pass a URL or a bare domain — let the extension-side
        # filter decide which field to apply.
        if "://" in url_filter:
            cookie_params["url"] = url_filter
        else:
            cookie_params["domain"] = url_filter

    resp = _send("cookies_get", cookie_params, timeout=15.0)
    ok, body = _unwrap(resp)
    if not ok:
        return tool_error(f"my_browser_session_save: cookies_get failed: {body}")
    cookies: List[dict] = body.get("cookies", [])

    # localStorage (best effort — may be empty if agent tab is about:blank)
    local_storage: Dict[str, Any] = {}
    page_url: Optional[str] = None
    if include_local_storage:
        ls_resp = _send("local_storage_get", {}, timeout=10.0)
        ls_ok, ls_body = _unwrap(ls_resp)
        if ls_ok:
            local_storage = ls_body.get("storage", {}) or {}
        # Capture current page URL too — useful to know context for restore
        st_resp = _send("status", {}, timeout=5.0)
        st_ok, st_body = _unwrap(st_resp)
        if st_ok:
            page_url = st_body.get("url")

    snapshot = {
        "name": name,
        "saved_at": datetime.now(timezone.utc).isoformat(),
        "plugin_version": "0.2.0",
        "url": page_url,
        "cookies": cookies,
        "local_storage": local_storage,
    }

    snapshot_path = _session_dir() / f"{name}.json"
    snapshot_path.write_text(json.dumps(snapshot, indent=2, ensure_ascii=False))

    return tool_result({
        "success": True,
        "name": name,
        "path": str(snapshot_path),
        "cookies": len(cookies),
        "local_storage_keys": len(local_storage),
        "url": page_url,
        "message": (
            f"Session '{name}' saved ({len(cookies)} cookies, "
            f"{len(local_storage)} localStorage keys)."
        ),
    })


def _handle_my_browser_session_restore(args: dict, **kw: Any) -> str:
    args = args or {}
    name = args.get("name") or ""
    include_local_storage = bool(args.get("include_local_storage", True))
    if not name:
        return tool_error("my_browser_session_restore: name is required")

    snapshot_path = _session_dir() / f"{name}.json"
    if not snapshot_path.exists():
        sessions = sorted(p.stem for p in _session_dir().glob("*.json"))
        listing = ", ".join(sessions) if sessions else "(none)"
        return tool_error(f"Session '{name}' not found. Available: {listing}")

    snapshot = json.loads(snapshot_path.read_text())
    cookies: List[dict] = snapshot.get("cookies", [])
    local_storage: Dict[str, Any] = snapshot.get("local_storage", {}) or {}

    # Restore cookies one by one (chrome.cookies.set takes one at a time)
    cookies_set = 0
    cookie_errors: List[str] = []
    for c in cookies:
        # chrome.cookies.set requires `url`. Synthesize one if missing.
        cookie_arg = dict(c)
        if "url" not in cookie_arg:
            domain = (cookie_arg.get("domain") or "").lstrip(".")
            if not domain:
                continue
            scheme = "https" if cookie_arg.get("secure") else "http"
            path = cookie_arg.get("path", "/")
            cookie_arg["url"] = f"{scheme}://{domain}{path}"
        # Strip read-only fields that chrome.cookies.set rejects
        for ro in ("hostOnly", "session"):
            cookie_arg.pop(ro, None)

        r = _send("cookies_set", {"cookie": cookie_arg}, timeout=5.0)
        ok, body = _unwrap(r)
        if ok:
            cookies_set += 1
        else:
            cookie_errors.append(str(body))

    ls_applied = 0
    if include_local_storage and local_storage:
        ls_resp = _send(
            "local_storage_set",
            {"items": local_storage, "clear": False},
            timeout=10.0,
        )
        ok, body = _unwrap(ls_resp)
        if ok:
            ls_applied = body.get("applied", 0)

    return tool_result({
        "success": True,
        "name": name,
        "saved_at": snapshot.get("saved_at"),
        "saved_url": snapshot.get("url"),
        "cookies_restored": cookies_set,
        "cookies_failed": len(cookie_errors),
        "local_storage_restored": ls_applied,
        "message": (
            f"Session '{name}' restored ({cookies_set}/{len(cookies)} cookies, "
            f"{ls_applied} localStorage keys)."
        ),
    })


# ---------------------------------------------------------------------------
# Userscript bridge handlers (Phase 2B)
# ---------------------------------------------------------------------------


def _handle_my_browser_userscript_list(args: dict, **kw: Any) -> str:
    resp = _send("userscript.list", {}, timeout=10.0)
    ok, body = _unwrap(resp)
    if not ok:
        return tool_error(f"my_browser_userscript_list: {body}")
    return tool_result({
        "success": True,
        "count": len(body.get("scripts") or []),
        "scripts": body.get("scripts") or [],
    })


def _handle_my_browser_userscript_get(args: dict, **kw: Any) -> str:
    args = args or {}
    sid = args.get("id") or ""
    if not sid:
        return tool_error("my_browser_userscript_get: id is required")
    resp = _send("userscript.get", {"id": sid}, timeout=10.0)
    ok, body = _unwrap(resp)
    if not ok:
        return tool_error(f"my_browser_userscript_get: {body}")
    return tool_result({"success": True, "script": body.get("script")})


def _handle_my_browser_userscript_install(args: dict, **kw: Any) -> str:
    args = args or {}
    source = args.get("source")
    url = args.get("url")
    enabled = bool(args.get("enabled", True))
    if not source and not url:
        return tool_error(
            "my_browser_userscript_install: provide `source` or `url`"
        )
    params: Dict[str, Any] = {"enabled": enabled}
    if isinstance(source, str) and source:
        params["source"] = source
    if isinstance(url, str) and url:
        params["url"] = url
    resp = _send("userscript.install", params, timeout=30.0)
    ok, body = _unwrap(resp)
    if not ok:
        return tool_error(f"my_browser_userscript_install: {body}")
    s = body.get("script") or {}
    return tool_result({
        "success": True,
        "id": s.get("id"),
        "name": (s.get("meta") or {}).get("name"),
        "version": (s.get("meta") or {}).get("version"),
        "enabled": s.get("enabled"),
        "matches": (s.get("meta") or {}).get("match"),
        "message": f"Installed userscript {(s.get('meta') or {}).get('name')!r}.",
    })


def _handle_my_browser_userscript_save(args: dict, **kw: Any) -> str:
    args = args or {}
    sid = args.get("id") or ""
    source = args.get("source") or ""
    if not sid or not source:
        return tool_error("my_browser_userscript_save: id and source are required")
    resp = _send("userscript.save", {"id": sid, "source": source}, timeout=15.0)
    ok, body = _unwrap(resp)
    if not ok:
        return tool_error(f"my_browser_userscript_save: {body}")
    return tool_result({"success": True, "script": body.get("script")})


def _handle_my_browser_userscript_remove(args: dict, **kw: Any) -> str:
    args = args or {}
    sid = args.get("id") or ""
    if not sid:
        return tool_error("my_browser_userscript_remove: id is required")
    resp = _send("userscript.remove", {"id": sid}, timeout=10.0)
    ok, body = _unwrap(resp)
    if not ok:
        return tool_error(f"my_browser_userscript_remove: {body}")
    return tool_result({"success": True, "removed": body.get("removed")})


def _handle_my_browser_userscript_set_enabled(args: dict, **kw: Any) -> str:
    args = args or {}
    sid = args.get("id") or ""
    enabled = bool(args.get("enabled", True))
    if not sid:
        return tool_error(
            "my_browser_userscript_set_enabled: id is required"
        )
    resp = _send(
        "userscript.setEnabled",
        {"id": sid, "enabled": enabled},
        timeout=10.0,
    )
    ok, body = _unwrap(resp)
    if not ok:
        return tool_error(f"my_browser_userscript_set_enabled: {body}")
    return tool_result({"success": True, "script": body.get("script")})


def _handle_my_browser_userscript_run(args: dict, **kw: Any) -> str:
    args = args or {}
    sid = args.get("id") or ""
    if not sid:
        return tool_error("my_browser_userscript_run: id is required")
    params: Dict[str, Any] = {"id": sid}
    if "args" in args:
        params["args"] = args["args"]
    resp = _send("userscript.run", params, timeout=60.0)
    ok, body = _unwrap(resp)
    if not ok:
        return tool_error(f"my_browser_userscript_run: {body}")
    return tool_result({
        "success": bool(body.get("ok")),
        "value": body.get("value"),
        "error": body.get("error"),
    })


# ---------------------------------------------------------------------------
# Hermes gateway HTTP API discovery — used by the side-panel chat client.
# ---------------------------------------------------------------------------


def _read_gateway_state() -> Dict[str, Any]:
    """Read ~/.hermes/gateway_state.json if available."""
    try:
        from pathlib import Path
        from hermes_constants import get_hermes_home
        path = get_hermes_home() / "gateway_state.json"
    except Exception:
        from pathlib import Path
        path = Path.home() / ".hermes" / "gateway_state.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}


def _read_gateway_config() -> Dict[str, Any]:
    """Best-effort read of gateway api_server config (host/port)."""
    try:
        from hermes_constants import get_hermes_home
        cfg_path = get_hermes_home() / "config.yaml"
    except Exception:
        from pathlib import Path
        cfg_path = Path.home() / ".hermes" / "config.yaml"
    if not cfg_path.exists():
        return {}
    try:
        import yaml  # type: ignore
        return yaml.safe_load(cfg_path.read_text()) or {}
    except Exception:
        return {}


def _handle_my_browser_chat_url(args: dict, **kw: Any) -> str:
    state = _read_gateway_state()
    config = _read_gateway_config()

    api = ((config.get("gateway") or {}).get("api_server") or {}) if isinstance(config, dict) else {}
    host = api.get("host") or "127.0.0.1"
    port = api.get("port") or 8642
    base = f"http://{host}:{port}/v1"

    platforms = (state.get("platforms") or {}) if isinstance(state, dict) else {}
    api_status = (platforms.get("api_server") or {}).get("state") if isinstance(platforms, dict) else None

    return tool_result({
        "success": True,
        "base_url": base,
        "default_base_url": DEFAULT_GATEWAY_API_BASE,
        "api_server_state": api_status,
        "endpoints": {
            "chat_completions": f"{base}/chat/completions",
            "models": f"{base}/models",
            "responses": f"{base}/responses",
        },
        "message": (
            f"Hermes gateway chat API base is {base}"
            + (f" (status: {api_status})" if api_status else "")
        ),
    })
