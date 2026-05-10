/**
 * Read user-supplied `File` / fetched `Blob` objects into composer-ready
 * `FileAttachment`s.
 *
 * The pipeline does these in order:
 *
 *   1. Size cap (matches Python `MAX_ATTACHMENT_BYTES`).
 *
 *   2. Upload the *full* bytes: side panel → `fetch(ATTACHMENT_HTTP_BASE/attach)`
 *      (raw POST body) to the bridge process — same on-disk layout as the
 *      Python `attachment.put` handler; there is no WebSocket / sendMessage
 *      upload path in the extension.
 *
 *   3. Optional preview (thumbnail / text snippet) *after* upload, with
 *      timeouts so it cannot block clearing the "uploading" chip.
 *
 * Errors are returned as plain strings so the caller can surface them
 * inline without juggling exception types — none of the failure modes
 * here (size cap, decode error, bridge disconnected, write error) are
 * "exceptional" enough to warrant a thrown error.
 *
 * Anything goes: every file kind is accepted (matching the user's
 * intention that "what the agent can identify is the agent's job"). We
 * only classify for *presentation* — the upload path is identical for
 * every type.
 */

import { ATTACHMENT_HTTP_BASE } from "~background/config";
import { shortId } from "~lib/utils";

import type {
  Attachment,
  AttachmentBadge,
  AttachmentKind,
  FileAttachment,
} from "./types";

// Hard limit, deliberately conservative for a side-panel context. Mirrors
// `MAX_ATTACHMENT_BYTES` on the Python side; if these drift apart the
// caller will see an opaque "attachment too large" error from the bridge.
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024; // 50 MB

/** How many decoded characters of text-ish content to keep for chip preview. */
const TEXT_PREVIEW_CHARS = 500;
/** Longest edge for the chip-side image thumbnail. */
const THUMB_LONG_EDGE = 256;
const IMAGE_REENCODE_QUALITY = 0.85;

/** Previews are best-effort; never block the bridge upload on them. */
const PREVIEW_BUDGET_MS = 20_000;
/** Upper bound for `fetch(/attach)` so the composer cannot spin forever. */
const PUT_MESSAGE_BUDGET_MS = 130_000;

const PREVIEW_TIMED_OUT = Symbol("previewTimedOut");

async function withBudget<T>(
  p: Promise<T>,
  ms: number,
): Promise<T | typeof PREVIEW_TIMED_OUT> {
  let tid: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof PREVIEW_TIMED_OUT>((resolve) => {
    tid = setTimeout(() => resolve(PREVIEW_TIMED_OUT), ms);
  });
  try {
    return await Promise.race([p as Promise<T>, timeout]);
  } finally {
    if (tid !== undefined) clearTimeout(tid);
  }
}

const IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/avif",
  "image/svg+xml",
]);

/**
 * Common text-ish extensions whose MIME types are routinely reported as
 * `""` or `application/octet-stream` by the OS. We classify these as
 * "text" so the chip shows a snippet preview and `kind="text"` is forwarded
 * to the agent. Kept lowercase, no leading dot.
 */
const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "rst",
  "log",
  "csv",
  "tsv",
  "json",
  "jsonc",
  "ndjson",
  "yml",
  "yaml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "xml",
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "sql",
  "graphql",
  "gql",
  "vue",
  "svelte",
  "tex",
  "patch",
  "diff",
  "lua",
  "r",
  "dart",
  "scala",
  "clj",
]);

/**
 * `accept` value for the hidden `<input type=file>`. We deliberately allow
 * **everything**: the agent decides what it can do with whatever the user
 * picks, so there's no point gating at the picker.
 */
export const ATTACHMENT_INPUT_ACCEPT = "*/*";

export type AttachmentReadOk = { ok: true; attachment: Attachment };
export type AttachmentReadFail = { ok: false; error: string; name: string };
export type AttachmentReadResult = AttachmentReadOk | AttachmentReadFail;

