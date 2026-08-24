/**
 * User-supplied attachments: what may be sent, and what may be told back.
 *
 * Policy: docs/policy/user-attachment-persistence.md.
 *
 * Deliberately pure -- no `server-only`, no Prisma, no storage. The composer,
 * the route handlers and the tests all need the same answers about what an
 * attachment is, and a rule that only exists inside a route handler is a rule
 * nothing can test without a database.
 *
 * The one rule this file exists to hold: **a client never names a storage
 * location.** It names an opaque id the server issued -- an upload id from the
 * finalisation step, or the id of an attachment already bound to one of the
 * caller's own messages -- and the server resolves the object key itself. A
 * key that arrived in a request body is a claim; a row the server wrote is a
 * fact.
 */

import { z } from "zod";

/* ------------------------------------------------------------------------ */
/* Kinds                                                                      */
/* ------------------------------------------------------------------------ */

/**
 * How the request layer reads a file: `text` is decoded as UTF-8 and placed in
 * the prompt, `file` keeps its bytes and is parsed, OCR'd or sent as a file
 * part depending on its media type.
 *
 * Server-decided, always. It was previously carried in the request body, where
 * a mismatched pair ("this .docx is text") had to be caught by a separate
 * check; derived from the media type there is nothing to disagree with.
 */
export const MESSAGE_ATTACHMENT_KINDS = ["file", "text"] as const;
export type MessageAttachmentKind = (typeof MESSAGE_ATTACHMENT_KINDS)[number];

/* ------------------------------------------------------------------------ */
/* The reference a client may send                                            */
/* ------------------------------------------------------------------------ */

/** The two opaque handles a signed-in client may use, and nothing else. */
export const MESSAGE_ATTACHMENT_REFERENCE_FIELDS = [
  "attachmentId",
  "uploadId",
] as const;

const opaqueId = z.string().trim().min(1).max(64);

/**
 * One attachment as it appears in a chat request or a message pre-save.
 *
 * `name`, `mediaType`, `size` and `kind` are allowed through because the
 * composer already has them and the card must render before the round trip --
 * but nothing downstream believes them. Every one of the four is re-read from
 * the row the id resolves to (`resolveMessageAttachmentReferences`), so a
 * request that understates a size or renames a `.docx` to a `.txt` changes
 * nothing about how the file is read.
 */
export const messageAttachmentReferenceSchema = z
  .object({
    id: z.string().trim().min(1).max(64).optional(),
    attachmentId: opaqueId.optional(),
    uploadId: opaqueId.optional(),
    name: z.string().trim().min(1).max(200).optional(),
    mediaType: z.string().trim().min(1).max(200).optional(),
    size: z.number().int().nonnegative().optional(),
    kind: z.enum(MESSAGE_ATTACHMENT_KINDS).optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.attachmentId || value.uploadId),
    "An attachment must be referenced by attachmentId or uploadId."
  );

export type MessageAttachmentReference = z.infer<
  typeof messageAttachmentReferenceSchema
>;

/* ------------------------------------------------------------------------ */
/* The shape that goes back to the browser                                    */
/* ------------------------------------------------------------------------ */

/**
 * Everything a client is ever told about a stored attachment.
 *
 * An allowlist rather than a select-and-hope: `objectKey` is not in this type,
 * so a serialiser that grows a spread cannot leak one through it. The bytes,
 * the extracted text, the paths inside an uploaded archive and any signed URL
 * are all absent for the same reason -- none of them is something the card
 * needs, and each of them is something an attacker would want.
 */
export type PublicMessageAttachment = {
  id: string;
  ordinal: number;
  name: string;
  mediaType: string;
  size: number;
  kind: MessageAttachmentKind;
};

/** The Prisma `select` that produces exactly the public shape. */
export const PUBLIC_MESSAGE_ATTACHMENT_SELECT = {
  id: true,
  ordinal: true,
  name: true,
  mediaType: true,
  size: true,
  kind: true,
} as const;

/**
 * Narrows a row to the public shape.
 *
 * Field by field, never by spread. The whole point of the type above is that
 * adding a column to the table must not add a field to the response, and a
 * spread would defeat that silently.
 */
