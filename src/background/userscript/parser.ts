/**
 * `==UserScript== ... ==/UserScript==` metadata block parser.
 *
 * Tampermonkey-compatible: each `// @key value` line maps onto our
 * UserScriptMetadata. Multi-value keys (@match/@include/@exclude/@require/
 * @resource/@grant/@connect) accumulate into arrays. Unknown keys are
 * preserved into `extra` for round-tripping.
 */

import type { RunAt, UserScriptMetadata } from "~lib/types";

const HEADER_OPEN = /^\s*\/\/\s*==UserScript==\s*$/m;
const HEADER_CLOSE = /^\s*\/\/\s*==\/UserScript==\s*$/m;
const HEADER_LINE = /^\s*\/\/\s*@(\S+)\s*(.*)$/;

const VALID_RUN_AT: RunAt[] = [
  "document-start",
  "document-body",
  "document-end",
  "document-idle",
];

export class UserScriptParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserScriptParseError";
  }
}

export function parseUserScript(source: string): UserScriptMetadata {
  const open = source.match(HEADER_OPEN);
  const close = source.match(HEADER_CLOSE);
  if (!open || !close || (open.index ?? 0) >= (close.index ?? 0)) {
    throw new UserScriptParseError(
      "Missing or malformed `// ==UserScript== ... // ==/UserScript==` block",
    );
  }
  const block = source
    .slice((open.index ?? 0) + open[0].length, close.index ?? 0)
    .split(/\r?\n/);

  const meta: UserScriptMetadata = {
    name: "",
    match: [],
    include: [],
    exclude: [],
    excludeMatch: [],
    grant: [],
    require: [],
    resource: [],
    runAt: "document-idle",
    noframes: false,
    connect: [],
    extra: {},
  };

  for (const line of block) {
    const m = line.match(HEADER_LINE);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    switch (key) {
      case "name":
        meta.name ||= value;
        break;
      case "namespace":
        meta.namespace ||= value;
        break;
      case "version":
        meta.version ||= value;
        break;
      case "description":
        meta.description ||= value;
        break;
      case "author":
        meta.author ||= value;
        break;
      case "homepage":
      case "homepageurl":
      case "website":
      case "source":
        meta.homepage ||= value;
        break;
      case "icon":
      case "iconurl":
      case "defaulticon":
        meta.icon ||= value;
        break;
      case "match":
        if (value) meta.match.push(value);
        break;
      case "include":
        if (value) meta.include.push(value);
        break;
      case "exclude":
        if (value) meta.exclude.push(value);
        break;
      case "exclude-match":
        if (value) meta.excludeMatch.push(value);
        break;
      case "grant":
        if (value) meta.grant.push(value);
        break;
      case "require":
        if (value) meta.require.push(value);
        break;
      case "resource": {
        // Format: @resource <name> <url>
        const idx = value.search(/\s+/);
        if (idx > 0) {
          const name = value.slice(0, idx).trim();
          const url = value.slice(idx).trim();
          if (name && url) meta.resource.push({ name, url });
        }
        break;
      }
      case "run-at": {
        const v = value as RunAt;
        if (VALID_RUN_AT.includes(v)) meta.runAt = v;
        break;
      }
      case "noframes":
        meta.noframes = true;
        break;
      case "connect":
        if (value) meta.connect.push(value);
        break;
      case "updateurl":
        meta.updateURL ||= value;
        break;
      case "downloadurl":
        meta.downloadURL ||= value;
        break;
      case "supporturl":
        meta.supportURL ||= value;
        break;
      default: {
        const slot = (meta.extra[key] ||= []);
        if (value) slot.push(value);
      }
    }
  }

  if (!meta.name) meta.name = "Untitled userscript";
  // If no @grant declared, Tampermonkey treats this as `@grant none` —
  // the script runs in the page (MAIN world) without GM_* APIs. We model
  // that by leaving the `grant` array empty.
  return meta;
}

/**
 * Best-effort: extract just the `@updateURL` from a script source without
 * parsing the entire header. Cheap enough that we can call it during update
 * polling.
 */
export function readUpdateURL(source: string): string | null {
  const m = source.match(/\/\/\s*@updateURL\s+(\S+)/i);
  return m ? m[1] : null;
}
