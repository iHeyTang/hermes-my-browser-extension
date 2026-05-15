import { History, Plus, Settings as SettingsIcon, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~components/ui/button";
import { useT } from "~lib/i18n";
import type { SessionMeta } from "~lib/sessions/types";
import { cn } from "~lib/utils";

interface Props {
  tabs: SessionMeta[];
  activeId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /**
   * Bulk close (Close others / Close to the right / Close all) from the
   * tab right-click menu. Atomic at the parent so the active-tab fallback
   * lands on a single neighbour rather than cascading through one removal
   * per id.
   */
  onCloseMany: (ids: string[]) => void;
  onNew: () => void;
  onOpenHistory: () => void;
  onOpenSettings: () => void;
}

interface MenuState {
  /** Viewport coords of the right-click. */
  x: number;
  y: number;
  /** The tab the menu was opened on. */
  sessionId: string;
}

/**
 * Cursor-style tab bar:
 *   - Horizontal scrollable strip of tabs (one per open session).
 *   - Bar sits on a tinted background so it visually separates from the
 *     chat surface below without needing a bottom border. The active tab
 *     uses `bg-background`, matching the panel and "merging" into it.
 *   - Per-tab `×` closes the tab without deleting the session.
 *   - Right of the strip: New / History / Settings buttons.
 *
 * Tab order is determined by the parent (`openTabIds`); we don't reorder
 * here. Drag-to-reorder is a follow-up; for now new tabs go to the right.
 */
export function TabBar({
  tabs,
  activeId,
  onActivate,
  onClose,
  onCloseMany,
  onNew,
  onOpenHistory,
  onOpenSettings,
}: Props) {
  const { t } = useT();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

  // Close the context menu whenever the open-tabs set changes (e.g. the
  // very action just executed by the menu) so it doesn't linger over the
  // wrong tab. Comparing by id list is enough — order changes here would
  // also invalidate the menu's reference index.
  useEffect(() => {
    setMenu((m) => {
      if (!m) return m;
      return tabs.some((t) => t.id === m.sessionId) ? m : null;
    });
  }, [tabs]);

  // Auto-scroll the active tab into view when it changes (e.g. after
  // opening a session from History whose tab is off-screen to the right).
  useEffect(() => {
    if (!activeId || !scrollerRef.current) return;
    const el = scrollerRef.current.querySelector<HTMLElement>(
      `[data-session-id="${CSS.escape(activeId)}"]`,
    );
    el?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeId]);

  // Cursor-style: a vertical mouse-wheel tick over the tab strip should pan
  // it horizontally. We attach the listener manually because React binds
  // `onWheel` as a passive listener at the root, which would silently drop
  // any `preventDefault()` and let the wheel bubble back to the page.
  // Trackpad horizontal pans (`deltaX !== 0`) and Shift+wheel keep their
  // native meaning so muscle memory still works.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      if (e.shiftKey) return;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      e.preventDefault();
      el.scrollLeft = Math.max(0, Math.min(max, el.scrollLeft + e.deltaY));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const ids = tabs.map((t) => t.id);
  const menuIndex = menu ? ids.indexOf(menu.sessionId) : -1;
  const idsToTheRight = menuIndex >= 0 ? ids.slice(menuIndex + 1) : [];
  const idsExceptMenu =
    menuIndex >= 0 ? ids.filter((id) => id !== menu!.sessionId) : [];

  return (
    <>
      <header className="flex h-7 shrink-0 items-stretch bg-muted/60">
        <div
          ref={scrollerRef}
          className="tabbar-scroller flex h-full min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden"
        >
          {tabs.length === 0 ? (
            <div className="flex flex-1 items-center px-3 text-xs italic text-muted-foreground">
              {t("sidepanel.tabbar.empty.before")}{" "}
              <Plus className="mx-1 inline h-3 w-3" />
              {t("sidepanel.tabbar.empty.after")}
            </div>
          ) : (
            tabs.map((tab) => (
              <Tab
                key={tab.id}
                session={tab}
                active={tab.id === activeId}
                onActivate={() => onActivate(tab.id)}
                onClose={() => onClose(tab.id)}
                onContextMenu={(x, y) =>
                  setMenu({ x, y, sessionId: tab.id })
                }
              />
            ))
          )}
        </div>

        <div className="flex h-full shrink-0 items-center gap-0.5 px-1">
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 [&_svg]:size-3.5"
            onClick={onNew}
            title={t("sidepanel.tabbar.button.new")}
          >
            <Plus />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 [&_svg]:size-3.5"
            onClick={onOpenHistory}
            title={t("sidepanel.tabbar.button.history")}
          >
            <History />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 [&_svg]:size-3.5"
            onClick={onOpenSettings}
            title={t("sidepanel.tabbar.button.settings")}
          >
            <SettingsIcon />
          </Button>
        </div>
      </header>

      {menu ? (
        <TabContextMenu
          x={menu.x}
          y={menu.y}
          onDismiss={() => setMenu(null)}
          items={[
            {
              label: t("sidepanel.tabbar.menu.close"),
              onClick: () => onClose(menu.sessionId),
            },
            {
              label: t("sidepanel.tabbar.menu.closeOthers"),
              disabled: idsExceptMenu.length === 0,
              onClick: () => onCloseMany(idsExceptMenu),
            },
            {
              label: t("sidepanel.tabbar.menu.closeRight"),
              disabled: idsToTheRight.length === 0,
              onClick: () => onCloseMany(idsToTheRight),
            },
            { separator: true },
            {
              label: t("sidepanel.tabbar.menu.closeAll"),
              disabled: ids.length === 0,
              onClick: () => onCloseMany(ids),
            },
          ]}
        />
      ) : null}
    </>
  );
}

interface TabProps {
  session: SessionMeta;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
  onContextMenu: (x: number, y: number) => void;
}

function Tab({
  session,
  active,
  onActivate,
  onClose,
  onContextMenu,
}: TabProps) {
  const { t } = useT();
  const title = session.title || t("sidepanel.tabbar.button.new");
  return (
    <div
      data-session-id={session.id}
      onClick={onActivate}
      onMouseDown={(e) => {
        // Middle-click closes the tab — matches browsers and Cursor.
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
      className={cn(
        "group flex h-full shrink-0 cursor-pointer select-none items-center gap-1 border-r border-border/40 px-3 text-xs last:border-r-0",
        active
          ? "bg-background text-foreground"
          : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
      )}
      title={title}
    >
      <span className="max-w-[140px] truncate">{title}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        title={t("sidepanel.tabbar.tab.close")}
        aria-label={t("sidepanel.tabbar.tab.closeAria")}
        className={cn(
          "ml-1 rounded p-0.5 transition-opacity hover:bg-foreground/10",
          active ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

type MenuItem =
  | { separator: true }
  | { label: string; disabled?: boolean; onClick: () => void };

interface TabContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onDismiss: () => void;
}

/**
 * Lightweight tab right-click menu. Anchored at the click coordinates and
 * clamped to the viewport so it never spills outside the side panel. We
 * intentionally don't use a portal: nothing in the parent tree applies
 * `transform`/`filter`, so `position: fixed` resolves against the viewport
 * regardless of where it lives in the DOM.
 *
 * Closes on outside click, right-click anywhere else, Esc, scroll, blur,
 * or after any item runs (the parent invalidates `menu` once tabs change).
 */
function TabContextMenu({ x, y, items, onDismiss }: TabContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // Clamp to viewport once the menu has measurable size. Doing this in an
  // effect (rather than during render) keeps the first paint at the click
  // origin even before measurement, then snaps in on the next frame if a
  // shift is needed.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 4;
    let nx = x;
    let ny = y;
    if (nx + r.width > vw - pad) nx = Math.max(pad, vw - r.width - pad);
    if (ny + r.height > vh - pad) ny = Math.max(pad, vh - r.height - pad);
    if (nx !== pos.x || ny !== pos.y) setPos({ x: nx, y: ny });
    // We deliberately depend on x/y only — `pos` would loop the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y]);

  useEffect(() => {
    const onDocDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    // We DON'T listen on `contextmenu` to dismiss: doing so races with
    // React's bubble-phase `onContextMenu` on a sibling Tab, where the
    // document listener fires *after* the React handler and ends up
    // overwriting the just-set `{newTab}` with `null`. Right-clicking
    // outside the menu is already covered by the `mousedown` listener
    // below, since right-click fires `mousedown` first.
    //
    // We also defer attachment until the next animation frame so the
    // very `mousedown` that just opened the menu (if it bubbled past
    // React) can never be the one that immediately dismisses it.
    let raf = 0;
    let attached = false;
    const attach = () => {
      attached = true;
      document.addEventListener("mousedown", onDocDown);
      document.addEventListener("keydown", onKey);
      // `true` so we catch scroll on any inner container, not just window.
      window.addEventListener("scroll", onDismiss, true);
      window.addEventListener("blur", onDismiss);
      window.addEventListener("resize", onDismiss);
    };
    raf = requestAnimationFrame(attach);
    return () => {
      cancelAnimationFrame(raf);
      if (!attached) return;
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onDismiss, true);
      window.removeEventListener("blur", onDismiss);
      window.removeEventListener("resize", onDismiss);
    };
  }, [onDismiss]);

  return (
    <div
      ref={ref}
      role="menu"
      style={{ position: "fixed", left: pos.x, top: pos.y, zIndex: 50 }}
      className="min-w-[170px] select-none rounded-md border border-border bg-popover p-1 text-xs text-popover-foreground shadow-md"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => {
        if ("separator" in it) {
          return (
            <div key={`sep-${i}`} className="my-1 h-px bg-border/60" />
          );
        }
        return (
          <button
            key={`item-${i}-${it.label}`}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              if (it.disabled) return;
              it.onClick();
              onDismiss();
            }}
            className={cn(
              "flex w-full items-center rounded-sm px-2 py-1.5 text-left transition-colors",
              it.disabled
                ? "cursor-not-allowed text-muted-foreground/60"
                : "cursor-pointer hover:bg-accent hover:text-accent-foreground",
            )}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
