/**
 * The two adapters that feed `classifyImageIntent`.
 *
 * Report: `.github/audits/image-intent-auto-switch-2026-08-24.md` §5.1, B-7.
 *
 * The server holds `TurnAttachmentDescriptor`s that a route built from saved
 * rows and finalised uploads; the composer holds `ChatAttachment`s that may
 * not have been uploaded at all yet. Neither shape may reach the classifier,
 * because a classifier that knows one of them is a classifier only one side
 * can call -- and one that knows both has imported a server type into the
 * browser bundle.
 *
 * So both sides normalise first, and the parity tests compare *the normalised
 * inputs* as well as the verdicts. Comparing only verdicts would pass on two
 * differently shaped inputs that happen to agree today.
 *
 * What survives normalisation is one boolean per attachment, spelled as a
 * two-value kind. Names, sizes and upload ids are dropped because the question
 * is "is there a picture in this turn", and a filename in the input is a
 * filename in the rules eventually.
 *
 * Pure, and free of both `server-only` and `"use client"`: this module is
 * imported from both.
 */

import type { ImageIntentAttachment, ImageIntentInput } from "@/lib/imageIntentSignals";

/** Anything with a media type. Both call sites already have one. */
type MediaTyped = { mediaType?: string | null };

/**
 * One media type to one kind.
 *
 * `image/*` only. An SVG is `image/svg+xml` and counts: a user who attaches
 * one and asks to change it is asking for the same thing the raster case asks
 * for, and the workspace cannot do either.
 */
export const imageIntentAttachmentKind = (
  mediaType: string | null | undefined
): ImageIntentAttachment["kind"] =>
  typeof mediaType === "string" && mediaType.toLowerCase().startsWith("image/")
    ? "image"
    : "other";

const normalize = (
  text: string,
  attachments: readonly MediaTyped[] | undefined
): ImageIntentInput => ({
  text: typeof text === "string" ? text : "",
  attachments: (attachments ?? []).map((attachment) => ({
    kind: imageIntentAttachmentKind(attachment.mediaType),
  })),
});

/**
 * Server adapter: this turn's attachment descriptors.
 *
 * Typed structurally rather than importing `TurnAttachmentDescriptor`, so the
 * client bundle never pulls `lib/messageAttachmentCore.ts` in through this
 * path and the preflight route -- whose attachments are `{mediaType, size}`
 * from the request body -- can use the same function.
 */
export const normalizeServerImageIntentInput = (input: {
  text: string;
  attachments: readonly MediaTyped[] | undefined;
}): ImageIntentInput => normalize(input.text, input.attachments);

/** Composer adapter: the draft's attachments, uploaded or not. */
export const normalizeComposerImageIntentInput = (input: {
  text: string;
  attachments: readonly MediaTyped[] | undefined;
}): ImageIntentInput => normalize(input.text, input.attachments);
