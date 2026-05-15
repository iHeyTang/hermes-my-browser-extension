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

logger = logging.getLogger(__name__)

# NOTE: Do not import `.tools` at package import time. The bridge subprocess runs
# `python -m hermes_my_browser_extension.bridge.server` with cwd = this repo; a
# top-level `from .tools` would load `tools.py`, whose `from tools.registry …`
# then resolves `tools` to that same file (not Hermes's `tools` package) and
# crashes with ModuleNotFoundError. Lazy-import inside `register()` only.

# ---------------------------------------------------------------------------
# Bridge process management
# ---------------------------------------------------------------------------

_bridge_process: subprocess.Popen | None = None


def _get_bridge_port() -> int:
    """Return the port the bridge should listen on."""
    import os
    return int(os.environ.get("MY_BROWSER_BRIDGE_PORT", "9393"))


def _get_attach_http_port() -> int:
    """HTTP POST /attach port (0 = disabled in bridge process)."""
    import os
    return int(os.environ.get("MY_BROWSER_ATTACH_HTTP_PORT", "9394"))


def _bridge_pkg_root() -> Path:
    """Directory that contains the `bridge/` package (this plugin root)."""
    return Path(__file__).resolve().parent


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


def _bridge_run_module() -> str:
    """Module path for `python -m …` bridge subprocess.

    Prefer ``bridge.server`` with ``cwd`` = plugin root: only loads the ``bridge/``
    tree and never imports ``hermes_my_browser_extension``'s package ``__init__``
    (which would pull Hermes-only ``tools`` imports when mis-resolved).

    Fall back to ``hermes_my_browser_extension.bridge.server`` only if the
    on-disk ``bridge/server.py`` layout is missing (unusual).
    """
    pkg_root = _bridge_pkg_root()
    if (pkg_root / "bridge" / "server.py").exists():
        return "bridge.server"
    try:
        import importlib.util

        if importlib.util.find_spec("hermes_my_browser_extension.bridge.server") is not None:
            return "hermes_my_browser_extension.bridge.server"
    except Exception:
        pass
    return "bridge.server"


