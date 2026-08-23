/**
 * Where a generated file lives, and how it stops living.
 *
 * Policy: docs/policy/generated-artifacts.md sections 5 and 8.
 *
 * The uncomfortable fact this module exists for: object storage and Postgres
 * cannot be written in one transaction. Every function here follows from
 * deciding which of the two failure shapes is acceptable.
 *
 *   * An object with no row is reclaimable. Nothing can reach it -- the
 *     download route reads the row first -- and two sweeps below collect it:
 *     the tombstone drain for deletions we caused, and the orphan sweep for
 *     objects whose row write never landed.
 *   * A row with no object is not. It is a download button that 500s, on a
 *     file the product told the user it had made.
 *
 * So bytes are written first and the row second, deletion goes the other way
 * (row first, tombstone, then object), and the only thing left to build is the
 * collector that reclaims what a failed turn wrote.
 */

import "server-only";

import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import {
  ARTIFACT_LIMITS,
  requireArtifactFormat,
  type SupportedArtifactFormat,
} from "@/lib/generatedArtifactCore";
import { prisma } from "@/lib/prisma";
import { deleteR2Object, listExpiredR2Objects, writeR2Object } from "@/lib/r2";

/**
 * The storage prefix. Enumerable, because the orphan sweep depends on being
 * able to list it, and separate from every other prefix so that listing it
 * cannot reach an attachment or a generated image.
 */
export const ARTIFACT_OBJECT_PREFIX = "message-artifacts/";

/**
 * How long an object may exist without a row before the sweep reclaims it.
 *
 * Generously longer than any single chat turn. The window is not a guess about
 * request duration but a safety margin against the one race that matters: the
 * sweep must never delete an object whose row is about to be written by a turn
 * that is still running.
 */
export const ARTIFACT_ORPHAN_TTL_MS = 6 * 60 * 60 * 1000;

const ARTIFACT_ORPHAN_SWEEP_BATCH = 200;
const ARTIFACT_CLEANUP_MAX_ATTEMPTS = 5;

export const ARTIFACT_CLEANUP_REASONS = [
  "conversation_deleted",
  "account_deleted",
  "message_deleted",
  "storage_rollback",
] as const;

export type ArtifactCleanupReason = (typeof ARTIFACT_CLEANUP_REASONS)[number];

/**
 * The object key for one artifact.
 *
 * The owner is in the path for one reason only: an operator reading a storage
 * listing can tell whose file it is. It is **not** an authorisation mechanism.
 * The download route decides access from the row, and a key that could be
 * guessed would still be useless because no route accepts a key from a client
 * (policy section 5).
 */
export const artifactObjectKey = (input: {
  userId: string;
  conversationId: string;
  artifactId: string;
  format: SupportedArtifactFormat;
}): string =>
  `${ARTIFACT_OBJECT_PREFIX}${input.userId}/${input.conversationId}/` +
  `${input.artifactId}${requireArtifactFormat(input.format).extension}`;

/* ------------------------------------------------------------------------ */
/* Writing                                                                    */
/* ------------------------------------------------------------------------ */

export type StoredArtifact = {
  id: string;
  ordinal: number;
  format: SupportedArtifactFormat;
  filename: string;
  mediaType: string;
  byteSize: number;
  objectKey: string;
  modelId: string | null;
};

/**
 * Puts the bytes in storage and returns the row that has not been written yet.
 *
 * Deliberately does not touch the database. The assistant message it belongs
 * to does not exist while the turn is streaming -- it is created when the
 * stream finishes -- and a foreign key cannot point at a row that is not
 * there. So the object goes down now, the row goes down with the message
 * later, and `discardStoredArtifacts` covers the gap.
 */
export const putArtifactObject = async (input: {
  userId: string;
  conversationId: string;
  ordinal: number;
  format: SupportedArtifactFormat;
  filename: string;
  mediaType: string;
  bytes: Uint8Array;
  modelId: string | null;
}): Promise<StoredArtifact> => {
  if (input.bytes.byteLength <= 0) {
    throw new Error("Refusing to store an empty artifact.");
  }
  if (input.bytes.byteLength > ARTIFACT_LIMITS.maxOutputBytes) {
    throw new Error("Refusing to store an artifact over the size limit.");
  }

  const id = randomUUID();
  const objectKey = artifactObjectKey({
    userId: input.userId,
    conversationId: input.conversationId,
    artifactId: id,
    format: input.format,
  });

  await writeR2Object(objectKey, Buffer.from(input.bytes), input.mediaType);

  return {
    id,
    ordinal: input.ordinal,
    format: input.format,
    filename: input.filename,
    mediaType: input.mediaType,
    byteSize: input.bytes.byteLength,
    objectKey,
    modelId: input.modelId,
  };
};

