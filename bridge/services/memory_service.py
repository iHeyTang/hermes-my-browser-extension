"""Read-only access to the Hermes curated memory files.

Hermes stores curated memory as two markdown files under ``$HERMES_HOME/memories``:
``MEMORY.md`` (agent self-notes) and ``USER.md`` (notes about the user). Entries
are separated by ``\\n§\\n``. Character limits mirror the upstream defaults
in ``hermes-agent/tools/memory_tool.py`` so the UI can show usage bars.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List

from ..adapters.hermes_core import hermes_home

ENTRY_DELIMITER = "\n§\n"

MEMORY_TARGETS = ("memory", "user")

# Mirrors MemoryStore defaults in hermes-agent/tools/memory_tool.py.
_CHAR_LIMITS: Dict[str, int] = {
    "memory": 2200,
    "user": 1375,
}

_FILE_NAMES: Dict[str, str] = {
    "memory": "MEMORY.md",
    "user": "USER.md",
}


def _memory_dir() -> Path:
    return hermes_home() / "memories"


def _path_for(target: str) -> Path:
    return _memory_dir() / _FILE_NAMES[target]


def _parse_entries(text: str) -> List[str]:
    if not text:
        return []
    parts = text.split(ENTRY_DELIMITER)
    return [p.strip() for p in parts if p.strip()]


def read_memory_entries(target: str) -> Dict[str, Any]:
    if target not in MEMORY_TARGETS:
        raise ValueError(f"target must be one of: {', '.join(MEMORY_TARGETS)}")

    path = _path_for(target)
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        entries: List[str] = []
    except OSError as exc:
        raise OSError(f"failed to read {path}: {exc}") from exc
    else:
        entries = _parse_entries(raw)

    char_count = len(ENTRY_DELIMITER.join(entries)) if entries else 0
    return {
        "target": target,
        "path": str(path),
        "entries": entries,
        "char_count": char_count,
        "char_limit": _CHAR_LIMITS[target],
    }


def read_memory_entries_response(target: str) -> Dict[str, Any]:
    return {"ok": True, **read_memory_entries(target)}
