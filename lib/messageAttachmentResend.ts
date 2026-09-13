import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { bindMessageAttachments } from "@/lib/messageAttachmentStorage";
import { readOwnR2ObjectBytes, writeR2Object } from "@/lib/r2";
import { classifyStorageError } from "@/lib/storageObjectErrors";

const opaqueId = z.string().trim().min(1).max(64);
/** Ordered, opaque handles only. Unlike a provider request, one save ref has one authority. */
export const savedMessageAttachmentReferenceSchema = z.union([
  z.object({ uploadId: opaqueId }).strict(),
  z.object({ attachmentId: opaqueId }).strict(),
]);
export const savedMessageAttachmentReferencesSchema = z.array(savedMessageAttachmentReferenceSchema).max(5)
  .refine((refs) => new Set(refs.map((ref) => "attachmentId" in ref ? `attachment:${ref.attachmentId}` : `upload:${ref.uploadId}`)).size === refs.length,
    "Each attachment handle may occur only once per saved message.");
export type SavedMessageAttachmentReference = z.infer<typeof savedMessageAttachmentReferenceSchema>;

export class MessageAttachmentResendError extends Error {
  constructor(readonly code: "ATTACHMENT_UNAVAILABLE" | "ATTACHMENT_STORAGE_UNAVAILABLE" | "MESSAGE_SAVE_CONFLICT", readonly status: number) {
    super(code);
    this.name = "MessageAttachmentResendError";
  }
}

type Message = {
  id: string;
  content: string;
  modelId?: string;
  attachmentUploadIds?: string[];
  attachmentReferences?: SavedMessageAttachmentReference[];
};
const metadataSelect = {
  id: true, userId: true, objectKey: true, name: true,
  mediaType: true, size: true, kind: true,
} as const;
type Metadata = {
  id: string; userId: string; objectKey: string; name: string;
  mediaType: string; size: number; kind: string;
};
type PreparedRef = { uploadId: string } | { sourceId: string; source: Metadata; copyKey?: string };
type Db = Pick<Prisma.TransactionClient, "message" | "messageAttachment" | "messageAttachmentUpload">;
const unavailable = () => new MessageAttachmentResendError("ATTACHMENT_UNAVAILABLE", 410);

async function existingOwnedMessage(db: Db, messageId: string, userId: string, conversationId: string) {
  const existing = await db.message.findUnique({
    where: { id: messageId }, select: { role: true, conversationId: true, conversation: { select: { userId: true } } },
  });
  if (!existing) return false;
  if (existing.role !== "user" || existing.conversationId !== conversationId || existing.conversation.userId !== userId) {
    throw new MessageAttachmentResendError("MESSAGE_SAVE_CONFLICT", 409);
  }
  return true;
}

async function readSources(db: Db, refs: SavedMessageAttachmentReference[], input: { userId: string; conversationId: string; ownPrefix: string }): Promise<PreparedRef[]> {
  const result: PreparedRef[] = [];
  for (const ref of refs) {
    if ("attachmentId" in ref) {
      const row = await db.messageAttachment.findFirst({
        where: { id: ref.attachmentId, userId: input.userId, conversationId: input.conversationId },
        select: { ...metadataSelect, unavailableAt: true },
      });
      if (!row || row.unavailableAt || !row.objectKey.startsWith(input.ownPrefix) || !Number.isSafeInteger(row.size) || row.size <= 0) throw unavailable();
      result.push({ sourceId: row.id, source: row });
    } else {
      const row = await db.messageAttachmentUpload.findFirst({
        where: { id: ref.uploadId, userId: input.userId }, select: metadataSelect,
      });
      if (!row || !row.objectKey.startsWith(input.ownPrefix)) throw unavailable();
      const bound = await db.messageAttachment.findUnique({ where: { objectKey: row.objectKey }, select: { id: true } });
      if (bound) throw unavailable();
      result.push({ uploadId: row.id });
    }
  }
  return result;
}

/** Only this operation's never-published fresh keys; never the source or a winner's bound object. */
async function enqueueUnboundCopies(keys: string[]) {
  if (!keys.length) return;
  await prisma.$transaction(async (tx) => {
    const bound = await tx.messageAttachment.findMany({ where: { objectKey: { in: keys } }, select: { objectKey: true } });
    const protectedKeys = new Set(bound.map((row) => row.objectKey));
    const unused = keys.filter((key) => !protectedKeys.has(key));
    if (!unused.length) return;
    await tx.messageAttachmentCleanup.createMany({
      data: unused.map((objectKey) => ({ objectKey, reason: "upload_abandoned" })), skipDuplicates: true,
    });
  });
}

/**
 * Copy bytes before opening the default-duration transaction. A concurrent loser
 * can prepare temporary copies, but only the PK winner binds rows. All settled
 * unbound writes are queued afterwards; a process kill / unavailable cleanup DB
 * retains the existing objects-first recovery limitation, not an atomic R2 claim.
 */
