import "server-only";

import { prisma } from "@/lib/prisma";
import { deleteR2Object, readOwnR2ObjectBytes, writeR2Object } from "@/lib/r2";

/**
 * The text read out of an earlier message's file, kept so the next turn does
 * not read and parse the file again (operator decision 2026-11-18).
 *
 * Every turn resends the whole conversation, and every earlier file used to be
 * fetched from R2 and parsed again each time -- a scanned PDF went through paid
 * OCR again on every message. That cost grew with the file size, which is what
 * held the attachment ceiling at 10 MB. Now the first turn that reads an earlier
 * file stores what it extracted next to the original, and later turns read only
 * that.
 *
 * What is stored, and where:
 * - Next to the original, as `<objectKey>.extracted-v<N>.json`, inside the same
 *   account prefix. Storage keys are written once and never rewritten
 *   (docs/policy/user-attachment-persistence.md), so the text can never
 *   describe a different file.
 * - Only for a file bound to a message row of a signed-in account -- never a
 *   guest object and never an unbound upload -- and only while that row is
 *   held (`writeBoundAttachmentTextCache`), so the one deletion path for
 *   attachments, the `MessageAttachmentCleanup` queue, always removes it with
 *   the original (`drainMessageAttachmentCleanupQueue`).
 * - A cache hit still asks storage whether the original exists, so a file
 *   that storage lost is reported exactly as it was without the cache.
 * - Only text a model-independent extractor produced (PDF text or OCR, Office,
 *   legacy Office, plain text), complete and not cut by the parse budget. Images,
 *   a PDF sent to the model as a file, iWork notes and archives are read as
 *   before.
 *
 * Bump the version when an extractor's output changes: old entries are then
 * never read again, and deletion removes every version up to the current one.
 *
 * `CHAT_ATTACHMENT_TEXT_CACHE=0` turns it off; reading then behaves exactly as
 * it did, and nothing already written is consulted.
 */
export const ATTACHMENT_TEXT_CACHE_VERSION = 1;

/** Comfortably above the parse budget written as UTF-8 JSON. */
const MAX_CACHE_BYTES = 64 * 1024 * 1024;

const CONTENT_TYPE = "application/json";

export type CachedAttachmentText = { kind: string; text: string };

export const attachmentTextCacheEnabled = (
  environment: Record<string, string | undefined> = process.env
) => environment.CHAT_ATTACHMENT_TEXT_CACHE !== "0";

export const attachmentTextCacheKey = (
  objectKey: string,
  version: number = ATTACHMENT_TEXT_CACHE_VERSION
) => `${objectKey}.extracted-v${version}.json`;

/** Every key a version of this cache may have written, oldest first. */
export const attachmentTextCacheKeys = (objectKey: string) =>
  Array.from({ length: ATTACHMENT_TEXT_CACHE_VERSION }, (_, index) =>
    attachmentTextCacheKey(objectKey, index + 1)
  );

/** The categories whose extracted text does not depend on the model or a switch. */
export const ATTACHMENT_TEXT_CACHE_CATEGORIES: ReadonlySet<string> = new Set([
  "pdf",
  "office",
  "legacy-office",
  "text",
]);

/** Null for anything that is not exactly what `serialize` wrote. */
export const parseCachedAttachmentText = (
  raw: string
): CachedAttachmentText[] | null => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as { version?: unknown; entries?: unknown };
  if (record.version !== ATTACHMENT_TEXT_CACHE_VERSION) return null;
  if (!Array.isArray(record.entries) || record.entries.length === 0) return null;
  const entries: CachedAttachmentText[] = [];
  for (const entry of record.entries) {
    if (!entry || typeof entry !== "object") return null;
    const { kind, text } = entry as { kind?: unknown; text?: unknown };
    if (typeof kind !== "string" || typeof text !== "string") return null;
    entries.push({ kind, text });
  }
  return entries;
};

export const serializeCachedAttachmentText = (entries: readonly CachedAttachmentText[]) =>
  JSON.stringify({
    version: ATTACHMENT_TEXT_CACHE_VERSION,
    entries: entries.map(({ kind, text }) => ({ kind, text })),
  });