/**
 * Type guard distinguishing the success vs. error variants. Plasmo's
 * shipped tsconfig uses `strict: false`, which means discriminated-
 * union narrowing through a boolean tag (`r.ok`) doesn't always kick in;
 * a function-shaped guard works regardless of strict-mode settings, so
 * call sites use this instead of bare `if (r.ok)`.
 */
export function isAttachmentReadOk(
  r: AttachmentReadResult,
): r is AttachmentReadOk {
  return r.ok === true;
}

/** Settings every read needs from the call site. */
export interface AttachmentReadOptions {
  /**
   * UUID of the side-panel chat session this attachment belongs to. Used
   * by Python to group uploads in `~/.hermes/plugins/.../attachments/<id>/`
   * so we can GC them when the chat is deleted. Pass `"default"` (or
   * anything stable) if you don't have a session id yet.
   */
  sessionId: string;
  /**
   * When the UI already showed a pending row (spinner), pass the same id so
   * the completed attachment replaces that row. If we mint a fresh id here
   * instead, a missed state merge leaves the chip stuck on "uploading".
   */
  uiId?: string;
  /** Set when the attachment was auto-created from the user's current tab. */
  fromPageContext?: boolean;
  /** Original URL for `fromPageContext` attachments — surfaced in the prompt. */
  sourceUrl?: string;
}

/**
 * Read a `File` (file picker / drag / paste) into a composer attachment.
 */
export async function readFileAsAttachment(
  file: File,
  options: AttachmentReadOptions,
): Promise<AttachmentReadResult> {
  return readBlobAsAttachment({
    blob: file,
    name: file.name || "file",
    mime: file.type || "",
    options,
  });
}

/**
 * Read a `Blob` (e.g. fetched from a URL) into a composer attachment. The
 * `File`-based entry point delegates to this so the file-picker path and
 * the page-context auto-attach path share one pipeline.
 */
export async function readBlobAsAttachment(args: {
  blob: Blob;
  name: string;
  mime?: string;
  options: AttachmentReadOptions;
}): Promise<AttachmentReadResult> {
  const { blob, options } = args;
  const name = sanitizeDisplayName(args.name);
  const mime = (args.mime || blob.type || "").toLowerCase();
  const size = blob.size;

  if (size <= 0) {
    return {
      ok: false,
      error: "File is empty.",
      name,
    };
  }
  if (size > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      error: `File is ${formatBytesShort(size)}; the limit is ${formatBytesShort(MAX_ATTACHMENT_BYTES)}.`,
      name,
    };
  }

  const kind = classify(name, mime);

  // Upload first. We used to build image/text previews *before* this step;
  // `buildImageThumbnail` / `decode` can hang or run for minutes on some
  // inputs (huge PNGs, exotic codecs), which left the composer stuck on
  // "uploading" because the bridge was never contacted.
  let path: string;
  try {
    path = await uploadBlobViaAttachHttp(blob, name, mime, options.sessionId);
  } catch (e) {
    return {
      ok: false,
      error: (e as Error)?.message || String(e),
      name,
    };
  }

  // Preview side-channel — failures and slow paths are non-fatal.
  let thumbDataUrl: string | undefined;
  let textPreview: string | undefined;
  try {
    if (kind === "image") {
      const r = await withBudget(
        buildImageThumbnail(blob, mime || "image/png"),
        PREVIEW_BUDGET_MS,
      );
      if (r === PREVIEW_TIMED_OUT) {
        console.warn("[attachments] thumbnail timed out; continuing without preview");
      } else {
        thumbDataUrl = r;
      }
    } else if (kind === "text") {
      const r = await withBudget(buildTextPreview(blob), PREVIEW_BUDGET_MS);
      if (r === PREVIEW_TIMED_OUT) {
        console.warn("[attachments] text preview timed out; continuing without preview");
      } else {
        textPreview = r;
      }
    }
  } catch (e) {
    console.warn(
      "[attachments] preview generation failed:",
      (e as Error)?.message || e,
    );
  }

  const att: FileAttachment = {
    uiId: options.uiId ?? shortId("att"),
    name,
    mime: mime || "application/octet-stream",
    size,
    kind,
    path,
    uploading: false,
    ...(thumbDataUrl ? { thumbDataUrl } : {}),
    ...(textPreview ? { textPreview } : {}),
    ...(options.fromPageContext ? { fromPageContext: true } : {}),
    ...(options.sourceUrl ? { sourceUrl: options.sourceUrl } : {}),
  };
  return { ok: true, attachment: att };
}

