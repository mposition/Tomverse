import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { BoundedBufferError } from "@/lib/boundedBuffer";
import { attachmentKindForFormat } from "@/lib/chatAttachmentFormats";
import { MAX_EXTRACTED_ATTACHMENT_CHARACTERS } from "@/lib/chatAttachmentLimits";
import { ChatAttachmentValidationError, validateChatAttachmentUpload } from "@/lib/chatAttachmentValidation";
import { hasConversationUnlockGrant } from "@/lib/conversationLock";
import { generatedArtifactRevisionEnabled, generatedArtifactRevisionFormat } from "@/lib/generatedArtifactRevisionCore";
import { accountAttachmentPrefix, registerFinalizedUpload, type RegisteredUpload } from "@/lib/messageAttachmentStorage";
import { prisma } from "@/lib/prisma";
import { readOwnR2ObjectBytes, writeR2Object } from "@/lib/r2";
import { classifyStorageError } from "@/lib/storageObjectErrors";
import { parseCanonicalWorkbookSpec, prepareGeneratedWorkbookRevision, WorkbookRevisionError, type CanonicalWorkbookSpec } from "@/lib/generatedArtifactWorkbookRevision";

const opaqueId = z.string().trim().min(1).max(64);
export const generatedArtifactCopySchema = z.object({
  action: z.literal("generated-artifact-copy"),
  artifactId: opaqueId,
  conversationId: opaqueId,
  operationId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
}).strict();

export class GeneratedArtifactRevisionError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = "GeneratedArtifactRevisionError";
  }
}

const sourceSelect = {
  id: true, conversationId: true, objectKey: true, format: true, filename: true,
  mediaType: true, byteSize: true, status: true,
  canonicalSpec: true, lineageId: true,
  conversation: { select: { userId: true, password: true, passwordVersion: true } },
} as const;
type Input = z.infer<typeof generatedArtifactCopySchema> & {
  userId: string;
  email: string;
  request: Request;
  maxBytes: number;
  reserveBytes: (bytes: number) => Promise<void>;
};
type Db = Pick<Prisma.TransactionClient, "messageArtifact">;
const unavailable = () => new GeneratedArtifactRevisionError("ATTACHMENT_UNAVAILABLE", 404);

async function readSource(db: Db, input: Input) {
  const source = await db.messageArtifact.findFirst({
    where: { id: input.artifactId, userId: input.userId, conversationId: input.conversationId },
    select: sourceSelect,
  });
  if (!source || source.conversation.userId !== input.userId || source.status !== "ready" ||
    !source.objectKey?.startsWith(`message-artifacts/${input.userId}/${input.conversationId}/`)) throw unavailable();
  if (!hasConversationUnlockGrant(input.request, input.userId, input.conversationId, source.conversation.password == null ? null : source.conversation.passwordVersion)) {
    throw new GeneratedArtifactRevisionError("CONVERSATION_LOCKED", 423);
  }
  return source;
}

const asUpload = (row: { id: string; userId: string; objectKey: string; name: string; mediaType: string; size: number; kind: string; sourceCanonicalSpec?: unknown }, userId: string, ownPrefix: string): RegisteredUpload => {
  if (row.userId !== userId || !row.objectKey.startsWith(ownPrefix)) throw unavailable();
  const canonical = parseCanonicalWorkbookSpec(row.sourceCanonicalSpec);
  return { uploadId: row.id, name: row.name, mediaType: row.mediaType, size: row.size, kind: row.kind === "text" ? "text" : "file",
    ...(canonical ? { revisionMode: canonical.fidelity === "values" ? "workbook-values" : "workbook" } as const : {}) };
};

/**
 * Exact selected output -> independent private input. No model, message or lineage write.
 * A hash-derived opaque upload id identifies the operation without a new schema.
 * Each attempt writes a fresh key outside the transaction. Only the winning key
 * is registered; cleanup never sees the source or another attempt's winning key.
 */
