import "server-only";

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  imageAssetR2Key,
  IMAGE_ASSET_CLEANUP_MAX_ATTEMPTS,
  IMAGE_ORIGINAL_MAX_READ_BYTES,
  IMAGE_THUMBNAIL_MAX_RETRIES,
  STALE_IMAGE_GENERATION_AFTER_MS,
  STALE_IMAGE_SETTLING_AFTER_MS,
  type ImageAssetCleanupReason,
} from "@/lib/imageGenerationStateCore";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import { prisma } from "@/lib/prisma";
import { deleteR2Object, readOwnR2ObjectBytes, writeR2Object } from "@/lib/r2";

// Storage lifecycle for generated images: DB-first deletion tombstones and
// the fifteen-minute maintenance sweep. Policy:
// docs/policy/image-generation.md section 9.
//
// Order matters. Deleting a conversation enqueues every attached R2 key as
// an ImageAssetCleanup row in the SAME transaction that removes the rows;
// only afterwards does the sweep delete the objects. R2 is never deleted
// ahead of the database, so a partial failure retries from the tombstone
// instead of leaving rows that point at missing objects.

export const enqueueImageAssetCleanupForConversations = async (
  tx: Prisma.TransactionClient,
  conversationIds: string[],
  reason: ImageAssetCleanupReason = "conversation_deleted"
): Promise<number> => {
  if (conversationIds.length === 0) return 0;
  const assets = await tx.imageAsset.findMany({
    where: { generation: { conversationId: { in: conversationIds } } },
    select: { r2Key: true },
  });
  if (assets.length === 0) return 0;
  // skipDuplicates: a re-delete of the same conversation (or a retried
  // request) must not fail on the r2Key unique constraint.
  await tx.imageAssetCleanup.createMany({
    data: assets.map((asset) => ({ r2Key: asset.r2Key, reason })),
    skipDuplicates: true,
  });
  return assets.length;
};

export type ImageAssetCleanupSweepResult = {
  examined: number;
  deleted: number;
  failed: number;
  exhausted: number;
};

/**
 * Drains pending cleanup tombstones. S3 DeleteObject succeeds for a key
 * that no longer exists, so two overlapping sweeps racing on one row both
 * converge on "object gone, row completed" -- the operation is idempotent
 * and needs no claim. Rows past IMAGE_ASSET_CLEANUP_MAX_ATTEMPTS are left
 * for an operator and reported as `exhausted`.
 */
export const drainImageAssetCleanupQueue = async (
  limit = 200,
  now = new Date()
): Promise<ImageAssetCleanupSweepResult> => {
  const pending = await prisma.imageAssetCleanup.findMany({
    where: {
      completedAt: null,
      attempts: { lt: IMAGE_ASSET_CLEANUP_MAX_ATTEMPTS },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, r2Key: true },
  });

  let deleted = 0;
  let failed = 0;
  for (const item of pending) {
    try {
      await deleteR2Object(item.r2Key);
      await prisma.imageAssetCleanup.update({
        where: { id: item.id },
        data: { completedAt: now, attempts: { increment: 1 }, lastError: null },
      });
      deleted += 1;
    } catch (error) {
      failed += 1;
      await prisma.imageAssetCleanup
        .update({
          where: { id: item.id },
          data: {
            attempts: { increment: 1 },
            lastError:
              error instanceof Error
                ? `${error.name}: ${error.message}`.slice(0, 1_000)
                : String(error).slice(0, 1_000),
          },
        })
        .catch(() => undefined);
    }
  }

  const exhausted = await prisma.imageAssetCleanup.count({
    where: {
      completedAt: null,
      attempts: { gte: IMAGE_ASSET_CLEANUP_MAX_ATTEMPTS },
    },
  });

  return { examined: pending.length, deleted, failed, exhausted };
};

export type ImageThumbnailRepairResult = {
  examined: number;
  repaired: number;
  failed: number;
  /** Rows past IMAGE_THUMBNAIL_MAX_RETRIES: no longer retried, still failed. */
  exhausted: number;
};

/**
 * The background thumbnail retry policy §9 promises.
 *
 * A thumbnail that failed to derive left a `failed` asset row and nothing
 * that would ever try again, so the card rendered the full-size original for
 * the life of the conversation. This re-reads the stored original -- with the
 * non-destructive R2 read, since the original is the thing being protected --
 * derives again, and fills the SAME row in. One thumbnail row per generation
 * either way: creating a second one would put two rows in a role the readers
 * assume is singular.
 *
 * The original is never touched. A repair that could damage it would defeat
 * the rule it exists to serve.
 */
