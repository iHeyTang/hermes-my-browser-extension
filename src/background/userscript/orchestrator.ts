/**
 * Userscript orchestrator.
 *
 * Owns install / save / remove / enable lifecycle and the persistent store.
 *
 * Auto-injection on page load is handled entirely by the static bouncer
 * content script in `src/contents/userscript-host.ts` — it queries the SW
 * for matching scripts per URL and injects an inline `<script>` carrying
 * the wrapped runtime. This avoids the cost and ordering hazards of
 * `chrome.scripting.registerContentScripts` while still honouring the four
 * `@run-at` modes (the host script schedules them itself).
 *
 * Manual "force run on agent tab" is implemented via a one-shot
 * `chrome.scripting.executeScript` injection that goes straight to the
 * page in MAIN world.
 */

import type { UserScript } from "~lib/types";

import { parseUserScript } from "./parser";
import {
  cacheScriptResources,
  dropScriptResources,
  getCachedResource,
  requireName,
} from "./resources";
import { deleteScript, getScript, listScripts, putScript } from "./store";

// ---------------------------------------------------------------------------
// Install / save / remove / enable
// ---------------------------------------------------------------------------

export interface InstallOpts {
  enabled?: boolean;
  sourceURL?: string;
}

export async function installUserscriptFromSource(
  source: string,
  opts: InstallOpts = {},
): Promise<UserScript> {
  const meta = parseUserScript(source);
  const id = makeScriptId(meta.name, meta.namespace);
  const now = Date.now();
  const script: UserScript = {
    id,
    source,
    meta,
    enabled: opts.enabled !== false,
    installedAt: now,
    updatedAt: now,
    sourceURL: opts.sourceURL,
  };
  await putScript(script);
  await cacheScriptResources(script).catch((e) =>
    console.warn("[hermes-userscript] resource cache failed:", e),
  );
  return script;
}

export async function installUserscriptFromUrl(
  url: string,
  opts: InstallOpts = {},
): Promise<UserScript> {
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  }
  const source = await res.text();
  return installUserscriptFromSource(source, { ...opts, sourceURL: url });
}

export async function updateUserscript(
  id: string,
  source: string,
): Promise<UserScript> {
  const existing = await getScript(id);
  if (!existing) throw new Error(`Script not found: ${id}`);
  const meta = parseUserScript(source);
  const updated: UserScript = {
    ...existing,
    source,
    meta,
    updatedAt: Date.now(),
  };
  await putScript(updated);
  await cacheScriptResources(updated).catch((e) =>
    console.warn("[hermes-userscript] resource cache failed:", e),
  );
  return updated;
}

export async function removeUserscript(id: string): Promise<void> {
  await dropScriptResources(id).catch(() => {});
  await deleteScript(id);
}

export async function setUserscriptEnabled(
  id: string,
  enabled: boolean,
): Promise<UserScript> {
  const existing = await getScript(id);
  if (!existing) throw new Error(`Script not found: ${id}`);
  const updated = { ...existing, enabled, updatedAt: Date.now() };
  await putScript(updated);
  return updated;
}

export async function listUserscripts(): Promise<UserScript[]> {
  return listScripts();
}

// SW lifecycle hook — called from background entry on (re)bootstrap.
// Currently a no-op; reserved so we can later add idempotent re-validation.
export async function reapplyAllRegistrations(): Promise<void> {
  return;
}

// ---------------------------------------------------------------------------
// Manual run on a caller-chosen tab (used by `userscript.run` bridge method).
// The target tab is resolved by the caller via `resolveTargetTab()` so the
// same userscript can be forced onto either the agent surface or the user's
// tab depending on the current run-target.
// ---------------------------------------------------------------------------

export async function runUserscriptOnTab(
  id: string,
  tabId: number,
  args: unknown,
): Promise<{ ok: boolean; value: unknown; error: string | null }> {
  const script = await getScript(id);
  if (!script) throw new Error(`Script not found: ${id}`);

  // Materialise @require sources for the manual run too.
  const requires: string[] = [];
  for (const url of script.meta.require) {
    const cached = await getCachedResource(script.id, requireName(url));
    if (cached) requires.push(cached.text);
  }
  const resources: Array<{ name: string; url: string; dataUrl: string }> = [];
  for (const r of script.meta.resource) {
    const cached = await getCachedResource(script.id, r.name);
    if (cached) {
      resources.push({ name: r.name, url: r.url, dataUrl: cached.dataUrl });
    }
  }

  const payload = {
    id: script.id,
    name: script.meta.name,
    source: script.source,
    meta: script.meta,
    requires,
    resources,
    runtimeArgs: args ?? null,
  };

  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    world: pickWorld(script),
    args: [payload],
    func: (script: typeof payload) => {
      // Bridge back to the bouncer (which lives in ISOLATED world). When the
      // forced run happens in MAIN world, we postMessage; the bouncer picks
      // it up and applies the wrapped-source injection. When MAIN world is
      // unavailable (sandboxed pages), this still runs but won't get GM_*.
      try {
        window.postMessage(
          { type: "hermes:userscript-run", script },
          window.location.origin,
        );
      } catch (e) {
        console.warn("[hermes-userscript] forced run dispatch failed", e);
      }
      return { dispatched: true };
    },
  });

  const frame = results[0]?.result as { dispatched?: boolean } | undefined;
  return {
    ok: !!frame?.dispatched,
    value: frame ?? null,
    error: frame?.dispatched ? null : "executeScript returned no frame",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickWorld(script: UserScript): "MAIN" | "ISOLATED" {
  if (script.meta.grant.includes("ISOLATED")) return "ISOLATED";
  return "MAIN";
}

function makeScriptId(name: string, namespace?: string): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24);
  const base = slug(`${namespace || ""}-${name || "script"}`) || "script";
  const rand = Math.random().toString(36).slice(2, 8);
  return `${base}-${rand}`;
}
