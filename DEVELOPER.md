# Hermes Browser Extension — developer notes

Audience: contributors and anyone debugging packaging or the bridge to Hermes.

This repo is the **Chrome extension only**. The matching Hermes Python
plugin (WebSocket hub + tools) lives at
[`iHeyTang/hermes-plugin-browser-tools`](https://github.com/iHeyTang/hermes-plugin-browser-tools).

## Layout

- `package.json` / `pnpm-lock.yaml` — Plasmo MV3 project.
- `src/` — extension source (background, sidepanel, options, content scripts, userscript runtime).
- `assets/` — extension icons.
- `patches/` — `pnpm patch` artefacts (currently `property-information@7.1.0`).
- `docs/index.html` — download/landing page served via GitHub Pages.
- `.github/workflows/` — CI (typecheck + production build) and Release (tag-triggered zip → GitHub Releases).

## Build

```
pnpm install
pnpm build         # → build/chrome-mv3-prod/
```

Load `build/chrome-mv3-prod/` as an unpacked extension in `chrome://extensions`.

## Bridge port

The extension connects to the local Hermes plugin via WebSocket. Defaults:
`MY_BROWSER_BRIDGE_PORT` / `MY_BROWSER_ATTACH_HTTP_PORT` (defined in
`src/background/config.ts`). If you change the port on the plugin side, rebuild
the extension after editing the matching constants here.

## Trade-offs vs full CDP

**Gains:** no automation banner, no focus stealing on screenshots, separate agent window, userscripts + side-panel chat.

**Limits:** no arbitrary CDP; viewport screenshots only; strict CSP may block `my_browser_eval` unless `world="ISOLATED"` where applicable.

## Side panel CORS / `API_SERVER_*`

Gateway reads `API_SERVER_ENABLED`, `API_SERVER_KEY`, `API_SERVER_CORS_ORIGINS` from `~/.hermes/.env`. The extension also ships a declarativeNetRequest workaround for localhost Origin stripping; env-based CORS is still the recommended configuration.

## Userscripts / GM API (reference)

Scripts run on the **agent tab**. Supported surface includes (not exhaustive): `GM_info`, `GM_setValue` / `GM_getValue` / `GM_deleteValue` / `GM_listValues`, value change listeners, `GM_xmlhttpRequest` (with `abort()`), `GM_addStyle` / `GM_addElement`, `GM_setClipboard`, `GM_notification`, `GM_openInTab`, `GM_download`, `GM_log`, `GM_getResourceText` / `GM_getResourceURL`, menu commands, `unsafeWindow`, and Promise-style `GM.*` variants. Metadata: `@match` / `@include` / `@exclude`, `@require`, `@resource`, `@run-at`, etc.

## License

MIT
