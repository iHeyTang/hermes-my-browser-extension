/**
 * Two-state toggle that selects where the agent's browser-control tool
 * calls land: the dedicated agent window (default) or the user's own
 * tab. Rendered as a pill that pops a small menu on click. We chose a
 * popover over a one-click cycling button because the consequence of
 * "switch to My tab" — handing the agent the keys to the user's actual
 * page — deserves an explicit pick rather than something a stray click
 * could land on.
 *
 * The component is purely presentational. The parent owns the mode
 * value and persists / pushes it to the SW; this component just
 * surfaces it and emits onChange.
 */

import { Bot, MousePointerClick } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { RunTarget } from "~lib/types";
import { cn } from "~lib/utils";

interface RunModeToggleProps {
  mode: RunTarget;
  onChange: (next: RunTarget) => void;
  /** When true the popover is suppressed (e.g. while the agent is
   * streaming) — switching modes mid-turn is allowed via the status
   * bar's explicit "Move to my tab" button, but not via the composer
   * pill, since the agent's already started using the previous mode. */
  disabled?: boolean;
}

interface ModeMeta {
  value: RunTarget;
  label: string;
  description: string;
  Icon: typeof Bot;
}

const MODES: ModeMeta[] = [
  {
    value: "agent",
    label: "Background",
    description:
      "Run in the dedicated agent window. Your own tabs are never touched.",
    Icon: Bot,
  },
  {
    value: "user",
    label: "My tab",
    description:
      "Drive the tab you're on right now. Captured at send time so flipping tabs after won't redirect the agent.",
    Icon: MousePointerClick,
  },
];

export function RunModeToggle({
  mode,
  onChange,
  disabled,
}: RunModeToggleProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const current = MODES.find((m) => m.value === mode) ?? MODES[0];

  // Click-outside / escape close the popover. We don't trap focus —
  // tabbing out is just as valid a "close" gesture as clicking the
  // backdrop.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (wrapperRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const Icon = current.Icon;

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        title={current.description}
        className={cn(
          "inline-flex h-6 select-none items-center gap-1 rounded-full border pl-2 pr-2 text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          mode === "agent"
            ? "border-border bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            : "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
          disabled && "cursor-not-allowed opacity-50",
        )}
      >
        <Icon className="h-3 w-3" />
        <span>{current.label}</span>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Run mode"
          // Pop UP from the composer (the side panel scrolls up to its
          // own top, so menus sliding above the pill stay in view; a
          // downward menu would clip below the panel edge).
          //
          // We use `bg-background` + `text-foreground` rather than the
          // shadcn-default `bg-popover` because this project's
          // tailwind.config.js doesn't register a `popover` colour
          // token — `--popover` is defined in CSS but invisible to
          // Tailwind, so `bg-popover` quietly produces no rule and the
          // menu reads as transparent. Sticking to `background` keeps
          // us in lock-step with SessionDrawer / TabBar.
          className="absolute bottom-7 left-0 z-30 w-56 overflow-hidden rounded-md border border-border bg-background text-foreground shadow-md"
        >
          {MODES.map((m) => {
            const ItemIcon = m.Icon;
            const active = m.value === mode;
            return (
              <button
                key={m.value}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(m.value);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-start gap-2 px-2.5 py-2 text-left text-[11px] transition-colors hover:bg-accent hover:text-accent-foreground",
                  active && "bg-accent/60 text-accent-foreground",
                )}
              >
                <ItemIcon className="mt-0.5 h-3 w-3 shrink-0" />
                <div className="flex-1">
                  <div className="text-[12px] font-medium leading-tight">
                    {m.label}
                  </div>
                  <div className="mt-0.5 leading-snug text-muted-foreground">
                    {m.description}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
