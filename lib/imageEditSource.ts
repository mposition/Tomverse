import "server-only";

import { createHash } from "node:crypto";

import {
  IMAGE_EDIT_INPUT_MAX_EDGE_PX,
  IMAGE_EDIT_SOURCE_MAX_BYTES,
  IMAGE_EDIT_SOURCE_MEDIA_TYPES,
  imageEditOutputSize,
  type ImageSize,
} from "@/lib/imageGenerationPricing";
import {
  IMAGE_EDIT_SOURCE_TOO_LARGE,
  IMAGE_EDIT_SOURCE_UNSUPPORTED,
  type ImageEditSourceRefusalCode,
} from "@/lib/chatImageTurnCore";
import type { ImageEditInput } from "@/lib/imageProviderAdapter";
import { prisma } from "@/lib/prisma";
import { readOwnR2ObjectBytes } from "@/lib/r2";

/**
 * Default off. Editing is a paid provider call with its own surcharge, so an
 * operator turns it on (IMAGE_EDIT_ENABLED=true) after the price is approved.
 * Each model still edits only once its edit pricing is verified
 * (imageModelSupportsEdit).
 */
export const imageEditEnabled = (env: Record<string, string | undefined> = process.env) =>
  env.IMAGE_EDIT_ENABLED === "true";

/**
 * The photo a Chat image edit changes: the first image attached to the
 * question being answered. Read from the saved message, never from anything
 * the request names, so an edit can only ever start from the caller's own
 * file on that turn. Null when the question carries no usable image.
 */
export const findChatImageEditSource = async (input: {
  userId: string;
  conversationId: string;
  sourceUserMessageId: string;
}): Promise<{ attachmentId: string; size: ImageSize } | null> => {
  const attachment = await prisma.messageAttachment.findFirst({
    where: {
      messageId: input.sourceUserMessageId,
      conversationId: input.conversationId,
      userId: input.userId,
      mediaType: { in: [...IMAGE_EDIT_SOURCE_MEDIA_TYPES] },
      unavailableAt: null,
    },
    orderBy: { ordinal: "asc" },
    select: { id: true, objectKey: true, size: true },
  });
  if (!attachment) return null;
  // A chat attachment may be 50 MB; an edit reads 10. Said now, by name,
  // while nothing is reserved -- found out at execution it was a generic
  // failure after the credits had been taken and given back.
  if (attachment.size > IMAGE_EDIT_SOURCE_MAX_BYTES) {
    throw new ImageEditSourceError(
      "The photo is too large to edit.",
      IMAGE_EDIT_SOURCE_TOO_LARGE
    );
  }
  // The edit keeps the photo's shape: a landscape photo edited into a square
  // would come back cropped or stretched. A photo storage cannot be read for
  // right now is square, and the executor fails it before the provider is
  // called if it is still unreadable; one that is read but cannot be decoded
  // is refused here, since the executor would only fail it later.
  let size: ImageSize = "1024x1024";
  let bytes: Buffer | null = null;
  try {
    bytes = await readOwnR2ObjectBytes(attachment.objectKey, {
      maxBytes: IMAGE_EDIT_SOURCE_MAX_BYTES,
    });
  } catch {
    bytes = null;
  }
  if (bytes) {
    try {
      const sharp = (await import("sharp")).default;
      const { width, height, orientation } = await sharp(bytes, { animated: false }).metadata();
      if (!width || !height) throw new Error("no dimensions");
      size = imageEditOutputSize(width, height, orientation);
    } catch {
      throw new ImageEditSourceError(
        "The photo cannot be edited: its format is not supported.",
        IMAGE_EDIT_SOURCE_UNSUPPORTED
      );
    }
  }
  return { attachmentId: attachment.id, size };
};

export class ImageEditSourceError extends Error {
  /** Set when the cause is known before anything is reserved. */
  readonly code?: ImageEditSourceRefusalCode;

  constructor(message: string, code?: ImageEditSourceRefusalCode) {
    super(message);
    this.name = "ImageEditSourceError";
    this.code = code;
  }
}

/**
 * The bytes an edit sends: the attachment, upright (EXIF orientation applied),
 * scaled to fit IMAGE_EDIT_INPUT_MAX_EDGE_PX and re-encoded as PNG. The size
 * bound is what keeps the image-input cost inside the budget the reservation
 * priced. The read never deletes or rewrites the user's file.
 */
export const loadImageEditInput = async (input: {
  userId: string;
  attachmentId: string;
}): Promise<ImageEditInput> => {
  const attachment = await prisma.messageAttachment.findFirst({
    where: { id: input.attachmentId, userId: input.userId, unavailableAt: null },
    select: { objectKey: true, mediaType: true },
  });
  if (!attachment || !IMAGE_EDIT_SOURCE_MEDIA_TYPES.includes(attachment.mediaType)) {
    throw new ImageEditSourceError("The photo to edit is no longer available.");
  }
  let original: Buffer;
  try {
    original = await readOwnR2ObjectBytes(attachment.objectKey, {
      maxBytes: IMAGE_EDIT_SOURCE_MAX_BYTES,
    });
  } catch {
    throw new ImageEditSourceError("The photo to edit could not be read.");
  }
  try {
    const sharp = (await import("sharp")).default;
    const { data, info } = await sharp(original, { animated: false })
      .rotate()
      .resize(IMAGE_EDIT_INPUT_MAX_EDGE_PX, IMAGE_EDIT_INPUT_MAX_EDGE_PX, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer({ resolveWithObject: true });
    return {
      bytes: data,
      mimeType: "image/png",
      width: info.width,
      height: info.height,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
  } catch {
    throw new ImageEditSourceError("The photo to edit could not be decoded.");
  }
};
