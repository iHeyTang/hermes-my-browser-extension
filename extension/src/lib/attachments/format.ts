/**
 * Helpers for turning composer-time `FileAttachment`s into the on-the-wire
 * pieces of an OpenAI Chat Completions request.
 *
 * Single output: `formatFileAttachmentsForPrompt(...)` produces one
 * synthetic system message that lists every attachment in a fenced
 * `<file-attachment>` block. The block is *metadata only* — the actual
 * file contents live on disk at `path` and the agent uses its own
 * server-side tools (read_file / pdf-text / image / OCR / …) to read
 * them when it cares.
 *
 * Mirrors the shape used by `formatPageContextsForPrompt` in
 * `page-context/capture.ts` so the model sees one consistent pattern for
 * "extra reference material the user pinned to this turn".
 *
 * Image flag: `INLINE_IMAGES_AS_DATA_URL` is the escape hatch for going
 * back to OpenAI multimodal `image_url` content parts when an inlined
 * vision flow is preferable to the path-tool flow. False by default
 * (matching the project's path-only design); flipping it true does NOT
 * remove the path block — the model just gets both representations.
 */

import type { FileAttachment } from "./types";

/**
 * When true, image attachments also get inlined as `image_url` content
 * parts on the user message so a vision-capable model can "see" them
 * directly. False today: images are referenced by path like everything
 * else and read through whatever image tool the agent has.
 *
 * Toggle this if the agent doesn't yet have a usable image tool and the
 * direct-vision flow is producing noticeably better results.
 */
export const INLINE_IMAGES_AS_DATA_URL = false;

/**
 * Render an attachment list as one combined system-prompt string, or `""`
 * when the list is empty. Same intro shape as `formatPageContextsForPrompt`.
 */
export function formatFileAttachmentsForPrompt(
  atts: FileAttachment[],
): string {
  if (atts.length === 0) return "";
  const intro =
    atts.length === 1
      ? [
          "The user has attached the following file. Use your read_file /",
          "pdf / image / etc. tools to read it from the given path if you",
          "need its contents. If the question is unrelated, ignore it.",
        ]
      : [
          `The user has attached ${atts.length} files. Use your read_file /`,
          "pdf / image / etc. tools to read them from the given paths if you",
          "need their contents. Ignore any that are unrelated to the question.",
        ];
  const blocks = atts.map((att, i) => {
    const indexAttr = atts.length > 1 ? ` index="${i + 1}"` : "";
    const lines: string[] = [
      `<file-attachment${indexAttr}>`,
      `Name: ${att.name}`,
      `Kind: ${att.kind}`,
      `Mime: ${att.mime || "application/octet-stream"}`,
      `Size: ${att.size} bytes`,
    ];
    if (att.path) lines.push(`Path: ${att.path}`);
    if (att.fromPageContext && att.sourceUrl) {
      lines.push(`Source-URL: ${att.sourceUrl}`);
      lines.push("Source: auto-attached from the user's current browser tab");
    }
    if (att.textPreview) {
      lines.push("");
      lines.push("Preview (first chars only — read the file for full content):");
      lines.push(att.textPreview);
    }
    lines.push("</file-attachment>");
    return lines.join("\n");
  });
  return [...intro, "", blocks.join("\n\n")].join("\n");
}

/**
 * Build `image_url` content parts for the OpenAI multimodal user message.
 *
 * Always returns `[]` when `INLINE_IMAGES_AS_DATA_URL` is false (the
 * default) — the caller gets to keep the same spread+length-check shape
 * regardless of whether inline vision is enabled.
 *
 * When the flag is on we'd need to re-introduce a way to carry the full
 * data URL on the attachment (today only the 256px thumbnail is kept on
 * `thumbDataUrl`, which is too small for vision). Left as a TODO: this
 * helper currently always returns `[]`. Flip the flag *and* extend
 * `FileAttachment` with a full-size `dataUrl?: string` populated at
 * intake time before relying on it.
 */
export function imageAttachmentsToImageParts(
  _atts: FileAttachment[],
): Array<{ type: "image_url"; image_url: { url: string } }> {
  if (!INLINE_IMAGES_AS_DATA_URL) return [];
  return [];
}

/** Convenience filter — kept so call sites don't need to know the kind tag. */
export function pickImageAttachments(
  atts: FileAttachment[],
): FileAttachment[] {
  return atts.filter((a) => a.kind === "image");
}

/** Convenience filter — text-ish attachments (text/json/markdown/code/…). */
export function pickTextAttachments(
  atts: FileAttachment[],
): FileAttachment[] {
  return atts.filter((a) => a.kind === "text");
}
