from __future__ import annotations

from aiohttp import web

from .lark_cli import search_all


def _parse_int(value: str | None, default: int) -> int:
    if not value:
        return default
    try:
        return int(value)
    except ValueError:
        return default


async def handle_search(request: web.Request) -> web.Response:
    query = request.query.get("q", "")
    limit = _parse_int(request.query.get("limit"), 8)
    payload = await search_all(query, limit)
    # Always 200 — the extension treats an empty / error result as "fall
    # back to free-text", not as a transport failure.
    return web.json_response(payload)


def register(app: web.Application) -> None:
    app.add_routes(
        [
            web.get("/hermes/lark/search", handle_search),
        ]
    )
