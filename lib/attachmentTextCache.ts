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
 * are never read, and the next turn writes the current one over them. It does
 * not reach a recording's transcript, which was paid for and has its own
 * version, far above (AUDIO_TRANSCRIPT_RESULT_VERSION).
 *
 * `CHAT_ATTACHMENT_TEXT_CACHE=0` turns it off; reading then behaves exactly as
 * it did, and nothing already written is consulted -- again except a paid
 * transcript, which the audio path reads and writes either way.
 */
export const ATTACHMENT_TEXT_CACHE_VERSION = 1;

/**
 * Versions from here up are a recording's paid transcription result, never an
 * extractor's text: bumping ATTACHMENT_TEXT_CACHE_VERSION for a PDF or Office
 * change stays far below it and leaves every paid transcript readable
 * (review r-20261127-124325-a4352d). A test pins the order.
 */
export const AUDIO_TRANSCRIPT_VERSION_BAND = 1_000_000;

/**
 * The version a paid transcription result -- a transcript, or the finding that
 * a recording holds no speech -- is stored and read at.
 *
 * Bump it only on purpose: when the transcript's stored form or the
 * transcription model changes enough that every recording must be transcribed
 * again. Bumping it makes every stored result a miss, so the next request for
 * each recording pays for it again (docs/policy/chat-attachment-formats.md
 * 2.4.1). Older results in the band are the only paid rows a claim may take
 * over.
 */
export const AUDIO_TRANSCRIPT_RESULT_VERSION = AUDIO_TRANSCRIPT_VERSION_BAND + 1;

/** Whether a row's version is one a reader may use: the extractor's, or the paid audio result's. */
export const isCurrentAttachmentTextVersion = (
  version: number,
  extractorVersion: number = ATTACHMENT_TEXT_CACHE_VERSION
) => version === extractorVersion || version === AUDIO_TRANSCRIPT_RESULT_VERSION;

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

/**
 * The cached text, or null on any miss -- a miss only means "read the file".
 * A recording's stored transcript is read here too, at its own version;
 * `extractorVersion` is a seam for the tests that bump the other one.
 */