export async function saveMessagesWithAttachmentReferences(input: {
  userId: string; conversationId: string; ownPrefix: string; messages: Message[];
  beforeCreate: (tx: Prisma.TransactionClient) => Promise<void>;
}): Promise<{ count: number }> {
  if (new Set(input.messages.map((message) => message.id)).size !== input.messages.length) {
    throw new MessageAttachmentResendError("MESSAGE_SAVE_CONFLICT", 409);
  }
  for (const message of input.messages) {
    if (message.attachmentReferences && (!savedMessageAttachmentReferencesSchema.safeParse(message.attachmentReferences).success || message.attachmentUploadIds)) {
      throw new MessageAttachmentResendError("MESSAGE_SAVE_CONFLICT", 409);
    }
  }
  const prepared = new Map<string, PreparedRef[] | null>();
  const freshKeys: string[] = [];
  try {
    // Validate the whole batch before copying its first byte.
    for (const message of input.messages) {
      if (!message.attachmentReferences) continue;
      prepared.set(message.id, await existingOwnedMessage(prisma, message.id, input.userId, input.conversationId)
        ? null : await readSources(prisma, message.attachmentReferences, input));
    }
    // Pure readback of fully persisted, owned reference saves reserves no new
    // quota. A mixed batch and every legacy upload-only save keep their checks.
    if (prepared.size === input.messages.length && [...prepared.values()].every((refs) => refs === null)) return { count: 0 };
    // A cheap refusal before storage I/O; the authoritative check repeats in
    // the winner transaction because this precheck reserves no capacity.
    await prisma.$transaction(input.beforeCreate);
    for (const refs of prepared.values()) {
      for (const ref of refs ?? []) {
        if (!("sourceId" in ref)) continue;
        let bytes: Buffer;
        try {
          bytes = await readOwnR2ObjectBytes(ref.source.objectKey, { maxBytes: ref.source.size });
        } catch (error) {
          throw classifyStorageError(error) === "missing"
            ? unavailable() : new MessageAttachmentResendError("ATTACHMENT_STORAGE_UNAVAILABLE", 503);
        }
        if (bytes.length !== ref.source.size) throw unavailable();
        ref.copyKey = `${input.ownPrefix}resend/${randomUUID()}`;
        freshKeys.push(ref.copyKey); // A rejected PUT can still have written bytes.
        try { await writeR2Object(ref.copyKey, bytes, ref.source.mediaType); }
        catch { throw new MessageAttachmentResendError("ATTACHMENT_STORAGE_UNAVAILABLE", 503); }
      }
    }
    return await prisma.$transaction(async (tx) => {
      await input.beforeCreate(tx);
      let count = 0;
      for (const message of input.messages) {
        const created = await tx.message.createMany({ data: [{
          id: message.id, conversationId: input.conversationId, role: "user",
          content: message.content, status: "normal", modelId: message.modelId || null,
        }], skipDuplicates: true });
        count += created.count;
        if (message.attachmentReferences) {
          if (!created.count) {
            if (!await existingOwnedMessage(tx, message.id, input.userId, input.conversationId)) throw new MessageAttachmentResendError("MESSAGE_SAVE_CONFLICT", 409);
            continue;
          }
          const refs = prepared.get(message.id);
          // A row deleted between the fast readback and this transaction is not
          // recreated without its original attachments. Retry from a fresh save.
          if (!refs) throw new MessageAttachmentResendError("MESSAGE_SAVE_CONFLICT", 409);
          const uploadIds: string[] = [];
          for (const ref of refs) {
            if ("uploadId" in ref) { uploadIds.push(ref.uploadId); continue; }
            const [current] = await readSources(tx, [{ attachmentId: ref.sourceId }], input);
            if (!("sourceId" in current) || current.source.objectKey !== ref.source.objectKey || !ref.copyKey) throw unavailable();
            const upload = await tx.messageAttachmentUpload.create({ data: {
              userId: input.userId, objectKey: ref.copyKey, name: ref.source.name,
              mediaType: ref.source.mediaType, size: ref.source.size, kind: ref.source.kind,
            }, select: { id: true } });
            uploadIds.push(upload.id);
          }
          await bindMessageAttachments(tx, { ...input, messageId: message.id, uploadIds });
        } else if (message.attachmentUploadIds?.length) {
          // Legacy saves retain their existing binder/refusal semantics.
          await bindMessageAttachments(tx, { ...input, messageId: message.id, uploadIds: message.attachmentUploadIds });
        }
      }
      return { count };
    });
  } finally {
    try { await enqueueUnboundCopies(freshKeys); }
    catch {
      // No keys, bytes or exception text enter logs. The cleanup DB can itself
      // be unavailable; do not claim a completed cleanup in that case.
      console.error(JSON.stringify({ event: "message_attachment_resend_cleanup_deferred", objectCount: freshKeys.length }));
    }
  }
}
