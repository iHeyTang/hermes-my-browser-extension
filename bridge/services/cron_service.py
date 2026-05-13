"""Thin wrapper around Hermes Agent's ``cron.jobs`` module.

Hermes already owns cron job storage, scheduling, and the per-job lifecycle
(``$HERMES_HOME/cron/jobs.json``, the in-process file lock, schedule parsing,
next-run computation). The bridge's only job here is to expose the same CRUD
surface over HTTP so the options page can manage jobs without duplicating
any of that logic.

Mirrors what the upstream FastAPI server exposes at ``/api/cron/jobs`` —
see ``hermes_cli/web_server.py:2563`` and onwards — but uses the underlying
``cron.jobs`` Python functions directly, the same way ``skills_service`` and
``memory_service`` reach past the upstream HTTP layer.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger("my-browser-bridge")


# ---------------------------------------------------------------------------
# Upstream-backed helpers — defensive imports so the bridge can still return
# a structured "cron unavailable" error when running outside a Hermes install.
# ---------------------------------------------------------------------------


def _cron_unavailable_error(exc: Exception) -> str:
    return (
        "Hermes cron module not importable (is the bridge running inside "
        f"Hermes Agent's venv?): {exc}"
    )


def list_jobs_response() -> Dict[str, Any]:
    """Return all cron jobs, including paused/disabled ones."""
    try:
        from cron.jobs import list_jobs  # type: ignore
    except Exception as exc:
        logger.warning("cron.jobs.list_jobs unavailable: %s", exc)
        return {"ok": False, "error": _cron_unavailable_error(exc), "jobs": []}
    try:
        jobs = list_jobs(include_disabled=True)
    except Exception as exc:
        logger.exception("list_jobs failed")
        return {"ok": False, "error": f"list_jobs failed: {exc}", "jobs": []}
    return {"ok": True, "jobs": jobs}


def get_job_response(job_id: str) -> Dict[str, Any]:
    try:
        from cron.jobs import get_job  # type: ignore
    except Exception as exc:
        return {"ok": False, "error": _cron_unavailable_error(exc)}
    try:
        job = get_job(job_id)
    except Exception as exc:
        logger.exception("get_job %s failed", job_id)
        return {"ok": False, "error": f"get_job failed: {exc}"}
    if not job:
        return {"ok": False, "error": "job not found"}
    return {"ok": True, "job": job}


def create_job_response(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Create a new cron job.

    Accepts a subset of ``cron.jobs.create_job`` kwargs that make sense from
    the options page: ``prompt`` / ``schedule`` / ``name`` / ``deliver`` /
    ``repeat`` / ``skills`` / ``model`` / ``provider`` / ``base_url`` /
    ``script`` / ``no_agent`` / ``context_from`` / ``enabled_toolsets`` /
    ``workdir``. Extra keys are ignored so the frontend can stay forward-
    compatible without breaking when upstream adds new ones.
    """
    try:
        from cron.jobs import create_job  # type: ignore
    except Exception as exc:
        return {"ok": False, "error": _cron_unavailable_error(exc)}

    schedule = payload.get("schedule")
    if not isinstance(schedule, str) or not schedule.strip():
        return {"ok": False, "error": "schedule is required"}

    prompt = payload.get("prompt")
    if prompt is not None and not isinstance(prompt, str):
        return {"ok": False, "error": "prompt must be a string"}

    no_agent = bool(payload.get("no_agent", False))
    script = payload.get("script")
    if script is not None and not isinstance(script, str):
        return {"ok": False, "error": "script must be a string"}

    if not no_agent and not (isinstance(prompt, str) and prompt.strip()):
        return {"ok": False, "error": "prompt is required unless no_agent=true"}

    kwargs: Dict[str, Any] = {
        "prompt": prompt,
        "schedule": schedule.strip(),
        "no_agent": no_agent,
    }

    for key in (
        "name",
        "deliver",
        "model",
        "provider",
        "base_url",
        "script",
        "workdir",
    ):
        if key in payload and payload[key] is not None:
            kwargs[key] = payload[key]

    repeat = payload.get("repeat")
    if isinstance(repeat, int):
        kwargs["repeat"] = repeat
    elif isinstance(repeat, dict) and isinstance(repeat.get("times"), int):
        kwargs["repeat"] = repeat["times"]

    if isinstance(payload.get("skills"), list):
        kwargs["skills"] = [str(s) for s in payload["skills"] if str(s).strip()]
    elif isinstance(payload.get("skill"), str) and payload["skill"].strip():
        kwargs["skill"] = payload["skill"].strip()

    if isinstance(payload.get("enabled_toolsets"), list):
        kwargs["enabled_toolsets"] = [
            str(t) for t in payload["enabled_toolsets"] if str(t).strip()
        ]

    if isinstance(payload.get("context_from"), (list, str)):
        kwargs["context_from"] = payload["context_from"]

    try:
        job = create_job(**kwargs)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:
        logger.exception("create_job failed")
        return {"ok": False, "error": f"create_job failed: {exc}"}
    return {"ok": True, "job": job}


