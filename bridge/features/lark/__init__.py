"""Lark — library + HTTP adapter, intentionally layered.

This package is split into two independent layers that should be kept
separate for future extraction:

  ``lark_cli``  — Python library wrapping the ``lark-cli`` subprocess.
                  No HTTP. No bridge-internal imports beyond ``hermes_constants``
                  (with a fallback). Any in-process consumer — this plugin,
                  another Hermes plugin, an ad-hoc script — can import it.

  ``routes``    — HTTP adapter that exposes the library to the browser
                  extension (which can't ``import`` Python). This layer
                  exists *only* because one of our consumers happens to
                  live in a browser; it is not part of the lark library
                  itself.

The split mirrors how Hermes ships its own integrations: ``hermes_cli.cron.jobs``
is a Python module, and any HTTP exposure lives in the consumer (in our
case ``bridge/features/cron/service.py``). Lark follows the same pattern.

Future extraction
-----------------
If ``lark_cli`` ever grows a second consumer outside this plugin, it can
move into a sibling Python package (``hermes_lark/``) by:

1. Moving ``lark_cli.py`` to the new package
2. Updating ``routes.py`` to ``from hermes_lark import search_all``

No other changes — the library has no other dependencies on this plugin.
"""

from __future__ import annotations

from .lark_cli import search_all
from .routes import register

__all__ = ["register", "search_all"]
