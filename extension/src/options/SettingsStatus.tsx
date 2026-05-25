/**
 * Status & lifecycle tab — runtime snapshot + the two long-running ops
 * (restart gateway / self-upgrade) mirrored from upstream's Status page.
 *
 * Layout follows SettingsGateway: plain ``<section>`` chunks, no cards.
 * Actions fire-and-poll: POST starts a detached subprocess, then we
 * tail-poll ``GET /hermes/actions/<name>/status`` until ``running=false``.
 */

import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "~components/ui/badge";
import { Button } from "~components/ui/button";
import { Separator } from "~components/ui/separator";
import {
  type ActionStatusResponse,
  type HermesStatusResponse,
  type LifecycleActionName,
  getActionStatus,
  getHermesStatus,
  restartHermesGateway,
  updateHermes,
} from "~lib/hermes-lifecycle";

const STATUS_POLL_MS = 10_000;
const ACTION_POLL_MS = 1_000;

interface ActionRunState {
  running: boolean;
  exitCode: number | null;
  pid: number | null;
  lines: string[];
  error: string | null;
}

const INITIAL_ACTION: ActionRunState = {
  running: false,
  exitCode: null,
  pid: null,
  lines: [],
  error: null,
};

function fmtTimestamp(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toLocaleString();
  }
  if (typeof value === "string" && value) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return new Date(n * 1000).toLocaleString();
    return value;
  }
  return "—";
}

function Field({
  label,
  children,
  mono,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-3 text-xs">
      <span className="w-32 shrink-0 text-muted-foreground">{label}</span>
      <span className={`min-w-0 break-all ${mono ? "font-mono" : ""}`}>
        {children}
      </span>
    </div>
  );
}

function UpdateHint({ status }: { status: HermesStatusResponse | null }) {
  const u = status?.update_check;
  if (!u || u.status === "unknown") return null;
  if (u.status === "up_to_date") {
    return (
      <span className="text-[11px] text-muted-foreground">
        already on latest
      </span>
    );
  }
  if (u.status === "behind") {
    const n = u.commits_behind;
    return (
      <span className="text-[11px] text-amber-600 dark:text-amber-400">
        {typeof n === "number" && n > 0
          ? `behind ${n} commit${n === 1 ? "" : "s"}`
          : "update available"}
      </span>
    );
  }
  return null;
}

function ActionLog({
  actionName,
  state,
}: {
  actionName: LifecycleActionName;
  state: ActionRunState;
}) {
  if (state.lines.length === 0 && !state.error) return null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="font-mono">{actionName}</span>
        {state.running && (
          <Badge variant="outline" className="gap-1 text-[10px]">
            <Loader2 className="h-3 w-3 animate-spin" />
            pid {state.pid ?? "?"}
          </Badge>
        )}
        {!state.running && state.exitCode != null && (
          <Badge
            variant={state.exitCode === 0 ? "default" : "destructive"}
            className="text-[10px]"
          >
            exit {state.exitCode}
          </Badge>
        )}
        {state.error && (
          <span className="text-destructive">{state.error}</span>
        )}
      </div>
      {state.lines.length > 0 && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-[10px] leading-relaxed">
          {state.lines.join("\n")}
        </pre>
      )}
    </div>
  );
}

