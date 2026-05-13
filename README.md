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
