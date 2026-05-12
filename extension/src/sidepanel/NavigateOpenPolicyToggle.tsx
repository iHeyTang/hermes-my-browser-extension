/**
 * Where browser automation runs: `my_browser_navigate` plus all other
 * `my_browser_*` tools (when not Auto, the choice overrides the model).
 */

import { Bot, MousePointerClick, PlusSquare, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { NavigateOpenPolicy } from "~lib/types";
import { cn } from "~lib/utils";

interface NavigateOpenPolicyToggleProps {
  policy: NavigateOpenPolicy;
  onChange: (next: NavigateOpenPolicy) => void;
}

interface PolicyMeta {
  value: NavigateOpenPolicy;
  label: string;
  description: string;
  Icon: typeof Sparkles;
}

const POLICIES: PolicyMeta[] = [
  {
    value: "auto",
    label: "Auto",
    description:
      "Model picks via open_in on each navigate; other tools follow the active run surface (updated by navigate + this menu when not Auto).",
    Icon: Sparkles,
  },
  {
    value: "agent",
    label: "Agent",
    description:
      "Dedicated agent window — all browser tools and in-place navigations.",
    Icon: Bot,
  },
  {
    value: "user_new_tab",
    label: "New tab",
    description:
      "Your Chrome window — each navigate opens a new tab; other tools follow that tab.",
    Icon: PlusSquare,
  },
  {
    value: "user_same_tab",
    label: "Same tab",
    description:
      "Your Chrome window — navigations and tools use the current tab.",
    Icon: MousePointerClick,
  },
];

export function NavigateOpenPolicyToggle({
  policy,
  onChange,
}: NavigateOpenPolicyToggleProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const current = POLICIES.find((p) => p.value === policy) ?? POLICIES[0];

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
        onClick={() => setOpen((v) => !v)}
        title={current.description}
        className={cn(
          "inline-flex h-6 select-none items-center gap-1 rounded-full border pl-2 pr-2 text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          policy === "auto"
            ? "border-border bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            : "border-amber-600/50 bg-amber-500/15 text-amber-950 dark:text-amber-100 hover:bg-amber-500/25",
        )}
      >
        <Icon className="h-3 w-3" />
        <span>{current.label}</span>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Navigate opens"
          className="absolute bottom-7 left-0 z-30 w-60 overflow-hidden rounded-md border border-border bg-background text-foreground shadow-md"
        >
          {POLICIES.map((p) => {
            const ItemIcon = p.Icon;
            const active = p.value === policy;
            return (
              <button
                key={p.value}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(p.value);
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
                    {p.label}
                  </div>
                  <div className="mt-0.5 leading-snug text-muted-foreground">
                    {p.description}
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
