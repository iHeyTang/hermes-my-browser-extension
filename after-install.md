# hermes-my-browser-extension installed

Plugin files are in `~/.hermes/plugins/hermes-my-browser-extension/`.

If you have not installed the plugin yet (e.g. you opened this file from the
repo instead of the Hermes installer), run:

```bash
hermes plugins install iHeyTang/hermes-my-browser-extension
```

The agent operates in a **dedicated background Chrome window**. It never
touches your active tabs and Chrome shows **no "is debugging this browser"
banner** anywhere.

v0.3.0 also bundles a Tampermonkey-compatible userscript engine and a
Hermes chat side panel inside the extension itself.

## Setup (4 steps)

### 1. Install the Python dependency

The bridge needs the `websockets` package in Hermes's own Python env:

```bash
~/.hermes/hermes-agent/venv/bin/pip install 'websockets>=12'
```

> Hermes ships its own venv at `~/.hermes/hermes-agent/venv/`.

### 2. Build the Chrome extension

The extension is a Plasmo (TypeScript + React + shadcn) project. You need
Node ≥ 20 and pnpm.

```bash
cd ~/.hermes/plugins/hermes-my-browser-extension/extension
pnpm install
pnpm build
```

That produces `extension/build/chrome-mv3-prod/`.

> For active development run `pnpm dev` instead — it watches the source
> tree and reloads to `extension/build/chrome-mv3-dev/`.

### 3. Load the extension in Chrome

1. Open `chrome://extensions/`
2. Toggle **Developer mode** (top-right)
3. Click **Load unpacked**
4. Pick:

   ```
   ~/.hermes/plugins/hermes-my-browser-extension/extension/build/chrome-mv3-prod
   ```

5. The extension icon appears in the toolbar.

### 4. Restart Hermes and connect

```bash
hermes gateway restart
```

Then in Chrome:

- Click the extension icon → the **side panel** opens directly.
- In the panel's status bar (just above the input box), click the
  **● Offline** pill → it flips to **● Connecting…** and then **● Online**.
- A small Chrome window appears in the background — that's the **agent window**.
  Click the window icon next to the status pill any time you want to
  bring it to the front.

## Verify it works

In Hermes:

```text
@my_browser_connect                                       # creates the agent window
@my_browser_navigate url=https://example.com              # loads in agent tab
@my_browser_screenshot                                    # returns /tmp/my_browser_screenshot_*.png
@my_browser_get_text selector=h1                          # "Example Domain"
```

Open the returned PNG — you'll see `example.com`'s viewport, captured **without
focus shifting away from whatever you were doing**.

## Userscripts

In the side panel's status bar, click the **scripts icon** (with a
badge showing how many are enabled) — or open
`chrome://extensions/` → "Hermes Browser Extension" → Details → Extension
options — to manage scripts.

- **New script** opens a CodeMirror editor preloaded with a Tampermonkey
  template.
- **Install from URL** fetches a `.user.js` and parses its header.
- Each row has an enable switch + edit + remove.

The agent can drive the same engine:

```text
@my_browser_userscript_list                                # see what's installed
@my_browser_userscript_install url=https://example.com/foo.user.js
@my_browser_userscript_run id=my-script-abc123 args='{"keyword":"hello"}'
```

`GM_info.scriptArgs` exposes whatever JSON you pass via `args`, so the
script can act as a parametrised batch operation invoked by the agent.

Supported GM APIs:

`GM_info`, `GM_setValue` / `GM_getValue` / `GM_deleteValue` / `GM_listValues`,
`GM_addValueChangeListener` / `GM_removeValueChangeListener`,
`GM_xmlhttpRequest` (full options + `abort()`, binary response types,
cross-origin via the SW), `GM_addStyle` / `GM_addElement`,
`GM_setClipboard`, `GM_notification`, `GM_openInTab`, `GM_download`,
`GM_log`, `GM_getResourceText` / `GM_getResourceURL`,
`GM_registerMenuCommand` / `GM_unregisterMenuCommand`, `unsafeWindow`,
plus the full `GM.*` Promise variants.

## Chat side panel

Click the extension icon — the side panel opens directly. It speaks to
the local Hermes gateway's OpenAI-compatible HTTP API:

```
extension SidePanel  ─SSE─►  127.0.0.1:8642/v1/chat/completions
```

### Required gateway config

Before the side panel can talk to the gateway, **two env vars must be set
in `~/.hermes/.env`**. Both are read by `gateway/platforms/api_server.py`
on startup; without them you'll see HTTP 401 / 403 errors in the side
panel:

| Env var | Why it's needed |
|---------|-----------------|
| `API_SERVER_ENABLED=true` | Turns the OpenAI-compatible HTTP API on. |
| `API_SERVER_KEY=<random-token>` | Bearer token. Required because the gateway always demands auth when this is set; if you leave it empty the gateway accepts unauthenticated calls but also rejects `X-Hermes-Session-Id`, so set it. |
| `API_SERVER_CORS_ORIGINS=*` | Allows the `chrome-extension://<id>` origin. Without this the gateway 403s any browser-initiated fetch. `*` is safe because the API server binds to `127.0.0.1` only. |

One-liner to set both at once and restart:

