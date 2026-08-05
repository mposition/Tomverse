import "server-only";

import type { Prisma } from "@prisma/client";
import {
  IMAGE_ASSET_CLEANUP_MAX_ATTEMPTS,
  STALE_IMAGE_GENERATION_AFTER_MS,
  STALE_IMAGE_SETTLING_AFTER_MS,
  type ImageAssetCleanupReason,
} from "@/lib/imageGenerationStateCore";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import { prisma } from "@/lib/prisma";
import { deleteR2Object } from "@/lib/r2";

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
  };
};

export type ImageAssetMaintenanceResult = {
  cleanup: ImageAssetCleanupSweepResult;
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
    const { reconcileStaleImageGenerations } = await import(
      "@/lib/imageGenerationService"
    );
    const staleRecovery = await reconcileStaleImageGenerations(now).catch(
      () => ({ examined: 0, refunded: 0, settlementStranded: 0 })
    );
    const invariants = await auditImageGenerationInvariants(now);
    return { cleanup, invariants, staleRecovery };
  } catch (error) {
    console.error("Image asset maintenance failed:", error);
    return {
      cleanup: { examined: 0, deleted: 0, failed: 0, exhausted: 0 },
      invariants: {
        emptyImageConversations: 0,
        staleGenerations: 0,
        strandedSettlements: 0,
        cleanupBacklog: 0,
      },
      staleRecovery: { examined: 0, refunded: 0, settlementStranded: 0 },
    };
  }
};
