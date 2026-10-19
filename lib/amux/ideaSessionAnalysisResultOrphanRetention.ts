import "server-only";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_V4_IDEA_SYSTEM_ACTOR,
  AMUX_V19_SESSION_RESULT_ORPHAN_KEY_CLAIM_ACTION,
  AMUX_V19_SESSION_RESULT_ORPHAN_KEY_RETIRE_ACTION,
  AMUX_V19_SESSION_RESULT_ORPHAN_KEY_TARGET } from
  "@/lib/adminAuditSystemActors";
import { prisma } from "@/lib/prisma";
import { AmuxContentRetirementError } from
  "./ideaContentKeyRetirementService.ts";
import { finishClaimedAmuxSessionResultKeyRetirement,
  retireClaimedAmuxSessionResultKey,
  verifyAmuxSessionResultKeyRetired } from "./ideaKeyStore.ts";
import { amuxIdeaHasActiveRetentionHold } from
  "./ideaRetentionHoldRead.ts";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 8;
type Candidate = { claimId: string; ideaId: string };
const keyFor = (row: Candidate) => ({ ideaId: row.ideaId,
  purpose: "analysis_result" as const, subjectId: row.claimId });

async function claimDue(row: Candidate): Promise<string | null> {
  let callbackReturned = false;
  let expectedAuditId: string | null = null;
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
               set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit,
               set_config('TimeZone', 'UTC', true) AS transaction_zone
      `;
      await takeAuditChainLock(tx);
      await tx.$queryRaw`SELECT "id" FROM "AmuxIdeaSubmission"
        WHERE "id" = ${row.ideaId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "AmuxIdeaSessionAnalysisBudgetClaim"
        WHERE "id" = ${row.claimId} FOR UPDATE`;
      const claim = await tx.amuxIdeaSessionAnalysisBudgetClaim.findUnique({
        where: { id: row.claimId },
        select: { budgetMode: true, claimAuditLogId: true,
          analysisResult: { select: { claimId: true } },
          reservation: { select: { ideaId: true,
            idea: { select: { submittedAt: true } } } },
          resultOrphanKeyRetirement: { select: { claimId: true } } },
      });
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`
        SELECT clock_timestamp() AS "now"`;
      const now = nowRows[0]?.now;
      if (!claim || !now || claim.budgetMode !== "max_shadow" ||
          claim.reservation.ideaId !== row.ideaId ||
          claim.analysisResult || claim.resultOrphanKeyRetirement ||
          claim.reservation.idea.submittedAt.getTime() + RETENTION_MS >
            now.getTime() ||
          await amuxIdeaHasActiveRetentionHold(tx, row.ideaId, now))
        return null;
      const auditId = await writeSystemAuditLog({ tx,
        systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
        action: AMUX_V19_SESSION_RESULT_ORPHAN_KEY_CLAIM_ACTION,
        targetType: AMUX_V19_SESSION_RESULT_ORPHAN_KEY_TARGET,
        targetId: row.claimId,
        summary: "Claimed retirement of an orphan Max result key.",
        metadata: { claimId: row.claimId, ideaId: row.ideaId,
          budgetClaimAuditLogId: claim.claimAuditLogId },
      });
      await tx.amuxIdeaSessionResultOrphanKeyRetirement.create({ data: {
        claimId: row.claimId, ideaId: row.ideaId,
        claimedAt: now, claimAuditLogId: auditId,
      } });
      expectedAuditId = auditId;
      callbackReturned = true;
      return auditId;
    }, { maxWait: 3_000, timeout: 12_000 });
  } catch {
    if (callbackReturned && expectedAuditId) {
      const receipt = await prisma.amuxIdeaSessionResultOrphanKeyRetirement
        .findUnique({ where: { claimId: row.claimId },
          select: { claimAuditLogId: true } }).catch(() => null);
      if (receipt?.claimAuditLogId === expectedAuditId) return expectedAuditId;
    }
    throw new AmuxContentRetirementError("outcome_unknown", keyFor(row));
  }
}

async function completeClaim(row: Candidate, claimAuditLogId: string):
  Promise<void> {
  let callbackReturned = false;
  let expectedAuditId: string | null = null;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
               set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit,
               set_config('TimeZone', 'UTC', true) AS transaction_zone
      `;
      await takeAuditChainLock(tx);
      await tx.$queryRaw`SELECT "claimId"
        FROM "AmuxIdeaSessionResultOrphanKeyRetirement"
        WHERE "claimId" = ${row.claimId} FOR UPDATE`;
      const record = await tx.amuxIdeaSessionResultOrphanKeyRetirement.findUnique({
        where: { claimId: row.claimId },
      });
      if (!record || record.ideaId !== row.ideaId ||
          record.claimAuditLogId !== claimAuditLogId ||
          record.keyDeletedAt || record.keyDeleteAuditLogId) {
        throw new AmuxContentRetirementError("integrity_unavailable", keyFor(row));
      }
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`
        SELECT clock_timestamp() AS "now"`;
      const now = nowRows[0]?.now;
      if (!now) throw new AmuxContentRetirementError("integrity_unavailable",
        keyFor(row));
      const auditId = await writeSystemAuditLog({ tx,
        systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
        action: AMUX_V19_SESSION_RESULT_ORPHAN_KEY_RETIRE_ACTION,
        targetType: AMUX_V19_SESSION_RESULT_ORPHAN_KEY_TARGET,
        targetId: row.claimId,
        summary: "Verified orphan Max result key retirement.",
        metadata: { claimId: row.claimId, ideaId: row.ideaId,
          claimAuditLogId },
      });
      const updated = await tx.amuxIdeaSessionResultOrphanKeyRetirement.updateMany({
        where: { claimId: row.claimId, keyDeletedAt: null,
          keyDeleteAuditLogId: null },
        data: { keyDeletedAt: now, keyDeleteAuditLogId: auditId },
      });
      if (updated.count !== 1) {
        throw new AmuxContentRetirementError("integrity_unavailable", keyFor(row));
      }
      expectedAuditId = auditId;
      callbackReturned = true;
    }, { maxWait: 3_000, timeout: 12_000 });
  } catch {
    if (callbackReturned && expectedAuditId) {
      const receipt = await prisma.amuxIdeaSessionResultOrphanKeyRetirement
        .findUnique({ where: { claimId: row.claimId }, select: {
          keyDeleteAuditLogId: true, keyDeletedAt: true } }).catch(() => null);
      if (receipt?.keyDeleteAuditLogId === expectedAuditId &&
          receipt.keyDeletedAt) return;
    }
    throw new AmuxContentRetirementError("outcome_unknown", keyFor(row));
  }
}

