"""
hermes-my-browser-extension — Browser extension plugin for Hermes Agent.

Architecture:
    Hermes Plugin ←WS→ bridge.py ←WS→ Chrome Extension → chrome.debugger

The plugin starts the WebSocket bridge as a background process when
Hermes loads. The Chrome Extension connects to the same bridge and
executes CDP commands via chrome.debugger API.
"""

from __future__ import annotations

import atexit
import logging
import subprocess
import sys
from pathlib import Path

from .tools import (
    MY_BROWSER_CONNECT_SCHEMA,
    MY_BROWSER_DISCONNECT_SCHEMA,
    MY_BROWSER_STATUS_SCHEMA,
    MY_BROWSER_NAVIGATE_SCHEMA,
    MY_BROWSER_SCREENSHOT_SCHEMA,
    MY_BROWSER_EVAL_SCHEMA,
    MY_BROWSER_CLICK_SCHEMA,
    MY_BROWSER_TYPE_SCHEMA,
    MY_BROWSER_GET_HTML_SCHEMA,
    MY_BROWSER_GET_TEXT_SCHEMA,
    MY_BROWSER_SESSION_SAVE_SCHEMA,
    MY_BROWSER_SESSION_RESTORE_SCHEMA,
    MY_BROWSER_USERSCRIPT_LIST_SCHEMA,
    MY_BROWSER_USERSCRIPT_GET_SCHEMA,
    MY_BROWSER_USERSCRIPT_INSTALL_SCHEMA,
    MY_BROWSER_USERSCRIPT_SAVE_SCHEMA,
    MY_BROWSER_USERSCRIPT_REMOVE_SCHEMA,
    MY_BROWSER_USERSCRIPT_SET_ENABLED_SCHEMA,
    MY_BROWSER_USERSCRIPT_RUN_SCHEMA,
    MY_BROWSER_CHAT_URL_SCHEMA,
    _check_my_browser_available,
    _handle_my_browser_connect,
    _handle_my_browser_disconnect,
    _handle_my_browser_status,
    _handle_my_browser_navigate,
    _handle_my_browser_screenshot,
    _handle_my_browser_eval,
    _handle_my_browser_click,
    _handle_my_browser_type,
    _handle_my_browser_get_html,
    _handle_my_browser_get_text,
    _handle_my_browser_session_save,
    _handle_my_browser_session_restore,
    _handle_my_browser_userscript_list,
    _handle_my_browser_userscript_get,
    _handle_my_browser_userscript_install,
    _handle_my_browser_userscript_save,
    _handle_my_browser_userscript_remove,
    _handle_my_browser_userscript_set_enabled,
    _handle_my_browser_userscript_run,
    _handle_my_browser_chat_url,
    _on_session_start,
    _on_session_end,
)

logger = logging.getLogger(__name__)

_TOOLS = (
    ("my_browser_connect",                MY_BROWSER_CONNECT_SCHEMA,                _handle_my_browser_connect,                "🔗"),
    ("my_browser_disconnect",             MY_BROWSER_DISCONNECT_SCHEMA,             _handle_my_browser_disconnect,             "🔌"),
    ("my_browser_status",                 MY_BROWSER_STATUS_SCHEMA,                 _handle_my_browser_status,                 "📡"),
    ("my_browser_navigate",               MY_BROWSER_NAVIGATE_SCHEMA,               _handle_my_browser_navigate,               "🧭"),
    ("my_browser_screenshot",             MY_BROWSER_SCREENSHOT_SCHEMA,             _handle_my_browser_screenshot,             "📸"),
    ("my_browser_eval",                   MY_BROWSER_EVAL_SCHEMA,                   _handle_my_browser_eval,                   "🧪"),
    ("my_browser_click",                  MY_BROWSER_CLICK_SCHEMA,                  _handle_my_browser_click,                  "🖱"),
    ("my_browser_type",                   MY_BROWSER_TYPE_SCHEMA,                   _handle_my_browser_type,                   "⌨️"),
    ("my_browser_get_html",               MY_BROWSER_GET_HTML_SCHEMA,               _handle_my_browser_get_html,               "📄"),
    ("my_browser_get_text",               MY_BROWSER_GET_TEXT_SCHEMA,               _handle_my_browser_get_text,               "📝"),
    ("my_browser_session_save",           MY_BROWSER_SESSION_SAVE_SCHEMA,           _handle_my_browser_session_save,           "💾"),
    ("my_browser_session_restore",        MY_BROWSER_SESSION_RESTORE_SCHEMA,        _handle_my_browser_session_restore,        "🔁"),
    # Userscript engine (Tampermonkey-compatible) — added in v0.3.0
    ("my_browser_userscript_list",        MY_BROWSER_USERSCRIPT_LIST_SCHEMA,        _handle_my_browser_userscript_list,        "📜"),
    ("my_browser_userscript_get",         MY_BROWSER_USERSCRIPT_GET_SCHEMA,         _handle_my_browser_userscript_get,         "🔎"),
    ("my_browser_userscript_install",     MY_BROWSER_USERSCRIPT_INSTALL_SCHEMA,     _handle_my_browser_userscript_install,     "📥"),
    ("my_browser_userscript_save",        MY_BROWSER_USERSCRIPT_SAVE_SCHEMA,        _handle_my_browser_userscript_save,        "💽"),
    ("my_browser_userscript_remove",      MY_BROWSER_USERSCRIPT_REMOVE_SCHEMA,      _handle_my_browser_userscript_remove,      "🗑️"),
    ("my_browser_userscript_set_enabled", MY_BROWSER_USERSCRIPT_SET_ENABLED_SCHEMA, _handle_my_browser_userscript_set_enabled, "⏯️"),
    ("my_browser_userscript_run",         MY_BROWSER_USERSCRIPT_RUN_SCHEMA,         _handle_my_browser_userscript_run,         "🚀"),
    # Chat side panel discovery — added in v0.3.0
    ("my_browser_chat_url",               MY_BROWSER_CHAT_URL_SCHEMA,               _handle_my_browser_chat_url,               "💬"),
)