def start_bridge() -> None:
    """Start the WebSocket bridge as a background subprocess."""
    import os

    global _bridge_process
    if _bridge_process is not None and _bridge_process.poll() is None:
        return  # already running

    pkg_root = _bridge_pkg_root()
    if not (pkg_root / "bridge" / "server.py").exists():
        logger.warning("Bridge package not found under %s — skipping auto-start", pkg_root)
        return

    port = _get_bridge_port()
    http_port = _get_attach_http_port()
    log_path = _bridge_log_path()
    try:
        from .bridge.adapters.dotenv_local import apply_plugin_dotenv

        apply_plugin_dotenv(base=pkg_root)
    except Exception:
        pass
    try:
        # Append to the log so successive Hermes restarts accumulate (truncate
        # the file manually if it gets too big).
        log_fp = open(log_path, "a", buffering=1)
        log_fp.write(
            f"\n--- my-browser-bridge starting (ws={port}, http_attach={http_port}) ---\n"
        )
        _bridge_process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                _bridge_run_module(),
                "--port",
                str(port),
                "--http-attach-port",
                str(http_port),
            ],
            cwd=str(pkg_root),
            env=os.environ.copy(),
            stdout=log_fp,
            stderr=subprocess.STDOUT,
        )
        logger.info(
            "my-browser-bridge started (pid=%d, ws=%d, http_attach=%d, log=%s)",
            _bridge_process.pid,
            port,
            http_port,
            log_path,
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


def _tools_registration_bundle():
    """Import Hermes-facing tool modules only when registering (not in bridge subprocess)."""
    from .tools import (
        MY_BROWSER_BOOKMARKS_LIST_SCHEMA,
        MY_BROWSER_BOOKMARKS_MANAGE_SCHEMA,
        MY_BROWSER_CHAT_URL_SCHEMA,
        MY_BROWSER_CLICK_SCHEMA,
        MY_BROWSER_EVAL_SCHEMA,
        MY_BROWSER_ACTIVE_TAB_SCHEMA,
        MY_BROWSER_GET_HTML_SCHEMA,
        MY_BROWSER_GET_TEXT_SCHEMA,
        MY_BROWSER_LIST_TABS_SCHEMA,
        MY_BROWSER_NAVIGATE_SCHEMA,
        MY_BROWSER_READ_TAB_SCHEMA,
        MY_BROWSER_SCREENSHOT_SCHEMA,
        MY_BROWSER_SESSION_RESTORE_SCHEMA,
        MY_BROWSER_SESSION_SAVE_SCHEMA,
        MY_BROWSER_STATUS_SCHEMA,
        MY_BROWSER_TYPE_SCHEMA,
        MY_BROWSER_USERSCRIPT_LIST_SCHEMA,
        MY_BROWSER_USERSCRIPT_MANAGE_SCHEMA,
        MY_BROWSER_USERSCRIPT_RUN_SCHEMA,
        _check_my_browser_available,
        _handle_my_browser_bookmarks_list,
        _handle_my_browser_bookmarks_manage,
        _handle_my_browser_chat_url,
        _handle_my_browser_click,
        _handle_my_browser_eval,
        _handle_my_browser_active_tab,
        _handle_my_browser_get_html,
        _handle_my_browser_get_text,
        _handle_my_browser_list_tabs,
        _handle_my_browser_navigate,
        _handle_my_browser_read_tab,
        _handle_my_browser_screenshot,
        _handle_my_browser_session_restore,
        _handle_my_browser_session_save,
        _handle_my_browser_status,
        _handle_my_browser_type,
        _handle_my_browser_userscript_list,
        _handle_my_browser_userscript_manage,
        _handle_my_browser_userscript_run,
        _on_session_end,
        _on_session_start,
    )

    tools = (
        ("my_browser_status", MY_BROWSER_STATUS_SCHEMA, _handle_my_browser_status, "📡"),
        ("my_browser_navigate", MY_BROWSER_NAVIGATE_SCHEMA, _handle_my_browser_navigate, "🧭"),
        ("my_browser_screenshot", MY_BROWSER_SCREENSHOT_SCHEMA, _handle_my_browser_screenshot, "📸"),
        ("my_browser_eval", MY_BROWSER_EVAL_SCHEMA, _handle_my_browser_eval, "🧪"),
        ("my_browser_click", MY_BROWSER_CLICK_SCHEMA, _handle_my_browser_click, "🖱"),
        ("my_browser_type", MY_BROWSER_TYPE_SCHEMA, _handle_my_browser_type, "⌨️"),
        ("my_browser_get_html", MY_BROWSER_GET_HTML_SCHEMA, _handle_my_browser_get_html, "📄"),
        ("my_browser_get_text", MY_BROWSER_GET_TEXT_SCHEMA, _handle_my_browser_get_text, "📝"),
        ("my_browser_active_tab", MY_BROWSER_ACTIVE_TAB_SCHEMA, _handle_my_browser_active_tab, "👁"),
        ("my_browser_list_tabs", MY_BROWSER_LIST_TABS_SCHEMA, _handle_my_browser_list_tabs, "🗂"),
        ("my_browser_read_tab", MY_BROWSER_READ_TAB_SCHEMA, _handle_my_browser_read_tab, "📖"),
        ("my_browser_session_save", MY_BROWSER_SESSION_SAVE_SCHEMA, _handle_my_browser_session_save, "💾"),
        ("my_browser_session_restore", MY_BROWSER_SESSION_RESTORE_SCHEMA, _handle_my_browser_session_restore, "🔁"),
        ("my_browser_userscript_list", MY_BROWSER_USERSCRIPT_LIST_SCHEMA, _handle_my_browser_userscript_list, "📜"),
        ("my_browser_userscript_manage", MY_BROWSER_USERSCRIPT_MANAGE_SCHEMA, _handle_my_browser_userscript_manage, "🛠"),
        ("my_browser_userscript_run", MY_BROWSER_USERSCRIPT_RUN_SCHEMA, _handle_my_browser_userscript_run, "🚀"),
        ("my_browser_bookmarks_list", MY_BROWSER_BOOKMARKS_LIST_SCHEMA, _handle_my_browser_bookmarks_list, "🔖"),
        ("my_browser_bookmarks_manage", MY_BROWSER_BOOKMARKS_MANAGE_SCHEMA, _handle_my_browser_bookmarks_manage, "🗂"),
        ("my_browser_chat_url", MY_BROWSER_CHAT_URL_SCHEMA, _handle_my_browser_chat_url, "💬"),
    )
    return tools, _check_my_browser_available, _on_session_start, _on_session_end


def register(ctx) -> None:
    """Register all tools and hooks with the plugin loader."""
    logger.info("Registering hermes-my-browser-extension")

    # Start the bridge process
    start_bridge()

    tools, check_fn, on_session_start, on_session_end = _tools_registration_bundle()

    # Register tools
    for name, schema, handler, emoji in tools:
        ctx.register_tool(
            name=name,
            toolset="my-browser-extension",
            schema=schema,
            handler=handler,
            check_fn=check_fn,
            emoji=emoji,
        )

    # Register lifecycle hooks
    ctx.register_hook("on_session_start", on_session_start)
    ctx.register_hook("on_session_end", on_session_end)

    logger.info(
        "hermes-my-browser-extension loaded: %d tools, 2 hooks",
        len(tools),
    )