export const repairFailedImageThumbnails = async (
  limit = 20,
  now = new Date()
): Promise<ImageThumbnailRepairResult> => {
  const pending = await prisma.imageAsset.findMany({
    where: {
      role: "thumbnail",
      status: "failed",
      deletedAt: null,
      thumbnailRetryCount: { lt: IMAGE_THUMBNAIL_MAX_RETRIES },
      // Only for a generation that actually succeeded: a failed generation has
      // no original to derive from, and repairing a deleted one would write an
      // object the cleanup sweep has already passed.
      generation: { status: "succeeded" },
    },
    orderBy: { id: "asc" },
    take: limit,
    select: {
      id: true,
      generationId: true,
      generation: {
        select: {
          userId: true,
          conversationId: true,
          assets: {
            where: { role: "original", status: "ready", deletedAt: null },
            select: { r2Key: true },
          },
        },
      },
    },
  });

  let repaired = 0;
  let failed = 0;
  for (const row of pending) {
    const originalKey = row.generation.assets[0]?.r2Key;
    if (!originalKey) {
      // No readable original. Burn an attempt rather than looping on it
      // forever; the row is not repairable and should reach `exhausted`.
      failed += 1;
      await prisma.imageAsset
        .update({
          where: { id: row.id },
          data: { thumbnailRetryCount: { increment: 1 } },
        })
        .catch(() => undefined);
      continue;
    }
    // Recomputed rather than read off the row: a row written before the key
    // was recorded honestly carries a `.thumb-failed` sentinel, and the repair
    // must write the real key regardless of what the old row says.
    const thumbKey = imageAssetR2Key({
      userId: row.generation.userId,
      conversationId: row.generation.conversationId,
      generationId: row.generationId,
      role: "thumbnail",
    });
    try {
      const originalBytes = await readOwnR2ObjectBytes(originalKey, {
        maxBytes: IMAGE_ORIGINAL_MAX_READ_BYTES,
      });
      const sharp = (await import("sharp")).default;
      const thumbBytes = await sharp(originalBytes)
        .resize(512, 512, { fit: "inside" })
        .webp({ quality: 80 })
        .toBuffer();
      const metadata = await sharp(thumbBytes).metadata();
      await writeR2Object(thumbKey, thumbBytes, "image/webp");
      await prisma.imageAsset.update({
        where: { id: row.id },
        data: {
          status: "ready",
          r2Key: thumbKey,
          mimeType: "image/webp",
          width: metadata.width ?? 0,
          height: metadata.height ?? 0,
          byteSize: thumbBytes.byteLength,
          sha256: createHash("sha256").update(thumbBytes).digest("hex"),
          // Derived, so it never carries the original's C2PA/SynthID.
          provenancePreserved: false,
          thumbnailRetryCount: { increment: 1 },
          updatedAt: now,
        },
      });
      repaired += 1;
    } catch (error) {
      failed += 1;
      // The key and the prompt stay out of the log (policy §10); the reason is
      // the whole point and the identifier is the generation.
      console.error("Image thumbnail repair failed:", {
        generationId: row.generationId,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      await prisma.imageAsset
        .update({
          where: { id: row.id },
          data: { thumbnailRetryCount: { increment: 1 } },
        })
        .catch(() => undefined);
    }
  }

  const exhausted = await prisma.imageAsset.count({
    where: {
      role: "thumbnail",
      status: "failed",
      deletedAt: null,
      thumbnailRetryCount: { gte: IMAGE_THUMBNAIL_MAX_RETRIES },
    },
  });

  return { examined: pending.length, repaired, failed, exhausted };
};

export type ImageInvariantAuditResult = {
  emptyImageConversations: number;
  staleGenerations: number;
  /**
   * The subset of `staleGenerations` sitting in `settling`. Counted apart
   * because it means something different: not a worker that never finished,
   * but a settlement transaction that failed after the provider was paid.
   */
  strandedSettlements: number;
  cleanupBacklog: number;
  /** Failed thumbnails the repair sweep will still try again. */
  thumbnailBacklog: number;
  /**
   * Failed thumbnails past IMAGE_THUMBNAIL_MAX_RETRIES. These need a person:
   * the original is intact and the card still renders it, but the derivation
   * has refused the same bytes every time.
   */
  thumbnailsExhausted: number;
};

/**
 * Counts the states that should not exist. An image conversation with no
 * generation means the "created only inside the reservation transaction"
 * invariant was violated somewhere; a generation stuck in a live status
 * past the stale window has lost its worker (the refund arm of that
 * recovery lands with the billing PR -- this audit makes the backlog
 * visible from day one).
 */
export const auditImageGenerationInvariants = async (
  now = new Date()
): Promise<ImageInvariantAuditResult> => {
  const [
    emptyImageConversations,
    staleGenerations,
    strandedSettlements,
    cleanupBacklog,
    thumbnailBacklog,
    thumbnailsExhausted,
  ] = await Promise.all([
    prisma.conversation.count({
      where: { kind: "image", imageGenerations: { none: {} } },
    }),
    prisma.imageGeneration.count({
      where: {
        status: { in: ["pending", "processing", "settling"] },
        updatedAt: {
          lt: new Date(now.getTime() - STALE_IMAGE_GENERATION_AFTER_MS),
        },
      },
    }),
    prisma.imageGeneration.count({
      where: {
        status: "settling",
        updatedAt: {
          lt: new Date(now.getTime() - STALE_IMAGE_SETTLING_AFTER_MS),
        },
      },
    }),
    prisma.imageAssetCleanup.count({ where: { completedAt: null } }),
    prisma.imageAsset.count({
      where: {
        role: "thumbnail",
        status: "failed",
        deletedAt: null,
        thumbnailRetryCount: { lt: IMAGE_THUMBNAIL_MAX_RETRIES },
      },
    }),
    prisma.imageAsset.count({
      where: {
        role: "thumbnail",
        status: "failed",
        deletedAt: null,
        thumbnailRetryCount: { gte: IMAGE_THUMBNAIL_MAX_RETRIES },
      },
    }),
  ]);

  if (emptyImageConversations > 0) {
    reportOperationalIncident({
      code: "IMAGE_CONVERSATION_INVARIANT_VIOLATED",
      title: "Image conversation exists without any generation",
      severity: "warning",
      cooldownMs: 60 * 60 * 1_000,
      context: {
        component: "image-asset-lifecycle",
        emptyImageConversations,
      },
    });
  }

  return {
    emptyImageConversations,
    staleGenerations,
    strandedSettlements,
    cleanupBacklog,
    thumbnailBacklog,
    thumbnailsExhausted,
  };
};

export type ImageAssetMaintenanceResult = {
  cleanup: ImageAssetCleanupSweepResult;
  thumbnails: ImageThumbnailRepairResult;
  invariants: ImageInvariantAuditResult;
  staleRecovery: {
    examined: number;
    refunded: number;
    /** Refunds that came from a settlement transaction that had failed. */
    settlementStranded: number;
  };
};

/**
 * The ride-along for the fifteen-minute maintenance cron. Never throws, so
 * it cannot turn a successful credit reconciliation run into a failed one
 * (same contract as drainNotificationDeliveriesQuietly). Alongside the R2
 * tombstone sweep, this is the refund arm for generations whose executor
 * died: the settling claim inside the service makes it race-safe against a
 * worker that is merely slow.
 */
export const runImageAssetMaintenanceQuietly = async (
  now = new Date()
): Promise<ImageAssetMaintenanceResult> => {
  try {
    const cleanup = await drainImageAssetCleanupQueue(200, now);
    // Bounded well below the cleanup drain: each repair downloads a full
    // original and re-encodes it, so this is the expensive arm of the sweep
    // and must not be able to stretch a fifteen-minute cadence.
    const thumbnails = await repairFailedImageThumbnails(20, now).catch(() => ({
      examined: 0,
      repaired: 0,
      failed: 0,
      exhausted: 0,
    }));
    const { reconcileStaleImageGenerations } = await import(
      "@/lib/imageGenerationService"
    );
    const staleRecovery = await reconcileStaleImageGenerations(now).catch(
      () => ({ examined: 0, refunded: 0, settlementStranded: 0 })
    );
    const invariants = await auditImageGenerationInvariants(now);
    return { cleanup, thumbnails, invariants, staleRecovery };
  } catch (error) {
    console.error("Image asset maintenance failed:", error);
    return {
      cleanup: { examined: 0, deleted: 0, failed: 0, exhausted: 0 },
      thumbnails: { examined: 0, repaired: 0, failed: 0, exhausted: 0 },
      invariants: {
        emptyImageConversations: 0,
        staleGenerations: 0,
        strandedSettlements: 0,
        cleanupBacklog: 0,
        thumbnailBacklog: 0,
        thumbnailsExhausted: 0,
      },
      staleRecovery: { examined: 0, refunded: 0, settlementStranded: 0 },
    };
  }
};