export async function copyGeneratedArtifactForRevision(input: Input): Promise<RegisteredUpload> {
  if (!generatedArtifactRevisionEnabled()) throw new GeneratedArtifactRevisionError("GENERATED_ARTIFACT_REVISION_DISABLED", 404);
  generatedArtifactCopySchema.parse({ action: input.action, artifactId: input.artifactId, conversationId: input.conversationId, operationId: input.operationId });
  const source = await readSource(prisma, input);
  const format = generatedArtifactRevisionFormat({ format: source.format, filename: source.filename, mediaType: source.mediaType });
  if (!format) throw new GeneratedArtifactRevisionError("UNSUPPORTED_ATTACHMENT_TYPE", 400);
  if (!Number.isSafeInteger(source.byteSize) || source.byteSize <= 0) throw unavailable();
  if (source.byteSize > input.maxBytes) throw new GeneratedArtifactRevisionError("ATTACHMENT_TOO_LARGE", 413);
  // A Research task file made from private sources is copied only while those sources still grant it.
  if (!(await (await import("@/lib/researchEngineTaskFiles")).researchTaskFileServable({ id: source.id, objectKey: source.objectKey! }))) throw unavailable();
  const operationHash = createHash("sha256").update(JSON.stringify([input.userId, input.conversationId, input.artifactId, input.operationId])).digest("hex");
  const ownPrefix = accountAttachmentPrefix(input.email);
  const uploadId = `rev_${operationHash.slice(0, 56)}`;
  const authorize = async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${uploadId}, 0))`;
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.userId} FOR KEY SHARE`;
    await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id" = ${input.conversationId} AND "userId" = ${input.userId} FOR SHARE`;
    await tx.$queryRaw`SELECT "id" FROM "MessageArtifact" WHERE "id" = ${input.artifactId} AND "userId" = ${input.userId} FOR SHARE`;
    const current = await readSource(tx, input);
    if (current.objectKey !== source.objectKey || current.byteSize !== source.byteSize || current.filename !== source.filename || current.format !== source.format || current.mediaType !== source.mediaType || current.lineageId !== source.lineageId || JSON.stringify(current.canonicalSpec) !== JSON.stringify(source.canonicalSpec)) throw unavailable();
    return tx.messageAttachmentUpload.findFirst({ where: { id: uploadId, userId: input.userId } });
  };
  const replay = await prisma.$transaction(authorize);
  if (replay) return asUpload(replay, input.userId, ownPrefix);
  // Source reads are bounded and never use the destructive upload-validation reader.
  let bytes: Buffer;
  try { bytes = await readOwnR2ObjectBytes(source.objectKey!, { maxBytes: Math.min(source.byteSize, input.maxBytes) }); }
  catch (error) {
    if (error instanceof BoundedBufferError || classifyStorageError(error) === "missing") throw unavailable();
    throw new GeneratedArtifactRevisionError("ATTACHMENT_STORAGE_UNAVAILABLE", 503);
  }
  if (bytes.byteLength !== source.byteSize) throw unavailable();
  const inspected = await validateChatAttachmentUpload({ buffer: bytes, format, scope: "account",
    ...(source.format === "xlsx" ? {} : { maxExtractedCharacters: MAX_EXTRACTED_ATTACHMENT_CHARACTERS }) });
  let canonical: CanonicalWorkbookSpec | undefined;
  if (source.format === "xlsx") {
    try { canonical = await prepareGeneratedWorkbookRevision(bytes, source.canonicalSpec, source.filename); }
    catch (error) {
      if (error instanceof WorkbookRevisionError) throw new GeneratedArtifactRevisionError(error.code, error.status);
      throw error;
    }
  }
  if (!inspected.bytes.byteLength) throw new ChatAttachmentValidationError("ATTACHMENT_NO_TEXT");
  if (inspected.bytes.byteLength > input.maxBytes) throw new ChatAttachmentValidationError("ATTACHMENT_TOO_LARGE", 413);
  // Quota includes actual attempted writes. A settled replay above performs no I/O
  // or reservation; concurrent unregistered attempts each reserve their own bytes.
  await input.reserveBytes(inspected.bytes.byteLength);
  const copyKey = `${ownPrefix}generated-revision/${randomUUID()}`;
  try {
    try { await writeR2Object(copyKey, inspected.bytes, inspected.mediaType); }
    catch { throw new GeneratedArtifactRevisionError("ATTACHMENT_STORAGE_UNAVAILABLE", 503); }
    return await prisma.$transaction(async (tx) => {
      const existing = await authorize(tx);
      if (existing) return asUpload(existing, input.userId, ownPrefix);
      const registered = await registerFinalizedUpload({
        uploadId, userId: input.userId, objectKey: copyKey, ownPrefix, name: source.filename,
        mediaType: inspected.mediaType, size: inspected.bytes.byteLength, kind: attachmentKindForFormat(format),
        sourceArtifactId: source.id, sourceLineageId: source.lineageId ?? source.id,
        sourceConversationId: input.conversationId,
        ...(canonical ? { sourceCanonicalSpec: canonical as unknown as Prisma.InputJsonValue } : {}),
      }, tx);
      return { ...registered, ...(canonical ? { revisionMode: canonical.fidelity === "values" ? "workbook-values" : "workbook" } as const : {}) };
    });
  } catch (error) {
    // The unique key is still authoritative if a non-helper registrar won it.
    // Re-read after rollback, never inside an already aborted transaction.
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      const winner = await prisma.$transaction(authorize);
      if (winner) return asUpload(winner, input.userId, ownPrefix);
    }
    throw error;
  } finally {
    try {
      await prisma.$transaction(async (tx) => {
        const [upload, bound] = await Promise.all([
          tx.messageAttachmentUpload.findUnique({ where: { objectKey: copyKey }, select: { id: true } }),
          tx.messageAttachment.findUnique({ where: { objectKey: copyKey }, select: { id: true } }),
        ]);
        // Verify unknown commit outcomes. A registered or bound winner is kept;
        // only this attempt's never-published random key enters existing cleanup.
        if (!upload && !bound) await tx.messageAttachmentCleanup.createMany({
          data: [{ objectKey: copyKey, reason: "upload_abandoned" }], skipDuplicates: true,
        });
      });
    } catch {
      console.error(JSON.stringify({ event: "generated_artifact_revision_cleanup_deferred", objectCount: 1 }));
    }
  }
}