/**
 * Classify a (sanitised) name + mime into the `AttachmentKind` we'll use
 * for chip presentation. Always returns *something* — there is no "this
 * file type is forbidden" branch any more.
 */
export function classify(name: string, mime: string): AttachmentKind {
  const m = (mime || "").toLowerCase();
  if (IMAGE_MIMES.has(m) || m.startsWith("image/")) return "image";
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("text/")) return "text";
  if (
    m === "application/json" ||
    m === "application/xml" ||
    m === "application/javascript" ||
    m === "application/typescript" ||
    m === "application/x-yaml"
  ) {
    return "text";
  }

  const dot = name.lastIndexOf(".");
  if (dot >= 0) {
    const ext = name.slice(dot + 1).toLowerCase();
    if (ext === "pdf") return "pdf";
    if (TEXT_EXTENSIONS.has(ext)) return "text";
    if (
      ext === "png" ||
      ext === "jpg" ||
      ext === "jpeg" ||
      ext === "gif" ||
      ext === "webp" ||
      ext === "bmp" ||
      ext === "avif" ||
      ext === "svg"
    ) {
      return "image";
    }
  }
  return "binary";
}

/**
 * Build the lightweight `AttachmentBadge` we persist on the user message.
 *
 * With the path-based model the badge is structurally a near-copy of the
 * live attachment — there's no multi-MB inline payload to drop. We keep
 * the function so call sites stay simple and so future divergence (e.g.
 * compressing the thumbnail further for storage) has a single seam.
 */
export async function attachmentToBadge(
  att: Attachment,
): Promise<AttachmentBadge> {
  return {
    uiId: att.uiId,
    name: att.name,
    mime: att.mime,
    size: att.size,
    kind: att.kind,
    ...(att.path ? { path: att.path } : {}),
    ...(att.thumbDataUrl ? { thumbDataUrl: att.thumbDataUrl } : {}),
    ...(att.fromPageContext ? { fromPageContext: true } : {}),
    ...(att.sourceUrl ? { sourceUrl: att.sourceUrl } : {}),
  };
}

/**
 * Best-effort cleanup: ask Python to unlink the file the attachment lives
 * at. Used when the user removes a chip pre-send or deletes a chat session.
 *
 * Always resolves — failures are logged but never thrown. The Python side
 * refuses any path outside the attachments root, so this can't be abused
 * to delete unrelated files even if the call site passes garbage.
 */
export async function deleteAttachmentFile(
  pathOrAtt: string | { path?: string },
): Promise<void> {
  const path =
    typeof pathOrAtt === "string" ? pathOrAtt : pathOrAtt?.path || "";
  if (!path) return;
  try {
    await chrome.runtime.sendMessage({ action: "attachment.delete", path });
  } catch (e) {
    console.warn(
      "[attachments] delete failed:",
      (e as Error)?.message || e,
    );
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface UploadResponse {
  ok: boolean;
  path?: string;
  error?: string;
}

/**
 * POST raw bytes to bridge HTTP (`/attach`) — sole upload path for composer files.
 */
async function uploadBlobViaAttachHttp(
  blob: Blob,
  name: string,
  mime: string,
  sessionId: string,
): Promise<string> {
  const ctype = mime || blob.type || "application/octet-stream";
  const q = new URLSearchParams({
    session_id: sessionId || "default",
    name,
    mime: ctype,
  });
  const url = `${ATTACHMENT_HTTP_BASE.replace(/\/$/, "")}/attach?${q.toString()}`;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), PUT_MESSAGE_BUDGET_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      body: blob,
      headers: { "Content-Type": ctype },
      signal: ctrl.signal,
    });
    const j = (await res.json()) as UploadResponse;
    if (!res.ok || !j.ok || !j.path) {
      throw new Error(j.error || `${res.status} ${res.statusText}`);
    }
    return j.path;
  } finally {
    clearTimeout(tid);
  }
}