/**
 * Writes the rows for a finished turn, inside the caller's transaction.
 *
 * `createMany` with `skipDuplicates`, so a replayed persist converges on the
 * same rows rather than failing the whole message write. The unique index on
 * (messageId, ordinal) is what makes that idempotent rather than merely
 * forgiving.
 */
export const persistArtifactRows = async (
  tx: Prisma.TransactionClient,
  input: {
    messageId: string;
    conversationId: string;
    userId: string;
    stored: StoredArtifact[];
    failed: Array<{ ordinal: number; format: SupportedArtifactFormat; filename: string; mediaType: string; failureCode: string; modelId: string | null }>;
  }
): Promise<number> => {
  const rows = [
    ...input.stored.map((artifact) => ({
      id: artifact.id,
      messageId: input.messageId,
      conversationId: input.conversationId,
      userId: input.userId,
      ordinal: artifact.ordinal,
      format: artifact.format,
      filename: artifact.filename,
      mediaType: artifact.mediaType,
      byteSize: artifact.byteSize,
      status: "ready",
      objectKey: artifact.objectKey,
      modelId: artifact.modelId,
    })),
    // A failed generation is recorded too, so reopening the conversation still
    // shows what was attempted rather than silently dropping the request. It
    // carries no object key, which the migration's CHECK requires of it.
    ...input.failed.map((artifact) => ({
      messageId: input.messageId,
      conversationId: input.conversationId,
      userId: input.userId,
      ordinal: artifact.ordinal,
      format: artifact.format,
      filename: artifact.filename,
      mediaType: artifact.mediaType,
      byteSize: 0,
      status: "failed",
      objectKey: null,
      failureCode: artifact.failureCode,
      modelId: artifact.modelId,
    })),
  ];
  if (rows.length === 0) return 0;
  const created = await tx.messageArtifact.createMany({
    data: rows,
    skipDuplicates: true,
  });
  return created.count;
};

/**
 * Reclaims objects a turn wrote but never wrote a row for.
 *
 * Called on every path that ends without a persisted message: a cancelled
 * stream, a provider failure, a fallback that replaced the attempt, a message
 * write that threw. Best effort by design -- it never throws, because a
 * storage error here must not turn a turn that already failed into a second,
 * louder failure, and the orphan sweep below is the backstop that makes "best
 * effort" acceptable.
 */
export const discardStoredArtifacts = async (
  stored: StoredArtifact[]
): Promise<void> => {
  for (const artifact of stored) {
    try {
      await deleteR2Object(artifact.objectKey);
    } catch (error) {
      console.error("Generated artifact rollback failed for one object:", {
        objectKey: artifact.objectKey,
        error,
      });
    }
  }
};

/* ------------------------------------------------------------------------ */
/* Deleting                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Enqueues every artifact object attached to these conversations.
 *
 * Runs in the SAME transaction that removes the rows, which is the whole
 * ordering guarantee: the tombstone is committed with the deletion, so a
 * process that dies immediately afterwards still leaves a record of what has
 * to be collected.
 */
export const enqueueArtifactCleanupForConversations = async (
  tx: Prisma.TransactionClient,
  conversationIds: string[],
  reason: ArtifactCleanupReason = "conversation_deleted"
): Promise<number> => {
  if (conversationIds.length === 0) return 0;
  const artifacts = await tx.messageArtifact.findMany({
    where: { conversationId: { in: conversationIds }, objectKey: { not: null } },
    select: { objectKey: true },
  });
  const keys = artifacts
    .map((artifact) => artifact.objectKey)
    .filter((key): key is string => Boolean(key));
  if (keys.length === 0) return 0;
  await tx.messageArtifactCleanup.createMany({
    data: keys.map((objectKey) => ({ objectKey, reason })),
    skipDuplicates: true,
  });
  return keys.length;
};

/** The same, for every conversation an account owns. */
export const enqueueArtifactCleanupForUser = async (
  tx: Prisma.TransactionClient,
  userId: string,
  reason: ArtifactCleanupReason = "account_deleted"
): Promise<number> => {
  const artifacts = await tx.messageArtifact.findMany({
    where: { userId, objectKey: { not: null } },
    select: { objectKey: true },
  });
  const keys = artifacts
    .map((artifact) => artifact.objectKey)
    .filter((key): key is string => Boolean(key));
  if (keys.length === 0) return 0;
  await tx.messageArtifactCleanup.createMany({
    data: keys.map((objectKey) => ({ objectKey, reason })),
    skipDuplicates: true,
  });
  return keys.length;
};

