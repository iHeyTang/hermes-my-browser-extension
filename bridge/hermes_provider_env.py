"""Provider slug → environment variable names (Hermes ``ProviderProfile.env_vars``)."""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List

logger = logging.getLogger("my-browser-bridge")


def env_var_names_for_slug(slug: str) -> List[str]:
    """Return declared ``env_vars`` for a provider profile, or []."""
    s = str(slug).strip()
    if not s or s in ("auto", "custom"):
        return []
    try:
        from providers import get_provider_profile

        prof = get_provider_profile(s)
    except Exception:
        return []
    if prof is None:
        return []
    ev: Any = getattr(prof, "env_vars", None)
    if not ev:
        return []
    return [str(x).strip() for x in ev if str(x).strip()]


def collect_provider_env_var_map(provider_slugs: List[str]) -> Dict[str, List[str]]:
    """Return ``{slug: ["API_KEY", ...]}`` for slugs that have a registered profile.

    Empty dict when ``providers`` / plugins cannot be imported (bridge without
    full Hermes install).
    """
    out: Dict[str, List[str]] = {}
    seen: set[str] = set()
    try:
        from providers import get_provider_profile  # noqa: F401 — package load check
    except Exception as exc:
        logger.info("provider env map skipped (import providers): %s", exc)
        return out

    for slug in provider_slugs:
        if slug in ("auto", "custom"):
            continue
        s = str(slug).strip()
        if not s or s in seen:
            continue
        seen.add(s)
        names = env_var_names_for_slug(s)
        if names:
            out[s] = names
    return out


def provider_slugs_with_credentials_set(
    provider_env_map: Dict[str, List[str]],
) -> List[str]:
    """Return sorted slugs where at least one declared profile env var is non-empty.

    Uses the bridge process environment (plugin ``.env`` merged at startup / on save).
    """
    out: List[str] = []
    for slug in sorted(provider_env_map.keys()):
        if slug in ("auto", "custom"):
            continue
        names = provider_env_map[slug]
        if any(str(os.environ.get(n, "") or "").strip() for n in names):
            out.append(slug)
    return out


def provider_env_bridge_status(provider_slug: str) -> Dict[str, Any]:
    """For each declared env var: whether it is non-empty in the bridge process.

    Does not return secret values — only ``set`` and ``length``.
    """
    raw = (provider_slug or "").strip()
    if not raw or raw in ("auto", "custom"):
        return {"ok": True, "provider": raw, "env_vars": []}
    names = env_var_names_for_slug(raw)
    rows: List[Dict[str, Any]] = []
    for n in names:
        v = os.environ.get(n, "").strip()
        rows.append({"name": n, "set": bool(v), "length": len(v)})
    return {"ok": True, "provider": raw, "env_vars": rows}
