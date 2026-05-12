from __future__ import annotations

import json
from typing import Any, Dict

from aiohttp import web

MAX_JSON_BODY_BYTES = 64 * 1024


def json_error(status: int, message: str) -> web.Response:
    return web.json_response({"ok": False, "error": message}, status=status)


async def read_json_object(request: web.Request) -> Dict[str, Any]:
    raw_body = await request.read()
    if not raw_body:
        raise web.HTTPBadRequest(
            text=json.dumps({"ok": False, "error": "empty body"}),
            content_type="application/json",
        )
    if len(raw_body) > MAX_JSON_BODY_BYTES:
        raise web.HTTPBadRequest(
            text=json.dumps(
                {"ok": False, "error": f"body too large (max {MAX_JSON_BODY_BYTES} bytes)"}
            ),
            content_type="application/json",
        )
    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except Exception as exc:
        raise web.HTTPBadRequest(
            text=json.dumps({"ok": False, "error": f"invalid JSON: {exc}"}),
            content_type="application/json",
        )
    if not isinstance(payload, dict):
        raise web.HTTPBadRequest(
            text=json.dumps({"ok": False, "error": "JSON object required"}),
            content_type="application/json",
        )
    return payload

