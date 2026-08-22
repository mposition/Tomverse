/**
 * Where a user's attachment lives, how it is named, and how it stops living.
 *
 * Policy: docs/policy/user-attachment-persistence.md.
 *
 * The shape of this module is inherited from `lib/generatedArtifactStorage.ts`
 * on purpose, because the uncomfortable fact is the same: object storage and
 * Postgres cannot be written in one transaction. So the same two failure
 * shapes are weighed and the same answer is reached.
 *
 *   * An object with no row is reclaimable. Nothing reaches it -- no route
 *     accepts a key, and every read resolves a row first.
 *   * A row with no object is not. It is an attachment card the user can see
 *     and a later turn cannot read.
 *
 * So the bytes go down first (the browser PUTs them, the finalisation step
 * verifies them and only then writes the upload row), binding writes the
 * attachment row inside the caller's transaction, and deletion goes the other
 * way: row first, tombstone, then object.
 */

import "server-only";

import { createHash } from "node:crypto";

import type { Prisma } from "@prisma/client";

import {
  messageAttachmentKindFor,
  turnAttachmentHandle,
  type MessageAttachmentKind,
  type MessageAttachmentReference,
  type TurnAttachmentDescriptor,
} from "@/lib/messageAttachmentCore";
import { prisma } from "@/lib/prisma";
import { deleteR2Object } from "@/lib/r2";

/**
 * The storage prefix for one account's uploads.
 *
 * Derived from the caller's own signed identity, never from anything in a
 * request. It is not an authorisation mechanism -- the row is -- but it is the
 * second check every resolution performs, so a row that somehow named a key
 * outside its owner's prefix is refused rather than read.
 */
export const ATTACHMENT_OBJECT_PREFIX = "attachments/";

export const accountAttachmentPrefix = (email: string): string =>
  `${ATTACHMENT_OBJECT_PREFIX}${createHash("sha256")
    .update(email.toLowerCase())
    .digest("hex")
    .slice(0, 20)}/`;

export const MESSAGE_ATTACHMENT_CLEANUP_REASONS = [
  "conversation_deleted",
  "account_deleted",
  "message_deleted",
  "upload_abandoned",
] as const;

export type MessageAttachmentCleanupReason =
  (typeof MESSAGE_ATTACHMENT_CLEANUP_REASONS)[number];

const CLEANUP_MAX_ATTEMPTS = 5;

/* ------------------------------------------------------------------------ */
/* Upload registration                                                        */
/* ------------------------------------------------------------------------ */

export type RegisteredUpload = {
  uploadId: string;
  name: string;
  mediaType: string;
  size: number;
  kind: MessageAttachmentKind;
};

/**
 * Records a finalised upload and returns the opaque handle for it.
 *
 * Called only after the object has been read back from storage and its size
 * and content type confirmed, so `size` here is measured rather than declared.
 * Idempotent on the object key: a client that finalises twice gets the same
 * handle instead of a second row pointing at the same bytes.
 */
export const registerFinalizedUpload = async (input: {
  userId: string;
  objectKey: string;
  ownPrefix: string;
  name: string;
  mediaType: string;
  size: number;
}): Promise<RegisteredUpload> => {
  if (!input.objectKey.startsWith(input.ownPrefix)) {
    throw new Error("Refusing to register an upload outside the caller's prefix.");
  }
  const kind = messageAttachmentKindFor(input.mediaType);
  const existing = await prisma.messageAttachmentUpload.findUnique({
    where: { objectKey: input.objectKey },
    select: { id: true, userId: true, name: true, mediaType: true, size: true, kind: true },
  });
  if (existing) {
    // A different account cannot reach this branch: the key embeds the
    // owner's hash and the caller's prefix was checked above. Refused anyway,
    // because "cannot happen" is not a reason to write the row.
    if (existing.userId !== input.userId) {
      throw new Error("Refusing to re-register another account's upload.");
    }
    return {
      uploadId: existing.id,
      name: existing.name,
      mediaType: existing.mediaType,
      size: existing.size,
      kind: existing.kind === "text" ? "text" : "file",
    };
  }
  const created = await prisma.messageAttachmentUpload.create({
    data: {
      userId: input.userId,
      objectKey: input.objectKey,
      name: input.name,
      mediaType: input.mediaType,
      size: input.size,
      kind,
    },
    select: { id: true },
  });
  return {
    uploadId: created.id,
    name: input.name,
    mediaType: input.mediaType,
    size: input.size,
    kind,
  };
};