```bash
{ echo 'API_SERVER_ENABLED=true'
  # only add a key if you don't have one yet:
  grep -q '^API_SERVER_KEY=' ~/.hermes/.env || echo "API_SERVER_KEY=$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-43)"
  grep -q '^API_SERVER_CORS_ORIGINS=' ~/.hermes/.env || echo 'API_SERVER_CORS_ORIGINS=*'
} >> ~/.hermes/.env
hermes gateway restart
```

Then in **Options → Settings**, paste the value of `API_SERVER_KEY` into
the "API key" field. The extension stores it locally in
`chrome.storage.local` and never sends it anywhere except the configured
gateway.

> Why this isn't automatic: the Hermes gateway is shared across many
> integrations (CLI, Discord, Telegram, etc.), so the extension can't
> assume it owns those env vars. Setting them once here is a one-time
> step.

### Discovery + session handling

Configure base URL, model and session id in **Options → Settings**. The
agent has a discovery helper:

```text
@my_browser_chat_url
# → { base_url: "http://127.0.0.1:8642/v1", api_server_state: "connected" }
```

Sessions persist across panel reloads (the panel stores history in
`chrome.storage.local`). Click the refresh icon in the panel header to
start a new session.

### Belt-and-suspenders: in-extension Origin stripping

As a fallback, the extension also installs a
`chrome.declarativeNetRequest` rule that strips the `Origin` header from
outgoing chat requests, so the CORS gate is bypassed even if you forget to
set `API_SERVER_CORS_ORIGINS`. You can verify it's active in the SW
console (`chrome://extensions/` → Hermes Browser Extension → "Inspect views: service
worker"):

```
[hermes-bridge] Origin-strip DNR rule active for host=127.0.0.1:8642 …
```

This is a best-effort workaround — `modifyHeaders` rules in MV3 have
edge-case quirks across Chrome versions, so the env-var fix above is
still the recommended path. The side panel exposes a "Reset CORS rule"
button in the error banner if you need to reinstall it manually.

## Tools at a glance

### Browser control

| Tool | What it does |
|------|--------------|
| `my_browser_connect`         | Open / attach to the agent window |
| `my_browser_disconnect`      | Close the agent window |
| `my_browser_status`          | Bridge + agent window state, current URL |
| `my_browser_navigate`        | Load a URL in the agent tab (waits for load) |
| `my_browser_screenshot`      | Viewport screenshot (PNG / JPEG) |
| `my_browser_eval`            | Run JavaScript, return value |
| `my_browser_click`           | Click element matching CSS selector |
| `my_browser_type`            | Type into input/textarea/contenteditable |
| `my_browser_get_html`        | Page or element outerHTML |
| `my_browser_get_text`        | Page or element innerText |
| `my_browser_session_save`    | Snapshot cookies + localStorage |
| `my_browser_session_restore` | Apply a saved snapshot |

### Userscripts

| Tool | What it does |
|------|--------------|
| `my_browser_userscript_list`        | List installed scripts |
| `my_browser_userscript_get`         | Get source + metadata for one script |
| `my_browser_userscript_install`     | Install from `source` text or `url` |
| `my_browser_userscript_save`        | Replace the source of an existing script |
| `my_browser_userscript_remove`      | Uninstall a script |
| `my_browser_userscript_set_enabled` | Enable / disable a script |
| `my_browser_userscript_run`         | Force-run a script on the agent tab right now |

### Chat

| Tool | What it does |
|------|--------------|
| `my_browser_chat_url` | Discover the local gateway HTTP API base URL |

## Troubleshooting

| Symptom | Where to look |
|---------|---------------|
| Tools all fail "Bridge communication failed" | `~/.hermes/logs/my-browser-bridge.log` — most likely the `websockets` Python dep is missing |
| Extension stays disconnected after click | `chrome://extensions/` → service worker → Console |
| `my_browser_eval` says "Refused to evaluate a string" | Page has strict CSP — re-run with `world="ISOLATED"` |
| Userscript doesn't run on a page | Check `chrome://extensions/` → service worker console for parser errors; also check Options → script row → "error" badge |
| **Side panel chat: `Hermes 401: Invalid API key`** | `API_SERVER_KEY` is set on the gateway but the extension hasn't been told. Open Options → Settings and paste the value from `~/.hermes/.env`. |
| **Side panel chat: `Hermes 403: Forbidden`** | CORS rejection. Add `API_SERVER_CORS_ORIGINS=*` to `~/.hermes/.env` and `hermes gateway restart`. (See *Required gateway config* above for the full one-liner.) |
| Side panel chat 404 | `@my_browser_chat_url` first to confirm the base URL; then in Options → Settings paste it under "API base URL" — should end in `/v1` |
| Agent window keeps reappearing after closing | Expected — any tool call lazily re-creates it. Use `my_browser_disconnect` to fully tear down |

## Showing / hiding the agent window

The side panel's bridge status bar has a small **window icon** next to
the status pill — click it to bring the agent window to focus when you
want to see what the agent is doing. The agent window otherwise stays
in the background and never steals focus on its own.

## Optional: change bridge port

```bash
export MY_BROWSER_BRIDGE_PORT=9494
hermes gateway restart
```

If you change the port, also edit
`extension/src/background/config.ts`'s `BRIDGE_URL` to match, then `pnpm
build` again and reload the extension.