# ---------------------------------------------------------------------------
# Bridge process management
# ---------------------------------------------------------------------------

_bridge_process: subprocess.Popen | None = None


def _get_bridge_port() -> int:
    """Return the port the bridge should listen on."""
    import os
    return int(os.environ.get("MY_BROWSER_BRIDGE_PORT", "9393"))


def _bridge_script() -> str:
    """Return the absolute path to bridge/server.py."""
    return str(Path(__file__).parent / "bridge" / "server.py")


def _bridge_log_path() -> Path:
    """Return the path to the bridge log file inside ~/.hermes/logs/.

    Falls back to a temp dir if hermes_constants isn't importable (e.g. when
    running the bridge standalone for tests).
    """
    try:
        from hermes_constants import get_hermes_home
        log_dir = get_hermes_home() / "logs"
    except Exception:
        import tempfile
        log_dir = Path(tempfile.gettempdir()) / "hermes-logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir / "my-browser-bridge.log"


def start_bridge() -> None:
    """Start the WebSocket bridge as a background subprocess."""
    global _bridge_process
    if _bridge_process is not None and _bridge_process.poll() is None:
        return  # already running

    script = _bridge_script()
    if not Path(script).exists():
        logger.warning("Bridge script not found at %s — skipping auto-start", script)
        return

    port = _get_bridge_port()
    log_path = _bridge_log_path()
    try:
        # Append to the log so successive Hermes restarts accumulate (truncate
        # the file manually if it gets too big).
        log_fp = open(log_path, "a", buffering=1)
        log_fp.write(f"\n--- my-browser-bridge starting (port={port}) ---\n")
        _bridge_process = subprocess.Popen(
            [sys.executable, script, "--port", str(port)],
            stdout=log_fp,
            stderr=subprocess.STDOUT,
        )
        logger.info(
            "my-browser-bridge started (pid=%d, port=%d, log=%s)",
            _bridge_process.pid, port, log_path,
        )
    except Exception as exc:
        logger.error("Failed to start my-browser-bridge: %s (log=%s)", exc, log_path)
        _bridge_process = None


def stop_bridge() -> None:
    """Stop the WebSocket bridge if running."""
    global _bridge_process
    if _bridge_process is None:
        return
    try:
        _bridge_process.terminate()
        _bridge_process.wait(timeout=5)
        logger.info("my-browser-bridge stopped")
    except Exception as exc:
        logger.warning("Error stopping my-browser-bridge: %s", exc)
    finally:
        _bridge_process = None


# Auto-stop bridge on Hermes exit
atexit.register(stop_bridge)


# ---------------------------------------------------------------------------
# Plugin registration
# ---------------------------------------------------------------------------


def register(ctx) -> None:
    """Register all tools and hooks with the plugin loader."""
    logger.info("Registering hermes-my-browser-extension")

    # Start the bridge process
    start_bridge()

    # Register tools
    for name, schema, handler, emoji in _TOOLS:
        ctx.register_tool(
            name=name,
            toolset="my-browser-extension",
            schema=schema,
            handler=handler,
            check_fn=_check_my_browser_available,
            emoji=emoji,
        )

    # Register lifecycle hooks
    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_hook("on_session_end", _on_session_end)

    logger.info(
        "hermes-my-browser-extension loaded: %d tools, 2 hooks",
        len(_TOOLS),
    )
