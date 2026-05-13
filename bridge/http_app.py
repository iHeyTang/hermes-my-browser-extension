from __future__ import annotations

from aiohttp import web

from .routes.common import json_error
from .routes.config_routes import register_config_routes
from .routes.cron_routes import register_cron_routes
from .routes.memory_routes import register_memory_routes
from .routes.misc_routes import max_client_size_bytes, register_misc_routes
from .routes.model_routes import register_model_routes
from .routes.skills_routes import register_skills_routes


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
    register_model_routes(app)
    register_config_routes(app)
    register_memory_routes(app)
    register_skills_routes(app)
    register_cron_routes(app)
    register_misc_routes(app)
    app.router.add_route(
        "OPTIONS", "/{path_info:.*}", lambda _req: web.Response(status=204)
    )
    return app