/**
 * Removes an upload the composer discarded before it was ever sent.
 *
 * Only an *unbound* upload: once a message references the object, deleting it
 * from the composer would break a stored turn. A bound upload is reported as
 * `kept` rather than refused, because the composer's remove button is about
 * the draft and the user is not asking to edit history.
 */
export const discardUnboundUpload = async (input: {
  userId: string;
  uploadId: string;
}): Promise<{ removed: boolean; kept: boolean }> => {
  const upload = await prisma.messageAttachmentUpload.findFirst({
    where: { id: input.uploadId, userId: input.userId },
    select: { id: true, objectKey: true },
  });
  if (!upload) return { removed: false, kept: false };

  const bound = await prisma.messageAttachment.findUnique({
    where: { objectKey: upload.objectKey },
    select: { id: true },
  });
  if (bound) return { removed: false, kept: true };

  await prisma.messageAttachmentUpload.delete({ where: { id: upload.id } });
  await deleteR2Object(upload.objectKey);
  return { removed: true, kept: false };
};

/* ------------------------------------------------------------------------ */
/* Binding                                                                    */
/* ------------------------------------------------------------------------ */

export class MessageAttachmentBindError extends Error {
  constructor(
    readonly code:
      | "UNKNOWN_ATTACHMENT_UPLOAD"
      | "ATTACHMENT_UPLOAD_FORBIDDEN"
      | "ATTACHMENT_OUTSIDE_OWN_STORAGE"
      | "ATTACHMENT_ALREADY_BOUND",
    message: string
  ) {
    super(message);
    this.name = "MessageAttachmentBindError";
  }
};

/**
 * Binds finalised uploads to a message, inside the caller's transaction.
 *
 * The transaction is the contract: the message row and its attachment rows
 * commit together, so there is no state in which a stored turn shows a file
 * count it cannot list, or lists a file the message never carried.
 *
 * `createMany` with `skipDuplicates`, so a re-posted pre-save converges on the
 * same rows rather than failing the whole save. The unique index on
 * (messageId, ordinal) is what makes that idempotent rather than merely
 * forgiving -- and `objectKey`'s own unique index is what stops the same file
 * being bound to two different messages.
 */
export const bindMessageAttachments = async (
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    ownPrefix: string;
    conversationId: string;
    messageId: string;
    uploadIds: string[];
  }
): Promise<number> => {
  if (input.uploadIds.length === 0) return 0;

  const uploads = await tx.messageAttachmentUpload.findMany({
    where: { id: { in: input.uploadIds } },
    select: {
      id: true,
      userId: true,
      name: true,
      mediaType: true,
      size: true,
      kind: true,
      objectKey: true,
    },
  });
  const byId = new Map(uploads.map((upload) => [upload.id, upload]));

  const rows = input.uploadIds.map((uploadId, index) => {
    const upload = byId.get(uploadId);
    if (!upload) {
      throw new MessageAttachmentBindError(
        "UNKNOWN_ATTACHMENT_UPLOAD",
        "An attachment upload in this message does not exist."
      );
    }
    // Ownership is checked here rather than in the `where` above so that
    // "someone else's id" and "no such id" are distinguishable in the log and
    // indistinguishable in the response -- both answer the same 400.
    if (upload.userId !== input.userId) {
      throw new MessageAttachmentBindError(
        "ATTACHMENT_UPLOAD_FORBIDDEN",
        "An attachment upload in this message belongs to another account."
      );
    }
    if (!upload.objectKey.startsWith(input.ownPrefix)) {
      throw new MessageAttachmentBindError(
        "ATTACHMENT_OUTSIDE_OWN_STORAGE",
        "An attachment upload in this message is stored outside this account."
      );
    }
    return {
      messageId: input.messageId,
      conversationId: input.conversationId,
      userId: input.userId,
      ordinal: index,
      name: upload.name,
      mediaType: upload.mediaType,
      size: upload.size,
      kind: upload.kind,
      objectKey: upload.objectKey,
      uploadId: upload.id,
    };
  });

  /*
    An object belongs to one message.

    Checked here rather than left to the unique index, because `skipDuplicates`
    turns that index into a *silent* no-op: the save would succeed, the message
    would be stored, and the file it claimed to carry would simply not be
    there. A message that quietly lost its attachment is the failure this whole
    feature exists to remove, so the conflict is reported instead.

    Re-binding the same (messageId, ordinal) is the ordinary idempotent case
    and is not a conflict -- that is what `skipDuplicates` below is for.
  */
  const alreadyBound = await tx.messageAttachment.findMany({
    where: { objectKey: { in: rows.map((row) => row.objectKey) } },
    select: { objectKey: true, messageId: true },
  });
  if (alreadyBound.some((row) => row.messageId !== input.messageId)) {
    throw new MessageAttachmentBindError(
      "ATTACHMENT_ALREADY_BOUND",
      "An attachment in this message already belongs to another message."
    );
  }

  const created = await tx.messageAttachment.createMany({
    data: rows,
    skipDuplicates: true,
  });
  await tx.messageAttachmentUpload.updateMany({
    where: { id: { in: input.uploadIds }, boundAt: null },
    data: { boundAt: new Date() },
  });
  return created.count;
};

