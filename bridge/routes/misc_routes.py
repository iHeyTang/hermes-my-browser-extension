from __future__ import annotations

from urllib.parse import unquote

from aiohttp import web

from ..services.attachment_service import (
    MAX_ATTACHMENT_BYTES,
    build_attachment_upload_response,
)
from .common import json_error


async def handle_attach_upload(request: web.Request) -> web.Response:
    session_id = request.query.get("session_id")
    name = unquote(request.query.get("name", "file"))
    mime = unquote(request.query.get("mime", "")) or request.content_type
    if not mime:
        mime = "application/octet-stream"

    data = await request.read()
    try:
        result = build_attachment_upload_response(
            session_id=session_id,
            name=name,
            mime=mime,
            content_length=request.content_length,
            data=data,
        )
        return web.json_response(result)
    except ValueError as exc:
        return json_error(400, str(exc))
    except OverflowError as exc:
        return json_error(413, str(exc))


def max_client_size_bytes() -> int:
    return MAX_ATTACHMENT_BYTES


def register_misc_routes(app: web.Application) -> None:
    app.add_routes(
        [
            web.post("/attach", handle_attach_upload),
        ]
    )