/** The cached text, or null on any miss -- a miss only means "read the file". */
export const readAttachmentTextCache = async (
  objectKey: string
): Promise<CachedAttachmentText[] | null> => {
  try {
    // The reader for objects this server wrote: one GET, and never deletes
    // on a metadata mismatch -- the general reader would, and a lost cache
    // means the next turn parses (and may OCR) the file again.
    const buffer = await readOwnR2ObjectBytes(attachmentTextCacheKey(objectKey), {
      maxBytes: MAX_CACHE_BYTES,
    });
    return parseCachedAttachmentText(buffer.toString("utf8"));
  } catch {
    return null;
  }
};

export const writeAttachmentTextCache = async (
  objectKey: string,
  entries: readonly CachedAttachmentText[],
  options?: { abortSignal?: AbortSignal }
) => {
  const body = Buffer.from(serializeCachedAttachmentText(entries), "utf8");
  if (body.byteLength > MAX_CACHE_BYTES) return;
  await writeR2Object(attachmentTextCacheKey(objectKey), body, CONTENT_TYPE, options);
};

/**
 * How long the cache PUT may run, and how long the lock is held. The PUT is
 * aborted far inside the lock, so it can never still be running -- and land --
 * after the lock has gone.
 */
export const ATTACHMENT_TEXT_CACHE_PUT_TIMEOUT_MS = 15_000;
export const ATTACHMENT_TEXT_CACHE_LOCK_TIMEOUT_MS = 60_000;

/**
 * Writes the cache only while its attachment row exists, and holds that row
 * while it writes.
 *
 * The write happens inside a transaction that keeps a `FOR KEY SHARE` lock on
 * the `MessageAttachment` row. Deleting the row -- a conversation, a bulk or
 * an account deletion, cascades included -- needs a lock that conflicts with
 * it, so the two are ordered:
 *
 * - The deletion came first: the row is gone and nothing is written.
 * - The write came first: the deletion waits, then removes the row and leaves
 *   its `MessageAttachmentCleanup` tombstone, and the drain deletes this text
 *   with the original.
 * - The process stops mid-write: the row still exists, so its eventual
 *   deletion takes the text with it the same way.
 *
 * So a cache can never outlive its attachment, without a sweep and without a
 * window. Answers whether it wrote.
 */
export const writeBoundAttachmentTextCache = (input: {
  attachmentId: string;
  objectKey: string;
  entries: readonly CachedAttachmentText[];
}) =>
  prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "MessageAttachment"
        WHERE "id" = ${input.attachmentId} AND "objectKey" = ${input.objectKey}
        FOR KEY SHARE`;
      if (rows.length === 0) return false;
      try {
        await writeAttachmentTextCache(input.objectKey, input.entries, {
          abortSignal: AbortSignal.timeout(ATTACHMENT_TEXT_CACHE_PUT_TIMEOUT_MS),
        });
      } catch (error) {
        // An aborted or failed PUT has an unknown outcome. It is taken back
        // out while the lock is still held, before anything can delete the
        // row, and then the failure is reported.
        await deleteAttachmentTextCache(input.objectKey).catch(() => undefined);
        throw error;
      }
      // Proves the transaction -- and so the lock -- outlived the PUT. A
      // transaction that has already timed out fails here, and the caller
      // takes the text back out.
      await tx.$queryRaw`SELECT 1`;
      return true;
    },
    { timeout: ATTACHMENT_TEXT_CACHE_LOCK_TIMEOUT_MS }
  ).catch(async (error) => {
    await deleteAttachmentTextCache(input.objectKey).catch(() => undefined);
    throw error;
  });

/**
 * Deletes the cached text of every version, so bumping the version never
 * leaves an older one behind. Succeeds for keys that were never written, like
 * every DeleteObject.
 */
export const deleteAttachmentTextCache = async (objectKey: string) => {
  for (const key of attachmentTextCacheKeys(objectKey)) {
    await deleteR2Object(key);
  }
};
