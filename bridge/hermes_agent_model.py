"""
Read/write Hermes CLI main model block in ~/.hermes/config.yaml.

Mirrors what `hermes model` / `hermes config set` persist: the `model:` mapping
(provider, default model id, optional base_url).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional


def read_config_provider_keys() -> List[str]:
    """Return sorted `providers:` keys from ~/.hermes/config.yaml (custom hosts)."""
    path = _config_yaml_path()
    if not path.exists():
        return []
    try:
        import yaml  # type: ignore
    except ImportError:
        return []
    try:
        cfg = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception:
        return []
    if not isinstance(cfg, dict):
        return []
    p = cfg.get("providers")
    if not isinstance(p, dict):
        return []
    return sorted(
        str(k) for k in p.keys() if isinstance(k, str) and str(k).strip()
    )


def _config_yaml_path() -> Path:
    try:
        from hermes_constants import get_hermes_home

        return get_hermes_home() / "config.yaml"
    except Exception:
        return Path.home() / ".hermes" / "config.yaml"


def _load_yaml_module():
    try:
        import yaml  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "PyYAML is required to edit Hermes config from the bridge. "
            "Install: pip install pyyaml"
        ) from e
    return yaml


def read_main_model() -> Dict[str, Any]:
    """Return provider, model (default id), base_url from config.yaml."""
    path = _config_yaml_path()
    if not path.exists():
        return {
            "config_path": str(path),
            "config_exists": False,
            "provider": "auto",
            "model": "",
            "base_url": None,
        }
    yaml = _load_yaml_module()
    try:
        raw = path.read_text(encoding="utf-8")
        cfg = yaml.safe_load(raw) or {}
    except Exception as e:
        return {
            "config_path": str(path),
            "config_exists": True,
            "error": str(e),
            "provider": "auto",
            "model": "",
            "base_url": None,
        }
    if not isinstance(cfg, dict):
        cfg = {}
    block = cfg.get("model")
    if not isinstance(block, dict):
        block = {}
    name = block.get("default")
    if name is None:
        name = block.get("model")
    if name is not None and not isinstance(name, str):
        name = str(name)
    prov = block.get("provider")
    if prov is None or prov == "":
        prov = "auto"
    elif not isinstance(prov, str):
        prov = str(prov)
    bu = block.get("base_url")
    if bu is not None and not isinstance(bu, str):
        bu = str(bu)
    if isinstance(bu, str) and not bu.strip():
        bu = None
    return {
        "config_path": str(path),
        "config_exists": True,
        "provider": prov,
        "model": name or "",
        "base_url": bu,
    }


def write_main_model(
    *,
    provider: Optional[str] = None,
    model: Optional[str] = None,
    base_url: Optional[str] = None,
) -> Dict[str, Any]:
    """Merge into cfg['model'] and save. Omitted keys are left unchanged."""
    path = _config_yaml_path()
    yaml = _load_yaml_module()
    cfg: Dict[str, Any] = {}
    if path.exists():
        try:
            cfg = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        except Exception as e:
            raise ValueError(f"cannot parse existing config.yaml: {e}") from e
    if not isinstance(cfg, dict):
        cfg = {}
    mblock = cfg.get("model")
    if not isinstance(mblock, dict):
        mblock = {}
    mblock = dict(mblock)

    if provider is not None:
        p = str(provider).strip()
        mblock["provider"] = p if p else "auto"
    if model is not None:
        mid = str(model).strip()
        if mid:
            mblock["default"] = mid
            if "model" in mblock:
                del mblock["model"]
        else:
            mblock.pop("default", None)
            mblock.pop("model", None)
    if base_url is not None:
        bu = str(base_url).strip()
        if bu:
            mblock["base_url"] = bu
        else:
            mblock.pop("base_url", None)

    cfg["model"] = mblock
    path.parent.mkdir(parents=True, exist_ok=True)
    text = yaml.dump(
        cfg,
        default_flow_style=False,
        allow_unicode=True,
        sort_keys=False,
    )
    path.write_text(text, encoding="utf-8")
    return read_main_model()


AUXILIARY_SLOTS: List[str] = [
    "vision",
    "web_extract",
    "compression",
    "session_search",
    "skills_hub",
    "approval",
    "mcp",
    "title_generation",
]

_AUX_SLOT_FIELDS = ("provider", "model", "base_url", "api_key")


def _read_aux_slot(block: Dict[str, Any]) -> Dict[str, str]:
    """Extract the four fields from one auxiliary slot dict."""
    out: Dict[str, str] = {}
    for f in _AUX_SLOT_FIELDS:
        v = block.get(f)
        out[f] = str(v).strip() if v is not None and str(v).strip() else ""
    return out


def read_auxiliary_models() -> Dict[str, Any]:
    """Return all auxiliary model slots from config.yaml ``auxiliary:`` block."""
    path = _config_yaml_path()
    empty_slots = {s: {f: "" for f in _AUX_SLOT_FIELDS} for s in AUXILIARY_SLOTS}
    base: Dict[str, Any] = {
        "config_path": str(path),
        "config_exists": path.exists(),
        "slots": empty_slots,
    }
    if not path.exists():
        return base
    yaml = _load_yaml_module()
    try:
        cfg = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception as e:
        return {**base, "config_exists": True, "error": str(e)}
    if not isinstance(cfg, dict):
        cfg = {}
    aux_block = cfg.get("auxiliary")
    if not isinstance(aux_block, dict):
        aux_block = {}
    slots: Dict[str, Dict[str, str]] = {}
    for slot in AUXILIARY_SLOTS:
        sb = aux_block.get(slot)
        slots[slot] = _read_aux_slot(sb) if isinstance(sb, dict) else {f: "" for f in _AUX_SLOT_FIELDS}
    return {
        "config_path": str(path),
        "config_exists": True,
        "slots": slots,
    }


def write_auxiliary_slot(
    slot: str,
    *,
    provider: Optional[str] = None,
    model: Optional[str] = None,
    base_url: Optional[str] = None,
    api_key: Optional[str] = None,
) -> Dict[str, Any]:
    """Patch one named slot under ``auxiliary:`` and save config.yaml."""
    slot = slot.strip()
    if slot not in AUXILIARY_SLOTS:
        raise ValueError(f"unknown auxiliary slot: {slot!r}. Valid: {AUXILIARY_SLOTS}")
    path = _config_yaml_path()
    yaml = _load_yaml_module()
    cfg: Dict[str, Any] = {}
    if path.exists():
        try:
            cfg = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        except Exception as e:
            raise ValueError(f"cannot parse existing config.yaml: {e}") from e
    if not isinstance(cfg, dict):
        cfg = {}

    aux_block = cfg.get("auxiliary")
    if not isinstance(aux_block, dict):
        aux_block = {}
    aux_block = dict(aux_block)

    slot_block = aux_block.get(slot)
    if not isinstance(slot_block, dict):
        slot_block = {}
    slot_block = dict(slot_block)

    def _set_str(d: dict, key: str, val: Optional[str]) -> None:
        if val is not None:
            d[key] = str(val).strip()

    _set_str(slot_block, "provider", provider)
    _set_str(slot_block, "model", model)
    _set_str(slot_block, "base_url", base_url)
    _set_str(slot_block, "api_key", api_key)

    aux_block[slot] = slot_block
    cfg["auxiliary"] = aux_block
    path.parent.mkdir(parents=True, exist_ok=True)
    text = yaml.dump(cfg, default_flow_style=False, allow_unicode=True, sort_keys=False)
    path.write_text(text, encoding="utf-8")
    return read_auxiliary_models()
