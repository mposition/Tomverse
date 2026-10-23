import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "../adminAudit.ts";
import { AMUX_SESSION_IDEA_SUBMITTED_ACTION,
  AMUX_SESSION_IDEA_SUBMITTED_TARGET,
  AMUX_V19_MAX_CHECKOUT_CLAIM_BOUND_ACTION,
  auditRowActorKind } from "../adminAuditSystemActors.ts";
import {
  AMUX_V19_TRACKED_CHECKOUT_AUDIT_ACTOR,
  AMUX_V19_TRACKED_CHECKOUT_AUDIT_SUMMARY,
  AMUX_V19_TRACKED_CHECKOUT_RECORDED_ACTION,
  AMUX_V19_TRACKED_CHECKOUT_RECORDED_TARGET,
  amuxTrackedCheckoutEvidenceAuditMetadata,
  inspectAmuxTrackedCheckoutEvidence,
  type AmuxTrackedCheckoutEvidenceInput,
} from "./ideaTrackedCheckoutEvidenceCore.ts";
import { readAmuxSessionBudgetClaimReceipt } from
  "./ideaSessionAnalysisBudgetClaimService.ts";
import { readAmuxSessionAnalysisStopState } from
  "./ideaSessionAnalysisStopRead.ts";

export type AmuxMaxCheckoutClaim = { claimId: string; requestId: string;
  reservationId: string; invocationOrdinal: number };

export class AmuxTrackedCheckoutEvidenceError extends Error {
  constructor(readonly code: "invalid_evidence" | "idea_unavailable" |
    "reference_unpinned" | "already_recorded" | "claim_unavailable") {
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
  maxClaim?: AmuxMaxCheckoutClaim,
): Promise<AmuxTrackedCheckoutEvidenceRead> {
  const inspected = inspectAmuxTrackedCheckoutEvidence(input);
  if (!inspected) throw new AmuxTrackedCheckoutEvidenceError("invalid_evidence");

  await takeAuditChainLock(tx);
  if (maxClaim) await requireActiveMaxCheckoutClaim(tx, inspected.ideaId,
    maxClaim);
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
  const idea = await tx.amuxIdeaSubmission.findUnique({
    where: { id: inspected.ideaId },
    select: { submissionAuditLogId: true },
  });
  const submission = idea?.submissionAuditLogId
    ? await tx.adminAuditLog.findUnique({ where: { id: idea.submissionAuditLogId },
      select: { action: true, targetType: true, targetId: true,
        entryHash: true, metadata: true } }) : null;
  const metadata = submission?.metadata;
  const pinned = metadata && typeof metadata === "object" &&
    !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).pinnedCommitShas : null;
  if (!submission?.entryHash ||
      submission.action !== AMUX_SESSION_IDEA_SUBMITTED_ACTION ||
      submission.targetType !== AMUX_SESSION_IDEA_SUBMITTED_TARGET ||
      submission.targetId !== inspected.ideaId ||
      !Array.isArray(pinned) ||
      pinned[inspected.referenceOrdinal] !== inspected.pinnedCommitSha) {
    throw new AmuxTrackedCheckoutEvidenceError("reference_unpinned");
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
  if (maxClaim) {
    await writeSystemAuditLog({ tx,
      systemActor: AMUX_V19_TRACKED_CHECKOUT_AUDIT_ACTOR,
      action: AMUX_V19_MAX_CHECKOUT_CLAIM_BOUND_ACTION,
      targetType: AMUX_V19_TRACKED_CHECKOUT_RECORDED_TARGET,
      targetId: evidenceId,
      summary: "Bound AMUX v19 checkout evidence to one Max analysis claim.",
      metadata: { claimId: maxClaim.claimId,
        requestId: maxClaim.requestId,
        reservationId: maxClaim.reservationId,
        invocationOrdinal: maxClaim.invocationOrdinal,
        ideaId: inspected.ideaId,
        referenceOrdinal: inspected.referenceOrdinal,
        evidenceAuditLogId: auditLogId },
    });
  }
  return stored;
}

/** The audit lock precedes this claim lock, matching budget settlement. */
export async function requireActiveMaxCheckoutClaim(tx: Prisma.TransactionClient,
  ideaId: string, claim: AmuxMaxCheckoutClaim): Promise<void> {
  if (!Number.isSafeInteger(claim.invocationOrdinal) ||
      claim.invocationOrdinal < 0 || claim.invocationOrdinal > 2_147_483_647) {
    throw new AmuxTrackedCheckoutEvidenceError("claim_unavailable");
  }
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaSessionAnalysisBudgetClaim"
    WHERE "id" = ${claim.claimId} FOR UPDATE
  `;
  if (locked.length !== 1) {
    throw new AmuxTrackedCheckoutEvidenceError("claim_unavailable");
  }
  try {
    const receipt = await readAmuxSessionBudgetClaimReceipt(tx, claim);
    const stop = await readAmuxSessionAnalysisStopState(tx,
      claim.claimId, claim.reservationId, ideaId, "max_shadow");
    if (receipt.status !== "committed" ||
        receipt.claimId !== claim.claimId ||
        receipt.claimStatus !== "in_flight" || stop.stop) {
      throw new AmuxTrackedCheckoutEvidenceError("claim_unavailable");
    }
  } catch {
    throw new AmuxTrackedCheckoutEvidenceError("claim_unavailable");
  }
}

/** A lost Max write reply can only recover the proof audited for its own
 * immutable claim. Readback remains possible after the claim is settled. */
export async function readAmuxMaxTrackedCheckoutEvidence(tx: Prisma.TransactionClient,
  ideaId: string, referenceOrdinal: number, claim: AmuxMaxCheckoutClaim,
): Promise<AmuxTrackedCheckoutEvidenceRead | null> {
  const receipt = await readAmuxSessionBudgetClaimReceipt(tx, claim);
  if (receipt.status !== "committed" || receipt.claimId !== claim.claimId) {
    return null;
  }
  const evidence = await readAmuxTrackedCheckoutEvidence(tx, ideaId,
    referenceOrdinal);
  if (!evidence) return null;
  const bindings = await tx.adminAuditLog.findMany({ where: {
    action: AMUX_V19_MAX_CHECKOUT_CLAIM_BOUND_ACTION,
    targetType: AMUX_V19_TRACKED_CHECKOUT_RECORDED_TARGET,
    targetId: evidence.evidenceId,
  }, take: 2 });
  const audit = bindings[0];
  const metadata = audit?.metadata;
  const bound = metadata && typeof metadata === "object" &&
    !Array.isArray(metadata) ? metadata as Record<string, unknown> : null;
  if (bindings.length !== 1 || !audit?.entryHash ||
      auditRowActorKind(audit) !== "system" || !bound ||
      bound.claimId !== claim.claimId ||
      bound.requestId !== claim.requestId ||
      bound.reservationId !== claim.reservationId ||
      bound.invocationOrdinal !== claim.invocationOrdinal ||
      bound.ideaId !== ideaId ||
      bound.referenceOrdinal !== referenceOrdinal ||
      bound.evidenceAuditLogId !== evidence.auditLogId) return null;
  return evidence;
}
