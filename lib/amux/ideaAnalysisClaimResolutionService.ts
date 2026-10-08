import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { auditRowActorKind, AMUX_V4_ANALYSIS_CLAIM_ACTION,
  AMUX_V4_ANALYSIS_CLAIM_TARGET, AMUX_V4_ANALYSIS_RESULT_ACTION,
  AMUX_V4_ANALYSIS_RESULT_TARGET, AMUX_V4_IDEA_AUTO_CANCEL_ACTION,
  AMUX_V4_IDEA_AUTO_CANCEL_TARGET } from "@/lib/adminAuditSystemActors";
import { AMUX_V4_ANALYSIS_NAMESPACE } from "./ideaAnalysisBudgetCore.ts";
import { amuxIdeaAnalysisClaimReadbackDigest,
  type AmuxIdeaAnalysisClaimReadback,
  type AmuxIdeaAnalysisClaimResolutionDisposition } from
  "./ideaAnalysisClaimResolutionCore.ts";

const ID = /^[A-Za-z0-9:_-]{1,128}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ACTION = "amux.v4.analysis_claim.owner_resolved";
const TARGET = "AmuxIdeaAnalysisBudgetHold";

export class AmuxIdeaAnalysisClaimResolutionError extends Error {
  constructor(readonly code: "forbidden" | "not_resolvable" |
    "conflict" | "integrity_unavailable") {
    super(code);
    this.name = "AmuxIdeaAnalysisClaimResolutionError";
  }
}

function ownerId(session: Session): string {
  const id = session.user?.id;
  if (!id || !isAdminSession(session) || getAdminRole(session) !== "owner") {
    throw new AmuxIdeaAnalysisClaimResolutionError("forbidden");
  }
  return id;
}