export function SettingsStatus() {
  const [status, setStatus] = useState<HermesStatusResponse | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  const [gwState, setGwState] = useState<ActionRunState>(INITIAL_ACTION);
  const [updState, setUpdState] = useState<ActionRunState>(INITIAL_ACTION);
  const [triggering, setTriggering] = useState<{ gw: boolean; upd: boolean }>({
    gw: false,
    upd: false,
  });

  const gwAbort = useRef<AbortController | null>(null);
  const updAbort = useRef<AbortController | null>(null);

  const refreshStatus = useCallback(async () => {
    setStatusLoading(true);
    const r = await getHermesStatus();
    if (!r.ok) {
      setStatusErr(r.error || "unknown error");
    } else {
      setStatusErr(null);
      setStatus(r);
    }
    setStatusLoading(false);
  }, []);

  useEffect(() => {
    refreshStatus();
    const id = window.setInterval(refreshStatus, STATUS_POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshStatus]);

  const pollAction = useCallback(
    async (
      name: LifecycleActionName,
      setState: React.Dispatch<React.SetStateAction<ActionRunState>>,
      abortRef: React.MutableRefObject<AbortController | null>,
    ) => {
      const ctrl = new AbortController();
      abortRef.current?.abort();
      abortRef.current = ctrl;

      while (!ctrl.signal.aborted) {
        const r: ActionStatusResponse = await getActionStatus(
          name,
          200,
          ctrl.signal,
        );
        if (ctrl.signal.aborted) return;
        if (!r.ok) {
          setState((prev) => ({ ...prev, error: r.error || "poll failed" }));
          break;
        }
        setState({
          running: !!r.running,
          exitCode: r.exit_code ?? null,
          pid: r.pid ?? null,
          lines: r.lines ?? [],
          error: null,
        });
        if (!r.running) {
          void refreshStatus();
          break;
        }
        await new Promise<void>((res) =>
          window.setTimeout(res, ACTION_POLL_MS),
        );
      }
    },
    [refreshStatus],
  );

  useEffect(() => {
    void pollAction("gateway-restart", setGwState, gwAbort);
    void pollAction("hermes-update", setUpdState, updAbort);
    return () => {
      gwAbort.current?.abort();
      updAbort.current?.abort();
    };
  }, [pollAction]);

  const triggerGateway = useCallback(async () => {
    setTriggering((t) => ({ ...t, gw: true }));
    const r = await restartHermesGateway();
    setTriggering((t) => ({ ...t, gw: false }));
    if (!r.ok) {
      setGwState((s) => ({ ...s, error: r.error || "spawn failed" }));
      return;
    }
    setGwState({
      running: true,
      exitCode: null,
      pid: r.pid ?? null,
      lines: [],
      error: null,
    });
    void pollAction("gateway-restart", setGwState, gwAbort);
  }, [pollAction]);

  const triggerUpdate = useCallback(async () => {
    setTriggering((t) => ({ ...t, upd: true }));
    const r = await updateHermes();
    setTriggering((t) => ({ ...t, upd: false }));
    if (!r.ok) {
      setUpdState((s) => ({ ...s, error: r.error || "spawn failed" }));
      return;
    }
    setUpdState({
      running: true,
      exitCode: null,
      pid: r.pid ?? null,
      lines: [],
      error: null,
    });
    void pollAction("hermes-update", setUpdState, updAbort);
  }, [pollAction]);

  const versionMismatch =
    status?.config_version != null &&
    status?.latest_config_version != null &&
    status.config_version !== status.latest_config_version;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-muted/20 px-4">
        <div className="flex min-w-0 flex-col justify-center gap-0.5 leading-tight">
          <h2 className="text-sm font-semibold tracking-tight">Status</h2>
          <p className="truncate text-[11px] text-muted-foreground">
            Runtime snapshot + lifecycle actions
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={refreshStatus}
          disabled={statusLoading}
        >
          {statusLoading ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="mr-1 h-3 w-3" />
          )}
          Refresh
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="space-y-10">
          {statusErr && (
            <p className="text-xs text-destructive">{statusErr}</p>
          )}
          {!statusErr && !status && (
            <p className="text-xs text-muted-foreground">Loading…</p>
          )}

          {status && (
            <>
              <section className="space-y-3">
                <h3 className="text-sm font-medium text-foreground">Runtime</h3>
                <div className="space-y-1.5">
                  <Field label="Version">
                    {status.version || "—"}
                    {status.release_date ? (
                      <span className="ml-2 text-muted-foreground">
                        ({status.release_date})
                      </span>
                    ) : null}
                  </Field>
                  <Field label="Hermes home" mono>
                    {status.hermes_home || "—"}
                  </Field>
                  <Field label="Config path" mono>
                    {status.config_path || "—"}
                  </Field>
                  <Field label="Env path" mono>
                    {status.env_path || "—"}
                  </Field>
                  <Field label="Config version">
                    {status.config_version ?? "—"}
                    {status.latest_config_version != null && (
                      <span
                        className={`ml-2 text-[10px] ${
                          versionMismatch
                            ? "text-amber-600"
                            : "text-muted-foreground"
                        }`}
                      >
                        (latest {status.latest_config_version}
                        {versionMismatch ? ", upgrade needed" : ""})
                      </span>
                    )}
                  </Field>
                  <Field label="Active sessions">
                    {status.active_sessions ?? 0}
                  </Field>
                </div>
              </section>

              <Separator />

              <section className="space-y-3">
                <h3 className="text-sm font-medium text-foreground">Gateway</h3>
                <div className="space-y-1.5">
                  <Field label="Running">
                    <Badge
                      variant={status.gateway_running ? "default" : "secondary"}
                      className="text-[10px]"
                    >
                      {status.gateway_running ? "yes" : "no"}
                    </Badge>
                  </Field>
                  <Field label="PID">{status.gateway_pid ?? "—"}</Field>
                  <Field label="State">{status.gateway_state ?? "—"}</Field>
                  <Field label="Platforms">
                    {(() => {
                      const names = Object.keys(status.gateway_platforms ?? {});
                      if (!names.length) {
                        return (
                          <span className="text-muted-foreground">none</span>
                        );
                      }
                      return (
                        <span className="flex flex-wrap gap-1">
                          {names.map((n) => (
                            <Badge
                              key={n}
                              variant="secondary"
                              className="text-[10px]"
                            >
                              {n}
                            </Badge>
                          ))}
                        </span>
                      );
                    })()}
                  </Field>
                  {status.gateway_exit_reason && (
                    <Field label="Last exit">
                      {status.gateway_exit_reason}
                    </Field>
                  )}
                  {status.gateway_updated_at != null && (
                    <Field label="State updated">
                      {fmtTimestamp(status.gateway_updated_at)}
                    </Field>
                  )}
                </div>
              </section>

              <Separator />
            </>
          )}

          <section className="space-y-3">
            <h3 className="text-sm font-medium text-foreground">Actions</h3>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                onClick={triggerGateway}
                disabled={gwState.running || triggering.gw}
              >
                {(gwState.running || triggering.gw) && (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                )}
                Restart gateway
              </Button>
              <Button
                size="sm"
                variant={
                  status?.update_check?.status === "behind"
                    ? "default"
                    : "outline"
                }
                onClick={triggerUpdate}
                disabled={updState.running || triggering.upd}
              >
                {(updState.running || triggering.upd) && (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                )}
                Update Hermes
              </Button>
              <UpdateHint status={status} />
            </div>
            <ActionLog actionName="gateway-restart" state={gwState} />
            <ActionLog actionName="hermes-update" state={updState} />
          </section>
        </div>
      </div>
    </div>
  );
}
