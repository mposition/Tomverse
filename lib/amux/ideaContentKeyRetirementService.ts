import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_V4_CONTENT_KEY_DELETE_ACTION,
  AMUX_V4_CONTENT_PURGE_ACTION, AMUX_V4_CONTENT_RETIREMENT_TARGET,
  AMUX_V4_IDEA_SYSTEM_ACTOR } from "@/lib/adminAuditSystemActors";
import { prisma } from "@/lib/prisma";
import { amuxAnalysisFreeformSubjectId } from "./ideaAnalysisDraftSealCore.ts";
import { deleteAmuxContentUnitKey,
  type AmuxContentKeyIdentity } from "./ideaKeyStore.ts";

export type AmuxRetirableContent = AmuxContentKeyIdentity & {
  purpose: "transfer_payload" | "analysis_freeform" | "analysis_draft" |
    "task_result" | "task_patch" | "task_changed_paths" | "review_findings" |
    "repository_read_manifest" | "analysis_result";
};

export class AmuxContentRetirementError extends Error {
  constructor(readonly code: "integrity_unavailable" | "key_store_unavailable" |
    "outcome_unknown", readonly target?: AmuxRetirableContent,
    readonly readBack?: "purged" | "not_purged" | "partial" | "unavailable") {
    super(code);
    this.name = "AmuxContentRetirementError";
  }
}

const retiredTargetId = (target: AmuxRetirableContent) =>
  `${target.ideaId}:${target.purpose}:${target.subjectId}`;

async function nowInDb(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  if (!(rows[0]?.now instanceof Date) || !Number.isFinite(rows[0].now.getTime())) {
    throw new AmuxContentRetirementError("integrity_unavailable");
  }
  return rows[0].now;
}

/** Called within the transaction that clears the due ciphertext. No body or
 * storage key path is copied into the audit. */
export async function recordAmuxContentBodyPurge(tx: Prisma.TransactionClient,
  target: AmuxRetirableContent, purgedAt: Date,
  digest?: string, digestKeyId?: string): Promise<void> {
  if (!Number.isFinite(purgedAt.getTime()) ||
      ((digest !== undefined || digestKeyId !== undefined) &&
        (!digest || !/^[a-f0-9]{64}$/.test(digest) || !digestKeyId))) {
    throw new AmuxContentRetirementError("integrity_unavailable", target);
  }
  const auditId = await writeSystemAuditLog({ tx,
    systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
    action: AMUX_V4_CONTENT_PURGE_ACTION,
    targetType: AMUX_V4_CONTENT_RETIREMENT_TARGET,
    targetId: retiredTargetId(target),
    summary: "Purged a due AMUX v4 encrypted body and queued external key deletion.",
    metadata: { ideaId: target.ideaId, purpose: target.purpose,
      subjectId: target.subjectId, ...(digest ? { digest, digestKeyId } : {}) },
  });
  await tx.amuxIdeaContentKeyRetirement.create({ data: {
    ideaId: target.ideaId, purpose: target.purpose,
    subjectId: target.subjectId, bodyPurgedAt: purgedAt,
    purgeAuditLogId: auditId,
  } });
}

const V22_SEALED_PARTS = {
  task_result: "result", task_patch: "patch", task_changed_paths: "changed_paths",
} as const;
type V22SealedState = Array<{ ideaId: string; cleared: boolean;
  bodyPurgedAt: Date | null }>;

// One fixed statement per table: no identifier is ever composed.
const v22SealedState = (tx: Prisma.TransactionClient,
  purpose: keyof typeof V22_SEALED_PARTS, attemptId: string) =>
  purpose === "task_result" ? tx.$queryRaw<V22SealedState>`
    SELECT "ideaId", ("ciphertext" IS NULL AND "keyId" IS NULL AND
      "keyVersion" IS NULL) AS "cleared", "bodyPurgedAt"
    FROM "AmuxV22TaskResult" WHERE "attemptId" = ${attemptId}` :
  purpose === "task_patch" ? tx.$queryRaw<V22SealedState>`
    SELECT "ideaId", ("ciphertext" IS NULL AND "keyId" IS NULL AND
      "keyVersion" IS NULL) AS "cleared", "bodyPurgedAt"
    FROM "AmuxV22TaskPatch" WHERE "attemptId" = ${attemptId}` :
  tx.$queryRaw<V22SealedState>`
    SELECT "ideaId", ("ciphertext" IS NULL AND "keyId" IS NULL AND
      "keyVersion" IS NULL) AS "cleared", "bodyPurgedAt"
    FROM "AmuxV22TaskChangedPaths" WHERE "attemptId" = ${attemptId}`;

