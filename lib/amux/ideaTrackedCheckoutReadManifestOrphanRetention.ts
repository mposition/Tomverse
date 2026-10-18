import "server-only";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_V19_READ_MANIFEST_ORPHAN_KEY_CLAIM_ACTION,
  AMUX_V19_READ_MANIFEST_ORPHAN_KEY_CLAIM_TARGET,
  AMUX_V19_READ_MANIFEST_ORPHAN_KEY_RETIRE_ACTION,
  AMUX_V19_READ_MANIFEST_ORPHAN_KEY_RETIRE_TARGET,
  AMUX_V4_IDEA_SYSTEM_ACTOR } from
  "@/lib/adminAuditSystemActors";
import { prisma } from "@/lib/prisma";
import { AmuxContentRetirementError } from
  "./ideaContentKeyRetirementService.ts";
import { finishClaimedAmuxReadManifestKeyRetirement,
  retireClaimedAmuxReadManifestKey,
  verifyAmuxReadManifestKeyRetired } from "./ideaKeyStore.ts";
import { amuxIdeaHasActiveRetentionHold } from "./ideaRetentionHoldRead.ts";
import { amuxReadManifestDueAt,
  amuxTrackedCheckoutReadManifestKeyIdentity } from
  "./ideaTrackedCheckoutReadManifestStore.ts";

const BATCH_SIZE = 8;
type IntentIdentity = { id: string; ideaId: string; referenceOrdinal: number };

async function claimDueIntent(item: IntentIdentity): Promise<string | null> {
  const target = amuxTrackedCheckoutReadManifestKeyIdentity(item.ideaId, item.id);
  let callbackReturned = false;
  let expectedAuditLogId: string | null = null;
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
               set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
      `;
      await takeAuditChainLock(tx);
      await tx.$queryRaw`SELECT "id" FROM "AmuxIdeaSubmission"
        WHERE "id" = ${item.ideaId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "AmuxIdeaReadManifestKeyIntent"
        WHERE "id" = ${item.id} FOR UPDATE`;
      const intent = await tx.amuxIdeaReadManifestKeyIntent.findUnique({
        where: { id: item.id },
      });
      const idea = await tx.amuxIdeaSubmission.findUnique({
        where: { id: item.ideaId }, select: { submittedAt: true },
      });
      const manifest = await tx.amuxIdeaTrackedCheckoutReadManifest.findUnique({
        where: { ideaId_referenceOrdinal: { ideaId: item.ideaId,
          referenceOrdinal: item.referenceOrdinal } }, select: { id: true },
      });
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`
        SELECT clock_timestamp() AS "now"`;
      const now = nowRows[0]?.now;
      if (!intent || !idea || !now || manifest || intent.keyDeletedAt ||
          intent.keyRetirementClaimedAt || intent.ideaId !== item.ideaId ||
          intent.referenceOrdinal !== item.referenceOrdinal ||
          amuxReadManifestDueAt(idea.submittedAt) > now ||
          await amuxIdeaHasActiveRetentionHold(tx, item.ideaId, now)) {
        return null;
      }
      const auditLogId = await writeSystemAuditLog({ tx,
        systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
        action: AMUX_V19_READ_MANIFEST_ORPHAN_KEY_CLAIM_ACTION,
        targetType: AMUX_V19_READ_MANIFEST_ORPHAN_KEY_CLAIM_TARGET,
        targetId: intent.id,
        summary: "Claimed retirement of an orphan AMUX v19 read-manifest content key.",
        metadata: { policyVersion: 19, manifestId: intent.id,
          ideaId: intent.ideaId, referenceOrdinal: intent.referenceOrdinal,
          pinnedCommitSha: intent.pinnedCommitSha,
          intentAuditLogId: intent.auditLogId },
      });
      const changed = await tx.amuxIdeaReadManifestKeyIntent.updateMany({
        where: { id: intent.id, keyRetirementClaimedAt: null,
          claimAuditLogId: null, keyDeletedAt: null },
        data: { keyRetirementClaimedAt: now, claimAuditLogId: auditLogId },
      });
      if (changed.count !== 1) {
        throw new AmuxContentRetirementError("integrity_unavailable", target);
      }
      expectedAuditLogId = auditLogId;
      callbackReturned = true;
      return auditLogId;
    }, { maxWait: 3_000, timeout: 12_000 });
  } catch {
    if (callbackReturned) {
      const readback = await prisma.amuxIdeaReadManifestKeyIntent.findUnique({
        where: { id: item.id },
        select: { claimAuditLogId: true, keyRetirementClaimedAt: true },
      }).catch(() => null);
      if (expectedAuditLogId && readback?.claimAuditLogId === expectedAuditLogId &&
          readback.keyRetirementClaimedAt) {
        return readback.claimAuditLogId;
      }
    }
    throw new AmuxContentRetirementError("outcome_unknown", target);
  }
}

async function completeClaim(item: IntentIdentity, claimAuditLogId: string) {
  const target = amuxTrackedCheckoutReadManifestKeyIdentity(item.ideaId, item.id);
  let callbackReturned = false;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
               set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
      `;
      await takeAuditChainLock(tx);
      await tx.$queryRaw`SELECT "id" FROM "AmuxIdeaReadManifestKeyIntent"
        WHERE "id" = ${item.id} FOR UPDATE`;
      const intent = await tx.amuxIdeaReadManifestKeyIntent.findUnique({
        where: { id: item.id },
      });
      if (!intent || intent.ideaId !== item.ideaId ||
          intent.referenceOrdinal !== item.referenceOrdinal ||
          intent.claimAuditLogId !== claimAuditLogId ||
          !intent.keyRetirementClaimedAt || intent.keyDeletedAt) {
        throw new AmuxContentRetirementError("integrity_unavailable", target);
      }
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`
        SELECT clock_timestamp() AS "now"`;
      const now = nowRows[0]?.now;
      if (!now) throw new AmuxContentRetirementError("integrity_unavailable", target);
      const auditLogId = await writeSystemAuditLog({ tx,
        systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
        action: AMUX_V19_READ_MANIFEST_ORPHAN_KEY_RETIRE_ACTION,
        targetType: AMUX_V19_READ_MANIFEST_ORPHAN_KEY_RETIRE_TARGET,
        targetId: intent.id,
        summary: "Verified deletion of an orphan AMUX v19 read-manifest content key.",
        metadata: { policyVersion: 19, manifestId: intent.id,
          ideaId: intent.ideaId, referenceOrdinal: intent.referenceOrdinal,
          pinnedCommitSha: intent.pinnedCommitSha,
          intentAuditLogId: intent.auditLogId, claimAuditLogId },
      });
      const changed = await tx.amuxIdeaReadManifestKeyIntent.updateMany({
        where: { id: intent.id, claimAuditLogId, keyDeletedAt: null,
          keyDeleteAuditLogId: null },
        data: { keyDeletedAt: now, keyDeleteAuditLogId: auditLogId },
      });
      if (changed.count !== 1) {
        throw new AmuxContentRetirementError("integrity_unavailable", target);
      }
      callbackReturned = true;
    }, { maxWait: 3_000, timeout: 12_000 });
  } catch {
    if (callbackReturned) {
      const readback = await prisma.amuxIdeaReadManifestKeyIntent.findUnique({
        where: { id: item.id },
        select: { keyDeletedAt: true, keyDeleteAuditLogId: true },
      }).catch(() => null);
      if (readback?.keyDeletedAt && readback.keyDeleteAuditLogId) return;
    }
    throw new AmuxContentRetirementError("outcome_unknown", target);
  }
}