/** The same, for the assistant messages a per-model reset is about to remove. */
export const enqueueArtifactCleanupForMessages = async (
  tx: Prisma.TransactionClient,
  where: { conversationId: string; modelId?: string; role?: string }
): Promise<number> => {
  const artifacts = await tx.messageArtifact.findMany({
    where: {
      conversationId: where.conversationId,
      objectKey: { not: null },
      message: {
        ...(where.modelId ? { modelId: where.modelId } : {}),
        ...(where.role ? { role: where.role } : {}),
      },
    },
    select: { objectKey: true },
  });
  const keys = artifacts
    .map((artifact) => artifact.objectKey)
    .filter((key): key is string => Boolean(key));
  if (keys.length === 0) return 0;
  await tx.messageArtifactCleanup.createMany({
    data: keys.map((objectKey) => ({ objectKey, reason: "message_deleted" })),
    skipDuplicates: true,
  });
  return keys.length;
};

export type ArtifactCleanupSweepResult = {
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
 */
export const drainArtifactCleanupQueue = async (
  limit = 200,
  now = new Date()
): Promise<ArtifactCleanupSweepResult> => {
  const pending = await prisma.messageArtifactCleanup.findMany({
    where: { completedAt: null, attempts: { lt: ARTIFACT_CLEANUP_MAX_ATTEMPTS } },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, objectKey: true },
  });

  let deleted = 0;
  let failed = 0;
  for (const item of pending) {
    try {
      await deleteR2Object(item.objectKey);
      await prisma.messageArtifactCleanup.update({
        where: { id: item.id },
        data: { completedAt: now, lastError: null },
      });
      deleted += 1;
    } catch (error) {
      failed += 1;
      await prisma.messageArtifactCleanup
        .update({
          where: { id: item.id },
          data: {
            attempts: { increment: 1 },
            lastError: String(error).slice(0, 300),
          },
        })
        .catch(() => undefined);
    }
  }

  const exhausted = await prisma.messageArtifactCleanup.count({
    where: {
      completedAt: null,
      attempts: { gte: ARTIFACT_CLEANUP_MAX_ATTEMPTS },
    },
  });

  // Same shape and gate as `message_attachment_cleanup_swept`
  // (lib/messageAttachmentStorage.ts). The count reached the cron response and
  // `ScheduledJobRun.result` and nothing read either, so what this sweep
  // deleted was invisible. Silent on a no-op run on purpose.
  if (pending.length > 0 || exhausted > 0) {
    console.info(
      JSON.stringify({
        event: "generated_artifact_cleanup_swept",
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
 * Deletes objects older than the orphan TTL that no row references.
 *
 * This is the reconciliation the non-atomic write needs. The age filter is
 * load-bearing: without it the sweep would race a turn that has stored its
 * bytes and not yet written its row, and delete the file out from under an
 * answer that was about to succeed.
 *
 * Never throws -- a storage outage must not take the maintenance run with it.
 */
export const sweepOrphanedArtifactObjects = async (
  now = new Date()
): Promise<{ examined: number; deleted: number; failed: number }> => {
  const cutoff = new Date(now.getTime() - ARTIFACT_ORPHAN_TTL_MS);
  let examined = 0;
  let deleted = 0;
  let failed = 0;
  try {
    const keys = await listExpiredR2Objects(
      ARTIFACT_OBJECT_PREFIX,
      cutoff,
      ARTIFACT_ORPHAN_SWEEP_BATCH
    );
    examined = keys.length;
    if (keys.length === 0) return { examined, deleted, failed };

    const referenced = new Set(
      (
        await prisma.messageArtifact.findMany({
          where: { objectKey: { in: keys } },
          select: { objectKey: true },
        })
      )
        .map((artifact) => artifact.objectKey)
        .filter((key): key is string => Boolean(key))
    );

    for (const key of keys) {
      if (referenced.has(key)) continue;
      try {
        await deleteR2Object(key);
        deleted += 1;
      } catch (error) {
        failed += 1;
        console.error("Orphaned artifact cleanup failed for one object:", {
          key,
          error,
        });
      }
    }
  } catch (error) {
    console.error("Orphaned artifact sweep could not list objects:", error);
  }
  return { examined, deleted, failed };
};

export type GeneratedArtifactMaintenanceResult = {
  cleanup: ArtifactCleanupSweepResult;
  orphans: { examined: number; deleted: number; failed: number };
};

/**
 * The ride-along for the fifteen-minute maintenance cron.
 *
 * Never throws, the same contract `runImageAssetMaintenanceQuietly` holds: it
 * cannot turn a successful credit reconciliation run into a failed one.
 */
export const runGeneratedArtifactMaintenanceQuietly = async (
  now = new Date()
): Promise<GeneratedArtifactMaintenanceResult> => {
  try {
    const cleanup = await drainArtifactCleanupQueue(200, now);
    const orphans = await sweepOrphanedArtifactObjects(now);
    return { cleanup, orphans };
  } catch (error) {
    console.error("Generated artifact maintenance failed:", error);
    return {
      cleanup: { examined: 0, deleted: 0, failed: 0, exhausted: 0 },
      orphans: { examined: 0, deleted: 0, failed: 0 },
    };
  }
};
