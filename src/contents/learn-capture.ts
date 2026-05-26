/**
 * Captures clicks, form input, and submits on the recorded tab (learn mode).
 * Navigation is handled in the service worker via tabs.onUpdated.
 */

import type { PlasmoCSConfig } from "plasmo";

import type { LearnSelectorHints, LearnTraceEvent } from "~lib/learn/types";
import { LEARN_STORAGE_KEYS } from "~lib/learn/types";

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  run_at: "document_idle",
  all_frames: true,
};

let attached = false;
let inputTimer: ReturnType<typeof setTimeout> | null = null;

function isRestrictedPage(): boolean {
  const p = location.protocol;
  return (
    p === "chrome-extension:" ||
    p === "chrome:" ||
    p === "devtools:" ||
    p === "moz-extension:"
  );
}

function simpleCssPath(el: Element | null): string | undefined {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return undefined;
  if (el === document.documentElement) return ":root";
  if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) {
    return `#${CSS.escape(el.id)}`;
  }
  const parts: string[] = [];
  let cur: Element | null = el;
  let depth = 0;
  while (cur && cur !== document.body && depth < 8) {
    const tag = cur.tagName.toLowerCase();
    const parent = cur.parentElement;
    if (!parent) break;
    const siblings = Array.from(parent.children).filter(
      (c) => c.tagName === cur!.tagName,
    );
    const idx = siblings.indexOf(cur) + 1;
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);
    cur = parent;
    depth++;
  }
  return parts.length ? `body > ${parts.join(" > ")}` : undefined;
}

function hintsFor(el: Element | null): LearnSelectorHints | undefined {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return undefined;
  const tag = el.tagName.toLowerCase();
  const idAttr = el.id || undefined;
  const dataTestId =
    el.getAttribute("data-testid") ||
    el.getAttribute("data-test-id") ||
    undefined;
  const nameAttr =
    (el as HTMLInputElement).name ||
    el.getAttribute("name") ||
    undefined;
  const role = el.getAttribute("role") || undefined;
  const ariaLabel = el.getAttribute("aria-label") || undefined;
  let textSnippet: string | undefined;
  const itext = (el as HTMLElement).innerText?.trim();
  if (itext) {
    textSnippet =
      itext.length <= 80 ? itext : `${itext.slice(0, 77)}…`;
  }
  return {
    css: simpleCssPath(el),
    idAttr,
    dataTestId: dataTestId || undefined,
    name: nameAttr || undefined,
    role: role || undefined,
    ariaLabel: ariaLabel || undefined,
    tag,
    textSnippet,
  };
}

function sendPartial(
  partial: Omit<LearnTraceEvent, "t" | "url" | "title"> &
    Partial<Pick<LearnTraceEvent, "title">>,
) {
  if (isRestrictedPage()) return;
  void chrome.runtime.sendMessage({
    type: "learn.capture",
    payload: {
      ...partial,
      url: location.href,
      title: document.title || undefined,
      frameUrl: window === window.top ? undefined : location.href,
    },
  });
}

function onClickCapture(ev: MouseEvent) {
  if (ev.button !== 0) return;
  const t = ev.target;
  const el =
    t instanceof Element
      ? t
      : t instanceof Node && t.parentElement instanceof Element
        ? t.parentElement
        : null;
  if (!el) return;
  const link = el.closest("a");
  const href =
    link?.href && !link.href.startsWith("javascript:")
      ? link.href
      : undefined;
  sendPartial({
    type: "click",
    selectors: hintsFor(el),
    href,
  });
}

function flushInput(el: HTMLInputElement | HTMLTextAreaElement) {
  inputTimer = null;
  const isPwd = el.type === "password";
  sendPartial({
    type: "input",
    selectors: hintsFor(el),
    value: isPwd ? "[REDACTED]" : el.value,
    valueRedacted: isPwd,
  });
}

function onInput(ev: Event) {
  const t = ev.target;
  if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement))
    return;
  if (inputTimer) clearTimeout(inputTimer);
  inputTimer = setTimeout(() => flushInput(t), 400);
}

function onChange(ev: Event) {
  const t = ev.target;
  if (t instanceof HTMLSelectElement) {
    sendPartial({
      type: "change",
      selectors: hintsFor(t),
      value: t.value,
    });
    return;
  }
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) {
    const isPwd = t.type === "password";
    sendPartial({
      type: "change",
      selectors: hintsFor(t),
      value: isPwd ? "[REDACTED]" : t.value,
      valueRedacted: isPwd,
    });
  }
}

function onSubmit(ev: Event) {
  const form = ev.target;
  if (!(form instanceof HTMLFormElement)) return;
  const hint =
    form.getAttribute("name") || form.id || form.className || "form";
  sendPartial({
    type: "submit",
    selectors: {
      tag: "form",
      idAttr: form.id || undefined,
      name: form.getAttribute("name") || undefined,
      textSnippet:
        typeof hint === "string" ? hint.slice(0, 80) : "form",
    },
  });
}

function attach() {
  if (attached) return;
  attached = true;
  document.addEventListener("click", onClickCapture, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("change", onChange, true);
  document.addEventListener("submit", onSubmit, true);
}

function detach() {
  if (!attached) return;
  attached = false;
  if (inputTimer) {
    clearTimeout(inputTimer);
    inputTimer = null;
  }
  document.removeEventListener("click", onClickCapture, true);
  document.removeEventListener("input", onInput, true);
  document.removeEventListener("change", onChange, true);
  document.removeEventListener("submit", onSubmit, true);
}

async function syncFromStorage() {
  const data = await chrome.storage.local.get(LEARN_STORAGE_KEYS.meta);
  const meta = data[LEARN_STORAGE_KEYS.meta] as { active?: boolean } | undefined;
  if (meta?.active) attach();
  else detach();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[LEARN_STORAGE_KEYS.meta]) void syncFromStorage();
});

void syncFromStorage();