export const readAttachmentTextCache = async (
  attachmentId: string,
  options: { extractorVersion?: number } = {}
): Promise<CachedAttachmentText[] | null> => {
  try {
    const rows = await prisma.$queryRaw<Array<{ version: number; entries: unknown }>>`
      SELECT "version", "entries" FROM "MessageAttachmentTextCache"
      WHERE "attachmentId" = ${attachmentId}`;
    const row = rows[0];
    if (!row || !isCurrentAttachmentTextVersion(row.version, options.extractorVersion)) return null;
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
 * Takes the claim to transcribe this recording, in one statement, so two
 * requests cannot both take it. It takes over exactly two kinds of row: a
 * claim older than `staleSeconds` (its request died), and a paid result of an
 * older AUDIO_TRANSCRIPT_RESULT_VERSION (re-transcription on purpose). Every
 * other row -- a current paid result, a fresh claim, anything at an extractor
 * version -- answers false (review r-20261127-124325-a4352d: it used to take
 * over any row not at the extractor version, so bumping that version would
 * have made every paid transcript claimable).
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
      WHERE ("MessageAttachmentTextCache"."version" = ${ATTACHMENT_TEXT_CLAIM_VERSION}
             AND "MessageAttachmentTextCache"."createdAt" < CURRENT_TIMESTAMP - ${Math.max(1, Math.ceil(staleSeconds))}::int * INTERVAL '1 second')
         OR ("MessageAttachmentTextCache"."version" >= ${AUDIO_TRANSCRIPT_VERSION_BAND}
             AND "MessageAttachmentTextCache"."version" <> ${AUDIO_TRANSCRIPT_RESULT_VERSION})
    RETURNING "attachmentId"`;
  return rows.length > 0;
};

/**
 * Confirms this request still holds its claim and restarts its clock, in one
 * statement: true only if the row is still this token's claim. Run just before
 * the paid call, so the call starts with a whole stale window ahead of it, and
 * a request whose claim was taken over while it waited on its own bookings
 * learns so before it pays rather than after (review r-20261127-122037-b72ce5).
 * Row locks order it against a takeover: one of the two sees the other's write.
 */
export const renewAttachmentTextClaim = async (attachmentId: string, token: string) => {
  const rows = await prisma.$queryRaw<Array<{ attachmentId: string }>>`
    UPDATE "MessageAttachmentTextCache"
    SET "createdAt" = CURRENT_TIMESTAMP
    WHERE "attachmentId" = ${attachmentId}
      AND "version" = ${ATTACHMENT_TEXT_CLAIM_VERSION}
      AND "entries"->>'claim' = ${token}
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

export type AudioTranscriptOutcome = CachedAttachmentText[] | "no_text";

/** A paid result row's entries: the transcript list, or the no-speech marker. */
const audioOutcome = (entries: unknown): AudioTranscriptOutcome | null => {
  const marker = entries as { outcome?: unknown } | null;
  if (marker && !Array.isArray(marker) && marker.outcome === "no_text") return "no_text";
  return parseCachedAttachmentEntries(entries);
};

/**
 * What a recording's transcription came to: its text, or the fact that it
 * held no speech, or null when neither is stored at AUDIO_TRANSCRIPT_RESULT_VERSION.
 *
 * A transcription that found no speech was paid for as well, and it will find
 * none the next time (review r-20261127-114544-4444fa). It is kept as a row of
 * the result version whose `entries` is the object `{ "outcome": "no_text" }`
 * rather than a list, so `readAttachmentTextCache` -- and every other reader
 * -- still sees a miss, and the claim never takes it over. Only the audio
 * result version is consulted: the extractor's is not.
 */
export const readAttachmentTranscriptOutcome = async (
  attachmentId: string
): Promise<AudioTranscriptOutcome | null> => {
  const rows = await prisma.$queryRaw<Array<{ version: number; entries: unknown }>>`
    SELECT "version", "entries" FROM "MessageAttachmentTextCache"
    WHERE "attachmentId" = ${attachmentId}`;
  const row = rows[0];
  if (!row || row.version !== AUDIO_TRANSCRIPT_RESULT_VERSION) return null;
  return audioOutcome(row.entries);
};

/**
 * The paid result of the recording this attachment was copied from, if any.
 *
 * Resending or editing a message, and consuming a saved draft, copy each file
 * to a new object and bind it as a new row that names its original in
 * `sourceAttachmentId` (lib/messageAttachmentResend.ts). The bytes are the
 * same, so the transcript is too: the nearest ancestor's result, up to eight
 * copies back, same account, same media type and size. An ancestor that was
 * deleted took its result with it, and the copy is transcribed afresh.
 */
export const readInheritedTranscriptOutcome = async (
  attachmentId: string
): Promise<AudioTranscriptOutcome | null> => {
  const rows = await prisma.$queryRaw<Array<{ entries: unknown }>>`
    WITH RECURSIVE "origin" AS (
      SELECT "id", "userId", "mediaType", "size" FROM "MessageAttachment" WHERE "id" = ${attachmentId}
    ), "chain" ("id", "sourceAttachmentId", "depth") AS (
      SELECT a."id", a."sourceAttachmentId", 0
      FROM "MessageAttachment" a WHERE a."id" = ${attachmentId}
      UNION ALL
      SELECT a."id", a."sourceAttachmentId", c."depth" + 1
      FROM "chain" c
      JOIN "MessageAttachment" a ON a."id" = c."sourceAttachmentId"
      JOIN "origin" o ON a."userId" = o."userId" AND a."mediaType" = o."mediaType" AND a."size" = o."size"
      WHERE c."depth" < 8
    )
    SELECT t."entries"
    FROM "chain" c
    JOIN "MessageAttachmentTextCache" t ON t."attachmentId" = c."id"
    WHERE c."depth" > 0 AND t."version" = ${AUDIO_TRANSCRIPT_RESULT_VERSION}
    ORDER BY c."depth"
    LIMIT 1`;
  return rows[0] ? audioOutcome(rows[0].entries) : null;
};

/** Stores a paid transcript at the audio result version, over whatever row was there. */
export const writeAudioTranscript = async (
  attachmentId: string,
  entries: readonly CachedAttachmentText[]
) => {
  const characters = entries.reduce((sum, entry) => sum + entry.text.length, 0);
  if (entries.length === 0 || characters > ATTACHMENT_TEXT_CACHE_MAX_CHARACTERS) return false;
  const json = JSON.stringify(entries.map(({ kind, text }) => ({ kind, text })));
  await prisma.$executeRaw`
    INSERT INTO "MessageAttachmentTextCache" ("attachmentId", "version", "entries")
    VALUES (${attachmentId}, ${AUDIO_TRANSCRIPT_RESULT_VERSION}, ${json}::jsonb)
    ON CONFLICT ("attachmentId") DO UPDATE
      SET "version" = EXCLUDED."version",
          "entries" = EXCLUDED."entries",
          "createdAt" = CURRENT_TIMESTAMP`;
  return true;
};

/** Stores "this recording holds no speech" over the claim that found it. */
export const writeAttachmentNoTextOutcome = async (attachmentId: string) => {
  await prisma.$executeRaw`
    INSERT INTO "MessageAttachmentTextCache" ("attachmentId", "version", "entries")
    VALUES (${attachmentId}, ${AUDIO_TRANSCRIPT_RESULT_VERSION}, ${JSON.stringify({ outcome: "no_text" })}::jsonb)
    ON CONFLICT ("attachmentId") DO UPDATE
      SET "version" = EXCLUDED."version",
          "entries" = EXCLUDED."entries",
          "createdAt" = CURRENT_TIMESTAMP`;
  return true;
};
