/**
 * Composer-time attachments — files the user attaches before sending the
 * next chat turn (manual upload, drag/drop, paste, or auto-attach of the
 * current tab when it isn't an HTML page).
 *
 * Storage model: **path-based, not inline**.
 *
 * The extension never embeds binary payloads in the chat completion request.
 * Instead, every attached file is uploaded through the bridge to Python,
 * which writes it under `~/.hermes/plugins/<plugin>/attachments/<session>/`
 * and returns the absolute path. The chat prompt only references that path
 * via a `<file-attachment path="...">` system-message block. The agent uses
 * its own server-side tools (read_file / pdf-text / image / OCR / …) to
 * actually read the bytes if it cares about them.
 *
 * Why path-based for *everything*, including images:
 *   - Token-cheap regardless of file size
 *   - Uniform mental model — every attachment looks the same to the agent
 *   - Mirrors `my_browser_screenshot`, which already returns a `/tmp/...png`
 *     path and lets the agent decide what to do with it
 *   - Trade-off: the model no longer "sees" images directly through OpenAI's
 *     multimodal API. Vision goes through whatever image tool the agent has.
 *     If we ever need the inline-image flow back, flip
 *     `INLINE_IMAGES_AS_DATA_URL` in `format.ts` and the path block stays
 *     untouched alongside.
 *
 * `kind` is purely a *presentation* hint — it picks the chip icon and
 * decides whether we capture a thumbnail vs. a text snippet at intake time.
 * It does not change wire format; the prompt formatter renders the same
 * `<file-attachment>` shape for every kind.
 *
 * Persistence: at send time we strip the heavy fields (the original File
 * reference, large preview blobs we don't want twice in storage) and keep
 * only an `AttachmentBadge` on the message so old bubbles still render the
 * chip after a panel reload. Because everything is path-based now the
 * badge is structurally almost identical to the live attachment — there's
 * no multi-MB data URL to drop, just maybe a 256px thumbnail for images.
 */

/**
 * Presentation classification — drives chip icon, preview kind, and the
 * `kind` attribute we surface in the `<file-attachment>` system block so
 * the agent can route to the right tool without re-sniffing the MIME.
 */
export type AttachmentKind = "image" | "text" | "pdf" | "binary";

interface AttachmentBase {
  /** Stable id used for React keys + remove-by-id. */
  uiId: string;
  /** Original / sanitised filename. */
  name: string;
  /** Source MIME type as best we can determine it. */
  mime: string;
  /** Decoded byte size of the original file. */
  size: number;
  /** Presentation classification — see `AttachmentKind`. */
  kind: AttachmentKind;
  /**
   * Absolute path to the file on disk where Python wrote it (typically
   * `~/.hermes/plugins/<plugin>/attachments/<session>/<id>_<name>`).
   *
   * Optional only because intake may fail (bridge disconnected, write
   * error, etc.) — in that case we surface the error to the user and the
   * chip is never offered for send.
   */
  path?: string;
}

export interface FileAttachment extends AttachmentBase {
  /**
   * Tiny downscaled JPEG/PNG data URL (≤ 256px longest edge) used to
   * render the chip preview for image attachments. Only set when
   * `kind === "image"`.
   */
  thumbDataUrl?: string;
  /**
   * First few hundred characters of decoded text — for chip tooltips and
   * the bubble preview on text/pdf attachments. Never sent to the model;
   * the agent reads the full file from `path` if it cares.
   */
  textPreview?: string;
  /**
   * Set when this attachment was auto-created from the current browser tab
   * (vs. manually uploaded by the user). The chip surfaces a small "from
   * page" badge so the user can tell the two apart, and the prompt block
   * carries the original URL.
   */
  fromPageContext?: boolean;
  /** Source URL when `fromPageContext` is true. */
  sourceUrl?: string;
}

/**
 * Live-composer attachment. Today there is exactly one shape regardless of
 * file kind (the kind only changes which preview field is populated), but
 * we keep the union alias so call sites that already type against
 * `Attachment` keep compiling and so it's trivial to reintroduce shape
 * variants (e.g. an inline `image_url` flavour) later.
 */
export type Attachment = FileAttachment;

/**
 * Persisted-on-message metadata. Survives panel reload so historical
 * bubbles can still render the chip. Structurally a near-copy of
 * `FileAttachment` minus any large preview text we don't want to store
 * twice — the path is the durable handle and the agent can re-read from
 * it if revisiting a saved chat.
 */
export interface AttachmentBadge {
  uiId: string;
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
  path?: string;
  /** Same 256px thumbnail as on the live attachment, for image chips. */
  thumbDataUrl?: string;
  /** Set when the attachment originated from auto-attach of the current tab. */
  fromPageContext?: boolean;
  /** Original URL when `fromPageContext` is true. */
  sourceUrl?: string;
}