/* ------------------------------------------------------------------------ */
/* Resolution                                                                 */
/* ------------------------------------------------------------------------ */

export type ResolvedAttachment = {
  /** The bound row, when the reference named one. */
  attachmentId: string | null;
  uploadId: string | null;
  name: string;
  mediaType: string;
  size: number;
  kind: MessageAttachmentKind;
  /** Server-only. Never returned to a client by any route. */
  objectKey: string;
};

export class MessageAttachmentResolveError extends Error {
  constructor(
    readonly code:
      | "ATTACHMENT_REFERENCE_REQUIRED"
      | "ATTACHMENT_NOT_FOUND"
      | "ATTACHMENT_OUTSIDE_OWN_STORAGE",
    message: string
  ) {
    super(message);
    this.name = "MessageAttachmentResolveError";
  }
};

/**
 * Turns the opaque handles in a request into storage facts.
 *
 * Both lookups scope by `userId` inside the `where`, so ownership is part of
 * the query rather than a comparison afterwards: another account's id is
 * simply not found, and there is no branch that could be made to report the
 * difference. The prefix check that follows is redundant by construction and
 * kept anyway -- it is the check that still holds if a future writer ever
 * accepts a key from somewhere new.
 *
 * A bound attachment is additionally required to belong to the conversation
 * the request names, when it names one. Carrying a file forward from another
 * of the caller's own conversations is not a data leak, but it is not
 * something any screen can do, so a request that asks for it is not a request
 * this application made.
 */
