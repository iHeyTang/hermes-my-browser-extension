/**
 * English message catalog.
 *
 * Keys use dot-notation grouped by surface (options.*, sidepanel.*, etc.).
 * Use `{name}` placeholders for interpolation — see `t()` in `./index.ts`.
 *
 * To add a string:
 *   1. Add the key here.
 *   2. Add the same key to `zh-CN.ts` (TypeScript enforces this).
 *   3. Use `t("your.key")` in components via `useT()`.
 */
export const en = {
  // Generic
  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.delete": "Delete",
  "common.edit": "Edit",
  "common.close": "Close",
  "common.refresh": "Refresh",
  "common.confirm": "Confirm",
  "common.loading": "Loading…",
  "common.saving": "Saving…",
  "common.installing": "Installing…",
  "common.error": "Error",
  "common.enabled": "Enabled",
  "common.disabled": "Disabled",
  "common.on": "On",
  "common.off": "Off",
  "common.copy": "Copy",
  "common.copied": "Copied",
  "common.retry": "Retry",
  "common.untitled": "Untitled",

  // App shell
  "app.title": "Hermes",
  "app.subtitle": "Extension console",

  // Options nav
  "options.nav.preference": "Preference",
  "options.nav.scripts": "Userscripts",
  "options.nav.gateway": "Gateway",
  "options.nav.models": "Models",
  "options.nav.skills": "Skills",
  "options.nav.memory": "Memory",
  "options.nav.cron": "Cron",

  // Preference page
  "options.preference.title": "Preference",
  "options.preference.subtitle":
    "Extension UI and behavior (unrelated to Gateway / Models)",
  "options.preference.theme": "Theme",
  "options.preference.theme.auto": "Follow browser",
  "options.preference.theme.auto.desc":
    "Match the browser / OS light or dark preference (prefers-color-scheme).",
  "options.preference.theme.light": "Light",
  "options.preference.theme.light.desc": "Always use the light theme.",
  "options.preference.theme.dark": "Dark",
  "options.preference.theme.dark.desc": "Always use the dark theme.",
  "options.preference.language": "Language",
  "options.preference.language.auto": "Follow browser",
  "options.preference.language.auto.desc":
    "Match the browser language. Falls back to English when unsupported.",
  "options.preference.language.en": "English",
  "options.preference.language.en.desc": "Always use English.",
  "options.preference.language.zh-CN": "简体中文",
  "options.preference.language.zh-CN.desc": "Always use Simplified Chinese.",
  "options.preference.stream.label": "Side panel stream details",
  "options.preference.stream.desc":
    "When on, the side panel shows tool calls and reasoning fragments streamed from the model (kept in sync with the in-panel toggle).",
  "options.preference.newtab.label": "Use Hermes as new tab page",
  "options.preference.newtab.desc":
    "When on, opening a new tab shows the Hermes chat. The extension must still be granted the new-tab override permission by Chrome the first time it tries to take over.",
  "options.preference.newtab.fallback": "Fallback URL when off",
  "options.preference.newtab.fallback.placeholder":
    "https://www.google.com (leave blank for a Hermes splash)",
  "options.preference.newtab.fallback.desc":
    "Only used when the toggle above is off. With a URL set, new tabs redirect there; otherwise they land on a small Hermes splash with a link back to options.",

  // Userscripts
  "options.scripts.title": "Userscripts",
  "options.scripts.subtitle": "Create, install, and manage userscripts",
  "options.scripts.new": "New script",
  "options.scripts.installFromUrl": "Install from URL",
  "options.scripts.installDialog.title": "Install userscript from URL",
  "options.scripts.installDialog.label": "Script URL",
  "options.scripts.installDialog.install": "Install",
  "options.scripts.empty":
    "No userscripts installed yet. Use the buttons above to create or import one.",
  "options.scripts.removeConfirm":
    "Remove this userscript? This action can't be undone.",
  "options.scripts.editor.newTitle": "New userscript",
  "options.scripts.editor.editTitle": "Edit: {name}",
  "options.scripts.runAt": "Run at: {runAt}",
  "options.scripts.match": "Match: {match}",
  "options.scripts.version": "v{version}",
  "options.scripts.updatedAt": "Updated {time}",
  "options.scripts.lastError": "Last error",
  "options.scripts.errorBadge": "error",
  "options.scripts.noMatch": "(no @match)",
  "options.scripts.action.edit": "Edit",
  "options.scripts.action.remove": "Remove",
  "options.scripts.editor.save": "Save",
  "options.scripts.editor.cancel": "Cancel",
  "options.scripts.editor.placeholder":
    "// ==UserScript==\n// @name        My script\n// @match       https://example.com/*\n// @run-at      document-end\n// ==/UserScript==\n",

  // Gateway settings
  "options.gateway.title": "Gateway",
  "options.gateway.subtitle":
    "Side panel chat → hermes-agent-gateway",
  "options.gateway.subtitle.tooltip":
    "Side panel chat → hermes-agent-gateway (OpenAI-compatible HTTP)",
  "options.gateway.baseUrl": "Gateway base URL",
  "options.gateway.baseUrl.placeholder": "http://127.0.0.1:8765",
  "options.gateway.baseUrl.desc":
    "The bridge listens on this URL. Override it if you ran hermes-bridge on a different port or host.",
  "options.gateway.test": "Test connection",
  "options.gateway.testing": "Testing…",
  "options.gateway.test.ok": "Connected. Bridge is reachable.",
  "options.gateway.test.fail": "Could not reach the bridge: {error}",
  "options.gateway.startHint":
    "Bridge not running? Start it with `hermes-bridge` from the Hermes CLI.",
  "options.gateway.intro.lead": "The side panel chat talks to",
  "options.gateway.intro.gatewayName": "hermes-agent-gateway",
  "options.gateway.intro.protocol": "(OpenAI-compatible HTTP).",
  "options.gateway.intro.configureHint":
    "Configure Hermes CLI models and keys in the",
  "options.gateway.intro.modelsTab": "Models",
  "options.gateway.intro.tab": "tab.",
  "options.gateway.section.chat": "Side panel chat (gateway HTTP)",
  "options.gateway.apiBase.label": "API base URL",
  "options.gateway.apiBase.help":
    "Only affects the side panel's direct gateway connection (default port 8642). Separate from the Hermes config on the Models tab.",
  "options.gateway.model.label": "Chat model id",
  "options.gateway.model.fromGateway": "From gateway",
  "options.gateway.model.fromGateway.tooltip":
    "GET /v1/models from the API base above",
  "options.gateway.model.noModels": "Gateway returned no models.",
  "options.gateway.apiKey.label": "API key (optional)",
  "options.gateway.apiKey.placeholder":
    "leave empty if your gateway doesn't require auth",
  "options.gateway.sessions.help.before": "Multiple sessions are managed in the side panel's",
  "options.gateway.sessions.help.sessions": "Sessions",
  "options.gateway.sessions.help.after":
    "view; each request carries an",
  "options.gateway.sessions.help.headerSuffix": "header.",
  "options.gateway.save": "Save",
  "options.gateway.saved": "Saved.",
  "options.gateway.bridge.title": "Bridge",
  "options.gateway.bridge.fixed.before":
    "The WebSocket bridge is fixed at",
  "options.gateway.bridge.fixed.after":
    ". To use a different port, set",
  "options.gateway.bridge.fixed.suffix":
    "on the Hermes side and rebuild the extension.",

  // Memory settings
  "options.memory.title": "Memory",
  "options.memory.subtitle":
    "Hermes Agent's persistent memory (read-only view)",
  "options.memory.subtitle.tooltip":
    "$HERMES_HOME/memories/{MEMORY,USER}.md",
  "options.memory.empty": "(No memory entries yet)",
  "options.memory.refresh": "Refresh",
  "options.memory.failedToLoad": "Failed to load",
  "options.memory.chars": "{count} / {limit} chars",
  "options.memory.entries": "{count} entries",
  "options.memory.charsLen": "{count} chars",
  "options.memory.target.memory": "MEMORY.md",
  "options.memory.target.user": "USER.md",
  "options.memory.desc.memory":
    "Hermes Agent's own observations (environment facts, project conventions, tool quirks, etc.).",
  "options.memory.desc.user":
    "User preferences and collaboration habits noted by Hermes Agent.",
  "options.memory.flagTooltip":
    "Hermes safety-scan flag: {flag}\nThe same rules block entries before MEMORY.md is injected into the system prompt",

  // Models / Hermes model config
  "options.models.title": "Models",
  "options.models.subtitle":
    "Which providers and models Hermes uses for chat, embedding, and tool calls.",
  "options.models.catalog.loading": "Loading…",
  "options.models.catalog.ready": "Catalog ready",
  "options.models.catalog.unavailable": "Catalog unavailable",
  "options.models.catalog.updatedAt": "Catalog {time}",
  "options.models.refreshCatalog": "Refresh catalog",
  "options.models.loadingSettings": "Loading settings…",

  // Skills
  "options.skills.title": "Skills",
  "options.skills.subtitle":
    "Skill packs Hermes can load on demand. Toggle to enable per session.",
  "options.skills.subtitle.summary":
    "Skills available to the current agent ({enabled} / {total})",
  "options.skills.subtitle.platform": "  ·  platform={platform}",
  "options.skills.refresh": "Refresh",

  // Cron
  "options.cron.title": "Cron",
  "options.cron.subtitle":
    "Hermes Agent scheduled jobs ({count} total)",
  "options.cron.refresh": "Refresh",
  "options.cron.newJob": "New job",

  // Sidepanel
  "sidepanel.newChat": "Start a new chat",
  "sidepanel.tabbar.empty.before": "No open sessions — tap",
  "sidepanel.tabbar.empty.after": "or pick one from History",
  "sidepanel.tabbar.button.new": "New chat",
  "sidepanel.tabbar.button.history": "History",
  "sidepanel.tabbar.button.settings": "Settings",
  "sidepanel.tabbar.tab.close": "Close tab (session is kept in History)",
  "sidepanel.tabbar.tab.closeAria": "Close tab",
  "sidepanel.tabbar.menu.close": "Close",
  "sidepanel.tabbar.menu.closeOthers": "Close others",
  "sidepanel.tabbar.menu.closeRight": "Close to the right",
  "sidepanel.tabbar.menu.closeAll": "Close all",
  "sidepanel.placeholder": "Message Hermes…",
  "sidepanel.placeholder.uploading":
    "Waiting for attachment upload to finish…",
  "sidepanel.placeholder.withAttachments": "Add a question about your file(s)…",
  "sidepanel.placeholder.withPinned": "Ask about the attached page(s)…",
  "sidepanel.send": "Send",
  "sidepanel.send.tooltip": "Send (⌘/Ctrl+Enter)",
  "sidepanel.queue.tooltip": "Queue: send after the current turn finishes",
  "sidepanel.stop": "Stop generation",
  "sidepanel.regenerate": "Regenerate",
  "sidepanel.sessions": "Sessions",
  "sidepanel.tabs": "Tabs",
  "sidepanel.streamDetails": "Thoughts",
  "sidepanel.streamDetails.tooltip":
    "Show the agent's reasoning and tool-call trace in assistant bubbles (when the model doesn't emit reasoning, only tool calls are shown)",
  "sidepanel.attach": "Attach files",
  "sidepanel.attach.tooltip": "Attach files (multi-select supported)",
  "sidepanel.openOptions": "Open options",
  "sidepanel.pin": "Pin",
  "sidepanel.pin.pinAria": "Attach current page to next message",
  "sidepanel.pin.unpinAria": "Unpin current page",
  "sidepanel.pin.pinTooltip":
    "Attach the current page to the next message (one-shot snapshot)",
  "sidepanel.pin.unpinTooltip": "Detach this page from the next message",
  "sidepanel.learn.record": "Record actions",
  "sidepanel.learn.recording": "Recording · {count} steps",
  "sidepanel.learn.stop": "Stop and attach",
  "sidepanel.learn.processing": "Processing…",
  "sidepanel.learn.tooltip":
    "Record clicks and input on the active tab; the trace JSON will be attached to the conversation when you stop. Write your prompt yourself.",
  "sidepanel.queue.sendNow": "Send now: jump this message to the front of the queue",
  "sidepanel.queue.sendNow.aria": "Send now",
  "sidepanel.queue.edit":
    "Edit: load this message into the composer (keeps queue position, pauses the queue)",
  "sidepanel.queue.edit.aria": "Edit",
  "sidepanel.queue.delete": "Delete",
  "sidepanel.queue.editing": "This message is being edited in the composer",
  "sidepanel.composer.cancelEdit":
    "Cancel edit (discards composer changes; the queued item is unchanged)",
  "sidepanel.composer.cancelEdit.aria": "Cancel edit",
  "sidepanel.permission.allowOnce": "Allow once",
  "sidepanel.permission.allowOnce.desc":
    "Allow this time only; ask again next time",
  "sidepanel.permission.allowSession": "Allow this session",
  "sidepanel.permission.allowSession.desc":
    "Don't ask again for the rest of this chat",
  "sidepanel.permission.allowAlways": "Always allow",
  "sidepanel.permission.allowAlways.desc":
    "Remember this command; don't ask again",
  "sidepanel.permission.deny": "Deny",
  "sidepanel.permission.deny.desc": "Refuse; the agent receives an error",
  "sidepanel.permission.approvalNeeded": "Approval needed",
  "sidepanel.permission.allowedOnce": "Allowed once",
  "sidepanel.permission.allowedOnce.tooltip":
    "Approved for this execution only",
  "sidepanel.permission.allowedSession": "Allowed this session",
  "sidepanel.permission.allowedSession.tooltip":
    "Won't ask again for the rest of this session",
  "sidepanel.permission.allowedAlways": "Always allowed",
  "sidepanel.permission.allowedAlways.tooltip":
    "Added to the permanent allowlist (command_allowlist)",
  "sidepanel.permission.denied": "Denied",
  "sidepanel.permission.denied.tooltip": "User denied this command",
  "sidepanel.permission.expired": "Expired",
  "sidepanel.permission.expired.tooltip":
    "No response before gateway_timeout; the server auto-denied and unblocked",
  "sidepanel.permission.submitFailed": "Submit failed",
  "sidepanel.permission.submitFailed.tooltip":
    "POST /v1/runs/{runId}/approval request failed",
  "sidepanel.permission.waiting": "Waiting",
  "sidepanel.permission.chip.tool": "Tool: {tool}",
  "sidepanel.permission.chip.command": "Command: {command}",
  "sidepanel.permission.chip.reason": "Reason: {reason}",
  "sidepanel.permission.chip.requested": "Requested: {time}",
  "sidepanel.permission.chip.decided": "Decided: {time}",
  "sidepanel.permission.failedRecordStart": "Failed to start recording",
  "sidepanel.permission.failedRecordStop": "Failed to stop recording",
  "sidepanel.permission.dismissError": "Dismiss error",
  "sidepanel.attachment.uploading": "Uploading",
  "sidepanel.attachment.removeAria": "Remove {name}",
  "sidepanel.attachment.removePage": "Remove attached page",
  "sidepanel.attachment.autoFrom":
    "Auto-attached from {source}",
  "sidepanel.attachment.autoFrom.fallback": "current tab",
  "sidepanel.attachment.openInBrowser": "Open {name} in your browser",
  "sidepanel.attachment.remove": "Remove",
  "sidepanel.cors.reinstall": "Re-install the Origin-stripping rule",
  "sidepanel.cors.reset": "Reset CORS rule",
  "sidepanel.empty.title": "No conversation open",
  "sidepanel.empty.withHistory":
    "Start a new chat or pick one up from History.",
  "sidepanel.empty.firstChat": "Start your first chat with Hermes.",
  "sidepanel.empty.newChat": "New chat",
  "sidepanel.empty.openHistory": "Open from History",
  "sidepanel.empty.settings": "Settings",

  // Bridge status bar
  "sidepanel.status.connecting": "Connecting…",
  "sidepanel.status.online": "Online",
  "sidepanel.status.offline": "Offline",
  "sidepanel.status.bridgeUrl": "Bridge: {url}",
  "sidepanel.status.tooltip.online":
    "Hermes bridge is reachable. Click to open Gateway settings.",
  "sidepanel.status.tooltip.offline":
    "Hermes bridge is not reachable. Start `hermes-bridge` and check the Gateway URL.",
  "sidepanel.status.tooltip.connecting":
    "Connecting to the Hermes bridge…",
  "sidepanel.status.tooltipBase": "Hermes Browser Extension · {state}",
  "sidepanel.status.tooltip.agentRunning":
    "Agent window: #{windowId} · tab {tabId}",
  "sidepanel.status.tooltip.agentDown": "Agent window: not running",
  "sidepanel.status.tooltip.clickConnect": "Click to connect",
  "sidepanel.status.tooltip.clickDisconnect": "Click to disconnect",
  "sidepanel.status.aria.bar":
    "Hermes Browser Extension {label}. {action}.",
  "sidepanel.status.showAgentWindow": "Show agent window",
  "sidepanel.status.showAgentWindow.disabled":
    "Agent window not running — connect first",
  "sidepanel.status.dismiss": "Dismiss",

  // Navigate open policy toggle
  "sidepanel.navPolicy.label": "Open links",
  "sidepanel.navPolicy.background": "In background tab",
  "sidepanel.navPolicy.foreground": "In foreground tab",
  "sidepanel.navPolicy.sameTab": "Replace current tab",
  "sidepanel.navPolicy.tooltip":
    "Where to open links the agent navigates to.",
  "sidepanel.navPolicy.listAria": "Navigate opens",
  "sidepanel.navPolicy.auto.label": "Auto",
  "sidepanel.navPolicy.auto.desc":
    "Model picks via open_in on each navigate; other tools follow the active run surface (updated by navigate + this menu when not Auto).",
  "sidepanel.navPolicy.agent.label": "Agent",
  "sidepanel.navPolicy.agent.desc":
    "Dedicated agent window — all browser tools and in-place navigations.",
  "sidepanel.navPolicy.userNewTab.label": "New tab",
  "sidepanel.navPolicy.userNewTab.desc":
    "Your Chrome window — each navigate opens a new tab; other tools follow that tab.",
  "sidepanel.navPolicy.userSameTab.label": "Same tab",
  "sidepanel.navPolicy.userSameTab.desc":
    "Your Chrome window — navigations and tools use the current tab.",

  // Session drawer
  "sidepanel.sessions.title": "History",
  "sidepanel.sessions.empty": "No sessions yet. Send a message to start one.",
  "sidepanel.sessions.dialogAria": "Session history",
  "sidepanel.sessions.close": "Close",
  "sidepanel.sessions.openAsTab": "Open as tab",
  "sidepanel.sessions.rename": "Rename",
  "sidepanel.sessions.deletePermanently": "Delete permanently",
  "sidepanel.sessions.save": "Save",
  "sidepanel.sessions.cancel": "Cancel",
  "sidepanel.sessions.newChatTitle": "New chat",
  "sidepanel.sessions.deleteConfirm":
    "Permanently delete \"{title}\"? This drops the session and its messages from History — closing the tab from the top bar would have just hidden it.",
  "sidepanel.sessions.group.pinned": "Pinned",
  "sidepanel.sessions.group.today": "Today",
  "sidepanel.sessions.group.yesterday": "Yesterday",
  "sidepanel.sessions.group.earlierWeek": "Earlier this week",
  "sidepanel.sessions.group.thisMonth": "This month",
  "sidepanel.sessions.group.older": "Older",

  // New tab
  "newtab.greeting": "What can I help with?",
  "newtab.subtitle":
    "Look something up, read a page, handle Feishu, run a script — just tell me what you need.",
  "newtab.placeholder": "Message Hermes…",
  "newtab.send": "Send",
  "newtab.send.tooltip": "Send (Enter)",
  "newtab.refresh": "Refresh",
  "newtab.openOptions": "Open Hermes options",
  "newtab.history": "History",
  "newtab.latest": "Latest",
  "newtab.recentChats": "Recent chats",
  "newtab.clickToResume": "Click to resume",
  "newtab.row.failed": "— failed",
  "newtab.row.silent": "— nothing new",
  "newtab.row.msgs": "{count} msgs",
  "newtab.content.empty": "No cron run output yet.",
  "newtab.content.empty.row": "No output recorded for this run.",
  "newtab.content.truncated":
    "Output file exceeded the bridge's in-memory cap — only the head of the run is shown above.",
  "newtab.continueInChat": "Continue in chat",
  "newtab.continueInChat.prompt":
    "Below is the output from cron job \"{name}\" at {time}. Help me read it: what's worth handling right away, what can wait, and is there anything I need to follow up on?\n\n---\n\n{content}",
  "newtab.empty.installed": "Routine enabled",
  "newtab.empty.headline": "Get Hermes working for you",
  "newtab.empty.installedDesc":
    "It'll show up here after its next run. Add more, or wait for the first output.",
  "newtab.empty.headlineDesc":
    "Pick a routine — Hermes runs it on a schedule and the output lands here.",
  "newtab.empty.customCron": "Set up a custom cron job →",
  "newtab.install.failed": "Failed to install",
  "newtab.disabled.headline": "Hermes new tab is off",
  "newtab.disabled.message":
    "Enable it in Hermes options, or set a fallback URL to redirect new tabs elsewhere.",
  "newtab.redirecting.headline": "Redirecting…",
  "newtab.redirecting.message": "Opening {url}",
  "newtab.relative.justNow": "just now",
  "newtab.relative.mAgo": "{n}m ago",
  "newtab.relative.hAgo": "{n}h ago",
  "newtab.relative.dAgo": "{n}d ago",

  // Chat tab
  "chat.title": "Hermes chat",
  "chat.newChat": "Start a new chat",
  "chat.placeholder": "Send a message…",
  "chat.openOptions": "Open Hermes options",
  "chat.searchPlaceholder": "Search sessions…",
  "chat.searchClear": "Clear search",
  "chat.untitled": "Untitled chat",
  "chat.rename": "Rename",
  "chat.delete": "Delete",
  "chat.width.label": "Message column width",
  "chat.width.narrow": "Narrow",
  "chat.width.narrow.tooltip": "Narrow message column (same as input)",
  "chat.width.medium": "Medium",
  "chat.width.medium.tooltip": "Medium message column",
  "chat.width.full": "Full",
  "chat.width.full.tooltip": "Full-width messages",
  "chat.group.today": "Today",
  "chat.group.yesterday": "Yesterday",
  "chat.group.older": "Older",
  "chat.loadingSessions": "Loading sessions…",
  "chat.noMatches": "No matches.",
  "chat.noSessions": "No saved sessions yet.",
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;
