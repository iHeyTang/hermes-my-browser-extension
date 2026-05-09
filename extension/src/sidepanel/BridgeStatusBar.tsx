/**
 * Bridge status bar — single source of truth for steady-state status
 * above the composer.
 *
 * Carries three things in a single compact row:
 *
 *   - Connection pill (left): colour-coded dot + label (Online /
 *     Connecting… / Offline). Click toggles connect ↔ disconnect.
 *     Tooltip exposes the bridge URL and agent-window details.
 *   - Status messages (centre): pill-shaped chips describing
 *     transient warnings/info (e.g. failed page capture, attachment
 *     upload error). The parent owns the message list and pushes
 *     them in via `messages`; each carries its own dismiss handler.
 *     This is where any new "side panel needs to tell the user
 *     something" entry should land — we deliberately don't sprinkle
 *     additional banner rows around the composer any more.
 *   - Action buttons (right): show agent window + open settings.
 *
 * The bar is always visible — unlike the busy-only run-status cluster
 * inlined into the composer's bottom row, this one's job is steady-state
 * telemetry. It refreshes on `hermes:status-changed` broadcasts from the
 * SW plus a slow polling loop as a safety net for missed messages after
 * the SW restarts.
 */

import { AppWindow, Settings as SettingsIcon, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~components/ui/button";
import type { ConnectionState } from "~lib/types";
import { cn } from "~lib/utils";

interface StatusResponse {
  state?: ConnectionState;
  agentAlive?: boolean;
  agentWindowId?: number | null;
  agentTabId?: number | null;
  url?: string | null;
}

export type BridgeStatusLevel = "info" | "warning" | "error";

export interface BridgeStatusMessage {
  /** Stable id used as React key and for dedup at the call site. */
  id: string;
  /** Visual + a11y level. Defaults to `warning`. */
  level?: BridgeStatusLevel;
  /** One-line description shown in the chip; full text lands in `title`. */
  text: string;
  /** When provided, the chip renders an × button that calls this. */
  onDismiss?: () => void;
}

interface BridgeStatusBarProps {
  /**
   * Active status chips to surface inline. The parent component owns
   * the queue; we render in order. Empty / undefined hides the
   * messages region entirely.
   */
  messages?: BridgeStatusMessage[];
}

export function BridgeStatusBar({ messages }: BridgeStatusBarProps = {}) {
  const [resp, setResp] = useState<StatusResponse>({ state: "disconnected" });
  const [busy, setBusy] = useState(false);

  async function refreshStatus() {
    try {
      const r = (await chrome.runtime.sendMessage({
        action: "status",
      })) as StatusResponse;
      setResp(r || { state: "disconnected" });
    } catch {
      setResp({ state: "disconnected" });
    }
  }

  useEffect(() => {
    void refreshStatus();
    const onMsg = (msg: { type?: string }) => {
      if (msg?.type === "hermes:status-changed") {
        void refreshStatus();
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    // Slow polling loop is a safety net for missed broadcasts (e.g. SW
    // restart races). 5s is much less aggressive than the popup's 1.5s
    // because the side panel is long-lived and broadcasts cover the
    // common case.
    const t = setInterval(() => void refreshStatus(), 5000);
    return () => {
      clearInterval(t);
      chrome.runtime.onMessage.removeListener(onMsg);
    };
  }, []);

  const state = resp.state || "disconnected";
  const online = state === "connected";
  const connecting = state === "connecting";

  async function send(action: string) {
    setBusy(true);
    try {
      await chrome.runtime.sendMessage({ action });
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  }

  function toggleConnect() {
    if (busy) return;
    // In the "connecting" state we still want a click to back out — the
    // user might have second-guessed themselves while the WS handshake
    // dragged on. Map (online | connecting) → disconnect, offline →
    // connect.
    void send(online || connecting ? "disconnect" : "connect");
  }

  function showAgentWindow() {
    if (busy || !resp.agentAlive) return;
    void send("show");
  }

  const dotClass = connecting
    ? "bg-[hsl(var(--warning))] shadow-[0_0_8px_hsl(var(--warning))] animate-pulse"
    : online
      ? "bg-[hsl(var(--success))] shadow-[0_0_8px_hsl(var(--success))]"
      : "bg-muted-foreground";

  const label = connecting ? "Connecting…" : online ? "Online" : "Offline";

  // Aggregated tooltip carries the bits we used to show in the popup's
  // Bridge card. Keeping them in `title` avoids dedicating a second row
  // of pixels to information that's only occasionally interesting.
  const tooltipLines = [
    `Hermes Browser Extension · ${state}`,
    resp.agentAlive
      ? `Agent window: #${resp.agentWindowId} · tab ${resp.agentTabId}`
      : "Agent window: not running",
  ];
  if (resp.url) tooltipLines.push(resp.url);
  tooltipLines.push("");
  tooltipLines.push(
    online || connecting ? "Click to disconnect" : "Click to connect",
  );
  const tooltip = tooltipLines.join("\n");

  const activeMessages = (messages ?? []).filter((m) => !!m.text);

  return (
    <div className="mb-1 flex items-center gap-1">
      <button
        type="button"
        onClick={toggleConnect}
        disabled={busy}
        title={tooltip}
        aria-label={`Hermes Browser Extension ${label}. ${online || connecting ? "Click to disconnect" : "Click to connect"}.`}
        className={cn(
          "inline-flex h-6 shrink-0 select-none items-center gap-1.5 rounded-full border pl-2 pr-2.5 text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          online
            ? "border-[hsl(var(--success))]/40 bg-[hsl(var(--success))]/10 text-foreground hover:bg-[hsl(var(--success))]/15"
            : connecting
              ? "border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/10 text-foreground hover:bg-[hsl(var(--warning))]/15"
              : "border-border bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground",
          busy && "cursor-wait opacity-70",
        )}
      >
        <span
          aria-hidden
          className={cn("inline-block h-2 w-2 rounded-full", dotClass)}
        />
        <span>{label}</span>
      </button>

      {/*
        Status messages live in a flex-1 strip between the connection
        pill and the action icons. `min-w-0` is critical so children
        with `truncate` actually clip instead of pushing the actions
        off-screen. Multiple chips can share the row; each truncates
        independently and exposes its full text via `title`.
      */}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
        {activeMessages.map((m) => (
          <StatusChip key={m.id} message={m} />
        ))}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 [&_svg]:size-3.5"
          onClick={showAgentWindow}
          disabled={busy || !resp.agentAlive}
          title={
            resp.agentAlive
              ? "Show agent window"
              : "Agent window not running — connect first"
          }
          aria-label="Show agent window"
        >
          <AppWindow />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 [&_svg]:size-3.5"
          onClick={() => chrome.runtime.openOptionsPage()}
          title="Settings · Userscripts"
          aria-label="Open settings"
        >
          <SettingsIcon />
        </Button>
      </div>
    </div>
  );
}

function StatusChip({ message }: { message: BridgeStatusMessage }) {
  const level: BridgeStatusLevel = message.level ?? "warning";
  const styles =
    level === "error"
      ? "border-destructive/40 bg-destructive/10 text-foreground"
      : level === "info"
        ? "border-border bg-muted/40 text-muted-foreground"
        : "border-warning/40 bg-warning/10 text-foreground";
  // Compress newline-heavy messages (e.g. multi-file attachment errors)
  // into a single first-line preview for the chip; the full text stays
  // available via the tooltip.
  const preview = message.text.split("\n")[0] || message.text;

  return (
    <div
      role="status"
      aria-live="polite"
      title={message.text}
      className={cn(
        "inline-flex h-6 max-w-full min-w-0 shrink items-center gap-1 rounded-full border pl-1.5 pr-1 text-[11px]",
        styles,
      )}
    >
      <span aria-hidden className="text-[11px] leading-none">
        ⚠
      </span>
      <span className="min-w-0 truncate">{preview}</span>
      {message.onDismiss && (
        <button
          type="button"
          onClick={message.onDismiss}
          title="Dismiss"
          aria-label="Dismiss"
          className="ml-0.5 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </div>
  );
}