/**
 * A v22 row's purge state, read without its body: a large result cannot be
 * read whole (lib/amux/sealedByteaRead.ts), and only whether it is gone
 * matters here. With no final row, the unit key sealed only transfer chunks
 * (docs/policy/amux-v22-result-transfer.md 2.6): its body is purged once that
 * staging is gone, at the time its ledger row recorded.
 */
async function v22SealedPurgedAt(tx: Prisma.TransactionClient,
  target: AmuxRetirableContent & { purpose: keyof typeof V22_SEALED_PARTS },
  ledgerPurgedAt: Date | undefined): Promise<Date | null> {
  const rows = await v22SealedState(tx, target.purpose, target.subjectId);
  const row = rows[0];
  if (row) return row.ideaId === target.ideaId && row.cleared ? row.bodyPurgedAt : null;
  if (!ledgerPurgedAt) return null;
  const staged = await tx.amuxV22TransferPart.findUnique({
    where: { attemptId_part: { attemptId: target.subjectId,
      part: V22_SEALED_PARTS[target.purpose] } },
    select: { attemptId: true } });
  return staged ? null : ledgerPurgedAt;
}

async function sourcePurgedAt(tx: Prisma.TransactionClient,
  target: AmuxRetirableContent, ledgerPurgedAt?: Date): Promise<Date | null> {
  if (target.purpose === "analysis_result") {
    const row = await tx.amuxIdeaSessionAnalysisResult.findUnique({
      where: { claimId: target.subjectId },
      select: { ideaId: true, ciphertext: true, keyId: true,
        keyVersion: true, bodyPurgedAt: true },
    });
    return row?.ideaId === target.ideaId && row.ciphertext === null &&
      row.keyId === null && row.keyVersion === null ? row.bodyPurgedAt : null;
  }
  if (target.purpose === "repository_read_manifest") {
    const row = await tx.amuxIdeaTrackedCheckoutReadManifest.findUnique({
      where: { id: target.subjectId },
      select: { ideaId: true, ciphertext: true, keyId: true,
        keyVersion: true, bodyPurgedAt: true },
    });
    return row?.ideaId === target.ideaId && row.ciphertext === null &&
      row.keyId === null && row.keyVersion === null ? row.bodyPurgedAt : null;
  }
  if (target.purpose === "task_result" || target.purpose === "task_patch" ||
      target.purpose === "task_changed_paths")
    return v22SealedPurgedAt(tx, { ...target, purpose: target.purpose }, ledgerPurgedAt);
  if (target.purpose === "review_findings") {
    const row = await tx.amuxV52ReviewFindings.findUnique({
      where: { attemptId: target.subjectId },
      select: { ideaId: true, ciphertext: true, keyId: true,
        keyVersion: true, bodyPurgedAt: true },
    });
    return row?.ideaId === target.ideaId && row.ciphertext === null &&
      row.keyId === null && row.keyVersion === null ? row.bodyPurgedAt : null;
  }
  if (target.purpose === "transfer_payload") {
    const row = await tx.amuxIdeaTransferPreview.findUnique({
      where: { id: target.subjectId },
      select: { ideaId: true, payloadCiphertext: true, payloadKeyId: true,
        payloadKeyVersion: true, payloadPurgedAt: true },
    });
    return row?.ideaId === target.ideaId && row.payloadCiphertext === null &&
      row.payloadKeyId === null && row.payloadKeyVersion === null
      ? row.payloadPurgedAt : null;
  }
  if (target.purpose === "analysis_draft") {
    const row = await tx.amuxIdeaDraftUnit.findUnique({
      where: { id: target.subjectId },
      select: { ideaId: true, bodyCiphertext: true, bodyKeyId: true,
        bodyKeyVersion: true, bodyPurgedAt: true },
    });
    return row?.ideaId === target.ideaId && row.bodyCiphertext === null &&
      row.bodyKeyId === null && row.bodyKeyVersion === null
      ? row.bodyPurgedAt : null;
  }
  const chunks = await tx.amuxIdeaAnalysisChunk.findMany({
    where: { ideaId: target.ideaId },
    select: { currentPreviewId: true, freeformCiphertext: true,
      freeformKeyId: true, freeformKeyVersion: true,
      freeformPurgedAt: true },
  });
  const matched = chunks.filter((row) => row.currentPreviewId &&
    amuxAnalysisFreeformSubjectId(target.ideaId, row.currentPreviewId) ===
      target.subjectId);
  if (matched.length !== 1) return null;
  const row = matched[0];
  return row.freeformCiphertext === null && row.freeformKeyId === null &&
    row.freeformKeyVersion === null ? row.freeformPurgedAt : null;
}

