import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "../adminAudit.ts";
import {
  AMUX_V19_TRACKED_CHECKOUT_AUDIT_ACTOR,
  AMUX_V19_TRACKED_CHECKOUT_AUDIT_SUMMARY,
  AMUX_V19_TRACKED_CHECKOUT_RECORDED_ACTION,
  AMUX_V19_TRACKED_CHECKOUT_RECORDED_TARGET,
  amuxTrackedCheckoutEvidenceAuditMetadata,
  inspectAmuxTrackedCheckoutEvidence,
  type AmuxTrackedCheckoutEvidenceInput,
} from "./ideaTrackedCheckoutEvidenceCore.ts";

export class AmuxTrackedCheckoutEvidenceError extends Error {
  constructor(readonly code: "invalid_evidence" | "idea_unavailable" | "already_recorded") {
    super(code);
    this.name = "AmuxTrackedCheckoutEvidenceError";
  }
}

export type AmuxTrackedCheckoutEvidenceRead = {
  evidenceId: string;
  ideaId: string;
  referenceOrdinal: number;
  pinnedCommitSha: string;
  excludedCount: number;
  excludedReasons: {
    secret_path: number;
    secret_content: number;
    non_regular: number;
    unscannable_content: number;
  };
  excludedPathDigest: string;
  excludedPathDigestKeyId: string;
  auditLogId: string;
};

export async function readAmuxTrackedCheckoutEvidence(
  tx: Prisma.TransactionClient,
  ideaId: string,
  referenceOrdinal: number,
): Promise<AmuxTrackedCheckoutEvidenceRead | null> {
  const row = await tx.amuxIdeaTrackedCheckoutEvidence.findUnique({
    where: { ideaId_referenceOrdinal: { ideaId, referenceOrdinal } },
  });
  if (!row) return null;
  return {
    evidenceId: row.id,
    ideaId: row.ideaId,
    referenceOrdinal: row.referenceOrdinal,
    pinnedCommitSha: row.pinnedCommitSha,
    excludedCount: row.excludedCount,
    excludedReasons: {
      secret_path: row.excludedSecretPathCount,
      secret_content: row.excludedSecretContentCount,
      non_regular: row.excludedNonRegularCount,
      unscannable_content: row.excludedUnscannableCount,
    },
    excludedPathDigest: row.excludedPathDigest,
    excludedPathDigestKeyId: row.excludedPathDigestKeyId,
    auditLogId: row.auditLogId,
  };
}

/** Record the content-free proof inside a caller-owned transaction. This does
 * not open a repository, start a CLI or reserve cost. */
export async function recordAmuxTrackedCheckoutEvidence(
  tx: Prisma.TransactionClient,
  input: AmuxTrackedCheckoutEvidenceInput,
): Promise<AmuxTrackedCheckoutEvidenceRead> {
  const inspected = inspectAmuxTrackedCheckoutEvidence(input);
  if (!inspected) throw new AmuxTrackedCheckoutEvidenceError("invalid_evidence");

  await takeAuditChainLock(tx);
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaSubmission"
    WHERE "id" = ${inspected.ideaId}
      AND "submissionOrigin" = 'session'
      AND "cancelledAt" IS NULL
      AND "analysisCompletedAt" IS NULL
      AND "analysisDeadlineAt" > (clock_timestamp() AT TIME ZONE 'UTC')
    FOR KEY SHARE
  `;
  if (locked.length !== 1) {
    throw new AmuxTrackedCheckoutEvidenceError("idea_unavailable");
  }
  if (await readAmuxTrackedCheckoutEvidence(tx, inspected.ideaId,
    inspected.referenceOrdinal)) {
    throw new AmuxTrackedCheckoutEvidenceError("already_recorded");
  }

  const evidenceId = randomUUID();
  const auditLogId = await writeSystemAuditLog({
    tx,
    systemActor: AMUX_V19_TRACKED_CHECKOUT_AUDIT_ACTOR,
    action: AMUX_V19_TRACKED_CHECKOUT_RECORDED_ACTION,
    targetType: AMUX_V19_TRACKED_CHECKOUT_RECORDED_TARGET,
    targetId: evidenceId,
    summary: AMUX_V19_TRACKED_CHECKOUT_AUDIT_SUMMARY,
    metadata: amuxTrackedCheckoutEvidenceAuditMetadata(evidenceId, inspected),
  });
  await tx.amuxIdeaTrackedCheckoutEvidence.create({ data: {
    id: evidenceId,
    ideaId: inspected.ideaId,
    referenceOrdinal: inspected.referenceOrdinal,
    pinnedCommitSha: inspected.pinnedCommitSha,
    excludedCount: inspected.excludedCount,
    excludedSecretPathCount: inspected.excludedSecretPathCount,
    excludedSecretContentCount: inspected.excludedSecretContentCount,
    excludedNonRegularCount: inspected.excludedNonRegularCount,
    excludedUnscannableCount: inspected.excludedUnscannableCount,
    excludedPathDigest: inspected.excludedPathDigest,
    excludedPathDigestKeyId: inspected.excludedPathDigestKeyId,
    auditLogId,
  } });
  const stored = await readAmuxTrackedCheckoutEvidence(tx,
    inspected.ideaId, inspected.referenceOrdinal);
  if (!stored) throw new AmuxTrackedCheckoutEvidenceError("invalid_evidence");
  return stored;
}
