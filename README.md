# Hermes Browser Extension

**English** | [简体中文](README.zh-CN.md)

Hermes drives a **separate Chrome window** in your normal profile (no debugging banner, no stealing focus from your working tab). This repo adds a Plasmo extension plus a small Python bridge.

The extension surfaces Hermes in four places:

- **Side panel** — chat alongside the page you're browsing.
- **Home page** — replaces Chrome's new-tab page with a Hermes launcher (greeting, prompt input, recent sessions).
- **Full-screen chat** — a dedicated chat tab with a sessions rail on the left and an adjustable message column.
- **Options page** — configure the gateway, models, skills, memory, cron jobs, and userscripts.

### Side panel — chat next to your page

![Side panel next to the page you are browsing](docs/sidepanel-demo.png)

### Home page — new-tab launcher

![Hermes Home replacing the new-tab page](docs/home-newtab.png)

### Full-screen chat — dedicated tab

![Full-screen Hermes chat tab with sessions rail](docs/chat-fullscreen.png)

---

## Inbox — a shared surface across every channel

The new-tab **Inbox** is this extension's answer to a gap in Hermes core:
Hermes can run cron jobs and ferry messages across many channels (Feishu,
Telegram, Slack, …) but it has no built-in way for an agent in *one* channel
to read what produced in *another*. The Inbox fills that gap by acting as a
plugin-owned unified surface — anything that lands here is readable from
both the new-tab UI **and** any Hermes session via three companion tools.

Three independent layers — *Inbox is the aggregator*, not a store:

```
   Independent mechanisms                Aggregator layer        Consumers
   (each owns its own store)              (this plugin)

  ┌─────────────────────────┐                                ┌─────────────────┐
  │ Cron jobs               │                                │ new-tab Home    │
  │  (Hermes core)          │                                │  (renders cards)│
  │                         │                                └─────────────────┘
  │ store: $HERMES_HOME/    │ ──►                                     ▲
  │   cron/output/{job}/    │     ┌──────────────────────┐            │
  │   *.md                  │     │                      │            │
  └─────────────────────────┘     │  Inbox aggregator    │ ───────────┤
                                  │  (this plugin)       │            │
  ┌─────────────────────────┐     │                      │   ┌────────┴────────┐
  │ Agent cards             │ ──► │  - reads all sources │   │ Agent in any    │
  │  (this plugin, peer to  │     │  - unifies into one  │   │ channel         │
  │   cron jobs)            │     │    feed              │   │ (my_browser_    │
  │                         │     └──────────────────────┘   │  inbox_list/    │
  │ write: my_browser_      │                                │  read tools)    │
  │   card_push tool        │                                └─────────────────┘
  │ store: $HERMES_HOME/    │
  │   agent_cards/cards.json│
  └─────────────────────────┘
```

### What goes in

1. **Every cron run, automatically.** Hermes always writes each run's
   markdown to `$HERMES_HOME/cron/output/{job_id}/{timestamp}.md`; the
   extension indexes that directory and folds every run into the Inbox
   regardless of the job's `deliver` setting. The `deliver` field only
   controls *additional* channel pushing (Feishu / Telegram / …) on top
   of the always-on Inbox.
2. **Agent cards** via `my_browser_card_push`. This is an **independent
   mechanism**, conceptually peer to cron jobs and *not* internal to the
   Inbox: anything in the Hermes process — a chat turn, a background
   watchdog, a custom tool — can leave the user a structured card.
   Stored at `$HERMES_HOME/agent_cards/cards.json`. The Inbox is just one
   consumer of this source; future consumers (e.g. a Lark bot doing
   daily digest DMs) could read the same store.

### Agent tools (cross-channel)

Three tools register under the `my-browser-extension` toolset, so a Hermes
session running in any channel can use them once this plugin is enabled:

- **`my_browser_card_push`** — leave the user a structured card
  (headline + tldr + actions + urgency). **This is the agent-cards
  mechanism's writer, not an Inbox-internal API** — the card is stored
  under `$HERMES_HOME/agent_cards/` and the Inbox is one of its
  consumers. Use this proactively when there's something the user should
  know after the fact.
- **`my_browser_inbox_list`** — page through everything in the Inbox.
  Filters: `kind` (cron-result / agent-card / all), `source` substring
  match, `since_ms` cursor, `limit`, `include_silent`. Returns one-line
  previews so a session can decide what's worth opening.
- **`my_browser_inbox_read`** — pull the full body of one entry by id.
  For cron entries this is the complete run markdown; for agent cards
  it's the full synthesis.

Typical use from a Feishu session: "Did anything interesting come out of
this morning's cron jobs?" → agent calls `inbox_list` with a `since_ms`
covering the morning → reads a few entries via `inbox_read` → reports
back. No filesystem access needed; the tools read straight from
`$HERMES_HOME`.

### New-tab UI

The Home page's left column renders the Inbox as a card feed: unread
cards float to the top, errors get an accent border, and clicking a card
opens the full content inline. Cron cards show the verbatim run output
(no truncation, no summary "Hermes Card" coupling); agent-pushed cards
show their structured synthesis.

---

## Install with Hermes (recommended)

**Copy the whole block below** into **Hermes Agent**:

```
Follow the document at this link to install and configure Hermes Browser Extension on my machine:

https://raw.githubusercontent.com/iHeyTang/hermes-my-browser-extension/main/docs/AGENT_INSTALL.md
```

---

## After it is installed

Short guide: [`after-install.md`](./after-install.md)

Technical / packaging details: [`DEVELOPER.md`](./DEVELOPER.md)

## Uninstall

```bash
hermes plugins remove hermes-my-browser-extension
"${HOME}/.hermes/hermes-agent/venv/bin/python" -m pip uninstall hermes-my-browser-extension
```

Remove the extension from `chrome://extensions/` as well.

## License

MIT
