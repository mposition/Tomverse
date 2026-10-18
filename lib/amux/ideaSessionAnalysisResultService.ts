import "server-only";

import type { Prisma } from "@prisma/client";
import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_V4_IDEA_SYSTEM_ACTOR,
  AMUX_SESSION_IDEA_SUBMITTED_ACTION,
  AMUX_SESSION_IDEA_SUBMITTED_TARGET,
  AMUX_V19_SESSION_ANALYSIS_RESULT_ACTION,
  AMUX_V19_SESSION_ANALYSIS_RESULT_TARGET,
  auditRowActorKind } from "@/lib/adminAuditSystemActors";
import { sealAmuxContent, type AmuxContentKeys } from "./ideaCrypto.ts";
import { amuxContentUnitKeyId } from "./ideaKeyStore.ts";
import { readAmuxMaxTrackedCheckoutEvidence,
  requireActiveMaxCheckoutClaim,
  type AmuxMaxCheckoutClaim } from "./ideaTrackedCheckoutEvidenceStore.ts";
import { readAmuxMaxManifestIntentBinding,
  readAmuxTrackedCheckoutReadManifestKeyIntentReceipt,
  readAmuxTrackedCheckoutReadManifestReceipt } from
  "./ideaTrackedCheckoutReadManifestStore.ts";
import { commitAmuxSessionBudgetOutcome } from
  "./ideaSessionAnalysisBudgetSettlementService.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
type Tx = Prisma.TransactionClient;
export type AmuxMaxSessionResultIdentity = AmuxMaxCheckoutClaim & {
  ideaId: string; referenceOrdinal: number; evidenceId: string;
  manifestId: string;
};
type ResultInput = AmuxMaxSessionResultIdentity & {
  rawModelOutput: string; inputTokens: number; outputTokens: number;
  keys: AmuxContentKeys;
};

export class AmuxMaxSessionResultError extends Error {
  constructor(readonly code: "invalid_result" | "not_ready" |
    "integrity_unavailable") {
    super(code);
    this.name = "AmuxMaxSessionResultError";
  }
}

function validIdentity(input: AmuxMaxSessionResultIdentity): boolean {
  return !!input && [input.claimId, input.requestId,
    input.reservationId, input.ideaId, input.evidenceId,
    input.manifestId].every((value) => UUID.test(value)) &&
    Number.isSafeInteger(input.invocationOrdinal) &&
    input.invocationOrdinal >= 0 && input.invocationOrdinal <= 2_147_483_647 &&
    Number.isSafeInteger(input.referenceOrdinal) &&
    input.referenceOrdinal >= 0 && input.referenceOrdinal <= 2_147_483_647;
}

async function readPinnedSessionReferenceShas(tx: Tx,
  ideaId: string): Promise<string[]> {
  const idea = await tx.amuxIdeaSubmission.findUnique({ where: { id: ideaId },
    select: { submissionOrigin: true, submissionAuditLogId: true } });
  if (idea?.submissionOrigin !== "session" || !idea.submissionAuditLogId) {
    throw new AmuxMaxSessionResultError("not_ready");
  }
  const audit = await tx.adminAuditLog.findUnique({
    where: { id: idea.submissionAuditLogId },
    select: { action: true, targetType: true, targetId: true,
      entryHash: true, metadata: true, actorUserId: true,
      actorEmail: true, ipAddress: true, userAgent: true },
  });
  const metadata = audit?.metadata && typeof audit.metadata === "object" &&
    !Array.isArray(audit.metadata)
    ? audit.metadata as Record<string, unknown> : null;
  const pins = metadata?.pinnedCommitShas;
  const repositoryCount = metadata?.repositoryCount;
  const pullRequestCount = metadata?.pullRequestCount;
  if (!audit?.entryHash ||
      audit.action !== AMUX_SESSION_IDEA_SUBMITTED_ACTION ||
      audit.targetType !== AMUX_SESSION_IDEA_SUBMITTED_TARGET ||
      audit.targetId !== ideaId || auditRowActorKind(audit) !== "system" ||
      !Array.isArray(pins) || pins.length < 1 ||
      pins.length > 2_147_483_647 ||
      typeof repositoryCount !== "number" ||
      !Number.isSafeInteger(repositoryCount) || repositoryCount < 0 ||
      typeof pullRequestCount !== "number" ||
      !Number.isSafeInteger(pullRequestCount) || pullRequestCount < 0 ||
      pins.length !== repositoryCount + pullRequestCount ||
      !pins.every((pin) => typeof pin === "string" && SHA.test(pin))) {
    throw new AmuxMaxSessionResultError("not_ready");
  }
  return pins as string[];
}

