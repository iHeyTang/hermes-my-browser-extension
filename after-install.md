# hermes-my-browser-extension installed

Plugin files are in `~/.hermes/plugins/hermes-my-browser-extension/`.

The agent operates in a **dedicated background Chrome window**. It never
touches your active tabs and Chrome shows **no "is debugging this browser"
banner** anywhere.

To finish setup, do **3 things**:

## 1. Install the Python dependency

The bridge needs the `websockets` package in Hermes's own Python env:

```bash
~/.hermes/hermes-agent/venv/bin/pip install 'websockets>=12'
```

> Hermes ships its own venv at `~/.hermes/hermes-agent/venv/` (you can confirm
> with `head -1 $(which hermes)`). The path above is what you typically want.

## 2. Load the Chrome extension

1. Open `chrome://extensions/`
2. Toggle **Developer mode** (top-right)
3. Click **Load unpacked**
4. Pick this folder:

   ```
   ~/.hermes/plugins/hermes-my-browser-extension/extension
   ```

5. The extension icon appears in the toolbar.

## 3. Restart Hermes and connect

```bash
hermes gateway restart
```

Then in Chrome:

- Click the extension icon → **Connect to Hermes**
- A small Chrome window appears in the background — that's the **agent window**.
  Your active tabs are untouched.
- The popup status dot turns green.

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

## Tools at a glance

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

## Troubleshooting

| Symptom | Where to look |
|---------|---------------|
| Tools all fail "Bridge communication failed" | `~/.hermes/logs/my-browser-bridge.log` — most likely the `websockets` Python dep is missing |
| Extension stays disconnected after click | `chrome://extensions/` → service worker → Console |
| `my_browser_eval` says "Refused to evaluate a string" | Page has strict CSP — re-run with `world="ISOLATED"` |
| Agent window keeps reappearing after closing | Expected — any tool call lazily re-creates it. Use `my_browser_disconnect` to fully tear down |

## Showing / hiding the agent window

The popup has a **Show Agent Window** button to bring it to focus when you
want to see what the agent is doing. The agent window otherwise stays in the
background and never steals focus on its own.

## Optional: change bridge port

```bash
export MY_BROWSER_BRIDGE_PORT=9494
hermes gateway restart
```

(If you change the port, also edit `extension/background.js`'s `BRIDGE_URL`
to match, then reload the extension.)
