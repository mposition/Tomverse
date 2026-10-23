import "server-only";

import type { Prisma } from "@prisma/client";
import { takeAuditChainLock } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import { AmuxContentRetirementError, recordAmuxContentBodyPurge,
  readAmuxContentPurgeOutcome, retireVerifiedAmuxContentKey,
  type AmuxRetirableContent } from "./ideaContentKeyRetirementService.ts";
import { amuxContentUnitKeyId,
  deleteAmuxContentUnitKey } from "./ideaKeyStore.ts";
import { amuxIdeaHasActiveRetentionHold } from
  "./ideaRetentionHoldRead.ts";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 8;
const targetFor = (ideaId: string, claimId: string): AmuxRetirableContent =>
  ({ ideaId, purpose: "analysis_result", subjectId: claimId });

/** Clear only due ciphertext. Digest, token counts, and canonical audit stay. */
export async function commitAmuxDueSessionAnalysisResultPurge(
  tx: Prisma.TransactionClient, claimId: string): Promise<"purged" | "skipped"> {
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit,
           set_config('TimeZone', 'UTC', true) AS transaction_zone
  `;
  await takeAuditChainLock(tx);
  const found = await tx.amuxIdeaSessionAnalysisResult.findUnique({
    where: { claimId }, select: { ideaId: true },
  });
  if (!found) return "skipped";
  await tx.$queryRaw`SELECT "id" FROM "AmuxIdeaSubmission"
    WHERE "id" = ${found.ideaId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "claimId" FROM "AmuxIdeaSessionAnalysisResult"
    WHERE "claimId" = ${claimId} FOR UPDATE`;
  const row = await tx.amuxIdeaSessionAnalysisResult.findUnique({
    where: { claimId },
  });
  const idea = await tx.amuxIdeaSubmission.findUnique({
    where: { id: found.ideaId }, select: { submittedAt: true },
  });
  const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp() AS "now"`;
  const now = nowRows[0]?.now;
  if (!row || !idea || !now || row.bodyPurgedAt || !row.ciphertext)
    return "skipped";
  if (idea.submittedAt.getTime() + RETENTION_MS > now.getTime() ||
      await amuxIdeaHasActiveRetentionHold(tx, row.ideaId, now))
    return "skipped";
  const target = targetFor(row.ideaId, row.claimId);
  if (row.keyId !== amuxContentUnitKeyId(target) || row.keyVersion !== 1) {
    throw new AmuxContentRetirementError("integrity_unavailable", target);
  }
  await recordAmuxContentBodyPurge(tx, target, now,
    row.digest, row.digestKeyId);
  const changed = await tx.amuxIdeaSessionAnalysisResult.updateMany({
    where: { claimId, ciphertext: { not: null }, bodyPurgedAt: null },
    data: { ciphertext: null, keyId: null, keyVersion: null,
      bodyPurgedAt: now },
  });
  if (changed.count !== 1) {
    throw new AmuxContentRetirementError("integrity_unavailable", target);
  }
  return "purged";
}

/** Pending verified key deletes run first. Unknown DB/S3 outcomes stop the
 * tick and never trigger a second result write. */
export async function purgeDueAmuxSessionAnalysisResults(
  deleteKey: typeof deleteAmuxContentUnitKey = deleteAmuxContentUnitKey,
) {
  const pending = await prisma.amuxIdeaContentKeyRetirement.findMany({
    where: { purpose: "analysis_result", keyDeletedAt: null },
    orderBy: [{ bodyPurgedAt: "asc" }, { ideaId: "asc" }],
    take: BATCH_SIZE, select: { ideaId: true, subjectId: true },
  });
  let keysDeleted = 0;
  for (const row of pending) {
    const result = await retireVerifiedAmuxContentKey(
      targetFor(row.ideaId, row.subjectId), deleteKey);
    if (result === "deleted") keysDeleted += 1;
  }
  if (pending.length === BATCH_SIZE) return { bodiesPurged: 0,
    keysDeleted, scanned: pending.length, batchLimit: BATCH_SIZE };
  const nowRows = await prisma.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp() AS "now"`;
  const now = nowRows[0]?.now;
  if (!now) throw new AmuxContentRetirementError("integrity_unavailable");
  const due = await prisma.amuxIdeaSessionAnalysisResult.findMany({
    where: { ciphertext: { not: null }, bodyPurgedAt: null,
      idea: { submittedAt: { lte: new Date(now.getTime() - RETENTION_MS) },
        retentionHolds: { none: { releasedAt: null,
          expiresAt: { gt: now } } } } },
    orderBy: [{ createdAt: "asc" }, { claimId: "asc" }],
    take: BATCH_SIZE - pending.length,
    select: { claimId: true, ideaId: true },
  });
  let bodiesPurged = 0;
  for (const row of due) {
    const target = targetFor(row.ideaId, row.claimId);
    let result: "purged" | "skipped";
    try {
      result = await prisma.$transaction((tx) =>
        commitAmuxDueSessionAnalysisResultPurge(tx, row.claimId),
      { maxWait: 3_000, timeout: 12_000 });
    } catch (error) {
      const readBack = await readAmuxContentPurgeOutcome(target)
        .catch(() => "unavailable" as const);
      if (error instanceof AmuxContentRetirementError &&
          error.code === "integrity_unavailable" &&
          readBack === "not_purged") throw error;
      throw new AmuxContentRetirementError("outcome_unknown", target,
        readBack);
    }
    if (result === "purged") {
      bodiesPurged += 1;
      const retired = await retireVerifiedAmuxContentKey(target, deleteKey);
      if (retired === "deleted") keysDeleted += 1;
    }
  }
  return { bodiesPurged, keysDeleted,
    scanned: pending.length + due.length, batchLimit: BATCH_SIZE };
}