/** No content key is created until the live claim and every pinned reference's
 * checkout evidence and read manifest have been checked. The claim is the
 * durable key identity. */
export async function preflightAmuxMaxSessionResult(tx: Tx,
  input: AmuxMaxSessionResultIdentity): Promise<void> {
  if (!validIdentity(input)) throw new AmuxMaxSessionResultError("invalid_result");
  await takeAuditChainLock(tx);
  try {
    await requireActiveMaxCheckoutClaim(tx, input.ideaId, input);
    const pins = await readPinnedSessionReferenceShas(tx, input.ideaId);
    if (input.referenceOrdinal >= pins.length) {
      throw new AmuxMaxSessionResultError("not_ready");
    }
    for (let ordinal = 0; ordinal < pins.length; ordinal += 1) {
      const evidence = await readAmuxMaxTrackedCheckoutEvidence(tx,
        input.ideaId, ordinal, input);
      const manifest = await readAmuxTrackedCheckoutReadManifestReceipt(tx,
        input.ideaId, ordinal);
      const intent = await readAmuxTrackedCheckoutReadManifestKeyIntentReceipt(tx,
        input.ideaId, ordinal);
      if (!evidence || !manifest || manifest.bodyPurgedAt ||
          evidence.pinnedCommitSha !== pins[ordinal] ||
          manifest.pinnedCommitSha !== pins[ordinal] ||
          !intent || intent.id !== manifest.id ||
          !await readAmuxMaxManifestIntentBinding(tx, input.ideaId,
            ordinal, manifest.id, intent.auditLogId, input) ||
          (ordinal === input.referenceOrdinal &&
            (evidence.evidenceId !== input.evidenceId ||
             manifest.id !== input.manifestId))) {
        throw new AmuxMaxSessionResultError("not_ready");
      }
    }
  } catch {
    throw new AmuxMaxSessionResultError("not_ready");
  }
}

/** The raw response, its content-free audit, and measured Max shadow cost
 * commit atomically. A failed settlement rolls the result back. */
export async function commitAmuxMaxSessionResult(tx: Tx,
  input: ResultInput): Promise<{ claimId: string; resultAuditId: string;
    settlementAuditId: string; digest: string; digestKeyId: string }> {
  const bytes = typeof input?.rawModelOutput === "string"
    ? Buffer.from(input.rawModelOutput, "utf8") : null;
  if (!validIdentity(input) || !bytes || bytes.length < 1 ||
      bytes.length > 65_536 ||
      ![input.inputTokens, input.outputTokens].every((value) =>
        Number.isSafeInteger(value) && value >= 0 &&
        value <= 2_147_483_647) ||
      input.inputTokens + input.outputTokens <= 0 ||
      input.keys.masterKeyId !== amuxContentUnitKeyId({
        ideaId: input.ideaId, purpose: "analysis_result",
        subjectId: input.claimId })) {
    bytes?.fill(0);
    throw new AmuxMaxSessionResultError("invalid_result");
  }
  try {
    await preflightAmuxMaxSessionResult(tx, input);
    const sealed = sealAmuxContent(bytes, "analysis_result",
      input.claimId, input.keys);
    const resultAuditId = await writeSystemAuditLog({ tx,
      systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
      action: AMUX_V19_SESSION_ANALYSIS_RESULT_ACTION,
      targetType: AMUX_V19_SESSION_ANALYSIS_RESULT_TARGET,
      targetId: input.claimId,
      summary: "Recorded one claim-bound Max session analysis result.",
      metadata: { policyVersion: 19, claimId: input.claimId,
        reservationId: input.reservationId, ideaId: input.ideaId,
        referenceOrdinal: input.referenceOrdinal,
        evidenceId: input.evidenceId, manifestId: input.manifestId,
        digest: sealed.digest, digestKeyId: sealed.digestKeyId,
        inputTokens: input.inputTokens, outputTokens: input.outputTokens },
    });
    await tx.amuxIdeaSessionAnalysisResult.create({ data: {
      claimId: input.claimId, reservationId: input.reservationId,
      ideaId: input.ideaId, referenceOrdinal: input.referenceOrdinal,
      evidenceId: input.evidenceId, manifestId: input.manifestId,
      ciphertext: Uint8Array.from(sealed.ciphertext), keyId: sealed.keyId,
      keyVersion: sealed.keyVersion, digest: sealed.digest,
      digestKeyId: sealed.digestKeyId,
      inputTokens: input.inputTokens, outputTokens: input.outputTokens,
      auditLogId: resultAuditId,
    } });
    const settlement = await commitAmuxSessionBudgetOutcome(tx, {
      claimId: input.claimId, outcome: "verified_success",
      inputTokens: input.inputTokens, outputTokens: input.outputTokens,
      requiredBudgetMode: "max_shadow",
      exactAgentClaim: { requestId: input.requestId,
        reservationId: input.reservationId, ideaId: input.ideaId,
        invocationOrdinal: input.invocationOrdinal },
    });
    if (input.invocationOrdinal === 0) {
      const advanced = await tx.amuxIdeaSubmission.updateMany({
        where: { id: input.ideaId, state: "submitted", cancelledAt: null,
          analysisCompletedAt: null },
        data: { state: "analyzing" },
      });
      if (advanced.count !== 1) {
        throw new AmuxMaxSessionResultError("integrity_unavailable");
      }
    }
    return { claimId: input.claimId, resultAuditId,
      settlementAuditId: settlement.auditId,
      digest: sealed.digest, digestKeyId: sealed.digestKeyId };
  } finally { bytes.fill(0); }
}

