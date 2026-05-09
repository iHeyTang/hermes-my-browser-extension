# Hermes Browser Extension

**English** | [简体中文](README.zh-CN.md)

Hermes Agent controls **the same Chrome profile you already use**—without `--remote-debugging-port`, without restarting the browser, **without the “Chrome is being controlled by automated test software” banner**, and **without stealing focus from the tab you are working in**.

The extension (**Hermes Browser Extension**, Plasmo + TypeScript + React + shadcn/ui) connects Hermes tools to Chrome through a small Python bridge and a dedicated **agent window**. Your main window stays untouched.

## Screenshot

Side panel side-by-side with the page you're browsing: the page on the left, the chat on the right. **Page** mode automatically pulls the current tab's content in as context for the conversation, while the agent's own actions happen in a separate window that never interrupts you.

![Hermes Browser Extension side panel next to the page you are browsing](docs/sidepanel-demo.png)

## What you get

- **Dedicated agent window** — navigation, screenshots, clicks, and script runs happen there; your active tabs and focus stay where you are.
- **No `chrome.debugger`** — same profile (cookies, logins, bookmarks) as your daily browser; no CDP-style “debugging this browser” strip.
- **Tampermonkey-compatible userscripts** — `GM_*` / `GM.*`, `@require` / `@resource`, `@run-at`, `@match` / `@include` / `@exclude`; agent tools can list, install, enable, and **force-run** scripts on the agent tab.
- **Hermes chat side panel** — `chrome.sidePanel` talks to the local Hermes gateway OpenAI-compatible HTTP API (`/v1/chat/completions` with SSE), similar in spirit to embedding a bot in the browser, fully on your machine.

## How it fits together

```
Your Chrome (one profile)
├── Main window (your work)          ← never touched by the agent
│   └── tabs you care about
└── Agent window (created on connect) ← only place Hermes drives
    └── task tab(s)
```

```
Hermes tools ──ws──► bridge/server.py ──ws──► extension service worker ──► tabs / scripting / cookies
                                                              └──► userscript engine

Side panel ──HTTP SSE──► Hermes gateway (e.g. http://127.0.0.1:8642/v1)
```

## Quick start

### 1. Install the Hermes plugin

```bash
hermes plugins install iHeyTang/hermes-my-browser-extension
```

Hermes will surface the full post-install guide from [`after-install.md`](./after-install.md). The steps below are the short version.

### 2. Python dependency (bridge)

```bash
~/.hermes/hermes-agent/venv/bin/pip install 'websockets>=12'
```

### 3. Build the extension

Requires **Node.js ≥ 20** and **pnpm**.

```bash
cd ~/.hermes/plugins/hermes-my-browser-extension/extension
pnpm install
pnpm build
```

Output: `extension/build/chrome-mv3-prod/`. For development, use `pnpm dev` → `build/chrome-mv3-dev/`.

### 4. Load in Chrome

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. **Load unpacked** → select  
   `~/.hermes/plugins/hermes-my-browser-extension/extension/build/chrome-mv3-prod`

### 5. Gateway and chat (one-time)

For the side panel to reach the gateway, set in `~/.hermes/.env` (then `hermes gateway restart`):

| Variable | Purpose |
|----------|---------|
| `API_SERVER_ENABLED=true` | Enables the OpenAI-compatible HTTP API |
| `API_SERVER_KEY=<token>` | Bearer token; paste the same value in the extension **Options → Settings → API key** |
| `API_SERVER_CORS_ORIGINS=*` | Allows `chrome-extension://…` origins (API binds to localhost) |

Example append + restart:

```bash
{ echo 'API_SERVER_ENABLED=true'
  grep -q '^API_SERVER_KEY=' ~/.hermes/.env || echo "API_SERVER_KEY=$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-43)"
  grep -q '^API_SERVER_CORS_ORIGINS=' ~/.hermes/.env || echo 'API_SERVER_CORS_ORIGINS=*'
} >> ~/.hermes/.env
hermes gateway restart
```

Details and troubleshooting: [`after-install.md`](./after-install.md#required-gateway-config).

### 6. Connect from Chrome

```bash
hermes gateway restart
```

- Click the extension icon → **side panel** opens.
- In the status bar above the input, click **● Offline** until it shows **● Online**.
- A small background window appears — that is the **agent window**. Use the window icon next to the status pill to bring it to the front when you want to watch the agent.

### 7. Smoke test (Hermes agent)

```text
@my_browser_connect
@my_browser_navigate url=https://example.com
@my_browser_screenshot
@my_browser_get_text selector=h1
```

You should get a viewport screenshot path and the heading text, without your main window losing focus.

## Agent tools (summary)

**Browser:** `my_browser_connect`, `my_browser_disconnect`, `my_browser_status`, `my_browser_navigate`, `my_browser_screenshot`, `my_browser_eval`, `my_browser_click`, `my_browser_type`, `my_browser_get_html`, `my_browser_get_text`, `my_browser_session_save`, `my_browser_session_restore`.

**Userscripts:** `my_browser_userscript_list`, `my_browser_userscript_get`, `my_browser_userscript_install`, `my_browser_userscript_save`, `my_browser_userscript_remove`, `my_browser_userscript_set_enabled`, `my_browser_userscript_run` (runs on the agent tab; optional `args` → `GM_info.scriptArgs`).

**Chat:** `my_browser_chat_url` — discovers the gateway base URL (e.g. `http://127.0.0.1:8642/v1`) for Settings.

Full GM API list and behavior: [`after-install.md`](./after-install.md).

## Trade-offs vs CDP / remote debugging

**You gain:** no banner, no focus stealing on screenshots, clean window separation, userscripts + side-panel chat without extra extensions.

**You lose:** arbitrary CDP (e.g. full network interception, emulation knobs), viewport-only screenshots (not full-page), strict CSP pages may reject `my_browser_eval` unless you use `world="ISOLATED"` where applicable.

For full CDP, use Chrome with `--remote-debugging-port` and a CDP client—that is outside this plugin’s scope.

## Local development (repo clone)

```bash
ln -sf "$(pwd)" ~/.hermes/plugins/hermes-my-browser-extension
hermes plugins enable hermes-my-browser-extension
hermes gateway restart

cd extension
pnpm install
pnpm dev    # or pnpm build
```

Logs: bridge `~/.hermes/logs/my-browser-bridge.log`; extension service worker from `chrome://extensions/` → **Inspect views: service worker**.

## Requirements

- Hermes Agent ≥ **0.11.0**
- Python `websockets` ≥ 12 in Hermes’s venv (see step 2)
- Node ≥ 20, pnpm, Chrome/Chromium

## Uninstall

```bash
hermes plugins remove hermes-my-browser-extension
```

Also remove the extension from `chrome://extensions/`.

## License

MIT