function record(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

async function readActiveSnapshot(tx: Prisma.TransactionClient,
  actorUserId: string, holdId: string): Promise<AmuxIdeaAnalysisClaimReadback> {
  const hold = await tx.amuxIdeaAnalysisBudgetHold.findUnique({ where: { id: holdId } });
  if (!hold || hold.namespace !== AMUX_V4_ANALYSIS_NAMESPACE ||
      !["in_flight", "outcome_unknown"].includes(hold.status) ||
      !hold.dispatchedAt || hold.closedAt || hold.settledMicroUsd !== null) {
    throw new AmuxIdeaAnalysisClaimResolutionError("not_resolvable");
  }
  const preview = await tx.amuxIdeaTransferPreview.findUnique({
    where: { id: hold.previewId },
  });
  const idea = preview && await tx.amuxIdeaSubmission.findUnique({
    where: { id: preview.ideaId },
  });
  const chunk = preview && await tx.amuxIdeaAnalysisChunk.findUnique({
    where: { ideaId_chunkIndex: { ideaId: preview.ideaId,
      chunkIndex: preview.chunkIndex } },
  });
  const activeIdea = idea?.state === "analyzing" && idea.cancelledAt === null &&
    idea.analysisCompletedAt === null;
  const cancelledIdea = idea?.state === "cancelled" &&
    idea.cancelledAt instanceof Date && idea.analysisCompletedAt === null &&
    idea.cancelledAt >= idea.analysisDeadlineAt &&
    idea.rawPurgeAfter instanceof Date;
  if (!preview || !idea || !chunk || idea.actorUserId !== actorUserId ||
      preview.confirmedByUserId !== actorUserId ||
      (!activeIdea && !cancelledIdea) || chunk.currentPreviewId !== preview.id ||
      chunk.attempt !== preview.attempt || chunk.leaseGeneration !== 1 ||
      preview.consumedAt === null ||
      (hold.status === "in_flight" &&
        (preview.state !== "in_flight" || chunk.state !== "in_flight")) ||
      (hold.status === "outcome_unknown" &&
        (preview.state !== "outcome_unknown" || chunk.state !== "outcome_unknown" ||
          preview.outcomeUnknownAt === null))) {
    throw new AmuxIdeaAnalysisClaimResolutionError("integrity_unavailable");
  }
  if (cancelledIdea) {
    const cancellations = await tx.adminAuditLog.findMany({ where: {
      action: AMUX_V4_IDEA_AUTO_CANCEL_ACTION,
      targetType: AMUX_V4_IDEA_AUTO_CANCEL_TARGET, targetId: idea.id,
    }, take: 2 });
    const cancellation = cancellations[0];
    const cancellationData = cancellation && record(cancellation.metadata);
    if (cancellations.length !== 1 || !cancellation?.entryHash ||
        auditRowActorKind(cancellation) !== "system" || !cancellationData ||
        cancellationData.submittedAt !== idea.submittedAt.toISOString() ||
        cancellationData.analysisDeadlineAt !== idea.analysisDeadlineAt.toISOString() ||
        cancellationData.rawPurgeAfter !== idea.rawPurgeAfter?.toISOString()) {
      throw new AmuxIdeaAnalysisClaimResolutionError("integrity_unavailable");
    }
  }
  const claims = await tx.adminAuditLog.findMany({ where: {
    action: AMUX_V4_ANALYSIS_CLAIM_ACTION,
    targetType: AMUX_V4_ANALYSIS_CLAIM_TARGET, targetId: preview.id,
  }, take: 2 });
  const claim = claims[0];
  const claimData = claim && record(claim.metadata);
  if (claims.length !== 1 || !claim?.entryHash ||
      auditRowActorKind(claim) !== "system" || !claimData ||
      typeof claimData.requestId !== "string" || !ID.test(claimData.requestId) ||
      claimData.previewId !== preview.id || claimData.ideaId !== idea.id ||
      claimData.chunkIndex !== preview.chunkIndex || claimData.holdId !== hold.id ||
      claimData.payloadDigest !== preview.payloadDigest ||
      claimData.leaseGeneration !== 1 || claimData.modelCallStarted !== false) {
    throw new AmuxIdeaAnalysisClaimResolutionError("integrity_unavailable");
  }
  const results = await tx.adminAuditLog.findMany({ where: {
    action: AMUX_V4_ANALYSIS_RESULT_ACTION,
    targetType: AMUX_V4_ANALYSIS_RESULT_TARGET, targetId: preview.id,
  }, take: 2 });
  if ((hold.status === "in_flight" && results.length !== 0) ||
      (hold.status === "outcome_unknown" && results.length !== 1)) {
    throw new AmuxIdeaAnalysisClaimResolutionError("integrity_unavailable");
  }
  const result = results[0] ?? null;
  const resultData = result && record(result.metadata);
  const resultOutcome = resultData?.outcome;
  const expectedFailureReason = resultOutcome === "outcome_unknown"
    ? null : "usage_unverified";
  if (result && (!result.entryHash || auditRowActorKind(result) !== "system" ||
      !resultData || typeof resultData.requestId !== "string" ||
      !ID.test(resultData.requestId) || typeof resultData.resultDigest !== "string" ||
      !DIGEST.test(resultData.resultDigest) || resultData.ideaId !== idea.id ||
      resultData.holdId !== hold.id || resultData.leaseGeneration !== 1 ||
      !["verified_success", "invocation_failed", "outcome_unknown"].includes(
        String(resultOutcome)) || resultData.effectiveOutcome !== "outcome_unknown" ||
      resultData.failureReason !== expectedFailureReason ||
      resultData.state !== "outcome_unknown" ||
      resultData.retryAutomatically !== false)) {
    throw new AmuxIdeaAnalysisClaimResolutionError("integrity_unavailable");
  }
  return {
    holdId: hold.id, previewId: preview.id, ideaId: idea.id,
    chunkIndex: preview.chunkIndex, leaseGeneration: 1,
    reservedMicroUsd: hold.reservedMicroUsd.toString(),
    holdStatus: hold.status as "in_flight" | "outcome_unknown",
    ideaState: idea.state as "analyzing" | "cancelled",
    ideaCancelledAt: idea.cancelledAt?.toISOString() ?? null,
    claimRequestId: claimData.requestId,
    payloadDigest: preview.payloadDigest,
    resultRequestId: resultData?.requestId as string | undefined ?? null,
    resultDigest: resultData?.resultDigest as string | undefined ?? null,
    resultOutcome: resultOutcome as AmuxIdeaAnalysisClaimReadback["resultOutcome"] ?? null,
    resultEffectiveOutcome: resultData?.effectiveOutcome as
      AmuxIdeaAnalysisClaimReadback["resultEffectiveOutcome"] ?? null,
    resultFailureReason: resultData?.failureReason as
      AmuxIdeaAnalysisClaimReadback["resultFailureReason"] ?? null,
    zeroReleaseEligible: result === null,
  };
}

export async function readAmuxIdeaAnalysisClaimResolution(
  tx: Prisma.TransactionClient,
  input: { session: Session; holdId: string },
): Promise<AmuxIdeaAnalysisClaimReadback & { readbackDigest: string }> {
  const actorUserId = ownerId(input.session);
  await assertRecentAdminAuthentication(input.session);
  if (!ID.test(input.holdId)) {
    throw new AmuxIdeaAnalysisClaimResolutionError("not_resolvable");
  }
  const snapshot = await readActiveSnapshot(tx, actorUserId, input.holdId);
  return { ...snapshot, readbackDigest: amuxIdeaAnalysisClaimReadbackDigest(snapshot) };
}

/** Read-only recovery after a lost resolution response. Absence never permits
 * resubmitting the mutation; the operator keeps the request ID and checks it. */
export async function readAmuxIdeaAnalysisClaimResolutionReceipt(
  tx: Prisma.TransactionClient,
  input: { session: Session; resolutionRequestId: string },
): Promise<{ status: "absent" } | { status: "committed"; holdId: string;
  disposition: AmuxIdeaAnalysisClaimResolutionDisposition;
  settledMicroUsd: string; releasedMicroUsd: string; auditId: string }> {
  const actorUserId = ownerId(input.session);
  await assertRecentAdminAuthentication(input.session);
  if (!ID.test(input.resolutionRequestId)) {
    throw new AmuxIdeaAnalysisClaimResolutionError("not_resolvable");
  }
  const rows = await tx.adminAuditLog.findMany({ where: { action: ACTION,
    targetType: TARGET,
    metadata: { path: ["resolutionRequestId"], equals: input.resolutionRequestId },
  }, take: 2 });
  if (rows.length === 0) return { status: "absent" };
  const audit = rows[0]!;
  const data = record(audit.metadata);
  if (rows.length !== 1 || !audit.entryHash || auditRowActorKind(audit) !== "human" ||
      audit.actorUserId !== actorUserId || !audit.targetId || !data ||
      data.resolutionRequestId !== input.resolutionRequestId ||
      !["not_started_proven", "evidence_insufficient"].includes(
        String(data.disposition)) || typeof data.settledMicroUsd !== "string" ||
      typeof data.releasedMicroUsd !== "string") {
    throw new AmuxIdeaAnalysisClaimResolutionError("integrity_unavailable");
  }
  const hold = await tx.amuxIdeaAnalysisBudgetHold.findUnique({
    where: { id: audit.targetId }, select: { status: true, settledMicroUsd: true,
      preview: { select: { confirmedByUserId: true,
        idea: { select: { actorUserId: true } } } } },
  });
  const disposition = data.disposition as AmuxIdeaAnalysisClaimResolutionDisposition;
  const expectedStatus = disposition === "evidence_insufficient"
    ? "owner_consumed" : "owner_released_unstarted";
  if (!hold || hold.preview.confirmedByUserId !== actorUserId ||
      hold.preview.idea.actorUserId !== actorUserId || hold.status !== expectedStatus ||
      hold.settledMicroUsd?.toString() !== data.settledMicroUsd) {
    throw new AmuxIdeaAnalysisClaimResolutionError("integrity_unavailable");
  }
  return { status: "committed", holdId: audit.targetId, disposition,
    settledMicroUsd: data.settledMicroUsd, releasedMicroUsd: data.releasedMicroUsd,
    auditId: audit.id };
}

export async function commitAmuxIdeaAnalysisClaimResolution(
  tx: Prisma.TransactionClient,
  input: { session: Session; request: Request; resolutionRequestId: string;
    holdId: string; readbackDigest: string; evidenceDigest: string;
    disposition: AmuxIdeaAnalysisClaimResolutionDisposition },
): Promise<{ holdId: string; disposition: AmuxIdeaAnalysisClaimResolutionDisposition;
  settledMicroUsd: string; releasedMicroUsd: string; duplicate: boolean;
  auditId: string }> {
  const actorUserId = ownerId(input.session);
  await assertRecentAdminAuthentication(input.session);
  if (!ID.test(input.resolutionRequestId) || !ID.test(input.holdId) ||
      !DIGEST.test(input.readbackDigest) || !DIGEST.test(input.evidenceDigest) ||
      !["not_started_proven", "evidence_insufficient"].includes(input.disposition)) {
    throw new AmuxIdeaAnalysisClaimResolutionError("not_resolvable");
  }
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const prior = await tx.adminAuditLog.findMany({ where: {
    action: ACTION, targetType: TARGET,
    OR: [{ targetId: input.holdId },
      { metadata: { path: ["resolutionRequestId"], equals: input.resolutionRequestId } }],
  }, take: 2 });
  if (prior.length) {
    const audit = prior[0]!;
    const data = record(audit.metadata);
    if (prior.length !== 1 || !audit.entryHash || auditRowActorKind(audit) !== "human" ||
        audit.actorUserId !== actorUserId || audit.targetId !== input.holdId || !data ||
        data.resolutionRequestId !== input.resolutionRequestId ||
        data.readbackDigest !== input.readbackDigest ||
        data.evidenceDigest !== input.evidenceDigest ||
        data.disposition !== input.disposition ||
        typeof data.settledMicroUsd !== "string" ||
        typeof data.releasedMicroUsd !== "string") {
      throw new AmuxIdeaAnalysisClaimResolutionError("conflict");
    }
    const terminal = await tx.amuxIdeaAnalysisBudgetHold.findUnique({
      where: { id: input.holdId }, select: { status: true, settledMicroUsd: true },
    });
    const expectedStatus = input.disposition === "evidence_insufficient"
      ? "owner_consumed" : "owner_released_unstarted";
    if (!terminal || terminal.status !== expectedStatus ||
        terminal.settledMicroUsd?.toString() !== data.settledMicroUsd) {
      throw new AmuxIdeaAnalysisClaimResolutionError("integrity_unavailable");
    }
    return { holdId: input.holdId, disposition: input.disposition,
      settledMicroUsd: data.settledMicroUsd, releasedMicroUsd: data.releasedMicroUsd,
      duplicate: true, auditId: audit.id };
  }
  const identity = await tx.amuxIdeaAnalysisBudgetHold.findUnique({
    where: { id: input.holdId }, select: { previewId: true, namespace: true,
      monthStart: true, preview: { select: { ideaId: true, chunkIndex: true } } },
  });
  if (!identity || identity.namespace !== AMUX_V4_ANALYSIS_NAMESPACE) {
    throw new AmuxIdeaAnalysisClaimResolutionError("not_resolvable");
  }
  // Keep the shared claim/result lock order. Sequential awaits make the order
  // a property of the transaction, not an assumption about client scheduling.
  const locks = [
    await tx.$queryRaw`SELECT "id" FROM "AmuxIdeaSubmission" WHERE "id" = ${identity.preview.ideaId} FOR UPDATE`,
    await tx.$queryRaw`SELECT "chunkIndex" FROM "AmuxIdeaAnalysisChunk" WHERE "ideaId" = ${identity.preview.ideaId} AND "chunkIndex" = ${identity.preview.chunkIndex} FOR UPDATE`,
    await tx.$queryRaw`SELECT "id" FROM "AmuxIdeaTransferPreview" WHERE "id" = ${identity.previewId} FOR UPDATE`,
    await tx.$queryRaw`SELECT "namespace" FROM "AmuxIdeaAnalysisBudgetWindow" WHERE "namespace" = ${identity.namespace} AND "monthStart" = ${identity.monthStart} FOR UPDATE`,
    await tx.$queryRaw`SELECT "id" FROM "AmuxIdeaAnalysisBudgetHold" WHERE "id" = ${input.holdId} FOR UPDATE`,
  ];
  if (locks.some((rows) => !Array.isArray(rows) || rows.length !== 1)) {
    throw new AmuxIdeaAnalysisClaimResolutionError("integrity_unavailable");
  }
  const snapshot = await readActiveSnapshot(tx, actorUserId, input.holdId);
  if (amuxIdeaAnalysisClaimReadbackDigest(snapshot) !== input.readbackDigest) {
    throw new AmuxIdeaAnalysisClaimResolutionError("conflict");
  }
  if (input.disposition === "not_started_proven" &&
      !snapshot.zeroReleaseEligible) {
    throw new AmuxIdeaAnalysisClaimResolutionError("not_resolvable");
  }
  const hold = await tx.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({
    where: { id: input.holdId },
  });
  const window = await tx.amuxIdeaAnalysisBudgetWindow.findUnique({ where: {
    namespace_monthStart: { namespace: hold.namespace, monthStart: hold.monthStart },
  } });
  if (!window || window.reservedMicroUsd < hold.reservedMicroUsd) {
    throw new AmuxIdeaAnalysisClaimResolutionError("integrity_unavailable");
  }
  const settled = input.disposition === "evidence_insufficient"
    ? hold.reservedMicroUsd : BigInt(0);
  const released = hold.reservedMicroUsd - settled;
  const auditId = await writeAdminAuditLog({
    tx, session: input.session, request: input.request,
    action: ACTION, targetType: TARGET, targetId: hold.id,
    summary: input.disposition === "not_started_proven"
      ? "Owner closed one AMUX analysis claim after read-back proved the CLI did not start."
      : "Owner closed one AMUX analysis claim at its full reservation because execution evidence was insufficient.",
    metadata: { resolutionRequestId: input.resolutionRequestId,
      readbackDigest: input.readbackDigest, evidenceDigest: input.evidenceDigest,
      disposition: input.disposition, previewId: snapshot.previewId,
      ideaId: snapshot.ideaId, chunkIndex: snapshot.chunkIndex,
      ideaState: snapshot.ideaState,
      ideaCancelledAt: snapshot.ideaCancelledAt,
      claimRequestId: snapshot.claimRequestId,
      resultRequestId: snapshot.resultRequestId,
      resultOutcome: snapshot.resultOutcome,
      resultEffectiveOutcome: snapshot.resultEffectiveOutcome,
      resultFailureReason: snapshot.resultFailureReason,
      zeroReleaseEligible: snapshot.zeroReleaseEligible,
      reservedMicroUsd: snapshot.reservedMicroUsd,
      settledMicroUsd: settled.toString(), releasedMicroUsd: released.toString(),
      retryAutomatically: false, userCreditLedgerTouched: false },
  });
  const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = nowRows[0]?.now;
  if (!(now instanceof Date) || now < hold.dispatchedAt!) {
    throw new AmuxIdeaAnalysisClaimResolutionError("integrity_unavailable");
  }
  const windowUpdated = await tx.amuxIdeaAnalysisBudgetWindow.updateMany({
    where: { namespace: hold.namespace, monthStart: hold.monthStart,
      reservedMicroUsd: window.reservedMicroUsd },
    data: { reservedMicroUsd: { decrement: hold.reservedMicroUsd },
      ...(settled > BigInt(0) ? { spentMicroUsd: { increment: settled } } : {}) },
  });
  const holdUpdated = await tx.amuxIdeaAnalysisBudgetHold.updateMany({ where: {
    id: hold.id, status: snapshot.holdStatus, dispatchedAt: hold.dispatchedAt,
    closedAt: null, settledMicroUsd: null,
  }, data: { status: input.disposition === "evidence_insufficient"
      ? "owner_consumed" : "owner_released_unstarted",
    settledMicroUsd: settled, closedAt: now } });
  if ([windowUpdated.count, holdUpdated.count].some((count) => count !== 1)) {
    throw new AmuxIdeaAnalysisClaimResolutionError("integrity_unavailable");
  }
  if (snapshot.ideaState === "analyzing") {
    const previewUpdated = await tx.amuxIdeaTransferPreview.updateMany({ where: {
      id: snapshot.previewId, state: snapshot.holdStatus,
    }, data: { state: "owner_resolved" } });
    const chunkUpdated = await tx.amuxIdeaAnalysisChunk.updateMany({ where: {
      ideaId: snapshot.ideaId, chunkIndex: snapshot.chunkIndex,
      currentPreviewId: snapshot.previewId, state: snapshot.holdStatus,
      leaseGeneration: 1,
    }, data: { state: "awaiting_preview", leaseGeneration: 0 } });
    const ideaUpdated = snapshot.chunkIndex === 0
      ? await tx.amuxIdeaSubmission.updateMany({ where: { id: snapshot.ideaId,
          state: "analyzing", cancelledAt: null, analysisCompletedAt: null },
        data: { state: "submitted" } })
      : { count: 1 };
    if ([previewUpdated.count, chunkUpdated.count, ideaUpdated.count]
        .some((count) => count !== 1)) {
      throw new AmuxIdeaAnalysisClaimResolutionError("integrity_unavailable");
    }
  }
  return { holdId: hold.id, disposition: input.disposition,
    settledMicroUsd: settled.toString(), releasedMicroUsd: released.toString(),
    duplicate: false, auditId };
}