export const toPublicMessageAttachment = (row: {
  id: string;
  ordinal: number;
  name: string;
  mediaType: string;
  size: number;
  kind: string;
}): PublicMessageAttachment => ({
  id: row.id,
  ordinal: row.ordinal,
  name: row.name,
  mediaType: row.mediaType,
  size: row.size,
  kind: row.kind === "text" ? "text" : "file",
});

/* ------------------------------------------------------------------------ */
/* Turn handles                                                               */
/* ------------------------------------------------------------------------ */

/**
 * The handle a *model* is given for a file attached to the turn it is
 * answering.
 *
 * Not the row id, and not the object key. A model's handle can end up quoted
 * in an answer, so it is minted per request, means nothing outside it, and
 * addresses no route: `att_1` is the first file on this turn and is not a name
 * for anything tomorrow.
 */
export const turnAttachmentHandle = (index: number): string =>
  `att_${index + 1}`;

const TURN_HANDLE_PATTERN = /^att_([1-9][0-9]{0,2})$/;

export const isTurnAttachmentHandle = (value: unknown): value is string =>
  typeof value === "string" && TURN_HANDLE_PATTERN.test(value);

/**
 * What the model is told about one attached file.
 *
 * `byteSize` is included because a batch request over a spreadsheet the model
 * cannot see is a request it should be able to reason about the scale of;
 * nothing here identifies where the file is stored.
 */
export type TurnAttachmentDescriptor = {
  handle: string;
  name: string;
  mediaType: string;
  byteSize: number;
};

export const DOCX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/* ------------------------------------------------------------------------ */
/* Transcript admission                                                       */
/* ------------------------------------------------------------------------ */

/**
 * Refusals `admitTranscriptAttachmentObjects` can produce, as the codes the
 * request layer answers with.
 */
export const TRANSCRIPT_ATTACHMENT_REFUSAL_CODES = [
  "DUPLICATE_ATTACHMENT_OBJECT",
  "TOO_MANY_ATTACHMENT_OBJECTS",
] as const;

export type TranscriptAttachmentRefusalCode =
  (typeof TRANSCRIPT_ATTACHMENT_REFUSAL_CODES)[number];

export type TranscriptAttachmentAdmission =
  | { admitted: true; distinctObjectCount: number }
  | { admitted: false; code: TranscriptAttachmentRefusalCode };

/**
 * Decides whether a transcript may name the attachment objects it names.
 *
 * Two questions, and the scope of each is the whole point:
 *
 * **May one object be named twice?** Within the turn being sent, no. Five
 * reference slots all pointing at one file is a way to have the same bytes
 * read five times against a per-message allowance that counted five different
 * files, and nothing legitimate produces it -- the composer mints a fresh
 * upload per pick.
 *
 * **Across the transcript, yes.** An earlier turn naming the same object as
 * this one is an ordinary transcript fact: the route re-reads every message's
 * attachments on every turn already, so a repeat costs exactly what the second
 * message always cost. Refusing it made a *retry* impossible -- the failed turn
 * stays on screen, the retry names the same file again, and the request was
 * rejected before it reached a model, for as many times as the button was
 * pressed.
 *
 * **How many distinct objects may a conversation carry?** The cap counts
 * objects, not mentions, which is why it is measured on the deduplicated set.
 *
 * Identities are opaque strings minted by the caller (`a:`/`u:` for a resolved
 * reference, the object key for a guest); `null` means "this entry names no
 * object" and is skipped rather than treated as an identity of its own.
 */
export const admitTranscriptAttachmentObjects = (input: {
  /** Identities named by the message being sent, in composer order. */
  turn: readonly (string | null)[];
  /** Identities named by every earlier message in the transcript. */
  history: readonly (string | null)[];
  /** How many distinct objects one conversation may carry. */
  maxDistinctObjects: number;
}): TranscriptAttachmentAdmission => {
  const distinct = new Set<string>();
  for (const identity of input.turn) {
    if (!identity) continue;
    if (distinct.has(identity)) {
      return { admitted: false, code: "DUPLICATE_ATTACHMENT_OBJECT" };
    }
    distinct.add(identity);
  }
  for (const identity of input.history) {
    if (!identity) continue;
    distinct.add(identity);
  }
  if (distinct.size > input.maxDistinctObjects) {
    return { admitted: false, code: "TOO_MANY_ATTACHMENT_OBJECTS" };
  }
  return { admitted: true, distinctObjectCount: distinct.size };
};
