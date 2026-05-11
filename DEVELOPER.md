# Hermes Browser Extension — developer notes

Audience: contributors and anyone debugging packaging, the bridge, or Hermes integration.

## Layout

- `plugin.yaml` — Hermes directory-plugin manifest (`hermes plugins install …`).
- `pyproject.toml` — Python package metadata, **`websockets>=12`**, and the official pip entry point group **`hermes_agent.plugins`** (see [Build a Hermes Plugin — distribute via pip](https://hermes-agent.nousresearch.com/docs/guides/build-a-hermes-plugin#distribute-via-pip)).
- `hermes_my_browser_extension` — setuptools maps the repo root to this import name; bridge subprocess prefers `python -m hermes_my_browser_extension.bridge.server`, with fallback to `python -m bridge.server` when the package is not installed.
- `bridge/` — WebSocket hub + HTTP helpers for the extension.
- `extension/` — Plasmo (MV3) UI and service worker.
- `scripts/bootstrap-hermes-python.sh` — `pip install -e` into Hermes’s venv (optional `HERMES_PYTHON`, optional plugin path argument).

## Why `hermes plugins install` is not enough

`hermes plugins install owner/repo` clones under `~/.hermes/plugins/…` for discovery. It does **not** install `pyproject.toml` dependencies into `~/.hermes/hermes-agent/venv/`. Users (or an agent following `docs/AGENT_INSTALL.md`) still run **`pip install -e`** on that checkout—or install the same project from Git/PyPI.

## Pip-only install paths

- Editable checkout: `pip install -e ~/.hermes/plugins/hermes-my-browser-extension`
- Git: `pip install "git+https://github.com/iHeyTang/hermes-my-browser-extension.git"`
- PyPI (after publish): `pip install hermes-my-browser-extension`

With pip-only installs, build the extension from the `extension/` directory inside the installed package (resolve with `import hermes_my_browser_extension` and `Path(__file__).parent`).

## Bridge / tools

- Hermes tools live in `tools.py`; they talk to the extension over WebSockets via `bridge/server.py`.
- `tools.py` imports **`tools.registry`** from **Hermes** (not this repo’s filename); registering this repo as the package `hermes_my_browser_extension` avoids shadowing Hermes’s top-level `tools` package.

## Optional: bridge port

`MY_BROWSER_BRIDGE_PORT` / `MY_BROWSER_ATTACH_HTTP_PORT`; if changed, rebuild the extension after editing `extension/src/background/config.ts`.

## Trade-offs vs full CDP

**Gains:** no automation banner, no focus stealing on screenshots, separate agent window, userscripts + side-panel chat.

**Limits:** no arbitrary CDP; viewport screenshots only; strict CSP may block `my_browser_eval` unless `world="ISOLATED"` where applicable.

## Side panel CORS / `API_SERVER_*`

Gateway reads `API_SERVER_ENABLED`, `API_SERVER_KEY`, `API_SERVER_CORS_ORIGINS` from `~/.hermes/.env`. The extension also ships a declarativeNetRequest workaround for localhost Origin stripping; env-based CORS is still the recommended configuration.

## Userscripts / GM API (reference)

Scripts run on the **agent tab**. Supported surface includes (not exhaustive): `GM_info`, `GM_setValue` / `GM_getValue` / `GM_deleteValue` / `GM_listValues`, value change listeners, `GM_xmlhttpRequest` (with `abort()`), `GM_addStyle` / `GM_addElement`, `GM_setClipboard`, `GM_notification`, `GM_openInTab`, `GM_download`, `GM_log`, `GM_getResourceText` / `GM_getResourceURL`, menu commands, `unsafeWindow`, and Promise-style `GM.*` variants. Metadata: `@match` / `@include` / `@exclude`, `@require`, `@resource`, `@run-at`, etc.

## License

MIT
