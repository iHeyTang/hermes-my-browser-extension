#!/usr/bin/env bash
# Install this plugin into Hermes's venv (editable) so pyproject.toml deps
# (e.g. websockets) and the hermes_agent.plugins entry point are registered.
#
# Usage:
#   bash scripts/bootstrap-hermes-python.sh
#   bash scripts/bootstrap-hermes-python.sh ~/.hermes/plugins/hermes-my-browser-extension
#
# Env:
#   HERMES_PYTHON  — override path to Hermes venv python (default: ~/.hermes/hermes-agent/venv/bin/python)

set -euo pipefail

HERMES_PY="${HERMES_PYTHON:-${HOME}/.hermes/hermes-agent/venv/bin/python}"
PLUGIN_ROOT="${1:-${HOME}/.hermes/plugins/hermes-my-browser-extension}"

if [[ ! -x "$HERMES_PY" ]]; then
  echo "error: Hermes Python not found: $HERMES_PY" >&2
  echo "      Set HERMES_PYTHON to your hermes-agent venv python." >&2
  exit 1
fi
if [[ ! -f "${PLUGIN_ROOT}/pyproject.toml" ]]; then
  echo "error: plugin directory missing pyproject.toml: $PLUGIN_ROOT" >&2
  echo "      Run: hermes plugins install iHeyTang/hermes-my-browser-extension" >&2
  exit 1
fi

if ! "$HERMES_PY" -m pip --version &>/dev/null; then
  "$HERMES_PY" -m ensurepip --upgrade || true
fi

exec "$HERMES_PY" -m pip install -e "$PLUGIN_ROOT"
