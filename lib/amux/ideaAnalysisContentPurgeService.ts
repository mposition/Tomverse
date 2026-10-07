import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import { amuxAnalysisFreeformSubjectId } from "./ideaAnalysisDraftSealCore.ts";
import { AmuxContentRetirementError, readAmuxContentPurgeOutcome,
  recordAmuxContentBodyPurge, retireVerifiedAmuxContentKey,
  type AmuxRetirableContent } from "./ideaContentKeyRetirementService.ts";
import { amuxContentUnitKeyId } from "./ideaKeyStore.ts";
import { amuxIdeaHasActiveRetentionHold } from "./ideaRetentionHoldRead.ts";

const ID = /^[A-Za-z0-9:_-]{1,160}$/;
const BATCH_SIZE = 8;

async function dbNow(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  if (!(rows[0]?.now instanceof Date) || !Number.isFinite(rows[0].now.getTime())) {
    throw new AmuxContentRetirementError("integrity_unavailable");
  }
  return rows[0].now;
}

async function armAndLockIdea(tx: Prisma.TransactionClient, ideaId: string) {
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaSubmission" WHERE "id" = ${ideaId} FOR UPDATE
  `;
  return rows.length === 1;
}

export async function commitAmuxDueTransferPayloadPurge(tx: Prisma.TransactionClient,
  previewId: string): Promise<"purged" | "skipped"> {
  if (!ID.test(previewId)) throw new AmuxContentRetirementError("integrity_unavailable");
  const found = await tx.amuxIdeaTransferPreview.findUnique({ where: { id: previewId },
    select: { ideaId: true } });
  if (!found || !(await armAndLockIdea(tx, found.ideaId))) return "skipped";
  await tx.$queryRaw`
    SELECT "id" FROM "AmuxIdeaTransferPreview" WHERE "id" = ${previewId}
      AND "ideaId" = ${found.ideaId} FOR UPDATE
  `;
  const row = await tx.amuxIdeaTransferPreview.findUnique({ where: { id: previewId } });
  const now = await dbNow(tx);
  const unused = row && ["prepared", "confirmed", "provider_failed"]
    .includes(row.state);
  const dueAt = row && (unused ? row.expiresAt : row.payloadPurgeAfter);
  if (!row || row.ideaId !== found.ideaId || row.payloadCiphertext === null ||
      row.payloadPurgedAt !== null || !row.payloadPurgeAfter ||
      !dueAt || now < dueAt) return "skipped";
  const idea = await tx.amuxIdeaSubmission.findUnique({
    where: { id: row.ideaId },
    select: { state: true, analysisDeadlineAt: true },
  });
  if (!idea) throw new AmuxContentRetirementError("integrity_unavailable");
  if (row.state === "in_flight" && idea.state === "analyzing" &&
      now < idea.analysisDeadlineAt) return "skipped";
  if (await amuxIdeaHasActiveRetentionHold(tx, row.ideaId, now)) return "skipped";
  const target: AmuxRetirableContent = { ideaId: row.ideaId,
    purpose: "transfer_payload", subjectId: previewId };
  if (row.payloadKeyId !== amuxContentUnitKeyId(target) ||
      row.payloadKeyVersion !== 1) {
    throw new AmuxContentRetirementError("integrity_unavailable", target);
  }
  const changed = await tx.amuxIdeaTransferPreview.updateMany({
    where: { id: previewId, ideaId: row.ideaId,
      payloadCiphertext: { not: null }, payloadPurgedAt: null,
      OR: [{ state: { in: ["prepared", "confirmed", "provider_failed"] },
        expiresAt: { lte: now } },
      { payloadPurgeAfter: { lte: now } }] },
    data: { payloadCiphertext: null, payloadKeyId: null,
      payloadKeyVersion: null, payloadPurgedAt: now },
  });
  if (changed.count !== 1) {
    throw new AmuxContentRetirementError("integrity_unavailable", target);
  }
  await recordAmuxContentBodyPurge(tx, target, now,
    row.payloadDigest, row.payloadDigestKeyId);
  return "purged";
}

export async function commitAmuxDueFreeformPurge(tx: Prisma.TransactionClient,
  ideaId: string, chunkIndex: number): Promise<"purged" | "skipped"> {
  if (!ID.test(ideaId) || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
    throw new AmuxContentRetirementError("integrity_unavailable");
  }
  if (!(await armAndLockIdea(tx, ideaId))) return "skipped";
  await tx.$queryRaw`
    SELECT "ideaId" FROM "AmuxIdeaAnalysisChunk"
    WHERE "ideaId" = ${ideaId} AND "chunkIndex" = ${chunkIndex} FOR UPDATE
  `;
  const row = await tx.amuxIdeaAnalysisChunk.findUnique({
    where: { ideaId_chunkIndex: { ideaId, chunkIndex } },
  });
  const now = await dbNow(tx);
  if (!row || row.freeformCiphertext === null ||
      row.freeformPurgedAt !== null || !row.freeformPurgeAfter ||
      now < row.freeformPurgeAfter) return "skipped";
  if (await amuxIdeaHasActiveRetentionHold(tx, ideaId, now)) return "skipped";
  if (!row.currentPreviewId) {
    throw new AmuxContentRetirementError("integrity_unavailable");
  }
  const target: AmuxRetirableContent = { ideaId,
    purpose: "analysis_freeform",
    subjectId: amuxAnalysisFreeformSubjectId(ideaId, row.currentPreviewId) };
  if (row.freeformKeyId !== amuxContentUnitKeyId(target) ||
      row.freeformKeyVersion !== 1) {
    throw new AmuxContentRetirementError("integrity_unavailable", target);
  }
  const changed = await tx.amuxIdeaAnalysisChunk.updateMany({
    where: { ideaId, chunkIndex, currentPreviewId: row.currentPreviewId,
      freeformCiphertext: { not: null }, freeformPurgedAt: null,
      freeformPurgeAfter: { lte: now } },
    data: { freeformCiphertext: null, freeformKeyId: null,
      freeformKeyVersion: null, freeformPurgedAt: now },
  });
  if (changed.count !== 1) {
    throw new AmuxContentRetirementError("integrity_unavailable", target);
  }
  await recordAmuxContentBodyPurge(tx, target, now);
  return "purged";
}

export async function commitAmuxDueDraftUnitPurge(tx: Prisma.TransactionClient,
  unitId: string): Promise<"purged" | "skipped"> {
  if (!ID.test(unitId)) throw new AmuxContentRetirementError("integrity_unavailable");
  const found = await tx.amuxIdeaDraftUnit.findUnique({ where: { id: unitId },
    select: { ideaId: true, chunkIndex: true } });
  if (!found || !(await armAndLockIdea(tx, found.ideaId))) return "skipped";
  await tx.$queryRaw`
    SELECT "ideaId" FROM "AmuxIdeaAnalysisChunk"
    WHERE "ideaId" = ${found.ideaId} AND "chunkIndex" = ${found.chunkIndex}
    FOR UPDATE
  `;
  await tx.$queryRaw`
    SELECT "id" FROM "AmuxIdeaDraftUnit" WHERE "id" = ${unitId}
      AND "ideaId" = ${found.ideaId} FOR UPDATE
  `;
  const row = await tx.amuxIdeaDraftUnit.findUnique({ where: { id: unitId } });
  const now = await dbNow(tx);
  if (!row || row.ideaId !== found.ideaId || row.bodyCiphertext === null ||
      row.bodyPurgedAt !== null) return "skipped";
  const due = row.state === "proposed" ? row.expiresAt : row.bodyPurgeAfter;
  if (!due || now < due) return "skipped";
  if (await amuxIdeaHasActiveRetentionHold(tx, row.ideaId, now)) return "skipped";
  const target: AmuxRetirableContent = { ideaId: row.ideaId,
    purpose: "analysis_draft", subjectId: unitId };
  if (row.bodyKeyId !== amuxContentUnitKeyId(target) ||
      row.bodyKeyVersion !== 1) {
    throw new AmuxContentRetirementError("integrity_unavailable", target);
  }
  // The existing DB trigger sets the original expiry and bodyPurgedAt. It
  // refuses early deletion or resurrection independently of this worker.
  const changed = await tx.amuxIdeaDraftUnit.updateMany({
    where: { id: unitId, ideaId: row.ideaId, state: row.state,
      bodyCiphertext: { not: null }, bodyPurgedAt: null },
    data: { ...(row.state === "proposed" ? { state: "expired" } : {}),
      bodyCiphertext: null, bodyKeyId: null, bodyKeyVersion: null },
  });
  if (changed.count !== 1) {
    throw new AmuxContentRetirementError("integrity_unavailable", target);
  }
  const purged = await tx.amuxIdeaDraftUnit.findUnique({ where: { id: unitId },
    select: { bodyPurgedAt: true, bodyPurgeAfter: true, state: true } });
  if (!purged?.bodyPurgedAt || !purged.bodyPurgeAfter ||
      purged.bodyPurgedAt < purged.bodyPurgeAfter ||
      (row.state === "proposed" && purged.state !== "expired")) {
    throw new AmuxContentRetirementError("integrity_unavailable", target);
  }
  await recordAmuxContentBodyPurge(tx, target, purged.bodyPurgedAt,
    row.bodyDigest, row.bodyDigestKeyId);
  return "purged";
}

type Due = { target: AmuxRetirableContent; dueAt: Date;
  apply: (tx: Prisma.TransactionClient) => Promise<"purged" | "skipped"> };

/** One bounded tick covers payload, freeform and each draft unit. An unknown
 * DB or key-store outcome stops the whole tick and needs read-back. */
export async function purgeDueAmuxAnalysisContent() {
  const pending = await prisma.amuxIdeaContentKeyRetirement.findMany({
    where: { purpose: { in: ["transfer_payload", "analysis_freeform",
      "analysis_draft"] }, keyDeletedAt: null },
    orderBy: [{ bodyPurgedAt: "asc" }, { ideaId: "asc" }],
    take: BATCH_SIZE,
    select: { ideaId: true, purpose: true, subjectId: true },
  });
  let keysDeleted = 0;
  for (const row of pending) {
    await retireVerifiedAmuxContentKey(row as AmuxRetirableContent);
    keysDeleted += 1;
  }
  if (pending.length === BATCH_SIZE) return { bodiesPurged: 0,
    keysDeleted, scanned: pending.length, batchLimit: BATCH_SIZE };
  const now = await prisma.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  if (!(now[0]?.now instanceof Date)) {
    throw new AmuxContentRetirementError("integrity_unavailable");
  }
  const [previews, chunks, units] = await Promise.all([
    prisma.amuxIdeaTransferPreview.findMany({
      where: { payloadCiphertext: { not: null }, payloadPurgedAt: null,
        AND: [
          { OR: [{ state: { in: ["prepared", "confirmed", "provider_failed"] },
            expiresAt: { lte: now[0].now } },
          { payloadPurgeAfter: { lte: now[0].now } }] },
          { OR: [{ state: { not: "in_flight" } },
            { idea: { OR: [{ state: { not: "analyzing" } },
              { analysisDeadlineAt: { lte: now[0].now } }] } }] },
        ],
        idea: { retentionHolds: { none: { releasedAt: null,
          expiresAt: { gt: now[0].now } } } } },
      orderBy: [{ payloadPurgeAfter: "asc" }, { id: "asc" }],
      take: BATCH_SIZE, select: { id: true, ideaId: true, state: true,
        expiresAt: true, payloadPurgeAfter: true },
    }),
    prisma.amuxIdeaAnalysisChunk.findMany({
      where: { freeformCiphertext: { not: null }, freeformPurgedAt: null,
        freeformPurgeAfter: { lte: now[0].now },
        idea: { retentionHolds: { none: { releasedAt: null,
          expiresAt: { gt: now[0].now } } } } },
      orderBy: [{ freeformPurgeAfter: "asc" }, { ideaId: "asc" }],
      take: BATCH_SIZE, select: { ideaId: true, chunkIndex: true,
        currentPreviewId: true, freeformPurgeAfter: true },
    }),
    prisma.amuxIdeaDraftUnit.findMany({
      where: { bodyCiphertext: { not: null }, bodyPurgedAt: null,
        idea: { retentionHolds: { none: { releasedAt: null,
          expiresAt: { gt: now[0].now } } } },
        OR: [{ state: "proposed", expiresAt: { lte: now[0].now } },
          { state: { in: ["approved", "rejected", "expired"] },
            bodyPurgeAfter: { lte: now[0].now } }] },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: BATCH_SIZE, select: { id: true, ideaId: true, state: true,
        expiresAt: true, bodyPurgeAfter: true },
    }),
  ]);
  const due: Due[] = [
    ...previews.filter((row) => row.payloadPurgeAfter).map((row) => ({
      target: { ideaId: row.ideaId, purpose: "transfer_payload" as const,
        subjectId: row.id },
      dueAt: ["prepared", "confirmed", "provider_failed"].includes(row.state)
        ? row.expiresAt : row.payloadPurgeAfter!,
      apply: (tx: Prisma.TransactionClient) =>
        commitAmuxDueTransferPayloadPurge(tx, row.id),
    })),
    ...chunks.filter((row) => row.freeformPurgeAfter && row.currentPreviewId)
      .map((row) => ({ target: { ideaId: row.ideaId,
        purpose: "analysis_freeform" as const,
        subjectId: amuxAnalysisFreeformSubjectId(row.ideaId,
          row.currentPreviewId!) }, dueAt: row.freeformPurgeAfter!,
        apply: (tx: Prisma.TransactionClient) =>
          commitAmuxDueFreeformPurge(tx, row.ideaId, row.chunkIndex),
      })),
    ...units.map((row) => ({ target: { ideaId: row.ideaId,
      purpose: "analysis_draft" as const, subjectId: row.id },
      dueAt: row.state === "proposed" ? row.expiresAt : row.bodyPurgeAfter!,
      apply: (tx: Prisma.TransactionClient) =>
        commitAmuxDueDraftUnitPurge(tx, row.id),
    })),
  ].sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
    .slice(0, BATCH_SIZE - pending.length);
  let bodiesPurged = 0;
  for (const item of due) {
    try {
      const result = await prisma.$transaction((tx) => item.apply(tx),
        { maxWait: 3_000, timeout: 12_000 });
      if (result === "purged") {
        bodiesPurged += 1;
        await retireVerifiedAmuxContentKey(item.target);
        keysDeleted += 1;
      }
    } catch (error) {
      if (error instanceof AmuxContentRetirementError &&
          error.code === "key_store_unavailable") throw error;
      const readBack = await readAmuxContentPurgeOutcome(item.target)
        .catch(() => "unavailable" as const);
      throw new AmuxContentRetirementError("outcome_unknown", item.target,
        readBack);
    }
  }
  return { bodiesPurged, keysDeleted,
    scanned: pending.length + due.length, batchLimit: BATCH_SIZE };
}