export const resolveMessageAttachmentReferences = async (input: {
  userId: string;
  ownPrefix: string;
  conversationId: string | null;
  references: MessageAttachmentReference[];
}): Promise<ResolvedAttachment[]> => {
  if (input.references.length === 0) return [];

  const attachmentIds = Array.from(
    new Set(
      input.references
        .map((reference) => reference.attachmentId)
        .filter((value): value is string => Boolean(value))
    )
  );
  const uploadIds = Array.from(
    new Set(
      input.references
        .map((reference) => reference.uploadId)
        .filter((value): value is string => Boolean(value))
    )
  );

  const [attachments, uploads] = await Promise.all([
    attachmentIds.length
      ? prisma.messageAttachment.findMany({
          where: {
            id: { in: attachmentIds },
            userId: input.userId,
            ...(input.conversationId
              ? { conversationId: input.conversationId }
              : {}),
          },
          select: {
            id: true,
            uploadId: true,
            name: true,
            mediaType: true,
            size: true,
            kind: true,
            objectKey: true,
          },
        })
      : Promise.resolve([]),
    uploadIds.length
      ? prisma.messageAttachmentUpload.findMany({
          where: { id: { in: uploadIds }, userId: input.userId },
          select: {
            id: true,
            name: true,
            mediaType: true,
            size: true,
            kind: true,
            objectKey: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const attachmentById = new Map(attachments.map((row) => [row.id, row]));
  const uploadById = new Map(uploads.map((row) => [row.id, row]));

  return input.references.map((reference) => {
    const row = reference.attachmentId
      ? attachmentById.get(reference.attachmentId)
      : reference.uploadId
        ? uploadById.get(reference.uploadId)
        : undefined;
    if (!reference.attachmentId && !reference.uploadId) {
      throw new MessageAttachmentResolveError(
        "ATTACHMENT_REFERENCE_REQUIRED",
        "Attachments must be referenced by the id the upload step issued."
      );
    }
    if (!row) {
      throw new MessageAttachmentResolveError(
        "ATTACHMENT_NOT_FOUND",
        "An attachment in this request is no longer available."
      );
    }
    if (!row.objectKey.startsWith(input.ownPrefix)) {
      throw new MessageAttachmentResolveError(
        "ATTACHMENT_OUTSIDE_OWN_STORAGE",
        "An attachment in this request is stored outside this account."
      );
    }
    return {
      attachmentId: reference.attachmentId ? row.id : null,
      uploadId: reference.uploadId
        ? row.id
        : (row as { uploadId?: string | null }).uploadId ?? null,
      name: row.name,
      mediaType: row.mediaType,
      size: row.size,
      kind: row.kind === "text" ? "text" : "file",
      objectKey: row.objectKey,
    };
  });
};

/**
 * The handles the model is given for this turn's own files.
 *
 * Index-based and request-scoped: `att_1` is the first file on this turn and
 * addresses nothing outside it. Built from the same resolved list the request
 * layer reads, so a handle can never name a file the turn did not carry.
 */
export const describeTurnAttachments = (
  resolved: Array<{ name: string; mediaType: string; size: number }>
): TurnAttachmentDescriptor[] =>
  resolved.map((attachment, index) => ({
    handle: turnAttachmentHandle(index),
    name: attachment.name,
    mediaType: attachment.mediaType,
    byteSize: attachment.size,
  }));

/* ------------------------------------------------------------------------ */
/* Deleting                                                                   */
/* ------------------------------------------------------------------------ */

const enqueueKeys = async (
  tx: Prisma.TransactionClient,
  keys: string[],
  reason: MessageAttachmentCleanupReason
): Promise<number> => {
  if (keys.length === 0) return 0;
  await tx.messageAttachmentCleanup.createMany({
    data: keys.map((objectKey) => ({ objectKey, reason })),
    skipDuplicates: true,
  });
  return keys.length;
};

/**
 * Enqueues every attachment object in these conversations.
 *
 * Runs in the SAME transaction that removes the rows, which is the whole
 * ordering guarantee: the tombstone commits with the deletion, so a process
 * that dies immediately afterwards still leaves a record of what has to be
 * collected.
 */
export const enqueueMessageAttachmentCleanupForConversations = async (
  tx: Prisma.TransactionClient,
  conversationIds: string[],
  reason: MessageAttachmentCleanupReason = "conversation_deleted"
): Promise<number> => {
  if (conversationIds.length === 0) return 0;
  const rows = await tx.messageAttachment.findMany({
    where: { conversationId: { in: conversationIds } },
    select: { objectKey: true },
  });
  return enqueueKeys(
    tx,
    rows.map((row) => row.objectKey),
    reason
  );
};

/**
 * The same, for every attachment an account owns -- including the uploads it
 * finalised and never sent, which no conversation would ever name.
 */
export const enqueueMessageAttachmentCleanupForUser = async (
  tx: Prisma.TransactionClient,
  userId: string,
  reason: MessageAttachmentCleanupReason = "account_deleted"
): Promise<number> => {
  const [bound, uploads] = await Promise.all([
    tx.messageAttachment.findMany({
      where: { userId },
      select: { objectKey: true },
    }),
    tx.messageAttachmentUpload.findMany({
      where: { userId },
      select: { objectKey: true },
    }),
  ]);
  const keys = Array.from(
    new Set([
      ...bound.map((row) => row.objectKey),
      ...uploads.map((row) => row.objectKey),
    ])
  );
  return enqueueKeys(tx, keys, reason);
};

/**
 * The same, for a specific set of messages.
 *
 * Deliberately takes a message filter and no default role. The one caller that
 * exists today -- the per-model history reset -- deletes *assistant* messages,
 * and an attachment belongs to the *user* message the whole comparison shares.
 * Clearing one model's answers must not take the question's files with it, and
 * the way to be sure of that is for the filter to be the caller's to state.
 */
export const enqueueMessageAttachmentCleanupForMessages = async (
  tx: Prisma.TransactionClient,
  where: { conversationId: string; modelId?: string; role?: string }
): Promise<number> => {
  const rows = await tx.messageAttachment.findMany({
    where: {
      conversationId: where.conversationId,
      message: {
        ...(where.modelId ? { modelId: where.modelId } : {}),
        ...(where.role ? { role: where.role } : {}),
      },
    },
    select: { objectKey: true },
  });
  return enqueueKeys(
    tx,
    rows.map((row) => row.objectKey),
    "message_deleted"
  );
};

export type MessageAttachmentCleanupSweepResult = {
  examined: number;
  deleted: number;
  failed: number;
  exhausted: number;
};

/**
 * Drains pending tombstones.
 *
 * DeleteObject succeeds for a key that is already gone, so two overlapping
 * sweeps racing on one row both converge on "object gone, row completed": the
 * operation is idempotent and needs no claim. A row past the attempt ceiling
 * is left for an operator and reported as `exhausted` rather than retried
 * forever.
 *
 * Every outcome is a structured line. A cleanup queue nobody can see the
 * failures of is a queue that quietly stops being one.
 */
export const drainMessageAttachmentCleanupQueue = async (
  limit = 200,
  now = new Date()
): Promise<MessageAttachmentCleanupSweepResult> => {
  const pending = await prisma.messageAttachmentCleanup.findMany({
    where: { completedAt: null, attempts: { lt: CLEANUP_MAX_ATTEMPTS } },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, objectKey: true, reason: true, attempts: true },
  });

  let deleted = 0;
  let failed = 0;
  for (const item of pending) {
    try {
      await deleteR2Object(item.objectKey);
      await prisma.messageAttachmentCleanup.update({
        where: { id: item.id },
        data: { completedAt: now, lastError: null },
      });
      deleted += 1;
    } catch (error) {
      failed += 1;
      const attempts = item.attempts + 1;
      await prisma.messageAttachmentCleanup
        .update({
          where: { id: item.id },
          data: {
            attempts: { increment: 1 },
            lastError: String(error).slice(0, 300),
          },
        })
        .catch(() => undefined);
      console.error(
        JSON.stringify({
          event: "message_attachment_cleanup_failed",
          cleanupId: item.id,
          reason: item.reason,
          attempts,
          exhausted: attempts >= CLEANUP_MAX_ATTEMPTS,
          error: String(error).slice(0, 300),
          timestamp: now.toISOString(),
        })
      );
    }
  }

  const exhausted = await prisma.messageAttachmentCleanup.count({
    where: { completedAt: null, attempts: { gte: CLEANUP_MAX_ATTEMPTS } },
  });

  if (pending.length > 0 || exhausted > 0) {
    console.info(
      JSON.stringify({
        event: "message_attachment_cleanup_swept",
        examined: pending.length,
        deleted,
        failed,
        exhausted,
        timestamp: now.toISOString(),
      })
    );
  }

  return { examined: pending.length, deleted, failed, exhausted };
};

/**
 * The ride-along for the fifteen-minute maintenance cron.
 *
 * Never throws, the same contract the artifact and image sweeps hold: it
 * cannot turn a successful reconciliation run into a failed one.
 */
export const runMessageAttachmentMaintenanceQuietly = async (
  now = new Date()
): Promise<{ cleanup: MessageAttachmentCleanupSweepResult }> => {
  try {
    return { cleanup: await drainMessageAttachmentCleanupQueue(200, now) };
  } catch (error) {
    console.error("Message attachment maintenance failed:", error);
    return {
      cleanup: { examined: 0, deleted: 0, failed: 0, exhausted: 0 },
    };
  }
};
