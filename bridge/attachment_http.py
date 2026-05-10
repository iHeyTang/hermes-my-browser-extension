"""
Local HTTP attachment upload for the side panel.

POST /attach?session_id=&name=&mime= with raw body bytes — same on-disk layout
as tools._handle_attachment_put (WebSocket path). Listens on 127.0.0.1 only.

GET/POST /hermes/main-model — read/write ~/.hermes/config.yaml model: block
(same persistence as `hermes model`).

GET /hermes/model-catalog — curated provider/model manifest (Hermes docs JSON +
~/.hermes/cache fallback), merged with config.yaml custom provider names.

GET /hermes/provider-models?provider=&refresh= — model ids for one provider via
``hermes_cli.models.curated_models_for_provider`` (same path as ``hermes model``
after provider / auth), with manifest description overlay.

GET /hermes/provider-env-status?provider= — non-secret snapshot: which profile
``env_vars`` are set in the bridge process (boolean + length only).

GET /hermes/dotenv?keys=K1,K2 — values from plugin ``.env`` (else ``os.environ``).
POST /hermes/dotenv — JSON ``{"updates": {"KEY": "value"}}`` merges into ``.env``
and updates the bridge process environment.

CORS: Access-Control-Allow-Origin * so chrome-extension:// pages can fetch.
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import re
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
from urllib.parse import parse_qs, unquote, urlparse

from bridge.hermes_agent_model import (
    AUXILIARY_SLOTS,
    read_auxiliary_models,
    read_config_provider_keys,
    read_main_model,
    write_auxiliary_slot,
    write_main_model,
)
from bridge.hermes_canonical_providers import try_load_canonical_providers
from bridge.hermes_model_catalog import (
    get_model_catalog_manifest,
    merge_provider_ids,
)
from bridge.hermes_provider_env import (
    collect_provider_env_var_map,
    provider_env_bridge_status,
    provider_slugs_with_credentials_set,
)
from bridge.hermes_provider_models import build_provider_models_response
from bridge.dotenv_local import (
    get_dotenv_values_for_keys,
    is_valid_env_key,
    merge_dotenv_file_and_apply,
)

logger = logging.getLogger("my-browser-bridge")

PLUGIN_NAME = "hermes-my-browser-extension"
MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
MAX_JSON_BODY_BYTES = 64 * 1024
_FILENAME_SAFE_RE = re.compile(r"[^A-Za-z0-9._-]+")
_SESSION_ID_SAFE_RE = re.compile(r"[^A-Za-z0-9_-]+")

_HERMES_MAIN_MODEL_PATHS = frozenset({"/hermes/main-model", "/v1/hermes/main-model"})
_HERMES_MODEL_CATALOG_PATHS = frozenset(
    {"/hermes/model-catalog", "/v1/hermes/model-catalog"}
)
_HERMES_PROVIDER_MODELS_PATHS = frozenset(
    {"/hermes/provider-models", "/v1/hermes/provider-models"}
)
_HERMES_PROVIDER_ENV_STATUS_PATHS = frozenset(
    {"/hermes/provider-env-status", "/v1/hermes/provider-env-status"}
)
_HERMES_DOTENV_PATHS = frozenset({"/hermes/dotenv", "/v1/hermes/dotenv"})
_HERMES_AUXILIARY_MODELS_PATHS = frozenset(
    {"/hermes/auxiliary-models", "/v1/hermes/auxiliary-models"}
)
_ATTACH_PATHS = frozenset({"/attach", "/v1/attach"})


def _attachments_root() -> Path:
    try:
        from hermes_constants import get_hermes_home

        root = get_hermes_home() / "plugins" / PLUGIN_NAME / "attachments"
    except Exception:
        root = Path.home() / ".hermes" / "plugins" / PLUGIN_NAME / "attachments"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _attachment_session_dir(session_id: Optional[str]) -> Path:
    safe = _SESSION_ID_SAFE_RE.sub("_", str(session_id or "default")).strip("_")
    if not safe:
        safe = "default"
    p = _attachments_root() / safe
    p.mkdir(parents=True, exist_ok=True)
    return p


def _safe_basename(raw: str) -> str:
    base = os.path.basename(raw or "").strip()
    if not base or base in (".", ".."):
        return "file"
    cleaned = _FILENAME_SAFE_RE.sub("_", base).strip("._-")
    return cleaned or "file"


def _write_attachment(
    session_id: Optional[str], name: str, mime: str, data: bytes
) -> Dict[str, Any]:
    if len(data) > MAX_ATTACHMENT_BYTES:
        raise ValueError(
            f"attachment too large: {len(data)} bytes > {MAX_ATTACHMENT_BYTES}"
        )
    name = _safe_basename(name)
    mime = (mime or "application/octet-stream").strip() or "application/octet-stream"
    session_dir = _attachment_session_dir(session_id)
    uid = secrets.token_hex(4)
    target = session_dir / f"{uid}_{name}"
    target.write_bytes(data)
    return {
        "ok": True,
        "path": str(target),
        "name": name,
        "mime": mime,
        "size": len(data),
    }


def _json_body(obj: Dict[str, Any]) -> bytes:
    return json.dumps(obj, ensure_ascii=False).encode("utf-8")


def _http_response(
    status_line: str,
    body: bytes,
    extra_headers: Optional[list[tuple[str, str]]] = None,
) -> bytes:
    headers = [
        ("Content-Length", str(len(body))),
        ("Content-Type", "application/json; charset=utf-8"),
        ("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
        ("Access-Control-Allow-Headers", "Content-Type"),
    ]
    if extra_headers:
        headers.extend(extra_headers)
    lines = [status_line] + [f"{k}: {v}" for k, v in headers] + ["", ""]
    head = "\r\n".join(lines).encode("ascii")
    return head + body


def _parse_content_length(headers: Dict[str, str]) -> int:
    try:
        return int(headers.get("content-length", "0"))
    except ValueError:
        return 0


async def _read_body(
    reader, content_length: int, max_len: int
) -> Tuple[Optional[bytes], Optional[str]]:
    if content_length <= 0:
        return None, "Content-Length required"
    if content_length > max_len:
        return None, f"body too large (max {max_len} bytes)"
    data = await reader.readexactly(content_length)
    return data, None


async def handle_attachment_http(reader, writer) -> None:
    """HTTP/1.1: OPTIONS, Hermes catalog/provider-models/main-model, POST /attach."""
    try:
        req_line = await reader.readline()
        if not req_line:
            return
        try:
            line_s = req_line.decode("ascii", errors="replace").strip()
        except Exception:
            line_s = ""
        parts = line_s.split()
        if len(parts) < 2:
            writer.write(
                _http_response(
                    "HTTP/1.1 400 Bad Request",
                    _json_body({"ok": False, "error": "bad request"}),
                )
            )
            await writer.drain()
            return
        method, raw_path = parts[0].upper(), parts[1]

        headers: Dict[str, str] = {}
        while True:
            hline = await reader.readline()
            if not hline or hline in (b"\r\n", b"\n"):
                break
            try:
                hs = hline.decode("ascii", errors="replace").strip()
            except Exception:
                continue
            if ":" in hs:
                k, v = hs.split(":", 1)
                headers[k.strip().lower()] = v.strip()

        parsed = urlparse(raw_path)
        path_only = parsed.path or "/"

        if method == "OPTIONS":
            writer.write(
                _http_response(
                    "HTTP/1.1 204 No Content",
                    b"",
                    [("Access-Control-Max-Age", "86400")],
                )
            )
            await writer.drain()
            return

        # --- Hermes model catalog (same data source as TUI model picker) ---
        if path_only in _HERMES_MODEL_CATALOG_PATHS:
            if method != "GET":
                writer.write(
                    _http_response(
                        "HTTP/1.1 405 Method Not Allowed",
                        _json_body({"ok": False, "error": "use GET"}),
                    )
                )
                await writer.drain()
                return
            qs_mc = parse_qs(parsed.query or "")
            refresh_raw = (qs_mc.get("refresh") or ["0"])[0] or "0"
            force_refresh = str(refresh_raw).lower() in ("1", "true", "yes")
            manifest, cat_source = get_model_catalog_manifest(
                force_refresh=force_refresh
            )
            cfg_prov_keys = read_config_provider_keys()
            canonical = try_load_canonical_providers()
            canonical_slugs = (
                [str(p["slug"]) for p in canonical if p.get("slug")]
                if canonical
                else None
            )
            merged_ids = merge_provider_ids(
                manifest, cfg_prov_keys, canonical_slugs
            )
            pevm = collect_provider_env_var_map(merged_ids)
            env_ready = provider_slugs_with_credentials_set(pevm)

            providers_body: Dict[str, Any] = {}
            if manifest and isinstance(manifest.get("providers"), dict):
                providers_body = dict(manifest["providers"])

            def _block_has_models(block: Any) -> bool:
                return (
                    isinstance(block, dict)
                    and isinstance(block.get("models"), list)
                    and len(block["models"]) > 0
                )

            for slug in env_ready:
                cur = providers_body.get(slug)
                if _block_has_models(cur):
                    continue
                try:
                    resp_pm = build_provider_models_response(
                        slug,
                        manifest=manifest,
                        force_refresh=force_refresh,
                    )
                    mlist = resp_pm.get("models")
                    if not isinstance(mlist, list) or not mlist:
                        continue
                    base: Dict[str, Any] = {}
                    if isinstance(cur, dict):
                        if isinstance(cur.get("metadata"), dict):
                            base["metadata"] = cur["metadata"]
                    providers_body[slug] = {**base, "models": mlist}
                except Exception as exc:
                    logger.info("catalog model enrich for %r skipped: %s", slug, exc)

            body_mc: Dict[str, Any] = {
                "ok": True,
                "catalog_source": cat_source,
                "updated_at": manifest.get("updated_at") if manifest else None,
                "metadata": manifest.get("metadata") if manifest else None,
                "providers": providers_body,
                "provider_ids": merged_ids,
                "config_provider_ids": cfg_prov_keys,
                "env_ready_provider_ids": env_ready,
                "canonical_providers": canonical or [],
                "canonical_loaded": bool(canonical),
                "provider_env_vars": pevm,
            }
            if manifest is None:
                body_mc["warning"] = (
                    "Could not load catalog: check network or run `hermes model` "
                    "once so ~/.hermes/cache/model_catalog.json exists."
                )
            writer.write(_http_response("HTTP/1.1 200 OK", _json_body(body_mc)))
            await writer.drain()
            return

        if path_only in _HERMES_PROVIDER_MODELS_PATHS:
            if method != "GET":
                writer.write(
                    _http_response(
                        "HTTP/1.1 405 Method Not Allowed",
                        _json_body({"ok": False, "error": "use GET"}),
                    )
                )
                await writer.drain()
                return
            qs_pm = parse_qs(parsed.query or "")
            refresh_pm = (qs_pm.get("refresh") or ["0"])[0] or "0"
            force_pm = str(refresh_pm).lower() in ("1", "true", "yes")
            prov_q = (qs_pm.get("provider") or [""])[0] or ""
            provider_pm = unquote(str(prov_q)).strip()
            if not provider_pm:
                writer.write(
                    _http_response(
                        "HTTP/1.1 400 Bad Request",
                        _json_body(
                            {"ok": False, "error": "missing provider query parameter"}
                        ),
                    )
                )
                await writer.drain()
                return
            manifest_pm, _src_pm = get_model_catalog_manifest(
                force_refresh=force_pm
            )
            body_pm = build_provider_models_response(
                provider_pm,
                manifest=manifest_pm,
                force_refresh=force_pm,
            )
            writer.write(_http_response("HTTP/1.1 200 OK", _json_body(body_pm)))
            await writer.drain()
            return

        if path_only in _HERMES_PROVIDER_ENV_STATUS_PATHS:
            if method != "GET":
                writer.write(
                    _http_response(
                        "HTTP/1.1 405 Method Not Allowed",
                        _json_body({"ok": False, "error": "use GET"}),
                    )
                )
                await writer.drain()
                return
            qs_es = parse_qs(parsed.query or "")
            prov_es = (qs_es.get("provider") or [""])[0] or ""
            provider_es = unquote(str(prov_es)).strip()
            if not provider_es:
                writer.write(
                    _http_response(
                        "HTTP/1.1 400 Bad Request",
                        _json_body(
                            {"ok": False, "error": "missing provider query parameter"}
                        ),
                    )
                )
                await writer.drain()
                return
            body_es = provider_env_bridge_status(provider_es)
            writer.write(_http_response("HTTP/1.1 200 OK", _json_body(body_es)))
            await writer.drain()
            return

        if path_only in _HERMES_DOTENV_PATHS:
            if method == "GET":
                qs_d = parse_qs(parsed.query or "")
                keys_raw = (qs_d.get("keys") or [""])[0] or ""
                keys_list = [k.strip() for k in keys_raw.split(",") if k.strip()]
                if not keys_list:
                    writer.write(
                        _http_response(
                            "HTTP/1.1 400 Bad Request",
                            _json_body(
                                {"ok": False, "error": "missing keys query (comma-separated)"}
                            ),
                        )
                    )
                    await writer.drain()
                    return
                for k in keys_list:
                    if not is_valid_env_key(k):
                        writer.write(
                            _http_response(
                                "HTTP/1.1 400 Bad Request",
                                _json_body(
                                    {"ok": False, "error": f"invalid env key: {k!r}"}
                                ),
                            )
                        )
                        await writer.drain()
                        return
                vals = get_dotenv_values_for_keys(keys_list)
                writer.write(
                    _http_response(
                        "HTTP/1.1 200 OK",
                        _json_body({"ok": True, "values": vals}),
                    )
                )
                await writer.drain()
                return

            if method == "POST":
                cl = _parse_content_length(headers)
                raw_body, err = await _read_body(reader, cl, MAX_JSON_BODY_BYTES)
                if err or raw_body is None:
                    writer.write(
                        _http_response(
                            "HTTP/1.1 400 Bad Request",
                            _json_body({"ok": False, "error": err or "empty body"}),
                        )
                    )
                    await writer.drain()
                    return
                try:
                    payload = json.loads(raw_body.decode("utf-8"))
                except (ValueError, UnicodeDecodeError) as exc:
                    writer.write(
                        _http_response(
                            "HTTP/1.1 400 Bad Request",
                            _json_body({"ok": False, "error": f"invalid JSON: {exc}"}),
                        )
                    )
                    await writer.drain()
                    return
                if not isinstance(payload, dict):
                    writer.write(
                        _http_response(
                            "HTTP/1.1 400 Bad Request",
                            _json_body({"ok": False, "error": "JSON object required"}),
                        )
                    )
                    await writer.drain()
                    return
                updates_raw = payload.get("updates")
                if not isinstance(updates_raw, dict):
                    writer.write(
                        _http_response(
                            "HTTP/1.1 400 Bad Request",
                            _json_body({"ok": False, "error": "updates object required"}),
                        )
                    )
                    await writer.drain()
                    return
                updates: Dict[str, str] = {}
                for k, v in updates_raw.items():
                    if not isinstance(k, str) or not is_valid_env_key(k):
                        writer.write(
                            _http_response(
                                "HTTP/1.1 400 Bad Request",
                                _json_body(
                                    {"ok": False, "error": f"invalid env key: {k!r}"}
                                ),
                            )
                        )
                        await writer.drain()
                        return
                    if v is not None and not isinstance(v, str):
                        writer.write(
                            _http_response(
                                "HTTP/1.1 400 Bad Request",
                                _json_body(
                                    {"ok": False, "error": f"value for {k} must be string"}
                                ),
                            )
                        )
                        await writer.drain()
                        return
                    updates[k] = str(v) if v is not None else ""
                try:
                    merge_dotenv_file_and_apply(updates)
                except OSError as exc:
                    writer.write(
                        _http_response(
                            "HTTP/1.1 500 Internal Server Error",
                            _json_body({"ok": False, "error": str(exc)}),
                        )
                    )
                    await writer.drain()
                    return
                writer.write(
                    _http_response(
                        "HTTP/1.1 200 OK",
                        _json_body({"ok": True, "updated": list(updates.keys())}),
                    )
                )
                await writer.drain()
                return

            writer.write(
                _http_response(
                    "HTTP/1.1 405 Method Not Allowed",
                    _json_body({"ok": False, "error": "use GET or POST"}),
                )
            )
            await writer.drain()
            return

        # --- Hermes CLI main model (config.yaml) ---
        if path_only in _HERMES_MAIN_MODEL_PATHS:
            if method == "GET":
                try:
                    data = read_main_model()
                    writer.write(
                        _http_response(
                            "HTTP/1.1 200 OK",
                            _json_body({"ok": True, **data}),
                        )
                    )
                except RuntimeError as exc:
                    writer.write(
                        _http_response(
                            "HTTP/1.1 501 Not Implemented",
                            _json_body({"ok": False, "error": str(exc)}),
                        )
                    )
                await writer.drain()
                return

            if method == "POST":
                cl = _parse_content_length(headers)
                raw_body, err = await _read_body(reader, cl, MAX_JSON_BODY_BYTES)
                if err or raw_body is None:
                    writer.write(
                        _http_response(
                            "HTTP/1.1 400 Bad Request",
                            _json_body({"ok": False, "error": err or "empty body"}),
                        )
                    )
                    await writer.drain()
                    return
                try:
                    payload = json.loads(raw_body.decode("utf-8"))
                except (ValueError, UnicodeDecodeError) as exc:
                    writer.write(
                        _http_response(
                            "HTTP/1.1 400 Bad Request",
                            _json_body({"ok": False, "error": f"invalid JSON: {exc}"}),
                        )
                    )
                    await writer.drain()
                    return
                if not isinstance(payload, dict):
                    writer.write(
                        _http_response(
                            "HTTP/1.1 400 Bad Request",
                            _json_body({"ok": False, "error": "JSON object required"}),
                        )
                    )
                    await writer.drain()
                    return
                try:
                    merged = write_main_model(
                        provider=payload.get("provider"),
                        model=payload.get("model"),
                        base_url=payload.get("base_url"),
                    )
                    writer.write(
                        _http_response(
                            "HTTP/1.1 200 OK",
                            _json_body({"ok": True, **merged}),
                        )
                    )
                except ValueError as exc:
                    writer.write(
                        _http_response(
                            "HTTP/1.1 400 Bad Request",
                            _json_body({"ok": False, "error": str(exc)}),
                        )
                    )
                except RuntimeError as exc:
                    writer.write(
                        _http_response(
                            "HTTP/1.1 501 Not Implemented",
                            _json_body({"ok": False, "error": str(exc)}),
                        )
                    )
                await writer.drain()
                return

            writer.write(
                _http_response(
                    "HTTP/1.1 405 Method Not Allowed",
                    _json_body({"ok": False, "error": "use GET or POST"}),
                )
            )
            await writer.drain()
            return

        # --- Hermes CLI auxiliary models (config.yaml auxiliary: block) ---
        if path_only in _HERMES_AUXILIARY_MODELS_PATHS:
            if method == "GET":
                try:
                    data = read_auxiliary_models()
                    writer.write(
                        _http_response(
                            "HTTP/1.1 200 OK",
                            _json_body({"ok": True, **data}),
                        )
                    )
                except RuntimeError as exc:
                    writer.write(
                        _http_response(
                            "HTTP/1.1 501 Not Implemented",
                            _json_body({"ok": False, "error": str(exc)}),
                        )
                    )
                await writer.drain()
                return

            if method == "POST":
                cl = _parse_content_length(headers)
                raw_body, err = await _read_body(reader, cl, MAX_JSON_BODY_BYTES)
                if err or raw_body is None:
                    writer.write(
                        _http_response(
                            "HTTP/1.1 400 Bad Request",
                            _json_body({"ok": False, "error": err or "empty body"}),
                        )
                    )
                    await writer.drain()
                    return
                try:
                    payload = json.loads(raw_body.decode("utf-8"))
                except (ValueError, UnicodeDecodeError) as exc:
                    writer.write(
                        _http_response(
                            "HTTP/1.1 400 Bad Request",
                            _json_body({"ok": False, "error": f"invalid JSON: {exc}"}),
                        )
                    )
                    await writer.drain()
                    return
                if not isinstance(payload, dict):
                    writer.write(
                        _http_response(
                            "HTTP/1.1 400 Bad Request",
                            _json_body({"ok": False, "error": "JSON object required"}),
                        )
                    )
                    await writer.drain()
                    return
                slot = payload.get("slot")
                if not isinstance(slot, str) or slot.strip() not in AUXILIARY_SLOTS:
                    writer.write(
                        _http_response(
                            "HTTP/1.1 400 Bad Request",
                            _json_body({"ok": False, "error": f"slot must be one of: {AUXILIARY_SLOTS}"}),
                        )
                    )
                    await writer.drain()
                    return
                try:
                    merged = write_auxiliary_slot(
                        slot.strip(),
                        provider=payload.get("provider"),
                        model=payload.get("model"),
                        base_url=payload.get("base_url"),
                        api_key=payload.get("api_key"),
                    )
                    writer.write(
                        _http_response(
                            "HTTP/1.1 200 OK",
                            _json_body({"ok": True, **merged}),
                        )
                    )
                except ValueError as exc:
                    writer.write(
                        _http_response(
                            "HTTP/1.1 400 Bad Request",
                            _json_body({"ok": False, "error": str(exc)}),
                        )
                    )
                except RuntimeError as exc:
                    writer.write(
                        _http_response(
                            "HTTP/1.1 501 Not Implemented",
                            _json_body({"ok": False, "error": str(exc)}),
                        )
                    )
                await writer.drain()
                return

            writer.write(
                _http_response(
                    "HTTP/1.1 405 Method Not Allowed",
                    _json_body({"ok": False, "error": "use GET or POST"}),
                )
            )
            await writer.drain()
            return

        # --- Attachment upload ---
        if method == "POST" and path_only in _ATTACH_PATHS:
            qs = parse_qs(parsed.query or "")
            session_id = (qs.get("session_id") or [None])[0]
            name = unquote((qs.get("name") or ["file"])[0] or "file")
            mime = unquote((qs.get("mime") or [""])[0] or "") or headers.get(
                "content-type", "application/octet-stream"
            )

            content_length = _parse_content_length(headers)
            if content_length <= 0:
                writer.write(
                    _http_response(
                        "HTTP/1.1 400 Bad Request",
                        _json_body({"ok": False, "error": "Content-Length required"}),
                    )
                )
                await writer.drain()
                return
            if content_length > MAX_ATTACHMENT_BYTES:
                writer.write(
                    _http_response(
                        "HTTP/1.1 413 Payload Too Large",
                        _json_body({"ok": False, "error": "attachment too large"}),
                    )
                )
                await writer.drain()
                return

            data = await reader.readexactly(content_length)
            try:
                result = _write_attachment(session_id, name, mime, data)
            except ValueError as exc:
                writer.write(
                    _http_response(
                        "HTTP/1.1 400 Bad Request",
                        _json_body({"ok": False, "error": str(exc)}),
                    )
                )
                await writer.drain()
                return

            writer.write(_http_response("HTTP/1.1 200 OK", _json_body(result)))
            await writer.drain()
            return

        writer.write(
            _http_response(
                "HTTP/1.1 404 Not Found",
                _json_body({"ok": False, "error": "not found"}),
            )
        )
        await writer.drain()
    except Exception as exc:
        logger.exception("attachment HTTP handler failed: %s", exc)
        try:
            writer.write(
                _http_response(
                    "HTTP/1.1 500 Internal Server Error",
                    _json_body({"ok": False, "error": str(exc)}),
                )
            )
            await writer.drain()
        except Exception:
            pass
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass
