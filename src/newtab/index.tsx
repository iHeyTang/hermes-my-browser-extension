/**
 * New-tab Home page.
 *
 * Plasmo auto-registers this file as ``chrome_url_overrides.newtab``, so
 * every new tab routes here. To fall through to Chrome's default NTP or
 * another extension's override, the user disables our override at
 * chrome://extensions — there is no in-page API that can do that, so we
 * don't expose an in-extension toggle.
 *
 * Layout intent — a cron-run reader, not a search box:
 *
 *   ┌─────────────────────────────────────────────────────┐
 *   │ [Logo] Hermes                       [⚙ Settings]    │
 *   ├─────────────────────────────────────────────────────┤
 *   │ ╭─ Message Hermes ─────────────────────────────╮    │
 *   │ ╰──────────────────────────────────────────────╯    │
 *   │                                                     │
 *   │ ╭ History ╮ ╭ Selected run (markdown) ╮ ╭ Recent ╮  │
 *   │ │ row     │ │  ...full body...        │ │ chats  │  │
 *   │ │ row*    │ │                         │ │        │  │
 *   │ ╰─────────╯ ╰─────────────────────────╯ ╰────────╯  │
 *   └─────────────────────────────────────────────────────┘
 *
 * Left column: a list of recent cron runs (history). Selecting a row
 * loads its content into the centre column. The centre column defaults
 * to the most recent run on first load.
 */

import {
  AlertTriangle,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Globe,
  ImageIcon as ImageBadgeIcon,
  Inbox as InboxIcon,
  MessageSquare,
  Moon,
  Plus,
  RefreshCw,
  Settings,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { Streamdown } from "streamdown";
import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import "~style.css";

import { HermesLogo } from "~components/hermes-logo";
import { Textarea } from "~components/ui/textarea";
import { useCronRuns } from "~lib/cron-runs/use-cron-runs";
import {
  cronRunKey,
  type CronRun,
  type CronRunStatus,
} from "~lib/cron-runs/types";
import {
  DEFAULT_ROUTINES,
  getInstalledRoutineIds,
  installRoutine,
  type RoutineTemplate,
} from "~lib/cron-runs/default-routines";
import {
  useHomeShortcuts,
  type HomeShortcut,
  type HomeShortcutsController,
} from "~lib/home-shortcuts/use-home-shortcuts";
import {
  renderQuickActionPrompt,
  useQuickActions,
  type ResolvedQuickAction,
} from "~lib/quick-actions";
import { useResume, type ResumeItem } from "~lib/resume/use-resume";
import { useSessions } from "~lib/sessions/use-sessions";
import {
  useWallpaper,
  type Wallpaper,
  type WallpaperController,
} from "~lib/wallpaper/use-wallpaper";
import { useResolvedTheme } from "~lib/theme";
import { useT } from "~lib/i18n";
import { cn } from "~lib/utils";

const HOME_PENDING_PROMPT_KEY = "home.pendingPrompt";

export default function NewTab() {
  useResolvedTheme();
  return <Home />;
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

function Home() {
  const { t } = useT();
  const sessions = useSessions();
  const cronRuns = useCronRuns();
  const resume = useResume(sessions.sessions);
  const shortcuts = useHomeShortcuts();
  const wallpaper = useWallpaper();
  const { actions: quickActions } = useQuickActions(t);

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // Bottom peek dashboard. Off-screen at rest; wheel-down anywhere on
  // the page slides it up, wheel-up (outside the panel's own scrollable
  // area) slides it back down. There's no auto-collapse on mouse-leave
  // — once raised the panel stays put until the user explicitly wheels
  // it away.
  const [peekExpanded, setPeekExpanded] = useState(false);
  // The cooldown keeps continuous trackpad wheel events from instantly
  // toggling on/off — without it a single fast scroll gesture would
  // fire ~30 wheel events and the panel would oscillate.
  const peekExpandedRef = useRef(peekExpanded);
  const wheelCooldownUntilRef = useRef<number>(0);
  useEffect(() => {
    peekExpandedRef.current = peekExpanded;
  }, [peekExpanded]);
  useEffect(() => {
    function onWheel(e: WheelEvent) {
      const target = e.target as HTMLElement | null;
      // Self-scrolling form controls (the composer textarea above
      // all) must keep their own scroll behaviour — a long prompt
      // that overflows the composer should scroll the composer,
      // not bounce the peek panel up/down. `closest()` so the check
      // survives any wrapper element that might sit between the
      // event target and the actual textarea.
      if (target?.closest("textarea, input")) return;

      // When the panel is expanded AND the wheel originates inside the
      // peek's content area (e.g. scrollable markdown in the CronContent
      // column), let the browser scroll the inner element normally —
      // don't hijack it.
      const inPeek = target?.closest("[data-bottom-peek-scroll]");
      if (peekExpandedRef.current && inPeek) return;

      // Outside the scrollable peek area (or panel is collapsed): the
      // page itself has nothing to scroll (root is `overflow-hidden`),
      // so a wheel gesture is unambiguously a peek-toggle intent.
      e.preventDefault();

      const now = Date.now();
      if (now < wheelCooldownUntilRef.current) return;

      if (e.deltaY > 0 && !peekExpandedRef.current) {
        setPeekExpanded(true);
        wheelCooldownUntilRef.current = now + 600;
      } else if (e.deltaY < 0 && peekExpandedRef.current) {
        setPeekExpanded(false);
        wheelCooldownUntilRef.current = now + 600;
      }
    }
    // `passive: false` is required so `preventDefault` actually
    // suppresses any latent page-level scroll on browsers that haven't
    // already short-circuited it via `overflow-hidden`.
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, []);

  // On mount: focus composer; on focus re-pull runs so a long-open tab
  // catches up. Initial fetch is fired by the hook itself.
  useEffect(() => {
    inputRef.current?.focus();
    const onFocus = () => {
      void cronRuns.refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Selection rule: the user's explicit pick if it's still in the list;
  // otherwise the newest run. Keeps "latest by default" without stomping
  // a deliberate selection that survives a refresh.
  const selectedRun = useMemo<CronRun | null>(() => {
    if (cronRuns.runs.length === 0) return null;
    if (selectedKey) {
      const found = cronRuns.runs.find((r) => cronRunKey(r) === selectedKey);
      if (found) return found;
    }
    return cronRuns.runs[0];
  }, [cronRuns.runs, selectedKey]);

  function goToChatTab() {
    try {
      window.location.replace(chrome.runtime.getURL("tabs/chat.html"));
    } catch {
      // Best-effort.
    }
  }

  async function submitToChat(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy || !sessions.ready) return;
    setBusy(true);
    try {
      await sessions.createNew();
      await chrome.storage.local.set({
        [HOME_PENDING_PROMPT_KEY]: { text: trimmed, ts: Date.now() },
      });
      goToChatTab();
    } finally {
      setBusy(false);
    }
  }

  async function openSession(id: string) {
    if (!sessions.ready) return;
    setBusy(true);
    try {
      await sessions.openTab(id);
      goToChatTab();
    } finally {
      setBusy(false);
    }
  }

  /**
   * "Continue in chat": seed a fresh session with the selected run's
   * full markdown so the assistant has context without a round-trip
   * through memory.
   */
  async function continueRunInChat(run: CronRun) {
    if (!sessions.ready) return;
    setBusy(true);
    try {
      await sessions.createNew();
      const stamp = new Date(run.runAtMs).toLocaleString();
      const prompt = t("newtab.continueInChat.prompt", {
        name: run.jobName,
        time: stamp,
        content: run.content,
      });
      await chrome.storage.local.set({
        [HOME_PENDING_PROMPT_KEY]: { text: prompt, ts: Date.now() },
      });
      goToChatTab();
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    const ne = e.nativeEvent;
    if (ne.isComposing || e.key === "Process") return;
    if (
      (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ||
      (e.key === "Enter" && !e.shiftKey && !e.altKey)
    ) {
      e.preventDefault();
      void submitToChat(input);
    }
  }

  const canSend = input.trim().length > 0 && !busy && sessions.ready;

  return (
    <div
      className={cn(
        // `isolate` confines the wallpaper's negative-z stacking to this
        // subtree; without it `-z-10` would escape behind <html> and the
        // overlay would never visibly composite. We deliberately drop the
        // outer `bg-background`: WallpaperBackdrop renders the base color
        // itself so the wallpaper can paint on top of it when enabled.
        // `overflow-hidden` hard-clips the bottom peek panel when it's
        // translated below the viewport in its collapsed state; without
        // this, the off-screen 60vh of panel would extend the document
        // height and let the user scroll into a "ghost" area below the
        // wallpaper.
        "relative isolate flex h-screen w-full flex-col overflow-hidden text-foreground",
      )}
    >
      <WallpaperBackdrop controller={wallpaper} dim={peekExpanded} />
      <TopBar
        wallpaperController={wallpaper.enabled ? wallpaper : null}
        onOpenSettings={() => chrome.runtime.openOptionsPage()}
      />

      <main
        className={cn(
          "flex w-full flex-1 flex-col gap-6 overflow-hidden px-8",
          // Centred vertically with a slight upward bias (the empty
          // composer feels more at home around the upper third than
          // dead-centre). Achieved via `padding-bottom` — shrinks the
          // available area from below so `justify-center` re-centres
          // the content in the smaller space. Layout-native: no
          // `transform: translate`, which would visually overlap the
          // TopBar and steal pointer events from its icons.
          "justify-center",
          "transition-[padding-bottom] duration-500 ease-out",
          peekExpanded
            ? "pb-[min(70vh,calc(100vh_-_280px))]"
            : "pb-[6vh]",
        )}
      >
        <section className="mx-auto w-full max-w-2xl shrink-0 space-y-2">
          {/* Floating text picks its colour off the wallpaper's
              average luminance — but ONLY once measurement has landed
              (`wallpaper.mode !== null`). Before then, whatever is
              actually visible behind the text is the theme's
              `bg-background` (the wallpaper image is still loading
              with `opacity-0`, or measurement permanently failed), so
              `text-foreground` is the correct, theme-matched fallback.
              The previous "always-white-when-wallpaper-enabled"
              fallback failed on blank/light backgrounds in light
              theme. */}
          {(() => {
            const ambient =
              wallpaper.enabled &&
              wallpaper.wallpaper &&
              wallpaper.mode !== null;
            const className = cn(
              "space-y-0.5 px-0.5",
              // No colour transition: the wallpaper-driven palette swap
              // pairs with an instant logo-asset swap; a fading text
              // beside an already-snapped logo reads as out-of-sync.
              !ambient
                ? "text-foreground"
                : wallpaper.mode === "light"
                  ? "text-neutral-900 [&_p]:drop-shadow-[0_1px_1px_rgba(255,255,255,0.4)]"
                  : "text-white [&_p]:drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]",
            );
            return (
              <div className={className}>
                <p className="text-sm font-semibold">
                  {t("newtab.greeting")}
                </p>
                <p className="text-xs opacity-80">{t("newtab.subtitle")}</p>
              </div>
            );
          })()}
          <ComposerCard
            ref={inputRef}
            value={input}
            onChange={setInput}
            onKeyDown={onKeyDown}
            onSend={() => void submitToChat(input)}
            canSend={canSend}
            busy={busy}
            quickActions={quickActions}
            onQuickAction={(action) => {
              const userText = input;
              if (!userText.trim()) {
                inputRef.current?.focus();
                return;
              }
              void submitToChat(
                renderQuickActionPrompt(action.template, userText),
              );
            }}
            peekExpanded={peekExpanded}
          />
        </section>

        <ShortcutsStrip
          controller={shortcuts}
          ambientMode={wallpaper.enabled ? wallpaper.mode : null}
        />
      </main>

      <BottomPeek
        expanded={peekExpanded}
        onToggle={() => setPeekExpanded((prev) => !prev)}
        cronRuns={cronRuns}
        selectedRun={selectedRun}
        onSelectRun={(r) => setSelectedKey(cronRunKey(r))}
        onContinueInChat={(r) => void continueRunInChat(r)}
        resume={resume}
        busy={busy}
        onOpenSession={(id) => void openSession(id)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bottom peek dashboard
//
// Lives entirely off-screen at rest (`translate-y-full` parks it below
// the viewport). A scroll-wheel-down anywhere on the page slides the
// whole panel up by translating it back to `translate-y-0`; a wheel-up
// (outside the panel's own scrollable region) slides it back down.
// No handle, no affordance — the wallpaper has the full bottom of the
// screen until the user explicitly wheels for it. The wheel logic
// itself is owned by `Home`; this component just renders.
//
// Panel height is 70vh, fixed. Main content slides up by -15vh in
// concert (animated on `main` in the same 500ms ease-out) so the
// composer block stays clear of the panel.
// ---------------------------------------------------------------------------

function BottomPeek({
  expanded,
  onToggle,
  cronRuns,
  selectedRun,
  onSelectRun,
  onContinueInChat,
  resume,
  busy,
  onOpenSession,
}: {
  expanded: boolean;
  onToggle: () => void;
  cronRuns: ReturnType<typeof useCronRuns>;
  selectedRun: CronRun | null;
  onSelectRun: (r: CronRun) => void;
  onContinueInChat: (r: CronRun) => void;
  resume: ReturnType<typeof useResume>;
  busy: boolean;
  onOpenSession: (id: string) => void;
}) {
  return (
    <div
      className={cn(
        "absolute inset-x-0 bottom-0 z-10 flex flex-col",
        // Panel height is clamped so it never eats below the
        // 280px we need above for TopBar + composer + shortcuts.
        // On tall screens this resolves to 70vh; on short screens
        // (laptops, tablets in landscape) it shrinks to whatever
        // leaves 280px above instead of bulldozing the main content.
        // Main's matching `pb-[…]` in `Home` uses the identical
        // expression so the layout stays in sync.
        "h-[min(70vh,calc(100vh_-_280px))]",
        "transition-transform duration-500 ease-out",
        // Collapsed state leaves the 1.75rem (28px) grab handle
        // peeking up from the bottom of the viewport — the
        // "something more is here" affordance. When fully expanded
        // the panel sits flush at translate-y-0.
        expanded ? "translate-y-0" : "translate-y-[calc(100%-1.75rem)]",
        // No panel-level border, gradient, or shadow — those collapsed
        // the three floating cards into one continuous block. Each
        // card carries its own glass recipe (bg + blur + shadow +
        // catch-light) and is what should define its own top edge.
      )}
    >
      {/* Grab handle — iOS bottom-sheet bar. Wrapped in a full-width
          button so clicking anywhere along the bottom edge toggles
          the panel even if the cursor isn't precisely on the bar.
          Hover widens + brightens to confirm it's interactive. */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse panel" : "Expand panel"}
        className={cn(
          "group/handle flex h-7 w-full shrink-0 cursor-pointer items-center justify-center",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "rounded-full bg-foreground/45",
            "transition-all duration-200 ease-out",
            "h-1 w-14",
            "group-hover/handle:w-20 group-hover/handle:bg-foreground/70",
          )}
        />
      </button>
      <div
        data-bottom-peek-scroll
        className="flex min-h-0 flex-1 flex-col gap-5 px-8 pb-6 lg:flex-row"
      >
        <CronHistorySection
          ready={cronRuns.ready}
          runs={cronRuns.runs}
          selectedKey={selectedRun ? cronRunKey(selectedRun) : null}
          onSelect={onSelectRun}
        />
        <CronContentSection
          ready={cronRuns.ready}
          run={selectedRun}
          onContinueInChat={onContinueInChat}
        />
        <ResumeSection
          ready={resume.ready}
          items={resume.items}
          busy={busy}
          onOpenSession={onOpenSession}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Home shortcuts — quick-launch strip between the composer and the dashboard.
//
// Cards are bookmarks under a dedicated folder; see
// `lib/home-shortcuts/use-home-shortcuts.ts`. The strip exposes the bare
// minimum of newtab-native interactions (add, remove, drag-reorder); deeper
// edits (rename, move out of folder, etc.) happen in Chrome's bookmark
// manager and stream back here via bookmark events.
// ---------------------------------------------------------------------------

function faviconUrl(url: string, size = 32, bust?: number): string {
  // MV3 `favicon` permission: extension-served, backed by Chrome's
  // internal favicon cache. The URL itself is a pure function of
  // (pageUrl, size), so the renderer's HTTP cache would otherwise pin
  // the first response (typically Chrome's default globe for sites the
  // user hasn't visited yet) for the whole session — and re-renders
  // would never see the real favicon Chrome populated after a visit.
  // `bust` flips the query string so each render that *should* re-check
  // (newtab mount, tab regains visibility) actually re-hits Chrome's
  // favicon service. See https://developer.chrome.com/docs/extensions/reference/api/favicon
  try {
    const base = chrome.runtime.getURL(
      `/_favicon/?pageUrl=${encodeURIComponent(url)}&size=${size}`,
    );
    return bust ? `${base}&v=${bust}` : base;
  } catch {
    return "";
  }
}

function normalizeAddUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    // Throws on truly malformed input; otherwise normalises (case, idn, …).
    const u = new URL(withScheme);
    return u.toString();
  } catch {
    return null;
  }
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function ShortcutsStrip({
  controller,
  ambientMode,
}: {
  controller: HomeShortcutsController;
  /**
   * Wallpaper tonal mode. The pill surface is ~70% transparent so
   * its visible colour is dominated by the (blurred) wallpaper
   * underneath — pill text needs to match the wallpaper, not the
   * theme. `null` falls back to theme `text-foreground` (i.e.
   * wallpaper off or still measuring).
   */
  ambientMode: "light" | "dark" | null;
}) {
  const { t } = useT();
  const { ready, items } = controller;
  const [managerOpen, setManagerOpen] = useState(false);
  // Cache-buster passed to `faviconUrl`. Reseeded on mount AND every time
  // the tab becomes visible again, so cards re-check Chrome's favicon
  // service after a click-through that populated the cache. Without this
  // the renderer's HTTP cache pins whatever response landed first
  // (usually Chrome's default globe) for the whole tab session.
  const [faviconBust, setFaviconBust] = useState<number>(() => Date.now());
  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === "visible") {
        setFaviconBust(Date.now());
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () =>
      document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Hide the section entirely while we're still resolving the folder on
  // first paint: the dashboard below is what users see first, and an
  // empty-but-loading strip flashing in is more visual noise than help.
  // Once `ready` is true, render — empty state included.
  if (!ready) return null;

  // Pill text colour follows the wallpaper, not the theme — see the
  // `ambientMode` prop doc above.
  const ambientTextClass =
    ambientMode === "light"
      ? "text-neutral-900"
      : ambientMode === "dark"
        ? "text-white"
        : "text-foreground";

  function openShortcut(url: string) {
    try {
      window.location.assign(url);
    } catch {
      // Fallback — open in a new tab if the current navigation is blocked.
      window.open(url, "_self");
    }
  }

  return (
    <section className="mx-auto w-full max-w-4xl shrink-0">
      <ul className="flex flex-wrap items-center justify-center gap-2.5">
        {items.map((s) => (
          <li key={s.id}>
            <ShortcutCard
              item={s}
              faviconBust={faviconBust}
              onOpen={() => openShortcut(s.url)}
              ambientTextClass={ambientTextClass}
            />
          </li>
        ))}
        <li>
          <button
            type="button"
            onClick={() => setManagerOpen(true)}
            aria-label={t("newtab.shortcuts.manage.tooltip")}
            title={t("newtab.shortcuts.manage.tooltip")}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-full px-3",
              // Match the shortcut pills exactly so the row reads as
              // one continuous control surface; secondary status is
              // signalled by the icon + text choice, not by the
              // chrome being weaker.
              "bg-gradient-to-b from-card/28 to-card/12",
              "backdrop-blur-2xl backdrop-saturate-110",
              "backdrop-brightness-115 dark:backdrop-brightness-85",
              "shadow-[inset_0_1px_0_0_rgb(255_255_255_/_0.2),0_1px_2px_0_rgb(0_0_0_/_0.06),0_4px_12px_-2px_rgb(0_0_0_/_0.1)]",
              "dark:shadow-[inset_0_1px_0_0_rgb(255_255_255_/_0.08),0_1px_2px_0_rgb(0_0_0_/_0.3),0_4px_12px_-2px_rgb(0_0_0_/_0.4)]",
              ambientTextClass,
              "text-xs transition-all duration-200",
              "hover:from-card/45 hover:to-card/25",
            )}
          >
            <Settings2 className="h-3.5 w-3.5" />
            <span>{t("newtab.shortcuts.manage")}</span>
          </button>
        </li>
      </ul>

      {items.length === 0 && (
        <p className="mt-1.5 text-center text-[11px] text-muted-foreground">
          {t("newtab.shortcuts.empty")}
        </p>
      )}

      {managerOpen && (
        <ShortcutsManager
          controller={controller}
          faviconBust={faviconBust}
          onClose={() => setManagerOpen(false)}
        />
      )}
    </section>
  );
}

function ShortcutCard({
  item,
  faviconBust,
  onOpen,
  ambientTextClass,
}: {
  item: HomeShortcut;
  faviconBust: number;
  onOpen: () => void;
  /**
   * Text colour class chosen by the parent to match the wallpaper —
   * the pill surface is mostly transparent so its visible colour is
   * the wallpaper, not the theme.
   */
  ambientTextClass: string;
}) {
  // Tie the "icon failed" state to the *exact* src that failed, not a
  // sticky boolean: when `faviconBust` (or item.url) changes, the src
  // changes, `failed` flips back to false, and the next render tries
  // the favicon again.
  const src = faviconUrl(item.url, 32, faviconBust);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = failedSrc === src;
  // Display fallback: hostname rather than the raw URL when the stored
  // title is the auto-placeholder we wrote before scraping `<title>`.
  const trimmedTitle = item.title?.trim() || "";
  const titleLooksAuto =
    !trimmedTitle ||
    trimmedTitle === item.url ||
    trimmedTitle === item.url.replace(/\/$/, "");
  const label = titleLooksAuto ? hostFromUrl(item.url) : trimmedTitle;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${label}\n${item.url}`}
      className={cn(
        "inline-flex h-8 max-w-[220px] items-center gap-1.5 rounded-full pl-1 pr-3",
        "bg-gradient-to-b from-card/28 to-card/12",
        "backdrop-blur-2xl backdrop-saturate-110",
        "backdrop-brightness-115 dark:backdrop-brightness-85",
        // Three-layer shadow recipe = real glass:
        //   1. `inset 0 1px 0 rgba(255,255,255,X)` — a 1px-thick white
        //      highlight along the inner top edge that follows the
        //      pill's rounded curvature (the "wet-glass" catch-light).
        //   2. `0 1px 2px black` — tight outline shadow that defines
        //      the pill against the wallpaper without a hard border.
        //   3. `0 4px 12px -2px black` — diffuse drop shadow that
        //      lifts the pill off the surface.
        // Dark mode flips the highlight down (white is less visible
        // anyway) and pushes the dark shadows harder for contrast.
        "shadow-[inset_0_1px_0_0_rgb(255_255_255_/_0.2),0_1px_2px_0_rgb(0_0_0_/_0.06),0_4px_12px_-2px_rgb(0_0_0_/_0.1)]",
        "dark:shadow-[inset_0_1px_0_0_rgb(255_255_255_/_0.08),0_1px_2px_0_rgb(0_0_0_/_0.3),0_4px_12px_-2px_rgb(0_0_0_/_0.4)]",
        // `transition-all` (not `transition-[background-color]`) so the
        // gradient stops Tailwind sets via CSS variables actually
        // animate on hover — `background-image` is not in the default
        // `transition` property list, which is why the previous hover
        // change appeared instant.
        ambientTextClass,
        "text-xs transition-all duration-200",
        "hover:from-card/45 hover:to-card/25",
      )}
    >
      {/* Theme-matched favicon "tile" — pure white in light mode,
          near-black in dark mode. Mirrors how browser tabs render
          favicons: a flat surface the icon sits on with predictable
          contrast, decoupled from whatever colour the pill's glass
          happens to reveal underneath. */}
      <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white dark:bg-neutral-900">
        {failed ? (
          <Globe className="h-3.5 w-3.5 text-neutral-500" />
        ) : (
          <img
            src={src}
            alt=""
            width={16}
            height={16}
            onError={() => setFailedSrc(src)}
            className="h-4 w-4"
          />
        )}
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Shortcuts manager — modal dialog. Centralises every mutation (add, rename,
// remove, reorder) so the homepage strip itself can stay strictly read-only.
// Closes on Esc, backdrop click, or the explicit ×.
// ---------------------------------------------------------------------------

function ShortcutsManager({
  controller,
  faviconBust,
  onClose,
}: {
  controller: HomeShortcutsController;
  faviconBust: number;
  onClose: () => void;
}) {
  const { t } = useT();
  const { items, add, remove, rename, reorder } = controller;

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex items-start justify-center overflow-y-auto",
        "bg-black/40 backdrop-blur-[2px] px-4 py-12",
      )}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t("newtab.shortcuts.manage.title")}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "w-full max-w-lg rounded-xl border border-border bg-background shadow-2xl",
        )}
      >
        <header className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <h2 className="text-sm font-semibold tracking-tight">
            {t("newtab.shortcuts.manage.title")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("newtab.shortcuts.manage.close")}
            title={t("newtab.shortcuts.manage.close")}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="px-4 pb-4 pt-3">
          <ManagerAddRow onAdd={add} />

          {items.length === 0 ? (
            <p className="mt-4 text-center text-xs text-muted-foreground">
              {t("newtab.shortcuts.manage.listEmpty")}
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-border/40 rounded-lg border border-border/60">
              {items.map((s, i) => (
                <ManagerRow
                  key={s.id}
                  item={s}
                  faviconBust={faviconBust}
                  isFirst={i === 0}
                  isLast={i === items.length - 1}
                  onRename={(title) => rename(s.id, title)}
                  onRemove={() => remove(s.id)}
                  onMoveUp={() => reorder(i, i - 1)}
                  onMoveDown={() => reorder(i, i + 1)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function ManagerAddRow({
  onAdd,
}: {
  onAdd: (input: { url: string; title: string }) => Promise<void>;
}) {
  const { t } = useT();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    const normalized = normalizeAddUrl(url);
    if (!normalized) {
      setErr(t("newtab.shortcuts.add.invalidUrl"));
      return;
    }
    setSubmitting(true);
    try {
      await onAdd({ url: normalized, title: title.trim() });
      setUrl("");
      setTitle("");
      setErr(null);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-1.5">
      {/* Column order mirrors the list rows below: title (primary) on the
          left, URL (secondary) on the right. Mixing the two orders would
          make users re-read each row top-to-bottom. */}
      <div className="flex items-stretch gap-1.5">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={t("newtab.shortcuts.add.dialog.titlePlaceholder")}
          className="flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs focus:border-foreground/40 focus:outline-none"
        />
        <input
          type="url"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            if (err) setErr(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={t("newtab.shortcuts.add.dialog.urlPlaceholder")}
          className="flex-[2] rounded-md border border-border bg-background px-2.5 py-1.5 text-xs focus:border-foreground/40 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting || url.trim().length === 0}
          className={cn(
            "shrink-0 rounded-md px-3 text-xs font-medium transition-colors",
            "bg-foreground text-background hover:bg-foreground/85",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {t("newtab.shortcuts.add.dialog.confirm")}
        </button>
      </div>
      {err && <p className="text-[11px] text-destructive">{err}</p>}
    </div>
  );
}

function ManagerRow({
  item,
  faviconBust,
  isFirst,
  isLast,
  onRename,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  item: HomeShortcut;
  faviconBust: number;
  isFirst: boolean;
  isLast: boolean;
  onRename: (title: string) => Promise<void> | void;
  onRemove: () => Promise<void> | void;
  onMoveUp: () => Promise<void> | void;
  onMoveDown: () => Promise<void> | void;
}) {
  const { t } = useT();
  const src = faviconUrl(item.url, 32, faviconBust);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = failedSrc === src;
  const trimmedTitle = item.title?.trim() || "";
  const titleLooksAuto =
    !trimmedTitle ||
    trimmedTitle === item.url ||
    trimmedTitle === item.url.replace(/\/$/, "");
  const initialLabel = titleLooksAuto ? hostFromUrl(item.url) : trimmedTitle;
  // Local input state so the user can type without the bookmark
  // round-tripping on every keystroke. Commit on blur or Enter.
  const [draft, setDraft] = useState(initialLabel);
  // If the upstream item title changes (e.g. agent renamed it from
  // elsewhere, or scrape finished), pick up the new value — but only
  // when the input isn't currently dirty (user is typing).
  useEffect(() => {
    setDraft(initialLabel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, item.title]);

  function commit() {
    const next = draft.trim();
    if (!next || next === initialLabel) return;
    void onRename(next);
  }

  return (
    <li className="flex items-center gap-2 px-2.5 py-2">
      {/* Same tile colour as the homepage pills — keeps the modal's
          row visually consistent with what the user sees outside it. */}
      <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-md bg-white dark:bg-neutral-900">
        {failed ? (
          <Globe className="h-3.5 w-3.5 text-neutral-500" />
        ) : (
          <img
            src={src}
            alt=""
            width={16}
            height={16}
            onError={() => setFailedSrc(src)}
            className="h-4 w-4"
          />
        )}
      </span>
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.currentTarget as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(initialLabel);
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        aria-label={t("newtab.shortcuts.rename")}
        className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-xs text-foreground hover:border-border focus:border-foreground/40 focus:bg-background focus:outline-none"
      />
      <span
        className="hidden truncate text-[10px] text-muted-foreground/70 sm:inline-block sm:max-w-[140px]"
        title={item.url}
      >
        {hostFromUrl(item.url)}
      </span>
      <div className="flex shrink-0 items-center">
        <button
          type="button"
          onClick={() => void onMoveUp()}
          disabled={isFirst}
          aria-label={t("newtab.shortcuts.manage.moveUp")}
          title={t("newtab.shortcuts.manage.moveUp")}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => void onMoveDown()}
          disabled={isLast}
          aria-label={t("newtab.shortcuts.manage.moveDown")}
          title={t("newtab.shortcuts.manage.moveDown")}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => void onRemove()}
          aria-label={t("newtab.shortcuts.remove")}
          title={t("newtab.shortcuts.remove")}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Wallpaper backdrop — daily photo from Bing, dimmed for legibility, with
// a small attribution chip in the corner. All layers live at `-z-10` so
// the page's flow content (composer, dashboard cards) paints above them
// without further z-index management. The parent must have `isolate`.
// ---------------------------------------------------------------------------

function WallpaperBackdrop({
  controller,
  dim,
}: {
  controller: WallpaperController;
  /**
   * Whether to paint the page-wide tint overlay over the wallpaper.
   * Off when the peek panel is collapsed (wallpaper shines through
   * cleanly), on when the panel is expanded (overlay tones the photo
   * down so the dashboard cards above it have a calmer backdrop to
   * read against). Toggling is animated.
   */
  dim: boolean;
}) {
  const { wallpaper, enabled } = controller;
  return (
    <>
      {/* Solid base color, always present. Keeps the page from going
          transparent while the wallpaper is loading, missing, or
          disabled. */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-background"
      />
      {enabled && wallpaper ? <WallpaperImage wallpaper={wallpaper} /> : null}
      {/* Conditional dim — fades in/out in lockstep with the bottom
          peek's translate animation (same 500ms ease-out). Heavy at
          top + bottom, lightest in the middle so the dashboard cards
          (bottom-most when expanded) sit on the most uniform tone. */}
      <div
        aria-hidden
        className={cn(
          "absolute inset-0 -z-10",
          "bg-gradient-to-b from-background/70 via-background/25 to-background/75",
          "transition-opacity duration-500 ease-out",
          dim ? "opacity-100" : "opacity-0",
        )}
      />
    </>
  );
}

function WallpaperImage({ wallpaper }: { wallpaper: Wallpaper }) {
  // Fade in only after the image actually finishes loading; before that
  // the base background shows through.
  const [loaded, setLoaded] = useState(false);
  return (
    <img
      src={wallpaper.url}
      alt=""
      aria-hidden
      onLoad={() => setLoaded(true)}
      className={cn(
        "absolute inset-0 -z-10 h-full w-full object-cover",
        "transition-opacity duration-700 ease-out",
        loaded ? "opacity-100" : "opacity-0",
      )}
    />
  );
}

function WallpaperCredit({
  controller,
  ambientClass,
}: {
  controller: WallpaperController;
  /**
   * Pre-computed text/hover colour class that adapts to the wallpaper
   * mode; supplied by the parent so the credit chip shares its tonal
   * adaptation logic with the rest of the TopBar action group.
   */
  ambientClass: string;
}) {
  const { t } = useT();
  const { wallpaper, cycle, cycling } = controller;
  if (!wallpaper) return null;
  const text = wallpaper.title || wallpaper.copyright;
  if (!text) return null;
  // Lives inline inside the TopBar action group (see `TopBar`). Default
  // state matches the other TopBar buttons in size (h-8) and shape, so
  // it disappears into the row when you're not interested in it. Hover
  // slides out the full `{title} · Bing` link plus a small "next image"
  // button via an animated `max-width`, so both the attribution and the
  // "cycle wallpaper" action cost zero permanent real estate.
  //
  // Structure: outer div is the hover target (`group/credit`); inside
  // sit (1) the always-visible icon, (2) an expandable area that hides
  // a credit link + a cycle button behind a `max-w-0 → max-w-[X]`
  // transition. Link and button are siblings (not nested), so each
  // gets its own click semantics — nested <a><button> is invalid HTML.
  return (
    <div
      title={wallpaper.copyright || text}
      className={cn(
        "group/credit inline-flex h-8 items-center overflow-hidden rounded-full",
        "text-[11px] transition-colors duration-200 hover:bg-white/10",
        ambientClass,
      )}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center">
        <ImageBadgeIcon className="h-4 w-4" />
      </span>
      {/*
       * Animate to content's natural width via the grid 0fr → 1fr trick.
       * `max-width` transitions look instant here because the target
       * (45vw) is far larger than the actual text width, so the visible
       * portion (clamped by content) finishes in the first ~30% of the
       * duration. Grid 1fr resolves to content size, so the transition
       * runs over its full duration regardless of how wide the text is.
       */}
      <div
        className={cn(
          "grid grid-cols-[0fr] transition-[grid-template-columns] duration-200 ease-out",
          "group-hover/credit:grid-cols-[1fr]",
          "group-focus-within/credit:grid-cols-[1fr]",
        )}
      >
        <div className="flex items-center overflow-hidden">
        {wallpaper.copyrightLink ? (
          <a
            href={wallpaper.copyrightLink}
            target="_blank"
            rel="noreferrer"
            className="whitespace-nowrap px-1 hover:underline"
          >
            {text} · Bing
          </a>
        ) : (
          <span className="whitespace-nowrap px-1">{text} · Bing</span>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            void cycle();
          }}
          disabled={cycling}
          aria-label={t("newtab.wallpaper.cycle")}
          title={t("newtab.wallpaper.cycle")}
          className={cn(
            "ml-0.5 mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
            "transition-colors hover:bg-white/15",
            // Inherit colour from the parent chip (which already
            // ran the ambient adaptation), so the cycle button
            // stays in sync with the credit text it lives in.
            "text-inherit",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          <RefreshCw
            className={cn("h-3 w-3", cycling && "animate-spin")}
          />
        </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

function TopBar({
  wallpaperController,
  onOpenSettings,
}: {
  /**
   * Wallpaper hook (when feature is enabled); renders as the inline
   * credit chip in the TopBar. Pass `null` to hide the chip entirely.
   */
  wallpaperController: WallpaperController | null;
  onOpenSettings: () => void;
}) {
  const { t } = useT();
  // Same `ambient` gate the greeting block / shortcut pills use — we
  // only switch off `text-foreground` once the wallpaper's luminance
  // mode has actually been measured. Before then the visible surface
  // is `bg-background` (image still loading / measurement failed), so
  // the theme color is the right baseline.
  const ambient =
    wallpaperController?.enabled === true &&
    wallpaperController.wallpaper !== null &&
    wallpaperController.mode !== null;
  const wordmarkClass = !ambient
    ? "text-foreground"
    : wallpaperController?.mode === "light"
      ? "text-neutral-900 [&_p]:drop-shadow-[0_1px_1px_rgba(255,255,255,0.4)]"
      : "text-white [&_p]:drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]";
  // Action icons (credit chip, Settings) need the same adaptation but
  // we keep them slightly dimmer than the wordmark — they're tools, not
  // headings — and let `hover:` push to full prominence.
  const iconClass = !ambient
    ? "text-muted-foreground hover:text-foreground"
    : wallpaperController?.mode === "light"
      ? "text-neutral-900/75 hover:text-neutral-900"
      : "text-white/80 hover:text-white";
  // HermesLogo is a raster PNG, not a currentColor SVG, so it can't
  // inherit `wordmarkClass`. Pick the contrasting variant explicitly
  // from the wallpaper mode (when ambient) or fall back to the document
  // theme (when not). Mode "light" = light photograph behind it →
  // render the dark-glyph variant via `light-bg`.
  const logoVariant: "auto" | "light-bg" | "dark-bg" = !ambient
    ? "auto"
    : wallpaperController?.mode === "light"
      ? "light-bg"
      : "dark-bg";
  return (
    <header className="flex shrink-0 items-center justify-between gap-3 px-6 py-4">
      <div
        className={cn(
          // No `transition-colors` here: the logo PNG swaps its asset
          // instantly when wallpaper mode lands, so a fading wordmark
          // beside an already-snapped logo reads as out-of-sync.
          "flex items-center gap-2.5",
          wordmarkClass,
        )}
      >
        <HermesLogo size={22} variant={logoVariant} />
        <p className="text-sm font-semibold tracking-tight">
          {t("app.title")}
        </p>
      </div>
      <div className="flex items-center gap-1">
        {wallpaperController?.wallpaper ? (
          <WallpaperCredit
            controller={wallpaperController}
            ambientClass={iconClass}
          />
        ) : null}
        <button
          type="button"
          onClick={onOpenSettings}
          className={cn(
            "inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors",
            "hover:bg-white/10",
            iconClass,
          )}
          aria-label={t("newtab.openOptions")}
          title={t("newtab.openOptions")}
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Module wrapper — shared visual container for every dashboard column.
// ---------------------------------------------------------------------------

function ModuleCard({
  title,
  meta,
  sizeClass,
  bodyClassName,
  children,
}: {
  title: string;
  meta?: React.ReactNode;
  sizeClass: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        // `relative` is required so the `before:` specular highlight can
        // position itself; `overflow-hidden` clips the highlight to the
        // rounded corners.
        "relative flex flex-col overflow-hidden rounded-xl",
        // Surface + blur + brightness are tuned as one unit:
        //   - Low tint opacity (`/22` → `/8`) lets the wallpaper's
        //     colour-field show through — the "transparent glass"
        //     feel.
        //   - High blur radius (`-3xl` = 64px) destroys underlying
        //     detail so text isn't fighting against tree branches /
        //     cloud edges.
        //   - `backdrop-brightness-115` (light) lifts dark wallpaper
        //     regions toward neutral so `text-foreground` (dark)
        //     keeps contrast; in dark mode we *darken* instead
        //     (`brightness-85`) so light text still has contrast on
        //     bright wallpapers. This is what fixes "图片本身比较
        //     暗就看不清" without forcing a thicker white wash.
        "bg-gradient-to-b from-card/22 to-card/8",
        "backdrop-blur-3xl backdrop-saturate-110",
        "backdrop-brightness-115 dark:backdrop-brightness-85",
        // No ring, no border. Any stroked edge — even at 12% opacity —
        // reads as a drawn outline against a varying wallpaper and
        // kills the glass illusion. The card defines its rectangle
        // purely through (a) the bg-gradient tint, (b) layered
        // shadow, and (c) the top `before:` catch-light below.
        //
        // Two-layer shadow: a soft *upward*-cast layer plus the
        // standard downward drop. The upward layer is what gives each
        // card its own top-edge against the wallpaper above — without
        // it the cards visually melt into the surrounding panel area.
        // Kept subtle so it reads as "this thing is floating slightly",
        // not as a heavy halo.
        "shadow-[0_-2px_6px_-2px_rgba(0,0,0,0.1),0_8px_24px_-4px_rgba(0,0,0,0.12)]",
        "dark:shadow-[0_-2px_6px_-2px_rgba(0,0,0,0.35),0_8px_24px_-4px_rgba(0,0,0,0.45)]",
        // Top specular highlight — the catch-light along the curved
        // upper edge of real glass. Bumped a notch over the previous
        // `/45` so it actually carries the top edge on darker
        // wallpapers without sliding into "drawn line" territory.
        "before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px",
        "before:bg-gradient-to-r before:from-transparent before:via-white/55 before:to-transparent",
        "dark:before:via-white/30",
        sizeClass,
      )}
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-foreground/[0.04] px-4 py-2.5">
        {/* `text-muted-foreground` was tuned for opaque card backgrounds.
            Over a translucent glass surface the wallpaper bleeds into
            the effective background and the muted grey loses contrast.
            Switching to `text-foreground/70` keeps the visual hierarchy
            (still dimmer than body text) while staying legible. */}
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-foreground/70">
          {title}
        </h2>
        {meta}
      </header>
      <div className={cn("min-h-0 flex-1 overflow-y-auto", bodyClassName)}>
        {children}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Cron history — left column
// ---------------------------------------------------------------------------

function CronHistorySection({
  ready,
  runs,
  selectedKey,
  onSelect,
}: {
  ready: boolean;
  runs: CronRun[];
  selectedKey: string | null;
  onSelect: (run: CronRun) => void;
}) {
  const { t } = useT();
  const isEmpty = ready && runs.length === 0;
  return (
    <ModuleCard
      title={t("newtab.history")}
      sizeClass="min-h-0 min-w-0 flex-1 lg:flex-1"
    >
      {!ready ? (
        <HistorySkeleton />
      ) : isEmpty ? (
        <EmptyState />
      ) : (
        <ul className="divide-y divide-foreground/[0.04]">
          {runs.map((r) => {
            const key = cronRunKey(r);
            return (
              <li key={key}>
                <CronHistoryRow
                  run={r}
                  selected={key === selectedKey}
                  onSelect={onSelect}
                />
              </li>
            );
          })}
        </ul>
      )}
    </ModuleCard>
  );
}

function CronHistoryRow({
  run,
  selected,
  onSelect,
}: {
  run: CronRun;
  selected: boolean;
  onSelect: (r: CronRun) => void;
}) {
  const { t } = useT();
  return (
    <button
      type="button"
      onClick={() => onSelect(run)}
      className={cn(
        "flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors",
        selected ? "bg-muted/60" : "hover:bg-muted/50",
        "focus:outline-none focus-visible:bg-muted/50",
      )}
    >
      <StatusIcon status={run.status} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-foreground">
          {run.jobName}
          {run.status === "error" && (
            <span className="ml-1 text-foreground/60">
              {t("newtab.row.failed")}
            </span>
          )}
          {run.status === "silent" && (
            <span className="ml-1 text-foreground/60">
              {t("newtab.row.silent")}
            </span>
          )}
        </span>
      </span>
      <span className="shrink-0 tabular-nums text-[10px] text-foreground/60">
        {formatRelative(run.runAtMs, t)}
      </span>
    </button>
  );
}

function HistorySkeleton() {
  return (
    <div className="divide-y divide-foreground/[0.04]">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-2.5 px-4 py-2">
          <div className="h-3.5 w-3.5 shrink-0 animate-pulse rounded-full bg-muted/40" />
          <div className="h-3 flex-1 animate-pulse rounded bg-muted/40" />
        </div>
      ))}
    </div>
  );
}

function StatusIcon({ status }: { status: CronRunStatus }) {
  if (status === "error") {
    return (
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
    );
  }
  if (status === "silent") {
    return (
      <Moon className="h-3.5 w-3.5 shrink-0 text-foreground/50" />
    );
  }
  return (
    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
  );
}

/**
 * Cold-start state for the history column — no cron jobs installed yet,
 * so offer one-click installs of the default routines instead of
 * dead-ending the user.
 */
function EmptyState() {
  const { t } = useT();
  const [installedIds, setInstalledIds] = useState<Set<string>>(new Set());
  const [ready, setReady] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getInstalledRoutineIds().then((s) => {
      if (cancelled) return;
      setInstalledIds(s);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onInstall(routine: RoutineTemplate) {
    setBusyId(routine.id);
    setError(null);
    const res = await installRoutine(routine);
    setBusyId(null);
    if (res.ok) {
      setInstalledIds((prev) => new Set(prev).add(routine.id));
    } else {
      setError(res.error ?? t("newtab.install.failed"));
    }
  }

  const anyInstalled = installedIds.size > 0;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
      <div className="text-center">
        <h3 className="text-sm font-semibold">
          {anyInstalled
            ? t("newtab.empty.installed")
            : t("newtab.empty.headline")}
        </h3>
        <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
          {anyInstalled
            ? t("newtab.empty.installedDesc")
            : t("newtab.empty.headlineDesc")}
        </p>
      </div>

      <div className="flex w-full max-w-md flex-col gap-1.5">
        {DEFAULT_ROUTINES.map((routine) => {
          const installed = installedIds.has(routine.id);
          const rowBusy = busyId === routine.id;
          return (
            <button
              key={routine.id}
              type="button"
              disabled={!ready || installed || rowBusy}
              onClick={() => void onInstall(routine)}
              className={cn(
                "flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                installed
                  ? "border-border/50 bg-muted/20"
                  : "border-border bg-background hover:border-foreground/30 hover:bg-muted/40",
                "disabled:cursor-default",
              )}
            >
              <span className="text-base leading-none">{routine.emoji}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-foreground">
                  {routine.name}
                </span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {routine.description} · {routine.scheduleLabel}
                </span>
              </span>
              <span className="shrink-0 text-muted-foreground">
                {installed ? (
                  <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                ) : rowBusy ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
              </span>
            </button>
          );
        })}
      </div>

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-[11px] text-destructive">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={() => chrome.runtime.openOptionsPage()}
        className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground/80 transition-colors hover:text-foreground"
      >
        <InboxIcon className="h-3.5 w-3.5" />
        {t("newtab.empty.customCron")}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cron content — centre column
// ---------------------------------------------------------------------------

function CronContentSection({
  ready,
  run,
  onContinueInChat,
}: {
  ready: boolean;
  run: CronRun | null;
  onContinueInChat: (run: CronRun) => void;
}) {
  const { t } = useT();
  const meta = run ? (
    <span className="truncate text-[10px] tabular-nums text-foreground/60">
      {run.jobName} · {new Date(run.runAtMs).toLocaleString()}
    </span>
  ) : null;

  return (
    <ModuleCard
      title={t("newtab.latest")}
      meta={meta}
      sizeClass="min-h-0 min-w-0 flex-1 lg:flex-[2]"
      bodyClassName={!run ? "" : "flex flex-col"}
    >
      {!ready ? (
        <ContentSkeleton />
      ) : !run ? (
        <div className="flex h-full items-center justify-center p-6">
          <p className="text-xs text-foreground/65">
            {t("newtab.content.empty")}
          </p>
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {run.content ? (
              <Streamdown
                mode="static"
                className="chat-md chat-md--glass break-words text-sm text-foreground/90"
              >
                {run.content}
              </Streamdown>
            ) : (
              <p className="text-xs text-foreground/65">
                {t("newtab.content.empty.row")}
              </p>
            )}
            {run.truncatedBySize && (
              <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
                {t("newtab.content.truncated")}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-foreground/[0.04] px-4 py-2">
            <button
              type="button"
              onClick={() => onContinueInChat(run)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                "bg-foreground text-background hover:bg-foreground/85",
              )}
            >
              <MessageSquare className="h-3.5 w-3.5" />
              {t("newtab.continueInChat")}
            </button>
          </div>
        </>
      )}
    </ModuleCard>
  );
}

function ContentSkeleton() {
  return (
    <div className="space-y-3 px-6 py-5">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="h-4 animate-pulse rounded bg-muted/40"
          style={{ width: `${[88, 72, 95, 60][i]}%` }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

interface ComposerCardProps {
  value: string;
  onChange: (v: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  canSend: boolean;
  busy: boolean;
  /** Quick-action chips rendered below the textarea. Empty list = no strip. */
  quickActions: ResolvedQuickAction[];
  /** Click handler for a chip — caller wraps the input with `renderQuickActionPrompt`. */
  onQuickAction: (action: ResolvedQuickAction) => void;
  /**
   * When the bottom dashboard peek is open, the available area above it
   * is small; we lower the textarea's auto-grow cap so it scrolls
   * internally instead of being hidden behind the peek panel. Collapsing
   * the peek restores the full cap. The composer never resizes the user's
   * typed text — it just changes when the internal scrollbar takes over.
   */
  peekExpanded: boolean;
}

/**
 * Rotating placeholder typewriter for the composer. Cycles through a
 * list of example prompts, typing each one out one character at a
 * time, holding for a beat, then deleting and moving to the next. The
 * effect pauses while `active` is false (passed in as
 * `!value && !busy` so it stops as soon as the user starts typing or
 * a send is in flight).
 *
 * Implementation notes:
 *   - State machine (`typing` / `holding` / `deleting`) lives in a
 *     ref so the single `useEffect` doesn't need to re-run on every
 *     character. `setOutput` triggers the re-render, the loop schedules
 *     the next step via `setTimeout` recursively.
 *   - `prefers-reduced-motion: reduce` short-circuits to the first
 *     example shown statically — same affordance, no animation cost.
 *   - Per-char typing speed jitters by ±40ms so the cadence reads as
 *     "someone is typing" rather than "a CSS animation is running".
 */
function useTypewriterPlaceholder(
  active: boolean,
  examples: readonly string[],
): string {
  const [output, setOutput] = useState("");
  const stateRef = useRef<{
    idx: number;
    charIdx: number;
    phase: "typing" | "holding" | "deleting";
  }>({ idx: 0, charIdx: 0, phase: "typing" });

  useEffect(() => {
    if (examples.length === 0) return;

    // Respect users who've opted out of motion: show the first
    // example statically and skip the animation loop entirely.
    const reducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      setOutput(examples[0] ?? "");
      return;
    }

    if (!active) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function tick() {
      if (cancelled) return;
      const { idx, charIdx, phase } = stateRef.current;
      const current = examples[idx] ?? "";

      if (phase === "typing") {
        if (charIdx < current.length) {
          stateRef.current = { idx, charIdx: charIdx + 1, phase };
          setOutput(current.slice(0, charIdx + 1));
          timer = setTimeout(tick, 55 + Math.random() * 50);
        } else {
          stateRef.current = { idx, charIdx, phase: "holding" };
          timer = setTimeout(tick, 1800);
        }
      } else if (phase === "holding") {
        stateRef.current = { idx, charIdx, phase: "deleting" };
        timer = setTimeout(tick, 0);
      } else {
        // deleting
        if (charIdx > 0) {
          stateRef.current = { idx, charIdx: charIdx - 1, phase };
          setOutput(current.slice(0, charIdx - 1));
          timer = setTimeout(tick, 22);
        } else {
          stateRef.current = {
            idx: (idx + 1) % examples.length,
            charIdx: 0,
            phase: "typing",
          };
          timer = setTimeout(tick, 250);
        }
      }
    }

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, examples]);

  return output;
}

/**
 * Cap on auto-grown composer height when the bottom peek panel is
 * collapsed (the normal case). Above this, the textarea grows an
 * internal scrollbar instead of pushing the rest of the page down.
 * Tuned so the homepage shortcuts strip remains visible on a 720px
 * viewport even with a wall-of-text draft open.
 */
const COMPOSER_MAX_HEIGHT_PX = 280;

/**
 * Reduced cap when the bottom peek panel is expanded. With peek open, the
 * `main` area shrinks to ~280px minimum (see `Home`'s pb expression), and
 * that 280px is shared with the greeting + shortcuts strip. Capping the
 * textarea here at ~160px keeps composer + neighbours inside the visible
 * area instead of letting the textarea grow under the peek panel.
 */
const COMPOSER_MAX_HEIGHT_PEEKED_PX = 160;

const ComposerCard = forwardRef<HTMLTextAreaElement, ComposerCardProps>(
  function ComposerCard(
    {
      value,
      onChange,
      onKeyDown,
      onSend,
      canSend,
      busy,
      quickActions,
      onQuickAction,
      peekExpanded,
    },
    ref,
  ) {
    const { t } = useT();
    // Memoise so the typewriter effect doesn't restart on every render.
    // Re-derived only when the locale changes.
    const placeholderExamples = useMemo(
      () => [
        t("newtab.placeholder.example.1"),
        t("newtab.placeholder.example.2"),
        t("newtab.placeholder.example.3"),
        t("newtab.placeholder.example.4"),
        t("newtab.placeholder.example.5"),
      ],
      [t],
    );
    const placeholder = useTypewriterPlaceholder(
      !value && !busy,
      placeholderExamples,
    );
    const hasQuickActions = quickActions.length > 0;
    const chipsDisabled = busy || !value.trim();

    // Auto-grow: HTML <textarea> respects `rows` for initial height and
    // shows an internal scrollbar past it. To grow with content we
    // measure scrollHeight on each value change and set explicit height,
    // capped by COMPOSER_MAX_HEIGHT_PX (overflow flips back to scrollbar
    // once we hit the cap).
    const internalRef = useRef<HTMLTextAreaElement | null>(null);
    const setTextareaRef = useCallback(
      (el: HTMLTextAreaElement | null) => {
        internalRef.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
      },
      [ref],
    );
    const maxHeight = peekExpanded
      ? COMPOSER_MAX_HEIGHT_PEEKED_PX
      : COMPOSER_MAX_HEIGHT_PX;
    // Last measured natural content height (via the `height = "auto"`
    // trick). Cached so the peek-toggle path can re-clamp without
    // re-measuring — measuring forces an intermediate `auto` style write
    // that breaks CSS height transitions.
    const measuredHeightRef = useRef(0);

    // Keystroke path: re-measure with the auto-trick and apply
    // instantly. CSS transition is suppressed for this write so the
    // per-line growth reads as direct typing feedback, not a draggy
    // animation. We restore the inline transition (back to the CSS
    // class) right after so the peek-toggle path below keeps its
    // animation.
    useLayoutEffect(() => {
      const el = internalRef.current;
      if (!el) return;
      const prevTransition = el.style.transition;
      el.style.transition = "none";
      el.style.height = "auto";
      const sh = el.scrollHeight;
      measuredHeightRef.current = sh;
      const next = Math.min(sh, maxHeight);
      el.style.height = `${next}px`;
      el.style.overflowY = sh > maxHeight ? "auto" : "hidden";
      // Force the no-transition write to commit before restoring the
      // transition for subsequent (peek-driven) writes.
      void el.offsetHeight;
      el.style.transition = prevTransition;
      // Intentionally deps on `value` only — peek changes are handled
      // by the effect below, which animates the clamp.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value]);

    // Peek-toggle path: clamp the cached scrollHeight against the new
    // cap. Pure pixel-to-pixel write, so the CSS `transition-[height]`
    // on the Textarea handles the animation.
    useLayoutEffect(() => {
      const el = internalRef.current;
      if (!el) return;
      const sh = measuredHeightRef.current;
      const next = Math.min(sh, maxHeight);
      el.style.height = `${next}px`;
      el.style.overflowY = sh > maxHeight ? "auto" : "hidden";
    }, [maxHeight]);

    return (
      <div
        className={cn(
          // `rounded-2xl` (16px) sits in the same "card" family as the
          // dashboard cards (`rounded-xl`) instead of drifting into
          // pill territory. Inner flex column splits the textarea from
          // the action row so typed text never flows under controls.
          "flex flex-col rounded-2xl",
          // Single flat-ish glass surface — no gradient, no saturate,
          // no brightness adjustment. Just a clean translucent panel
          // over `backdrop-blur`. Cleanliness was suffering from too
          // many overlapping tone-shifts.
          "bg-card/70 backdrop-blur-2xl",
          // One outer drop shadow. That's it — no inset highlight,
          // no tight middle layer. The composer is the focal point
          // of the page; it doesn't need to "sell glass" with stacked
          // shadow tricks the way the smaller pills do.
          "shadow-[0_10px_30px_-12px_rgb(0_0_0_/_0.18)]",
          "dark:shadow-[0_10px_30px_-12px_rgb(0_0_0_/_0.5)]",
          "transition-colors duration-200",
          "focus-within:bg-card/85",
        )}
      >
        <Textarea
          ref={setTextareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={2}
          disabled={busy}
          // `transition-[height]` animates the peek-toggle clamp
          // (full cap ↔ peeked cap). Keystroke growth is intentionally
          // NOT animated — the value-driven effect above suppresses
          // this transition so per-line growth feels like direct typing
          // feedback, not a slow ramp. Duration loosely matches the
          // peek panel's 500ms so they read as one coordinated motion.
          className="min-h-[3.5rem] resize-none border-0 bg-transparent px-5 pb-1 pt-3.5 text-sm shadow-none transition-[height] duration-500 ease-out focus-visible:ring-0 focus-visible:ring-offset-0"
        />
        <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-0.5">
          {hasQuickActions ? (
            <div
              role="toolbar"
              aria-label={t("composer.quick.empty.tooltip")}
              className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
            >
              {quickActions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  onClick={() => onQuickAction(action)}
                  disabled={chipsDisabled}
                  title={
                    chipsDisabled && !busy
                      ? t("composer.quick.empty.tooltip")
                      : action.tooltip
                  }
                  className={cn(
                    "inline-flex h-6 shrink-0 select-none items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                    chipsDisabled
                      ? "cursor-not-allowed border-foreground/10 bg-transparent text-foreground/35"
                      : "cursor-pointer border-foreground/15 bg-background/60 text-foreground/80 hover:bg-foreground/10 hover:text-foreground",
                  )}
                >
                  <Sparkles className="h-3 w-3" />
                  <span className="max-w-[10rem] truncate">{action.label}</span>
                </button>
              ))}
            </div>
          ) : (
            // Empty growable spacer keeps the Send button anchored to the
            // right when there are no chips to push it there.
            <div className="flex-1" />
          )}
          <button
            type="button"
            onClick={onSend}
            disabled={!canSend}
            title={t("newtab.send.tooltip")}
            aria-label={t("newtab.send")}
            className={cn(
              "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
              "transition-colors duration-200",
              canSend
                ? "bg-foreground text-background hover:bg-foreground/85"
                : "bg-foreground/10 text-foreground/30",
            )}
          >
            <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.5} />
          </button>
        </div>
      </div>
    );
  },
);

// ---------------------------------------------------------------------------
// Resume section — right column
// ---------------------------------------------------------------------------

function ResumeSection({
  ready,
  items,
  busy,
  onOpenSession,
}: {
  ready: boolean;
  items: ResumeItem[];
  busy: boolean;
  onOpenSession: (id: string) => void;
}) {
  const { t } = useT();
  if (!ready || items.length === 0) return null;

  return (
    <ModuleCard
      title={t("newtab.recentChats")}
      meta={
        <span className="text-[10px] text-foreground/60">
          {t("newtab.clickToResume")}
        </span>
      }
      sizeClass="min-h-0 min-w-0 flex-1 lg:flex-1"
    >
      <ul className="divide-y divide-foreground/[0.04]">
        {items.map((item) => (
          <li key={item.id}>
            <ResumeRow item={item} busy={busy} onOpenSession={onOpenSession} />
          </li>
        ))}
      </ul>
    </ModuleCard>
  );
}

function ResumeRow({
  item,
  busy,
  onOpenSession,
}: {
  item: ResumeItem;
  busy: boolean;
  onOpenSession: (id: string) => void;
}) {
  const { t } = useT();
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => onOpenSession(item.id)}
      className={cn(
        "flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors",
        "hover:bg-muted/50",
        "disabled:cursor-not-allowed disabled:opacity-50",
      )}
    >
      <MessageSquare className="h-3.5 w-3.5 shrink-0 text-foreground/55" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-foreground">
          {item.title}
        </span>
      </span>
      {item.messageCount > 0 && (
        <span className="shrink-0 tabular-nums text-[10px] text-foreground/55">
          {t("newtab.row.msgs", { count: item.messageCount })}
        </span>
      )}
      <span className="shrink-0 tabular-nums text-[10px] text-foreground/60">
        {formatRelative(item.ts, t)}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelative(
  ms: number | undefined,
  t: ReturnType<typeof useT>["t"],
): string {
  if (!ms) return "";
  const diffSec = Math.round((Date.now() - ms) / 1000);
  if (diffSec < 60) return t("newtab.relative.justNow");
  if (diffSec < 3600) {
    return t("newtab.relative.mAgo", { n: Math.floor(diffSec / 60) });
  }
  if (diffSec < 86400) {
    return t("newtab.relative.hAgo", { n: Math.floor(diffSec / 3600) });
  }
  if (diffSec < 86400 * 7) {
    return t("newtab.relative.dAgo", { n: Math.floor(diffSec / 86400) });
  }
  return new Date(ms).toLocaleDateString();
}
