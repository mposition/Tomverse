/**
 * The order a request's shared allowances are spent in, and which earlier
 * files a conversation's count leaves out.
 *
 * A model accepts only so many images, and so many bytes of them, per request
 * (`inputCapabilities.maxImages`, `maxBase64ImagePayloadBytes`); earlier
 * messages' text shares one input allowance and one OCR allowance. Every
 * earlier message is read again on each turn, so whoever is read first spends
 * first. The message being sent is read first, then the earlier messages from
 * the nearest to the oldest: what is left out is the oldest, never the file the
 * person just attached or the one they sent a moment ago, and it does not
 * matter whether an image came directly or out of an archive, or whether its
 * size was known beforehand. The messages are still sent in conversation order.
 */

/**
 * The indexes of `count` messages in the order they are read: the last (the
 * message being sent), then the one before it, back to the first.
 */
export const messageReadingOrder = (count: number): number[] =>
  Array.from({ length: Math.max(0, count) }, (_, index) => count - 1 - index);

/**
 * The attachments a conversation's count leaves out: the `omitCount` oldest, in
 * conversation order, of those `perMessageCounts` gives (one number per
 * message, the files that message is read for). The last message -- the one
 * being sent -- is never among them. Returned as `"message:attachment"` keys.
 * Decided here, in conversation order, because the messages are not read in it.
 */
export function oldestAttachmentSlots(
  perMessageCounts: readonly number[],
  omitCount: number
): Set<string> {
  const slots = new Set<string>();
  let remaining = Math.max(0, omitCount);
  for (let message = 0; message < perMessageCounts.length - 1 && remaining > 0; message += 1) {
    for (let index = 0; index < perMessageCounts[message] && remaining > 0; index += 1) {
      slots.add(`${message}:${index}`);
      remaining -= 1;
    }
  }
  return slots;
}

/** The limit as the person reads it, from the model's own setting. */
export const describeImagePayloadLimit = (bytes: number) => {
  const megabytes = bytes / (1024 * 1024);
  return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`;
};

/**
 * What belongs to the n-th message with a given key, handed out in conversation
 * order whatever order the messages are later read in. A stored answer carries
 * its model's reasoning and tool context, kept in a queue per answer text in
 * the order they were written; two answers with the same text must get the
 * first and the second of them, not the other way round. `keys` has one entry
 * per message (null for a message that takes none); the queues are consumed.
 */
export function claimInConversationOrder<T>(
  keys: ReadonlyArray<string | null>,
  queues: Map<string, T[]>
): Map<number, T> {
  const claimed = new Map<number, T>();
  keys.forEach((key, index) => {
    if (key === null) return;
    const item = queues.get(key)?.shift();
    if (item !== undefined) claimed.set(index, item);
  });
  return claimed;
}
