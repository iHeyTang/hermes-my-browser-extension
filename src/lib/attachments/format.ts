/**
 * Render composer-time `FileAttachment`s into a plain-text block that gets
 * inlined into the user message content.
 *
 * Design: everything the agent sees about attachments is plain text inside
 * the user's own turn. We deliberately do not use OpenAI's multimodal
 * `image_url` content parts and do not produce a separate `system` role
 * message — the chat-completions wire shape is the simplest possible
 * `{role: "user", content: "<string>"}` regardless of attachment kind.
 *
 * The agent reads the actual bytes by path via its own tools
 * (`vision_analyze`, `read_file`, OCR, etc.) only if it decides the file
 * is relevant to the user's question. That decision is the agent's; this
 * formatter only surfaces *what* is attached, not whether to read it.
 */

import type { FileAttachment } from "./types";

/**
 * Render an attachment list as a plain-text block suitable for appending to
 * the user message content, or `""` when the list is empty.
 */
export function formatFileAttachmentsForPrompt(
  atts: FileAttachment[],
): string {
  const ready = atts.filter((a) => a.path && !a.uploading);
  if (ready.length === 0) return "";
  const intro =
    ready.length === 1
      ? [
          "The user has attached the following file. Use your read_file /",
          "pdf / image / etc. tools to read it from the given path if you",
          "need its contents. If the question is unrelated, ignore it.",
        ]
      : [
          `The user has attached ${ready.length} files. Use your read_file /`,
          "pdf / image / etc. tools to read them from the given paths if you",
          "need their contents. Ignore any that are unrelated to the question.",
        ];
  const blocks = ready.map((att, i) => {
    const indexAttr = ready.length > 1 ? ` index="${i + 1}"` : "";
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