/** Fence every due Max claim without a result. A delayed conditional key
 * creation then conflicts with the non-secret object occupying its path. */
export async function purgeDueAmuxOrphanSessionResultKeys(
  retireKey: typeof retireClaimedAmuxSessionResultKey =
    retireClaimedAmuxSessionResultKey,
  verifyRetired: typeof verifyAmuxSessionResultKeyRetired =
    verifyAmuxSessionResultKeyRetired,
  finishRetirement: typeof finishClaimedAmuxSessionResultKeyRetirement =
    finishClaimedAmuxSessionResultKeyRetirement,
) {
  const pending = await prisma.amuxIdeaSessionResultOrphanKeyRetirement.findMany({
    where: { keyDeletedAt: null }, orderBy: [{ claimedAt: "asc" },
      { claimId: "asc" }], take: BATCH_SIZE,
    select: { claimId: true, ideaId: true, claimAuditLogId: true },
  });
  let keysDeleted = 0;
  const retire = async (row: Candidate, auditId: string,
    resume: boolean) => {
    const key = keyFor(row);
    try {
      if (resume) await finishRetirement(key);
      else await retireKey(key);
    } catch {
      try { await verifyRetired(key); }
      catch { throw new AmuxContentRetirementError("outcome_unknown", key); }
    }
    await completeClaim(row, auditId);
    keysDeleted += 1;
  };
  for (const row of pending) await retire(row, row.claimAuditLogId, true);
  if (pending.length === BATCH_SIZE) return { keysDeleted,
    scanned: pending.length, batchLimit: BATCH_SIZE };
  const nowRows = await prisma.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp() AS "now"`;
  const now = nowRows[0]?.now;
  if (!now) throw new AmuxContentRetirementError("integrity_unavailable");
  const due = await prisma.amuxIdeaSessionAnalysisBudgetClaim.findMany({
    where: { budgetMode: "max_shadow", analysisResult: null,
      resultOrphanKeyRetirement: null,
      reservation: { idea: {
        submittedAt: { lte: new Date(now.getTime() - RETENTION_MS) },
        retentionHolds: { none: { releasedAt: null,
          expiresAt: { gt: now } } },
      } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: BATCH_SIZE - pending.length,
    select: { id: true, reservation: { select: { ideaId: true } } },
  });
  for (const claim of due) {
    const row = { claimId: claim.id, ideaId: claim.reservation.ideaId };
    const auditId = await claimDue(row);
    if (auditId) await retire(row, auditId, false);
  }
  return { keysDeleted, scanned: pending.length + due.length,
    batchLimit: BATCH_SIZE };
}
