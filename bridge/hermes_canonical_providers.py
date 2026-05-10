"""
Same provider list as `hermes model` TUI: `hermes_cli.models.CANONICAL_PROVIDERS`.

Requires Hermes Agent installed in the same Python environment as the bridge
(typically when Hermes starts the plugin / bridge). If import fails, returns
None and the HTTP handler falls back to manifest/config keys only.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional


def try_load_canonical_providers() -> Optional[List[Dict[str, Any]]]:
    """Return [{'slug', 'label', 'tui_desc'}, ...] or None if hermes_cli unavailable."""
    try:
        from hermes_cli.models import CANONICAL_PROVIDERS
    except Exception:
        return None
    out: List[Dict[str, Any]] = []
    for entry in CANONICAL_PROVIDERS:
        try:
            slug = str(getattr(entry, "slug", "") or "").strip()
            if not slug:
                continue
            out.append(
                {
                    "slug": slug,
                    "label": str(getattr(entry, "label", "") or slug),
                    "tui_desc": str(getattr(entry, "tui_desc", "") or slug),
                }
            )
        except Exception:
            continue
    return out or None
