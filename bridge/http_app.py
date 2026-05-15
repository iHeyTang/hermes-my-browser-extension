"""HTTP application factory.

Composes the bridge's HTTP surface from independent feature modules under
``bridge/features/``. Each feature owns its own routes and is registered
via the central ``FEATURES`` list there — adding or removing a feature
touches exactly its own subpackage.
"""

from __future__ import annotations

from aiohttp import web

from .common import json_error
from .features import register_all
from .features.chrome_extension import max_client_size_bytes


@web.middleware
async def cors_middleware(request: web.Request, handler):
    if request.method == "OPTIONS":
        resp = web.Response(status=204)
    else:
        try:
            resp = await handler(request)
        except web.HTTPException as exc:
            if exc.content_type == "application/json":
                resp = exc
            else:
                resp = json_error(exc.status, exc.reason)

    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Max-Age"] = "86400"
    return resp


def build_http_app() -> web.Application:
    app = web.Application(
        middlewares=[cors_middleware], client_max_size=max_client_size_bytes()
    )
    register_all(app)
    app.router.add_route(
        "OPTIONS", "/{path_info:.*}", lambda _req: web.Response(status=204)
    )
    return app