# Fields the frontend is allowed to pass through to ``cron.jobs.update_job``.
# Locked down so a stray field name can't silently mutate scheduler-internal
# state (``state``, ``last_run_at``, ``next_run_at``, ...).
_UPDATABLE_FIELDS = frozenset(
    (
        "name",
        "prompt",
        "schedule",
        "deliver",
        "skills",
        "skill",
        "model",
        "provider",
        "base_url",
        "script",
        "no_agent",
        "context_from",
        "enabled_toolsets",
        "workdir",
        "repeat",
    )
)


def update_job_response(job_id: str, updates: Dict[str, Any]) -> Dict[str, Any]:
    try:
        from cron.jobs import update_job  # type: ignore
    except Exception as exc:
        return {"ok": False, "error": _cron_unavailable_error(exc)}

    filtered: Dict[str, Any] = {
        k: v for k, v in updates.items() if k in _UPDATABLE_FIELDS
    }
    if not filtered:
        return {"ok": False, "error": "no updatable fields supplied"}

    try:
        job = update_job(job_id, filtered)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:
        logger.exception("update_job %s failed", job_id)
        return {"ok": False, "error": f"update_job failed: {exc}"}
    if not job:
        return {"ok": False, "error": "job not found"}
    return {"ok": True, "job": job}


def _lifecycle_op(job_id: str, op_name: str) -> Dict[str, Any]:
    try:
        if op_name == "pause":
            from cron.jobs import pause_job as _op  # type: ignore
        elif op_name == "resume":
            from cron.jobs import resume_job as _op  # type: ignore
        elif op_name == "trigger":
            from cron.jobs import trigger_job as _op  # type: ignore
        else:
            return {"ok": False, "error": f"unknown op: {op_name}"}
    except Exception as exc:
        return {"ok": False, "error": _cron_unavailable_error(exc)}
    try:
        job = _op(job_id)
    except Exception as exc:
        logger.exception("%s %s failed", op_name, job_id)
        return {"ok": False, "error": f"{op_name} failed: {exc}"}
    if not job:
        return {"ok": False, "error": "job not found"}
    return {"ok": True, "job": job}


def pause_job_response(job_id: str) -> Dict[str, Any]:
    return _lifecycle_op(job_id, "pause")


def resume_job_response(job_id: str) -> Dict[str, Any]:
    return _lifecycle_op(job_id, "resume")


def trigger_job_response(job_id: str) -> Dict[str, Any]:
    return _lifecycle_op(job_id, "trigger")


def delete_job_response(job_id: str) -> Dict[str, Any]:
    try:
        from cron.jobs import remove_job  # type: ignore
    except Exception as exc:
        return {"ok": False, "error": _cron_unavailable_error(exc)}
    try:
        removed = remove_job(job_id)
    except Exception as exc:
        logger.exception("remove_job %s failed", job_id)
        return {"ok": False, "error": f"remove_job failed: {exc}"}
    if not removed:
        return {"ok": False, "error": "job not found"}
    return {"ok": True}


def parse_schedule_preview(schedule: str) -> Dict[str, Any]:
    """Preview how Hermes will parse a schedule string.

    Lets the options page give immediate feedback on invalid schedules
    without round-tripping a job create. Mirrors ``cron.jobs.parse_schedule``
    plus ``compute_next_run`` so the UI can also display the next run.
    """
    if not isinstance(schedule, str) or not schedule.strip():
        return {"ok": False, "error": "schedule is required"}
    try:
        from cron.jobs import compute_next_run, parse_schedule  # type: ignore
    except Exception as exc:
        return {"ok": False, "error": _cron_unavailable_error(exc)}
    try:
        parsed = parse_schedule(schedule.strip())
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:
        logger.exception("parse_schedule failed")
        return {"ok": False, "error": f"parse_schedule failed: {exc}"}
    try:
        next_run = compute_next_run(parsed)
    except Exception as exc:
        logger.warning("compute_next_run failed: %s", exc)
        next_run = None
    return {
        "ok": True,
        "schedule": parsed,
        "display": parsed.get("display"),
        "next_run_at": next_run,
    }
