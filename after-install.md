# Hermes Browser Extension

Hermes can control a **separate Chrome window** in your normal profile (no automation banner; your main tabs stay untouched). The extension adds a **side panel** for chat and a bridge to those browser tools.

**Not set up yet?** Paste the install block from the [README](./README.md) (or [README.zh-CN](./README.zh-CN.md)) into Hermes Agent.

**Next steps for you**

1. **Chrome** — `chrome://extensions/` → Developer mode → **Load unpacked** →  
   `~/.hermes/plugins/hermes-my-browser-extension/extension/build/chrome-mv3-prod`
2. **Gateway** — `hermes gateway restart`, then open the extension → **side panel** → tap **● Offline** until **● Online**.
3. **Side panel sign-in** — if chat shows errors, set `API_SERVER_ENABLED`, `API_SERVER_KEY`, and `API_SERVER_CORS_ORIGINS=*` in `~/.hermes/.env`, restart the gateway, and paste the same API key under **Options → Settings** in the extension. Ask Hermes or see the [README](./README.md) install doc for the exact one-liner.

Optional: open the extension side panel, go **Online**, set **Open** (Auto / Agent / New tab / Same tab), then `@my_browser_navigate url=https://example.com` to confirm navigation.

More detail when you need it: [README](./README.md) · [DEVELOPER.md](./DEVELOPER.md) · [docs/AGENT_INSTALL.md](./docs/AGENT_INSTALL.md)
