/**
 * Strip the `Origin` request header from requests that the side-panel
 * chat client makes to the local Hermes gateway HTTP API.
 *
 * Why: `gateway/platforms/api_server.py` enforces an allowlist-based CORS
 * gate (`_origin_allowed()`).  When the `Origin` header is absent it treats
 * the caller as a non-browser client and accepts the request; when the
 * header is `chrome-extension://<id>` it returns 403 unless the user has
 * explicitly added the extension origin to `API_SERVER_CORS_ORIGINS`.
 *
 * The browser sets `Origin` automatically for cross-origin fetches from
 * extension pages, so we use a `declarativeNetRequestWithHostAccess`
 * `modifyHeaders` rule to strip it before the request leaves the browser.
 * The rule is scoped by URL filter to the configured Hermes API host so it
 * never affects unrelated traffic.
 *
 * The rule is reinstalled whenever the user changes `settings.chat.apiBase`
 * in the options page or side panel, so a custom Hermes deployment is
 * supported without any further config.
 */

import { DEFAULT_HERMES_API_BASE } from "./config";

// Reserve a dedicated session-rule ID. Session rules survive SW restarts
// within a browser session (cleared on browser shutdown), which matches the
// lifetime of any settings stored in `chrome.storage.local`.
const RULE_ID_STRIP_ORIGIN = 9001;

const STORAGE_KEY_API_BASE = "settings.chat.apiBase";

/**
 * Install (or replace) the Origin-stripping DNR rule based on the
 * currently-configured Hermes API base URL.  Idempotent.
 */
export async function refreshChatCorsRule(): Promise<void> {
  if (!chrome.declarativeNetRequest?.updateSessionRules) {
    console.warn(
      "[hermes-bridge] declarativeNetRequest API unavailable — skipping " +
        "chat CORS workaround. Add API_SERVER_CORS_ORIGINS=* to " +
        "~/.hermes/.env (server-side fix) if 403s persist.",
    );
    return;
  }

  const apiBase = await readApiBase();
  const host = parseHost(apiBase);
  if (!host) {
    console.warn(
      "[hermes-bridge] Cannot derive host from chat apiBase:",
      apiBase,
    );
    return;
  }

  // urlFilter caveats:
  //   - `||host/` is a *domain anchor* and only works when the text is
  //     treated as a real domain. Hostnames like `127.0.0.1:8642`
  //     contain a port + numeric octets and are NOT valid domains, so the
  //     rule silently never matches. (This is the bug v0.3.1 shipped with.)
  //   - `urlFilter` accepts plain text as a *substring* match, so we drop
  //     the `||` anchor and just match the host:port literally. This works
  //     for every host form (IPv4 + port, hostname, hostname + port).
  // We anchor with a leading `://` to be safer against false positives.
  const filter = host.includes(":") ? `://${host}/` : `://${host}/`;

  const rule: chrome.declarativeNetRequest.Rule = {
    id: RULE_ID_STRIP_ORIGIN,
    priority: 1,
    action: {
      type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: [
        {
          header: "origin",
          operation:
            "remove" as chrome.declarativeNetRequest.HeaderOperation,
        },
      ],
    },
    condition: {
      urlFilter: filter,
      resourceTypes: [
        "xmlhttprequest" as chrome.declarativeNetRequest.ResourceType,
      ],
    },
  };

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [RULE_ID_STRIP_ORIGIN],
      addRules: [rule],
    });
    // Verify the rule actually landed — updateSessionRules silently
    // "succeeds" on schema-valid but ineffective rules in some Chrome
    // versions, so we explicitly read it back.
    const installed = await chrome.declarativeNetRequest.getSessionRules();
    const ours = installed.find((r) => r.id === RULE_ID_STRIP_ORIGIN);
    if (!ours) {
      console.warn(
        "[hermes-bridge] DNR rule install reported success but no rule " +
          "with id " +
          RULE_ID_STRIP_ORIGIN +
          " is present. CORS stripping will not work.",
      );
      return;
    }
    console.log(
      "[hermes-bridge] Origin-strip DNR rule active for host=" +
        host +
        " urlFilter=" +
        filter,
    );
  } catch (e) {
    console.error(
      "[hermes-bridge] Failed to install Origin-strip DNR rule:",
      e,
    );
  }
}

/**
 * Lightweight introspection helper used by the side panel to render a
 * "CORS workaround active" badge.  Returns true iff the rule is present
 * for the currently-configured Hermes host.
 */
export async function isChatCorsRuleActive(): Promise<boolean> {
  if (!chrome.declarativeNetRequest?.getSessionRules) return false;
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    return rules.some((r) => r.id === RULE_ID_STRIP_ORIGIN);
  } catch {
    return false;
  }
}

async function readApiBase(): Promise<string> {
  try {
    const r = await chrome.storage.local.get(STORAGE_KEY_API_BASE);
    const v = r[STORAGE_KEY_API_BASE];
    if (typeof v === "string" && v.trim()) return v.trim();
  } catch {
    // fall through
  }
  return DEFAULT_HERMES_API_BASE;
}

function parseHost(base: string): string | null {
  try {
    return new URL(base).host || null;
  } catch {
    return null;
  }
}

/**
 * Watch `chrome.storage.local` for changes to `settings.chat.apiBase` and
 * reinstall the rule whenever the user points the extension at a different
 * Hermes endpoint.
 */
export function registerChatCorsListeners(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && STORAGE_KEY_API_BASE in changes) {
      void refreshChatCorsRule();
    }
  });
}