export async function readAmuxContentPurgeOutcome(target: AmuxRetirableContent):
  Promise<"purged" | "not_purged" | "partial"> {
  const row = await prisma.amuxIdeaContentKeyRetirement.findUnique({
    where: { ideaId_purpose_subjectId: target },
    select: { bodyPurgedAt: true, purgeAuditLogId: true },
  });
  const purgedAt = await prisma.$transaction((tx) =>
    sourcePurgedAt(tx, target, row?.bodyPurgedAt));
  if (!row) return purgedAt ? "partial" : "not_purged";
  if (!purgedAt || row.bodyPurgedAt.getTime() !== purgedAt.getTime()) {
    return "partial";
  }
  const audit = await prisma.adminAuditLog.findUnique({
    where: { id: row.purgeAuditLogId },
    select: { action: true, targetType: true, targetId: true, entryHash: true },
  });
  return audit?.action === AMUX_V4_CONTENT_PURGE_ACTION &&
    audit.targetType === AMUX_V4_CONTENT_RETIREMENT_TARGET &&
    audit.targetId === retiredTargetId(target) &&
    typeof audit.entryHash === "string" ? "purged" : "partial";
}

/** The key store call is outside the DB transaction. A missing object is a
 * verified deletion; an uncertain object-store response stops this tick. */
export async function retireVerifiedAmuxContentKey(target: AmuxRetirableContent,
  deleteKey: typeof deleteAmuxContentUnitKey = deleteAmuxContentUnitKey): Promise<
  "deleted" | "already_deleted"> {
  if (await readAmuxContentPurgeOutcome(target) !== "purged") {
    throw new AmuxContentRetirementError("integrity_unavailable", target);
  }
  const prior = await prisma.amuxIdeaContentKeyRetirement.findUnique({
    where: { ideaId_purpose_subjectId: target },
    select: { keyDeletedAt: true },
  });
  if (prior?.keyDeletedAt) return "already_deleted";
  try { await deleteKey(target); }
  catch { throw new AmuxContentRetirementError("key_store_unavailable", target); }
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
               set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
      `;
      await takeAuditChainLock(tx);
      await tx.$queryRaw`
        SELECT "id" FROM "AmuxIdeaSubmission"
        WHERE "id" = ${target.ideaId} FOR UPDATE
      `;
      await tx.$queryRaw`
        SELECT "ideaId" FROM "AmuxIdeaContentKeyRetirement"
        WHERE "ideaId" = ${target.ideaId} AND "purpose" = ${target.purpose}
          AND "subjectId" = ${target.subjectId} FOR UPDATE
      `;
      const row = await tx.amuxIdeaContentKeyRetirement.findUnique({
        where: { ideaId_purpose_subjectId: target },
      });
      const purgedAt = await sourcePurgedAt(tx, target, row?.bodyPurgedAt);
      if (!row || !purgedAt || row.bodyPurgedAt.getTime() !== purgedAt.getTime()) {
        throw new AmuxContentRetirementError("integrity_unavailable", target);
      }
      if (row.keyDeletedAt && row.keyDeleteAuditLogId) return "already_deleted";
      if (row.keyDeletedAt || row.keyDeleteAuditLogId) {
        throw new AmuxContentRetirementError("integrity_unavailable", target);
      }
      const now = await nowInDb(tx);
      const auditId = await writeSystemAuditLog({ tx,
        systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
        action: AMUX_V4_CONTENT_KEY_DELETE_ACTION,
        targetType: AMUX_V4_CONTENT_RETIREMENT_TARGET,
        targetId: retiredTargetId(target),
        summary: "Verified deletion of an AMUX v4 content unit key.",
        metadata: { ideaId: target.ideaId, purpose: target.purpose,
          subjectId: target.subjectId, purgeAuditLogId: row.purgeAuditLogId },
      });
      const changed = await tx.amuxIdeaContentKeyRetirement.updateMany({
        where: { ideaId: target.ideaId, purpose: target.purpose,
          subjectId: target.subjectId, keyDeletedAt: null,
          keyDeleteAuditLogId: null },
        data: { keyDeletedAt: now, keyDeleteAuditLogId: auditId },
      });
      if (changed.count !== 1) {
        throw new AmuxContentRetirementError("integrity_unavailable", target);
      }
      return "deleted";
    }, { maxWait: 3_000, timeout: 12_000 });
  } catch {
    const readBack = await prisma.amuxIdeaContentKeyRetirement.findUnique({
      where: { ideaId_purpose_subjectId: target },
      select: { keyDeletedAt: true, keyDeleteAuditLogId: true },
    }).catch(() => null);
    if (readBack?.keyDeletedAt && readBack.keyDeleteAuditLogId) {
      return "already_deleted";
    }
    throw new AmuxContentRetirementError("outcome_unknown", target);
  }
}