/** Strip directory components and trim, falling back to "file" when empty. */
function sanitizeDisplayName(raw: string): string {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "file";
  const lastSlash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const base = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
  return base.trim() || "file";
}

/**
 * Convert a Blob to a raw base64 string (no `data:` URI prefix).
 *
 * FileReader yields `data:<mime>;base64,<b64>` so we slice off the prefix.
 * We deliberately don't use `btoa` over `await blob.text()` because the
 * blob may be binary and `btoa` only accepts Latin-1.
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const r = reader.result;
      if (typeof r !== "string") {
        reject(new Error("FileReader returned non-string result"));
        return;
      }
      const comma = r.indexOf(",");
      resolve(comma >= 0 ? r.slice(comma + 1) : r);
    };
    reader.onerror = () =>
      reject(reader.error || new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

async function buildTextPreview(blob: Blob): Promise<string | undefined> {
  // Cap the slice we decode so a 50MB log file doesn't pull a 50MB string
  // through TextDecoder for the sake of a 500-char preview.
  const slice = blob.slice(0, 16 * 1024);
  const text = await slice.text();
  if (!text) return undefined;
  return text.length > TEXT_PREVIEW_CHARS
    ? text.slice(0, TEXT_PREVIEW_CHARS) + "…"
    : text;
}

async function buildImageThumbnail(
  blob: Blob,
  mime: string,
): Promise<string | undefined> {
  // GIFs would freeze on the first frame after canvas re-encode, so we
  // pass them through untouched if they're already small enough; otherwise
  // we accept the freeze trade-off for a usable thumbnail.
  const sourceMime = mime || blob.type || "image/png";
  const dataUrl = await blobToDataUrl(blob);
  if (sourceMime === "image/svg+xml") {
    // SVGs scale natively; just return the data URL as the preview.
    return dataUrl;
  }
  return downscaleImageDataUrl(dataUrl, THUMB_LONG_EDGE, sourceMime);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const r = reader.result;
      if (typeof r === "string") resolve(r);
      else reject(new Error("FileReader returned non-string result"));
    };
    reader.onerror = () =>
      reject(reader.error || new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Downscale an image data URL so its longest edge is ≤ `maxLongEdge`,
 * re-encoding to JPEG (PNG kept for transparency-carrying inputs).
 */
async function downscaleImageDataUrl(
  dataUrl: string,
  maxLongEdge: number,
  fallbackMime: string,
): Promise<string | undefined> {
  const sourceMime = pickMimeFromDataUrl(dataUrl) || fallbackMime;
  if (sourceMime === "image/gif") {
    return dataUrl;
  }
  const img = await loadImage(dataUrl).catch(() => null);
  if (!img) return undefined;
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) return undefined;
  const longEdge = Math.max(w, h);
  if (longEdge <= maxLongEdge) return dataUrl;
  const scale = maxLongEdge / longEdge;
  const targetW = Math.max(1, Math.round(w * scale));
  const targetH = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, targetW, targetH);
  const outMime = sourceMime === "image/png" ? "image/png" : "image/jpeg";
  return outMime === "image/png"
    ? canvas.toDataURL("image/png")
    : canvas.toDataURL("image/jpeg", IMAGE_REENCODE_QUALITY);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image failed to load"));
    img.src = src;
  });
}

function pickMimeFromDataUrl(dataUrl: string): string | null {
  const m = /^data:([^;,]+)/i.exec(dataUrl);
  return m ? m[1].toLowerCase() : null;
}

export function formatBytesShort(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}
