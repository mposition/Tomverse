import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * The text read out of an earlier message's file, kept so the next turn does
 * not read and parse the file again (operator decision 2026-11-18).
 *
 * Every turn resends the whole conversation, and every earlier file used to be
 * fetched from R2 and parsed again each time -- a scanned PDF went through paid
 * OCR again on every message. That cost grew with the file size, which is what
 * held the attachment ceiling at 10 MB. Now the first turn that reads an earlier
 * file stores what it extracted, and later turns read only that.
 *
 * What is stored, and where:
 * - One `MessageAttachmentTextCache` row per attachment, cascaded from its
 *   `MessageAttachment` row. Deleting the attachment -- a conversation, a bulk
 *   or an account deletion -- deletes the text in the same transaction, so it
 *   can never outlive the file whatever order a turn and a deletion run in. A
 *   write for a row that is already gone fails on the foreign key and writes
 *   nothing. (An earlier design kept it as an R2 object beside the file, which
 *   no transaction can order against a deletion; operator decision 2026-11-18.)
 * - Only for a file bound to a message row of a signed-in account -- never a
 *   guest object and never an unbound upload, which have no row.
 * - Only text a model-independent extractor produced (PDF text or OCR, Office,
 *   legacy Office, plain text), complete and not cut by the parse budget. Images,
 *   a PDF sent to the model as a file, iWork notes and archives are read as
 *   before.
 * - A cache hit still asks storage whether the original exists, so a file that
 *   storage lost is reported exactly as it was without the cache.
 *
 * Bump the version when an extractor's output changes: rows of another version
 * are never read, and the next turn writes the current one over them.
 *
 * `CHAT_ATTACHMENT_TEXT_CACHE=0` turns it off; reading then behaves exactly as
 * it did, and nothing already written is consulted.
 */
export const ATTACHMENT_TEXT_CACHE_VERSION = 1;

/** Beyond this the text is not cached; the file is simply read each turn. */
export const ATTACHMENT_TEXT_CACHE_MAX_CHARACTERS = 8_000_000;

export type CachedAttachmentText = { kind: string; text: string };

export const attachmentTextCacheEnabled = (
  environment: Record<string, string | undefined> = process.env
) => environment.CHAT_ATTACHMENT_TEXT_CACHE !== "0";

/** The categories whose extracted text does not depend on the model or a switch. */
export const ATTACHMENT_TEXT_CACHE_CATEGORIES: ReadonlySet<string> = new Set([
  "pdf",
  "office",
  "legacy-office",
  "text",
  // A transcript, which is the one entry here that was paid for: re-reading it
  // from the recording would transcribe and bill it again on every turn.
  "audio",
]);

/** Null for anything that is not a non-empty list of `{ kind, text }`. */
export const parseCachedAttachmentEntries = (
  value: unknown
): CachedAttachmentText[] | null => {
  if (!Array.isArray(value) || value.length === 0) return null;
  const entries: CachedAttachmentText[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const { kind, text } = entry as { kind?: unknown; text?: unknown };
    if (typeof kind !== "string" || typeof text !== "string") return null;
    entries.push({ kind, text });
  }
  return entries;
};

/** The cached text, or null on any miss -- a miss only means "read the file". */
export const readAttachmentTextCache = async (
  attachmentId: string
): Promise<CachedAttachmentText[] | null> => {
  try {
    const rows = await prisma.$queryRaw<Array<{ version: number; entries: unknown }>>`
      SELECT "version", "entries" FROM "MessageAttachmentTextCache"
      WHERE "attachmentId" = ${attachmentId}`;
    const row = rows[0];
    if (!row || row.version !== ATTACHMENT_TEXT_CACHE_VERSION) return null;
    return parseCachedAttachmentEntries(row.entries);
  } catch {
    return null;
  }
};

/**
 * Stores the text for a bound attachment, replacing any other version.
 *
 * Fails on the foreign key, writing nothing, when the attachment row is gone;
 * the caller treats every failure as "not cached". Answers whether it wrote.
 */
export const writeAttachmentTextCache = async (
  attachmentId: string,
  entries: readonly CachedAttachmentText[]
) => {
  const characters = entries.reduce((sum, entry) => sum + entry.text.length, 0);
  if (entries.length === 0 || characters > ATTACHMENT_TEXT_CACHE_MAX_CHARACTERS) {
    return false;
  }
  const json = JSON.stringify(entries.map(({ kind, text }) => ({ kind, text })));
  await prisma.$executeRaw`
    INSERT INTO "MessageAttachmentTextCache" ("attachmentId", "version", "entries")
    VALUES (${attachmentId}, ${ATTACHMENT_TEXT_CACHE_VERSION}, ${json}::jsonb)
    ON CONFLICT ("attachmentId") DO UPDATE
      SET "version" = EXCLUDED."version",
          "entries" = EXCLUDED."entries",
          "createdAt" = CURRENT_TIMESTAMP`;
  return true;
};

/**
 * A row of this version is a claim, not text: one request is producing the
 * attachment's text right now and the others wait for it
 * (`transcribeAudioAttachmentOnce` in lib/chatAudioAttachment.ts). Below every
 * cache version, so `readAttachmentTextCache` never reads it, the next write
 * replaces it, and deleting the attachment deletes it.
 */
export const ATTACHMENT_TEXT_CLAIM_VERSION = 0;

/**
 * Takes the claim to produce this attachment's text, in one statement, so two
 * requests cannot both take it. Answers false when the text is already stored
 * or another request's claim is younger than `staleSeconds`; a claim older
 * than that belonged to a request that died, and is taken over.
 */
export const claimAttachmentTextCache = async (
  attachmentId: string,
  token: string,
  staleSeconds: number
): Promise<boolean> => {
  const claim = JSON.stringify({ claim: token });
  const rows = await prisma.$queryRaw<Array<{ attachmentId: string }>>`
    INSERT INTO "MessageAttachmentTextCache" ("attachmentId", "version", "entries")
    VALUES (${attachmentId}, ${ATTACHMENT_TEXT_CLAIM_VERSION}, ${claim}::jsonb)
    ON CONFLICT ("attachmentId") DO UPDATE
      SET "version" = EXCLUDED."version",
          "entries" = EXCLUDED."entries",
          "createdAt" = CURRENT_TIMESTAMP
      WHERE "MessageAttachmentTextCache"."version" NOT IN (${ATTACHMENT_TEXT_CLAIM_VERSION}, ${ATTACHMENT_TEXT_CACHE_VERSION})
         OR ("MessageAttachmentTextCache"."version" = ${ATTACHMENT_TEXT_CLAIM_VERSION}
             AND "MessageAttachmentTextCache"."createdAt" < CURRENT_TIMESTAMP - ${Math.max(1, Math.ceil(staleSeconds))}::int * INTERVAL '1 second')
    RETURNING "attachmentId"`;
  return rows.length > 0;
};

/** Gives back this request's claim; text written over it is left alone. */
export const releaseAttachmentTextClaim = (attachmentId: string, token: string) =>
  prisma.$executeRaw`
    DELETE FROM "MessageAttachmentTextCache"
    WHERE "attachmentId" = ${attachmentId}
      AND "version" = ${ATTACHMENT_TEXT_CLAIM_VERSION}
      AND "entries"->>'claim' = ${token}`;
