/**
 * Which images of a conversation fit one request, and which are left out.
 *
 * A model accepts only so many images, and so many bytes of them, per request
 * (`inputCapabilities.maxImages`, `maxBase64ImagePayloadBytes`). Every earlier
 * message's images are sent again on each turn, and they are read oldest first:
 * the images already in the conversation used the allowance before the one the
 * person was sending now, and that one was refused. The message being sent
 * comes first. When the request holds too many, the oldest earlier images are
 * left out -- named to the model, never failing the turn -- until the rest fit.
 * Only an overflow made by the message's own images is an error.
 */

export type ImageSlot = {
  /** Identifies the attachment: message position and attachment position. */
  key: string;
  /** An image of the message being sent. */
  latest: boolean;
  /** Estimated base64 size, 0 when the size is not known before reading. */
  base64Bytes: number;
};

export type ImageLimits = {
  maxImages?: number;
  maxBase64ImagePayloadBytes?: number;
};

/** Base64 of `bytes` raw bytes, as the request will carry it. */
export const base64SizeOf = (bytes: number) =>
  Number.isFinite(bytes) && bytes > 0 ? Math.ceil(bytes / 3) * 4 : 0;

/**
 * The keys of the earlier images to leave out, oldest first, and what the
 * message being sent keeps for itself. `slots` are in conversation order.
 */
export function planImageOmissions(slots: readonly ImageSlot[], limits: ImageLimits) {
  const maxImages = limits.maxImages && limits.maxImages > 0 ? limits.maxImages : 0;
  const maxBytes =
    limits.maxBase64ImagePayloadBytes && limits.maxBase64ImagePayloadBytes > 0
      ? limits.maxBase64ImagePayloadBytes
      : 0;

  let keptCount = slots.length;
  let keptBytes = slots.reduce((sum, slot) => sum + slot.base64Bytes, 0);
  const omitted = new Set<string>();
  for (const slot of slots) {
    if (slot.latest) break;
    if (!(maxImages && keptCount > maxImages) && !(maxBytes && keptBytes > maxBytes)) break;
    omitted.add(slot.key);
    keptCount -= 1;
    keptBytes -= slot.base64Bytes;
  }

  const own = slots.filter((slot) => slot.latest);
  return {
    omitted,
    /** Held back from earlier messages that are read at run time. */
    reserveCount: own.length,
    reserveBase64Bytes: own.reduce((sum, slot) => sum + slot.base64Bytes, 0),
  };
}

/** The limit as the person reads it, from the model's own setting. */
export const describeImagePayloadLimit = (bytes: number) => {
  const megabytes = bytes / (1024 * 1024);
  return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`;
};
