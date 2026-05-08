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
import tempfile
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from tools.registry import tool_error, tool_result

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PLUGIN_NAME = "hermes-my-browser-extension"
BRIDGE_PORT = int(os.environ.get("MY_BROWSER_BRIDGE_PORT", "9393"))
BRIDGE_URL = f"ws://127.0.0.1:{BRIDGE_PORT}"

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
# event loop. Concurrency on the single shared websocket is serialized by
# `_send_lock` (created lazily on the bg loop) so request/response framing
# stays paired.
# ---------------------------------------------------------------------------

_ws_connection = None
_send_lock: Optional[asyncio.Lock] = None

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
    """Open the bridge websocket if it is not already connected."""
    global _ws_connection
    import websockets

    if _is_ws_open(_ws_connection):
        return _ws_connection

    _ws_connection = await websockets.connect(BRIDGE_URL)
    await _ws_connection.send(json.dumps({"role": "agent"}))
    return _ws_connection


async def _send_async(method: str, params: dict | None, timeout: float) -> dict:
    """Send one intent command and await the matching response."""
    global _send_lock
    if _send_lock is None:
        _send_lock = asyncio.Lock()

    async with _send_lock:
        ws = await _ensure_ws()
        req_id = _next_id()
        payload = json.dumps({
            "id": req_id,
            "method": method,
            "params": params or {},
        })
        await ws.send(payload)

        while True:
            raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
            try:
                resp = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if resp.get("id") == req_id:
                return resp


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
    global _ws_connection
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
# Session save / restore — cookies via chrome.cookies, localStorage via JS.
# ---------------------------------------------------------------------------


def _session_dir():
    from pathlib import Path
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
