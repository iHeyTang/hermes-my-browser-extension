from __future__ import annotations

from typing import Any, Dict

from ..adapters.hermes_agent_model import (
    AUXILIARY_SLOTS,
    read_auxiliary_models,
    read_main_model,
    write_auxiliary_slot,
    write_main_model,
)


def read_main_model_response() -> Dict[str, Any]:
    return {"ok": True, **read_main_model()}


def write_main_model_response(payload: Dict[str, Any]) -> Dict[str, Any]:
    merged = write_main_model(
        provider=payload.get("provider"),
        model=payload.get("model"),
        base_url=payload.get("base_url"),
    )
    return {"ok": True, **merged}


def read_auxiliary_models_response() -> Dict[str, Any]:
    return {"ok": True, **read_auxiliary_models()}


def write_auxiliary_models_response(payload: Dict[str, Any]) -> Dict[str, Any]:
    slot = payload.get("slot")
    if not isinstance(slot, str) or slot.strip() not in AUXILIARY_SLOTS:
        raise ValueError(f"slot must be one of: {AUXILIARY_SLOTS}")
    merged = write_auxiliary_slot(
        slot.strip(),
        provider=payload.get("provider"),
        model=payload.get("model"),
        base_url=payload.get("base_url"),
        api_key=payload.get("api_key"),
    )
    return {"ok": True, **merged}

