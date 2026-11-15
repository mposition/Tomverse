/**
 * Thumbnails for images a signed-in person already sent.
 *
 * Policy: docs/policy/user-attachment-persistence.md section 5.1.
 *
 * Shared by the preview route and the message list, so the two cannot
 * disagree about which files have a thumbnail: the list only asks for a
 * thumbnail the route will serve, and the route refuses everything else.
 *
 * Client-safe on purpose -- no server import -- because the list builds the
 * URL in the browser.
 */

/**
 * The raster formats a chat message may carry (lib/chatAttachmentFormats.ts),
 * and nothing else. Each one renders inside an <img> and cannot run script;
 * an SVG could, so it is not here and must never be added.
 */
export const PREVIEWABLE_ATTACHMENT_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/** The per-file upload ceiling (app/api/chat/route.ts MAX_ATTACHMENT_SIZE). */
export const MAX_PREVIEW_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const isPreviewableAttachmentMediaType = (mediaType: unknown): boolean =>
  typeof mediaType === "string" && PREVIEWABLE_ATTACHMENT_MEDIA_TYPES.has(mediaType);

/**
 * The thumbnail URL for a saved attachment, addressed by its opaque
 * `MessageAttachment` id -- the same id the conversation payload already
 * carries. The storage key never appears in it.
 */
export const messageAttachmentPreviewUrl = (attachmentId: string): string =>
  `/api/attachments/${encodeURIComponent(attachmentId)}/preview`;
