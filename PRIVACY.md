# Privacy Policy — Hermes Browser Extension

**Last updated**: 2026-05-25

This document describes what data the Hermes Browser Extension
("the extension") accesses, where it goes, and what we do (and don't
do) with it.

## TL;DR

- The extension talks **only to a Hermes Agent process running on your
  own machine** (`127.0.0.1:9394` over HTTP and `127.0.0.1:9393` over
  WebSocket).
- **No data is sent to any remote server controlled by the extension
  author or by Nous Research.** All network egress originates from the
  Hermes Agent process you installed locally, on your behalf, using
  credentials you configured.
- The extension does not include analytics, telemetry, ads, or third-
  party SDKs.

## Data the extension touches

The extension requests broad browser permissions because Hermes Agent
needs them to operate the browser on your behalf. Below is what each
permission is for and what data it implicates.

### `<all_urls>` host permission

Lets the extension inject content scripts and read page DOM on any
site you instruct the agent to visit. Used for:
- The side-panel chat that can attach the current tab's HTML / text /
  screenshot to a conversation when **you** ask the agent to.
- Tampermonkey-compatible userscripts you (or the agent on your
  behalf) install.

Page content is read **into the local Hermes process** running on your
machine. From there, whether it leaves your machine depends entirely
on the model provider you configured in Hermes (OpenAI, Anthropic,
local llama.cpp, etc.) — see the privacy policy of that provider.

### `tabs`, `scripting`, `activeTab`

Read tab metadata (URL, title), enumerate open tabs, inject scripts.
Same scope as above: data flows into the local Hermes process; nothing
leaves directly from the extension.

### `cookies`

Allows the agent to perform authenticated actions on your behalf
(e.g., "open this Gmail thread and summarize"). Cookies are read from
the browser's cookie store and **passed through to the local Hermes
process only when the agent's tool call explicitly requires them for
a specific request**. No cookies are stored by the extension.

### `bookmarks`

The `my_browser_bookmarks_*` tool family lets the agent list and
modify your bookmarks when you ask it to. Bookmark data does not leave
your machine via the extension.

### `storage`, `unlimitedStorage`

Local extension state: chat history, session metadata, user
preferences, drafts, attachments waiting to upload. All stays in
`chrome.storage.local` on your machine. Cleared with the extension.

### `sidePanel`, `notifications`, `downloads`, `alarms`, `favicon`,
### `declarativeNetRequestWithHostAccess`

UI surfaces and background scheduling for chat, notifications when a
cron job finishes, file downloads the agent saves on your behalf,
alarm timers for periodic checks, favicon rendering, and a narrow
declarativeNetRequest rule that lets the side-panel chat make CORS
requests to `127.0.0.1:9394`.

## Data the extension does NOT collect

- Analytics / telemetry / crash reports — **none**.
- Identifiers (advertising ID, device fingerprint) — **none**.
- Anything sent to a server controlled by the extension author, by
  Nous Research, or by any third party not configured by you.

## Data your local Hermes process may send

The local Hermes process (separate from this extension) is where any
outbound network traffic happens. It sends prompts and tool-call data
to whatever model provider you configured (`config.yaml`). That's
between you, Hermes, and that provider — outside the scope of this
extension's privacy.

## Third parties

The extension bundles open-source libraries (React, Plasmo, Radix UI,
CodeMirror, lucide-react, etc.) all running locally in the browser.
None phone home.

## Children

The extension is not directed at children under 13 and does not
knowingly collect data from them.

## Changes

Updates to this policy will be reflected in this file (`PRIVACY.md`)
with a new "Last updated" date.

## Contact

Issues: <https://github.com/iHeyTang/hermes-my-browser-extension/issues>