/** A response-loss read never selects the encrypted result or key. */
export async function readAmuxMaxSessionResultReceipt(tx: Tx,
  input: Pick<AmuxMaxSessionResultIdentity, "claimId" | "requestId" |
    "reservationId" | "ideaId" | "invocationOrdinal">):
  Promise<{ status: "absent" | "committed" | "partial";
    claimId: string; digest?: string; digestKeyId?: string }> {
  if (!UUID.test(input.claimId) || !UUID.test(input.requestId) ||
      !UUID.test(input.reservationId) || !UUID.test(input.ideaId) ||
      !Number.isSafeInteger(input.invocationOrdinal) ||
      input.invocationOrdinal < 0) {
    throw new AmuxMaxSessionResultError("invalid_result");
  }
  const row = await tx.amuxIdeaSessionAnalysisResult.findUnique({
    where: { claimId: input.claimId }, select: {
      claimId: true, reservationId: true, ideaId: true,
      digest: true, digestKeyId: true, auditLogId: true,
      claim: { select: { requestId: true, invocationOrdinal: true,
        status: true, resolutionAuditLogId: true } },
    },
  });
  if (!row) return { status: "absent", claimId: input.claimId };
  const audit = await tx.adminAuditLog.findUnique({
    where: { id: row.auditLogId }, select: { action: true,
      targetType: true, targetId: true, metadata: true,
      actorUserId: true, actorEmail: true, ipAddress: true,
      userAgent: true, entryHash: true },
  });
  const meta = audit?.metadata && typeof audit.metadata === "object" &&
    !Array.isArray(audit.metadata) ? audit.metadata as Record<string, unknown>
    : null;
  if (row.reservationId !== input.reservationId ||
      row.ideaId !== input.ideaId ||
      row.claim.requestId !== input.requestId ||
      row.claim.invocationOrdinal !== input.invocationOrdinal ||
      row.claim.status !== "succeeded" ||
      !row.claim.resolutionAuditLogId ||
      !audit?.entryHash || auditRowActorKind(audit) !== "system" ||
      audit.action !== AMUX_V19_SESSION_ANALYSIS_RESULT_ACTION ||
      audit.targetType !== AMUX_V19_SESSION_ANALYSIS_RESULT_TARGET ||
      audit.targetId !== input.claimId ||
      meta?.digest !== row.digest || meta?.digestKeyId !== row.digestKeyId) {
    return { status: "partial", claimId: input.claimId };
  }
  return { status: "committed", claimId: input.claimId,
    digest: row.digest, digestKeyId: row.digestKeyId };
}
