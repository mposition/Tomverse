import "server-only";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_V19_READ_MANIFEST_ORPHAN_KEY_RETIRE_ACTION,
  AMUX_V19_READ_MANIFEST_ORPHAN_KEY_RETIRE_TARGET,
  AMUX_V4_IDEA_SYSTEM_ACTOR } from
  "@/lib/adminAuditSystemActors";
import { prisma } from "@/lib/prisma";
import { AmuxContentRetirementError } from
  "./ideaContentKeyRetirementService.ts";
import { deleteAmuxContentUnitKey } from "./ideaKeyStore.ts";
import { amuxIdeaHasActiveRetentionHold } from "./ideaRetentionHoldRead.ts";
import { amuxReadManifestDueAt,
  amuxTrackedCheckoutReadManifestKeyIdentity } from
  "./ideaTrackedCheckoutReadManifestStore.ts";

const BATCH_SIZE = 8;
type DueIntent = { id: string; ideaId: string; referenceOrdinal: number };

/** The intent was committed before PutObject, so an orphan key has an exact
 * address even when the object-store or manifest COMMIT response was lost.
 * The key store itself verifies deletion before the DB audit records it. */
export async function purgeDueAmuxOrphanReadManifestKeys(
  deleteKey: typeof deleteAmuxContentUnitKey = deleteAmuxContentUnitKey,
) {
  const due = await prisma.$queryRaw<DueIntent[]>`
    SELECT k."id", k."ideaId", k."referenceOrdinal"
    FROM "AmuxIdeaReadManifestKeyIntent" k
    JOIN "AmuxIdeaSubmission" i ON i."id" = k."ideaId"
    WHERE k."keyDeletedAt" IS NULL
      AND i."submittedAt" + INTERVAL '7 days' <= clock_timestamp()
      AND NOT EXISTS (SELECT 1 FROM "AmuxIdeaTrackedCheckoutReadManifest" m
        WHERE m."ideaId" = k."ideaId" AND
          m."referenceOrdinal" = k."referenceOrdinal")
      AND NOT EXISTS (SELECT 1 FROM "AmuxIdeaRetentionHold" h
        WHERE h."ideaId" = k."ideaId" AND h."releasedAt" IS NULL AND
          h."expiresAt" > clock_timestamp())
    ORDER BY k."createdAt", k."id" LIMIT ${BATCH_SIZE}
  `;
  let keysDeleted = 0;
  for (const item of due) {
    const target = amuxTrackedCheckoutReadManifestKeyIdentity(item.ideaId, item.id);
    try { await deleteKey(target); }
    catch { throw new AmuxContentRetirementError("key_store_unavailable", target); }

    let callbackReturned = false;
    try {
      await prisma.$transaction(async (tx) => {
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
            intent.ideaId !== item.ideaId ||
            intent.referenceOrdinal !== item.referenceOrdinal ||
            amuxReadManifestDueAt(idea.submittedAt) > now ||
            await amuxIdeaHasActiveRetentionHold(tx, item.ideaId, now)) {
          throw new AmuxContentRetirementError("integrity_unavailable", target);
        }
        const auditLogId = await writeSystemAuditLog({ tx,
          systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
          action: AMUX_V19_READ_MANIFEST_ORPHAN_KEY_RETIRE_ACTION,
          targetType: AMUX_V19_READ_MANIFEST_ORPHAN_KEY_RETIRE_TARGET,
          targetId: intent.id,
          summary: "Verified deletion of an orphan AMUX v19 read-manifest content key.",
          metadata: { policyVersion: 19, manifestId: intent.id,
            ideaId: intent.ideaId, referenceOrdinal: intent.referenceOrdinal,
            pinnedCommitSha: intent.pinnedCommitSha,
            intentAuditLogId: intent.auditLogId },
        });
        const changed = await tx.amuxIdeaReadManifestKeyIntent.updateMany({
          where: { id: intent.id, keyDeletedAt: null,
            keyDeleteAuditLogId: null },
          data: { keyDeletedAt: now, keyDeleteAuditLogId: auditLogId },
        });
        if (changed.count !== 1) {
          throw new AmuxContentRetirementError("integrity_unavailable", target);
        }
        callbackReturned = true;
      }, { maxWait: 3_000, timeout: 12_000 });
      keysDeleted += 1;
    } catch {
      if (callbackReturned) {
        const readback = await prisma.amuxIdeaReadManifestKeyIntent.findUnique({
          where: { id: item.id },
          select: { keyDeletedAt: true, keyDeleteAuditLogId: true },
        }).catch(() => null);
        if (readback?.keyDeletedAt && readback.keyDeleteAuditLogId) {
          keysDeleted += 1;
          continue;
        }
      }
      throw new AmuxContentRetirementError("outcome_unknown", target);
    }
  }
  return { keysDeleted, scanned: due.length, batchLimit: BATCH_SIZE };
}
