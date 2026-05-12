"""Read-only enumeration of skills available to the current Hermes Agent.

Mirrors the discovery rules in ``agent.skill_utils`` and ``tools.skills_tool``
without importing those modules:

  * Scan ``$HERMES_HOME/skills`` and any directories listed under
    ``skills.external_dirs`` in ``config.yaml``.
  * Walk recursively; exclude ``.git``, ``.github``, ``.hub`` and ``.archive``.
  * Each ``SKILL.md`` carries a YAML frontmatter with ``name``, ``description``
    and an optional ``platforms`` list (``macos`` → ``darwin`` etc.).
  * Skills whose name is in ``skills.disabled`` (or
    ``skills.platform_disabled.<HERMES_PLATFORM>``) are marked disabled.
  * Skills whose ``platforms`` field excludes the current OS are marked
    incompatible.

The current agent's active skill set = compatible AND not disabled.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

import yaml

from ..adapters.hermes_core import hermes_home

logger = logging.getLogger("my-browser-bridge")

EXCLUDED_SKILL_DIRS = frozenset((".git", ".github", ".hub", ".archive"))

# Mirrors agent.skill_utils.PLATFORM_MAP.
PLATFORM_MAP = {
    "macos": "darwin",
    "linux": "linux",
    "windows": "win32",
}

MAX_FRONTMATTER_BYTES = 4096
MAX_DESCRIPTION_CHARS = 240


def _read_config() -> Dict[str, Any]:
    path = hermes_home() / "config.yaml"
    if not path.exists():
        return {}
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        logger.warning("failed to parse %s: %s", path, exc)
        return {}
    return data if isinstance(data, dict) else {}


def _resolve_platform_label() -> str:
    """Return the active platform label (matches HERMES_PLATFORM precedence)."""
    explicit = os.getenv("HERMES_PLATFORM") or os.getenv("HERMES_SESSION_PLATFORM")
    if explicit:
        return explicit.strip()
    return ""


def _skill_matches_current_os(frontmatter: Dict[str, Any]) -> bool:
    platforms = frontmatter.get("platforms")
    if not platforms:
        return True
    if not isinstance(platforms, list):
        platforms = [platforms]
    current = sys.platform
    for p in platforms:
        normalized = str(p).lower().strip()
        mapped = PLATFORM_MAP.get(normalized, normalized)
        if current.startswith(mapped):
            return True
    return False


def _disabled_set(config: Dict[str, Any], platform: str) -> Set[str]:
    skills_cfg = config.get("skills")
    if not isinstance(skills_cfg, dict):
        return set()
    if platform:
        platform_disabled = (skills_cfg.get("platform_disabled") or {}).get(platform)
        if platform_disabled is not None:
            return _normalize_str_set(platform_disabled)
    return _normalize_str_set(skills_cfg.get("disabled"))


def _normalize_str_set(values: Any) -> Set[str]:
    if values is None:
        return set()
    if isinstance(values, str):
        values = [values]
    if not isinstance(values, list):
        return set()
    out: Set[str] = set()
    for v in values:
        s = str(v).strip()
        if s:
            out.add(s)
    return out


def _load_bundled_names() -> Set[str]:
    """Names seeded from the Hermes-bundled skills manifest.

    Format mirrors ``hermes-agent/tools/skill_usage.py::_read_bundled_manifest_names``:
    one ``name:hash`` per line.
    """
    path = hermes_home() / "skills" / ".bundled_manifest"
    if not path.exists():
        return set()
    out: Set[str] = set()
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            name = line.split(":", 1)[0].strip()
            if name:
                out.add(name)
    except OSError as exc:
        logger.debug("failed to read %s: %s", path, exc)
    return out


def _load_usage_records() -> Dict[str, Dict[str, Any]]:
    """Whole ``.usage.json`` mapping name → record (created_at, last_patched_at, …)."""
    path = hermes_home() / "skills" / ".usage.json"
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.debug("failed to parse %s: %s", path, exc)
        return {}
    if not isinstance(data, dict):
        return {}
    return {
        str(name): rec for name, rec in data.items() if isinstance(rec, dict)
    }


def _load_hub_records() -> Dict[str, Dict[str, Any]]:
    """``.hub/lock.json`` installed map, name → record (installed_at, updated_at, …)."""
    path = hermes_home() / "skills" / ".hub" / "lock.json"
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.debug("failed to parse %s: %s", path, exc)
        return {}
    if not isinstance(data, dict):
        return {}
    installed = data.get("installed")
    if not isinstance(installed, dict):
        return {}
    return {
        str(name): rec
        for name, rec in installed.items()
        if isinstance(rec, dict)
    }


def _fs_birth_iso(path: Path) -> Optional[str]:
    try:
        st = path.stat()
    except OSError:
        return None
    ts = getattr(st, "st_birthtime", None)
    if ts is None:
        ts = st.st_ctime
    try:
        return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
    except (OSError, ValueError, OverflowError):
        return None


def _fs_mtime_iso(path: Path) -> Optional[str]:
    try:
        st = path.stat()
    except OSError:
        return None
    try:
        return datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat()
    except (OSError, ValueError, OverflowError):
        return None


def _resolve_timestamps(
    name: str,
    skill_md: Path,
    usage: Dict[str, Dict[str, Any]],
    hub: Dict[str, Dict[str, Any]],
) -> Tuple[Optional[str], Optional[str], str]:
    """Resolve (created_at, updated_at, source) using a multi-tier lookup.

    Order: ``.usage.json`` (most authoritative — set by Hermes Agent itself) →
    ``.hub/lock.json`` (covers Hub-installed skills) → file-system stat
    (covers bundled / manual where nothing else recorded a timestamp).
    """
    u = usage.get(name) or {}
    h = hub.get(name) or {}

    created = (
        _as_iso(u.get("created_at"))
        or _as_iso(h.get("installed_at"))
        or _fs_birth_iso(skill_md)
    )
    updated = (
        _as_iso(u.get("last_patched_at"))
        or _as_iso(h.get("updated_at"))
        or _fs_mtime_iso(skill_md)
    )

    if u.get("created_at") or u.get("last_patched_at"):
        source = "usage"
    elif h.get("installed_at") or h.get("updated_at"):
        source = "hub"
    else:
        source = "fs"
    return created, updated, source


def _as_iso(value: Any) -> Optional[str]:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _external_skills_dirs(config: Dict[str, Any]) -> List[Path]:
    skills_cfg = config.get("skills") if isinstance(config, dict) else None
    if not isinstance(skills_cfg, dict):
        return []
    raw = skills_cfg.get("external_dirs")
    if not raw:
        return []
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        return []
    home = hermes_home()
    local = (home / "skills").resolve()
    seen: Set[Path] = set()
    out: List[Path] = []
    for entry in raw:
        s = str(entry).strip()
        if not s:
            continue
        expanded = os.path.expanduser(os.path.expandvars(s))
        p = Path(expanded)
        if not p.is_absolute():
            p = (home / p).resolve()
        else:
            p = p.resolve()
        if p == local or p in seen:
            continue
        if p.is_dir():
            seen.add(p)
            out.append(p)
    return out


def _iter_skill_md(root: Path):
    if not root.exists():
        return
    for current, dirs, files in os.walk(root, followlinks=True):
        dirs[:] = [d for d in dirs if d not in EXCLUDED_SKILL_DIRS]
        if "SKILL.md" in files:
            yield Path(current) / "SKILL.md"


def _parse_frontmatter(text: str) -> Tuple[Dict[str, Any], str]:
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    fm_raw = text[3:end].lstrip("\n")
    body = text[end + 4 :].lstrip("\n")
    try:
        parsed = yaml.safe_load(fm_raw) or {}
    except Exception:  # noqa: BLE001
        parsed = {}
    if not isinstance(parsed, dict):
        parsed = {}
    return parsed, body


def _extract_description(frontmatter: Dict[str, Any], body: str) -> str:
    desc = frontmatter.get("description")
    if isinstance(desc, str) and desc.strip():
        result = desc.strip()
    else:
        result = ""
        for line in body.strip().splitlines():
            ln = line.strip()
            if ln and not ln.startswith("#"):
                result = ln
                break
    if len(result) > MAX_DESCRIPTION_CHARS:
        result = result[: MAX_DESCRIPTION_CHARS - 3] + "..."
    return result


def _extract_tags(frontmatter: Dict[str, Any]) -> List[str]:
    meta = frontmatter.get("metadata")
    if not isinstance(meta, dict):
        return []
    hermes_meta = meta.get("hermes")
    if not isinstance(hermes_meta, dict):
        return []
    raw = hermes_meta.get("tags")
    if not raw:
        return []
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        return []
    return [str(t).strip() for t in raw if str(t).strip()][:32]


def _category_from_path(skill_md: Path, root: Path) -> Optional[str]:
    try:
        rel = skill_md.relative_to(root)
    except ValueError:
        return None
    parts = rel.parts
    # rel = <category?>/.../<skill_dir>/SKILL.md ; category = first part when nested.
    if len(parts) <= 2:
        return None
    return parts[0]


def _classify_origin(
    name: str,
    source: str,
    bundled: Set[str],
    hub: Set[str],
    agent_created: Set[str],
) -> str:
    """Map a skill to its provenance label.

    ``agent`` and ``hub`` win over ``bundled`` since the same name could be
    re-installed via hub or rewritten by the curator — that newer signal is
    what the user cares about. ``external``/``plugin`` skills live outside
    ``$HERMES_HOME/skills`` and bypass the three local manifests entirely.
    """
    if source != "local":
        return source
    if name in agent_created:
        return "agent"
    if name in hub:
        return "hub"
    if name in bundled:
        return "bundled"
    return "manual"


def list_skills() -> Dict[str, Any]:
    """Enumerate all skills visible to Hermes Agent."""
    config = _read_config()
    platform_label = _resolve_platform_label()
    disabled = _disabled_set(config, platform_label)

    bundled_names = _load_bundled_names()
    hub_records = _load_hub_records()
    usage_records = _load_usage_records()

    hub_names = set(hub_records.keys())
    agent_names = {
        name
        for name, rec in usage_records.items()
        if rec.get("created_by") == "agent" or rec.get("agent_created") is True
    }

    local_root = hermes_home() / "skills"
    scan_roots: List[Tuple[Path, str]] = [(local_root, "local")]
    for ext_dir in _external_skills_dirs(config):
        scan_roots.append((ext_dir, "external"))

    skills: List[Dict[str, Any]] = []
    seen_names: Set[str] = set()

    for root, source in scan_roots:
        for skill_md in _iter_skill_md(root):
            try:
                head = skill_md.read_text(encoding="utf-8")[:MAX_FRONTMATTER_BYTES]
            except (OSError, UnicodeDecodeError) as exc:
                logger.debug("skip %s: %s", skill_md, exc)
                continue

            fm, body = _parse_frontmatter(head)
            name = str(fm.get("name") or skill_md.parent.name).strip()
            if not name or name in seen_names:
                continue
            seen_names.add(name)

            description = _extract_description(fm, body)
            tags = _extract_tags(fm)
            category = _category_from_path(skill_md, root)
            compatible = _skill_matches_current_os(fm)
            is_disabled = name in disabled
            active = compatible and not is_disabled

            origin = _classify_origin(
                name, source, bundled_names, hub_names, agent_names
            )
            created_at, updated_at, ts_source = _resolve_timestamps(
                name, skill_md, usage_records, hub_records
            )

            skills.append(
                {
                    "name": name,
                    "description": description,
                    "category": category,
                    "tags": tags,
                    "path": str(skill_md),
                    "source": source,
                    "origin": origin,
                    "platforms": fm.get("platforms") if isinstance(fm.get("platforms"), list) else None,
                    "compatible": compatible,
                    "disabled": is_disabled,
                    "active": active,
                    "version": str(fm.get("version") or "").strip() or None,
                    "created_at": created_at,
                    "updated_at": updated_at,
                    "timestamp_source": ts_source,
                }
            )

    skills.sort(key=lambda s: ((s.get("category") or "~"), s["name"].lower()))

    total = len(skills)
    active_count = sum(1 for s in skills if s["active"])
    disabled_count = sum(1 for s in skills if s["disabled"])
    incompatible_count = sum(1 for s in skills if not s["compatible"])

    origin_counts: Dict[str, int] = {}
    for s in skills:
        origin_counts[s["origin"]] = origin_counts.get(s["origin"], 0) + 1

    return {
        "skills": skills,
        "platform": platform_label,
        "sys_platform": sys.platform,
        "skills_dirs": [str(p) for p, _ in scan_roots],
        "totals": {
            "total": total,
            "active": active_count,
            "disabled": disabled_count,
            "incompatible": incompatible_count,
        },
        "origin_counts": origin_counts,
    }


def list_skills_response() -> Dict[str, Any]:
    return {"ok": True, **list_skills()}


# ---------------------------------------------------------------------------
# Skill directory browsing — used by the options page "view files" affordance.
# Read-only: we never mutate the skill tree from the bridge.
# ---------------------------------------------------------------------------

# Cap file enumeration so a stray symlink loop or an enormous external dir
# can't wedge the bridge. 10k is far above any sane skill.
MAX_SKILL_FILES = 10_000

# Cap on a single file read. Anything past this is reported as too-large
# instead of streamed; the options page is a viewer, not an IDE.
MAX_SKILL_FILE_BYTES = 1 * 1024 * 1024  # 1 MiB


def _resolve_skill_dir(name: str) -> Optional[Tuple[Path, Dict[str, Any]]]:
    """Find the on-disk directory for a skill by name.

    Returns ``(skill_dir, entry)`` where ``skill_dir`` is the parent of the
    skill's ``SKILL.md`` and ``entry`` is the metadata row from ``list_skills``.
    Returns ``None`` if no skill with that name is visible.
    """
    if not isinstance(name, str) or not name.strip():
        return None
    target = name.strip()
    for entry in list_skills()["skills"]:
        if entry.get("name") == target:
            skill_md = Path(str(entry.get("path") or ""))
            if not skill_md.is_file():
                return None
            return skill_md.parent, entry
    return None


def list_skill_files(name: str) -> Dict[str, Any]:
    """Walk a skill's directory and return one flat record per file.

    Output shape::

        {
            "ok": True,
            "name": "<skill name>",
            "root": "<absolute path of the skill dir>",
            "files": [
                {"path": "SKILL.md", "size": 1234, "modified_at": "..."},
                {"path": "references/foo.md", "size": 567, "modified_at": "..."},
                ...
            ],
            "truncated": False,
        }

    Directory entries are NOT returned — the UI groups by splitting `path`
    on ``/``. Excludes the same scaffolding dirs as the skill scanner
    (``.git``, ``.hub``, ...).
    """
    resolved = _resolve_skill_dir(name)
    if resolved is None:
        return {"ok": False, "error": f"skill {name!r} not found"}
    skill_dir, _entry = resolved
    if not skill_dir.is_dir():
        return {"ok": False, "error": f"skill directory missing: {skill_dir}"}

    files: List[Dict[str, Any]] = []
    truncated = False
    for current, dirs, names in os.walk(skill_dir, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in EXCLUDED_SKILL_DIRS)
        names.sort()
        for fname in names:
            if len(files) >= MAX_SKILL_FILES:
                truncated = True
                break
            full = Path(current) / fname
            try:
                st = full.stat()
            except OSError:
                continue
            try:
                rel = full.relative_to(skill_dir).as_posix()
            except ValueError:
                continue
            mod_iso: Optional[str]
            try:
                mod_iso = datetime.fromtimestamp(
                    st.st_mtime, tz=timezone.utc
                ).isoformat()
            except (OSError, ValueError, OverflowError):
                mod_iso = None
            files.append(
                {
                    "path": rel,
                    "size": int(st.st_size),
                    "modified_at": mod_iso,
                }
            )
        if truncated:
            break

    # Files come back in walk order (dir-by-dir, alphabetical within each).
    # Sort once more on the relative path so callers see a stable global
    # ordering regardless of fs walk quirks.
    files.sort(key=lambda f: f["path"])
    return {
        "ok": True,
        "name": _entry.get("name"),
        "root": str(skill_dir),
        "files": files,
        "truncated": truncated,
    }


def _is_probably_binary(sample: bytes) -> bool:
    """Quick heuristic: presence of a NUL byte in the first chunk."""
    return b"\x00" in sample


def read_skill_file(name: str, rel_path: str) -> Dict[str, Any]:
    """Read one file under a skill's directory.

    Path-traversal safe: the resolved file MUST live under the skill root,
    or we refuse. Binary files are returned with ``encoding: "binary"`` and
    no body (the UI shows a "binary, X bytes" placeholder). Files larger
    than ``MAX_SKILL_FILE_BYTES`` get ``encoding: "too-large"`` for the
    same reason.
    """
    resolved = _resolve_skill_dir(name)
    if resolved is None:
        return {"ok": False, "error": f"skill {name!r} not found"}
    skill_dir, _entry = resolved
    if not isinstance(rel_path, str) or not rel_path.strip():
        return {"ok": False, "error": "path is required"}

    candidate = (skill_dir / rel_path).resolve()
    try:
        candidate.relative_to(skill_dir.resolve())
    except ValueError:
        return {"ok": False, "error": "path escapes skill directory"}
    if any(part in EXCLUDED_SKILL_DIRS for part in candidate.relative_to(skill_dir).parts):
        return {"ok": False, "error": "path is inside an excluded directory"}
    if not candidate.is_file():
        return {"ok": False, "error": f"not a regular file: {rel_path}"}

    try:
        st = candidate.stat()
    except OSError as exc:
        return {"ok": False, "error": f"stat failed: {exc}"}

    size = int(st.st_size)
    if size > MAX_SKILL_FILE_BYTES:
        return {
            "ok": True,
            "name": _entry.get("name"),
            "path": rel_path,
            "size": size,
            "encoding": "too-large",
            "limit": MAX_SKILL_FILE_BYTES,
            "content": None,
        }

    try:
        raw = candidate.read_bytes()
    except OSError as exc:
        return {"ok": False, "error": f"read failed: {exc}"}

    if _is_probably_binary(raw[:8192]):
        return {
            "ok": True,
            "name": _entry.get("name"),
            "path": rel_path,
            "size": size,
            "encoding": "binary",
            "content": None,
        }

    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        # Sniff one more encoding before giving up — Hermes skills are
        # almost always utf-8 but the occasional Windows-authored README
        # ships as latin-1; surfacing those readably is cheap.
        try:
            text = raw.decode("latin-1")
        except UnicodeDecodeError:
            return {
                "ok": True,
                "name": _entry.get("name"),
                "path": rel_path,
                "size": size,
                "encoding": "binary",
                "content": None,
            }

    return {
        "ok": True,
        "name": _entry.get("name"),
        "path": rel_path,
        "size": size,
        "encoding": "utf-8",
        "content": text,
    }
