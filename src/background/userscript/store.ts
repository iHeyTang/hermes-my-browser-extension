/**
 * Userscript persistent store.
 *
 * Storage layout:
 *   chrome.storage.local["userscripts.index"] = string[]      // ordered list of script ids
 *   chrome.storage.local["userscripts.script.<id>"] = UserScript
 *
 * Resource caches (large blobs from `@require` and `@resource`) live in
 * IndexedDB — see `resources.ts`.
 */

import type { UserScript } from "~lib/types";

const INDEX_KEY = "userscripts.index";
const SCRIPT_PREFIX = "userscripts.script.";
const SCRIPT_VALUE_PREFIX = "userscripts.gmvalues.";

function scriptKey(id: string) {
  return `${SCRIPT_PREFIX}${id}`;
}

export async function listScriptIds(): Promise<string[]> {
  const { [INDEX_KEY]: ids } = await chrome.storage.local.get(INDEX_KEY);
  return Array.isArray(ids) ? (ids as string[]) : [];
}

export async function listScripts(): Promise<UserScript[]> {
  const ids = await listScriptIds();
  if (ids.length === 0) return [];
  const keys = ids.map(scriptKey);
  const items = await chrome.storage.local.get(keys);
  return ids
    .map((id) => items[scriptKey(id)] as UserScript | undefined)
    .filter((s): s is UserScript => !!s);
}

export async function getScript(id: string): Promise<UserScript | null> {
  const { [scriptKey(id)]: s } = await chrome.storage.local.get(scriptKey(id));
  return (s as UserScript) || null;
}

export async function putScript(s: UserScript): Promise<void> {
  const ids = await listScriptIds();
  if (!ids.includes(s.id)) ids.push(s.id);
  await chrome.storage.local.set({
    [INDEX_KEY]: ids,
    [scriptKey(s.id)]: s,
  });
}

export async function deleteScript(id: string): Promise<void> {
  const ids = (await listScriptIds()).filter((x) => x !== id);
  await chrome.storage.local.set({ [INDEX_KEY]: ids });
  await chrome.storage.local.remove(scriptKey(id));
  // Drop GM_setValue store namespace for this script.
  const all = (await chrome.storage.local.get(
    undefined as unknown as string,
  )) as Record<string, unknown>;
  const ns = `${SCRIPT_VALUE_PREFIX}${id}.`;
  const toDrop = Object.keys(all).filter((k) => k.startsWith(ns));
  if (toDrop.length) await chrome.storage.local.remove(toDrop);
}

// ---------------------------------------------------------------------------
// GM_setValue / GM_getValue store — namespaced by script id.
// ---------------------------------------------------------------------------

export function valueKey(scriptId: string, name: string) {
  return `${SCRIPT_VALUE_PREFIX}${scriptId}.${name}`;
}

export async function getValue(
  scriptId: string,
  name: string,
  fallback: unknown,
): Promise<unknown> {
  const k = valueKey(scriptId, name);
  const { [k]: v } = await chrome.storage.local.get(k);
  return v === undefined ? fallback : v;
}

export async function setValue(
  scriptId: string,
  name: string,
  value: unknown,
): Promise<void> {
  await chrome.storage.local.set({ [valueKey(scriptId, name)]: value });
}

export async function deleteValue(
  scriptId: string,
  name: string,
): Promise<void> {
  await chrome.storage.local.remove(valueKey(scriptId, name));
}

export async function listValues(scriptId: string): Promise<string[]> {
  const all = (await chrome.storage.local.get(
    undefined as unknown as string,
  )) as Record<string, unknown>;
  const prefix = `${SCRIPT_VALUE_PREFIX}${scriptId}.`;
  return Object.keys(all)
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));
}