/** The claim commits before S3 is touched. A retry reads the fixed fence,
 * replaces only a confirmed missing or old key, then removes old versions. */
export async function purgeDueAmuxOrphanReadManifestKeys(
  deleteKey: typeof retireClaimedAmuxReadManifestKey =
    retireClaimedAmuxReadManifestKey,
  verifyRetired: typeof verifyAmuxReadManifestKeyRetired =
    verifyAmuxReadManifestKeyRetired,
  finishRetirement: typeof finishClaimedAmuxReadManifestKeyRetirement =
    finishClaimedAmuxReadManifestKeyRetirement,
) {
  const pending = await prisma.amuxIdeaReadManifestKeyIntent.findMany({
    where: { keyRetirementClaimedAt: { not: null }, keyDeletedAt: null },
    orderBy: [{ keyRetirementClaimedAt: "asc" }, { id: "asc" }],
    take: BATCH_SIZE / 2,
    select: { id: true, ideaId: true, referenceOrdinal: true,
      claimAuditLogId: true },
  });
  let keysDeleted = 0;
  let firstError: AmuxContentRetirementError | null = null;
  for (const item of pending) {
    const target = amuxTrackedCheckoutReadManifestKeyIdentity(item.ideaId, item.id);
    if (!item.claimAuditLogId) {
      firstError ??= new AmuxContentRetirementError("integrity_unavailable", target);
      continue;
    }
    try {
      try { await verifyRetired(target); }
      catch { await finishRetirement(target); }
      await completeClaim(item, item.claimAuditLogId);
      keysDeleted += 1;
    } catch (error) {
      firstError ??= error instanceof AmuxContentRetirementError ? error :
        new AmuxContentRetirementError("outcome_unknown", target);
    }
  }
  const due = await prisma.$queryRaw<IntentIdentity[]>`
    SELECT k."id", k."ideaId", k."referenceOrdinal"
    FROM "AmuxIdeaReadManifestKeyIntent" k
    JOIN "AmuxIdeaSubmission" i ON i."id" = k."ideaId"
    WHERE k."keyRetirementClaimedAt" IS NULL AND k."keyDeletedAt" IS NULL
      AND i."submittedAt" + INTERVAL '7 days' <= clock_timestamp()
      AND NOT EXISTS (SELECT 1 FROM "AmuxIdeaTrackedCheckoutReadManifest" m
        WHERE m."ideaId" = k."ideaId" AND
          m."referenceOrdinal" = k."referenceOrdinal")
      AND NOT EXISTS (SELECT 1 FROM "AmuxIdeaRetentionHold" h
        WHERE h."ideaId" = k."ideaId" AND h."releasedAt" IS NULL AND
          h."expiresAt" > clock_timestamp())
    ORDER BY k."createdAt", k."id" LIMIT ${BATCH_SIZE - pending.length}
  `;
  for (const item of due) {
    const target = amuxTrackedCheckoutReadManifestKeyIdentity(item.ideaId, item.id);
    try {
      const claimAuditLogId = await claimDueIntent(item);
      if (!claimAuditLogId) continue;
      await deleteKey(target);
      await completeClaim(item, claimAuditLogId);
      keysDeleted += 1;
    } catch (error) {
      firstError ??= error instanceof AmuxContentRetirementError ? error :
        new AmuxContentRetirementError("outcome_unknown", target);
    }
  }
  if (firstError) throw firstError;
  return { keysDeleted, scanned: pending.length + due.length,
    batchLimit: BATCH_SIZE };
}
