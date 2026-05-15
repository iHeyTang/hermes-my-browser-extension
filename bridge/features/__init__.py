"""Feature modules that compose the bridge's HTTP surface.

Each subpackage owns one functional domain and exposes a top-level
``register(app)`` function. Domains are independent: adding or removing
a feature touches exactly its own subpackage and the ``FEATURES`` list
below. Future plugin extraction (one Hermes plugin per feature) is
mechanical — copy the subpackage and wire it into a separate
``plugin.yaml`` + bridge entrypoint.

Current features
----------------
- ``chrome_extension`` — the WebSocket hub's HTTP companion: side-panel
  attachment uploads. Foundational; everything else assumes the hub
  itself is running but does not depend on attachment storage.
- ``cron`` — CRUD wrapper over Hermes core's ``cron.jobs`` module, plus
  a read-only index over the markdown files it writes per run.
- ``lark`` — ``lark-cli`` search proxy.
- ``hermes_settings`` — Hermes core configuration shims: model catalog,
  main/auxiliary models, provider credentials, skills, memory.
"""

from __future__ import annotations

from typing import Callable, Iterable, Tuple

from aiohttp import web

from . import chrome_extension, cron, hermes_settings, lark

# (name, register_fn). Order is informational — aiohttp matches by URL
# pattern so registration order doesn't affect routing.
FEATURES: Tuple[Tuple[str, Callable[[web.Application], None]], ...] = (
    ("chrome_extension", chrome_extension.register),
    ("cron", cron.register),
    ("lark", lark.register),
    ("hermes_settings", hermes_settings.register),
)


def register_all(app: web.Application) -> None:
    """Register every enabled feature's routes on *app*."""
    for _name, fn in FEATURES:
        fn(app)


def iter_features() -> Iterable[Tuple[str, Callable[[web.Application], None]]]:
    return iter(FEATURES)
