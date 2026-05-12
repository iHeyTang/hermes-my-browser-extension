"""
Attachment upload service.

Owns both the request-level validation and the on-disk persistence layout
under ``<hermes_home>/plugins/<plugin>/attachments/<session>/``. The plugin
has no other use for attachment storage, so there is no separate adapter.
"""

from __future__ import annotations

import os
import re
import secrets
from pathlib import Path
from typing import Any, Dict, Optional

from ..adapters.hermes_core import hermes_home

PLUGIN_NAME = "hermes-my-browser-extension"
MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
_FILENAME_SAFE_RE = re.compile(r"[^A-Za-z0-9._-]+")
_SESSION_ID_SAFE_RE = re.compile(r"[^A-Za-z0-9_-]+")


def _attachments_root() -> Path:
    root = hermes_home() / "plugins" / PLUGIN_NAME / "attachments"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _attachment_session_dir(session_id: Optional[str]) -> Path:
    safe = _SESSION_ID_SAFE_RE.sub("_", str(session_id or "default")).strip("_")
    if not safe:
        safe = "default"
    p = _attachments_root() / safe
    p.mkdir(parents=True, exist_ok=True)
    return p


def _safe_basename(raw: str) -> str:
    base = os.path.basename(raw or "").strip()
    if not base or base in (".", ".."):
        return "file"
    cleaned = _FILENAME_SAFE_RE.sub("_", base).strip("._-")
    return cleaned or "file"


def _save_attachment(
    session_id: Optional[str], name: str, mime: str, data: bytes
) -> Dict[str, Any]:
    name = _safe_basename(name)
    mime = (mime or "application/octet-stream").strip() or "application/octet-stream"
    session_dir = _attachment_session_dir(session_id)
    uid = secrets.token_hex(4)
    target = session_dir / f"{uid}_{name}"
    target.write_bytes(data)
    return {
        "ok": True,
        "path": str(target),
        "name": name,
        "mime": mime,
        "size": len(data),
    }


def build_attachment_upload_response(
    *,
    session_id: Optional[str],
    name: str,
    mime: str,
    content_length: Optional[int],
    data: bytes,
) -> Dict[str, Any]:
    cl = int(content_length or 0)
    if cl <= 0:
        raise ValueError("Content-Length required")
    if cl > MAX_ATTACHMENT_BYTES:
        raise OverflowError("attachment too large")
    if not data:
        raise ValueError("empty body")
    if len(data) > MAX_ATTACHMENT_BYTES:
        raise OverflowError("attachment too large")
    return _save_attachment(session_id=session_id, name=name, mime=mime, data=data)
