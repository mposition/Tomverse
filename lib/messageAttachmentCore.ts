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
/* Availability                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Why a stored attachment can no longer be read.
 *
 * One entry today, and the enumeration exists anyway: this value decides what
 * the user is told, and a reason nobody wrote copy for would render as a card
 * that says something is wrong without saying what.
 *
 * `storage_object_missing` means storage answered 404 for an object a row
 * still names. In production that has had exactly one cause -- a time-based
 * bucket lifecycle rule deleting an object the application never enqueued for
 * deletion -- and the reason is deliberately named after the *observation*
 * rather than that cause, because the next cause will look identical from
 * here.
 */
export const MESSAGE_ATTACHMENT_UNAVAILABLE_REASONS = [
  "storage_object_missing",
] as const;

export type MessageAttachmentUnavailableReason =
  (typeof MESSAGE_ATTACHMENT_UNAVAILABLE_REASONS)[number];

export const isMessageAttachmentUnavailableReason = (
  value: unknown
): value is MessageAttachmentUnavailableReason =>
  typeof value === "string" &&
  (MESSAGE_ATTACHMENT_UNAVAILABLE_REASONS as readonly string[]).includes(value);

/**
 * The acknowledgement a client sends to continue a turn without a file it has
 * been told is gone.
 *
 * Per attachment id, never a blanket boolean. A boolean would let one
 * confirmation carry every future missing file in the conversation, including
 * ones the user has not been shown yet -- and the whole point of failing
 * closed is that the model must not answer about a document nobody knows it
 * did not read.
 *
 * Acknowledging is not deleting. The `MessageAttachment` row, the message and
 * the card all survive it; the acknowledgement scopes exactly one request.
 */
export const acknowledgedUnavailableAttachmentsSchema = z
  .array(opaqueId)
  .max(50)
  .optional();

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
  /**
   * ISO timestamp of the confirmed 404, when there has been one.
   *
   * Absent on an ordinary attachment rather than present-and-null, so a card
   * that has never been checked and a card that was checked and found is the
   * same shape -- there is nothing for a client to distinguish, and a `null`
   * would invite it to try.
   *
   * This is the only new thing a client learns about storage, and it is a
   * verdict rather than a location: no key, no bucket, no endpoint.
   */
  unavailableAt?: string;
  unavailableReason?: MessageAttachmentUnavailableReason;
};

/** The Prisma `select` that produces exactly the public shape. */
export const PUBLIC_MESSAGE_ATTACHMENT_SELECT = {
  id: true,
  ordinal: true,
  name: true,
  mediaType: true,
  size: true,
  kind: true,
  unavailableAt: true,
  unavailableReason: true,
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
  unavailableAt?: Date | string | null;
  unavailableReason?: string | null;
}): PublicMessageAttachment => ({
  id: row.id,
  ordinal: row.ordinal,
  name: row.name,
  mediaType: row.mediaType,
  size: row.size,
  kind: row.kind === "text" ? "text" : "file",
  ...(row.unavailableAt
    ? {
        unavailableAt:
          row.unavailableAt instanceof Date
            ? row.unavailableAt.toISOString()
            : String(row.unavailableAt),
      }
    : {}),
  // Only an enumerated reason travels. An unrecognised value in the column is
  // reported as no reason rather than passed through, because the client turns
  // this into a sentence and there is no sentence for a word it does not know.
  ...(isMessageAttachmentUnavailableReason(row.unavailableReason)
    ? { unavailableReason: row.unavailableReason }
    : {}),
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
