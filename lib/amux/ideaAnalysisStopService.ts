import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { auditRowActorKind } from "@/lib/adminAuditSystemActors";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { AMUX_V4_ANALYSIS_NAMESPACE } from "./ideaAnalysisBudgetCore.ts";
import { AmuxIdeaAnalysisUnknownOutcomeError,
  commitAmuxIdeaAnalysisUnknownOutcome } from
  "./ideaAnalysisUnknownOutcomeService.ts";

const ID = /^[A-Za-z0-9:_-]{1,128}$/;
export const AMUX_V19_ANALYSIS_STOP_ACTION = "amux.v19.analysis.owner_stopped";
export const AMUX_V19_ANALYSIS_STOP_TARGET = "AmuxIdeaAnalysisBudgetHold";

export class AmuxIdeaAnalysisStopError extends Error {
  constructor(readonly code: "forbidden" | "not_stoppable" |
    "conflict" | "integrity_unavailable") {
    super(code);
    this.name = "AmuxIdeaAnalysisStopError";
  }
}

function ownerId(session: Session): string {
  const id = session.user?.id;
  if (!id || !isAdminSession(session) || getAdminRole(session) !== "owner") {
    throw new AmuxIdeaAnalysisStopError("forbidden");
  }
  return id;
}

function metadata(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Read-back for an uncertain HTTP response. Absence is not permission to
 * resend the stop; an earlier transaction may still be committing. */
export async function readAmuxIdeaAnalysisStopReceipt(
  tx: Prisma.TransactionClient,
  input: { session: Session; stopRequestId: string },
): Promise<{ status: "absent" } | { status: "committed"; holdId: string;
  previewId: string; ideaId: string; auditId: string }> {
  const actorUserId = ownerId(input.session);
  await assertRecentAdminAuthentication(input.session);
  if (!ID.test(input.stopRequestId)) {
    throw new AmuxIdeaAnalysisStopError("not_stoppable");
  }
  const rows = await tx.adminAuditLog.findMany({ where: {
    action: AMUX_V19_ANALYSIS_STOP_ACTION,
    targetType: AMUX_V19_ANALYSIS_STOP_TARGET,
    metadata: { path: ["stopRequestId"], equals: input.stopRequestId },
  }, take: 2 });
  if (rows.length === 0) return { status: "absent" };
  const audit = rows[0]!;
  const data = metadata(audit.metadata);
  if (rows.length !== 1 || !audit.entryHash ||
      auditRowActorKind(audit) !== "human" ||
      audit.actorUserId !== actorUserId || !audit.targetId || !data ||
      data.stopRequestId !== input.stopRequestId ||
      typeof data.previewId !== "string" || !ID.test(data.previewId) ||
      typeof data.ideaId !== "string" || !ID.test(data.ideaId) ||
      data.retryAutomatically !== false) {
    throw new AmuxIdeaAnalysisStopError("integrity_unavailable");
  }
  const [hold, preview, chunk, resolutions] = await Promise.all([
    tx.amuxIdeaAnalysisBudgetHold.findUnique({ where: { id: audit.targetId } }),
    tx.amuxIdeaTransferPreview.findUnique({ where: { id: data.previewId } }),
    tx.amuxIdeaAnalysisChunk.findFirst({ where: {
      ideaId: data.ideaId, currentPreviewId: data.previewId } }),
    tx.adminAuditLog.findMany({ where: {
      action: "amux.v4.analysis_claim.owner_resolved",
      targetType: AMUX_V19_ANALYSIS_STOP_TARGET, targetId: audit.targetId,
    }, take: 2 }),
  ]);
  const resolution = resolutions[0];
  const resolutionData = resolution && metadata(resolution.metadata);
  const unresolved = hold?.status === "outcome_unknown" &&
    preview?.state === "outcome_unknown" && chunk?.state === "outcome_unknown" &&
    resolutions.length === 0;
  const settled = hold?.status === "owner_consumed" &&
    hold.closedAt !== null && hold.settledMicroUsd === hold.reservedMicroUsd &&
    resolutions.length === 1 && resolution?.entryHash &&
    auditRowActorKind(resolution) === "human" &&
    resolution.actorUserId === actorUserId && resolutionData &&
    resolutionData.disposition === "evidence_insufficient" &&
    resolutionData.previewId === data.previewId &&
    resolutionData.ideaId === data.ideaId &&
    resolutionData.settledMicroUsd === hold.reservedMicroUsd.toString() &&
    resolutionData.zeroReleaseEligible === false;
  if (!hold || !preview || !chunk || hold.previewId !== preview.id ||
      preview.ideaId !== data.ideaId || (!unresolved && !settled)) {
    throw new AmuxIdeaAnalysisStopError("integrity_unavailable");
  }
  return { status: "committed", holdId: hold.id, previewId: preview.id,
    ideaId: data.ideaId, auditId: audit.id };
}

/** One human stop atomically fences the in-flight result and keeps its full
 * Agent-cost reservation for later read-back. The Ubuntu worker must observe
 * this fence and kill its child in a separate, still-default-off slice. */
export async function commitAmuxIdeaAnalysisStop(
  tx: Prisma.TransactionClient,
  input: { session: Session; request: Request; stopRequestId: string;
    holdId: string; ownerConfirmed: true },
): Promise<{ holdId: string; previewId: string; ideaId: string;
  auditId: string }> {
  const actorUserId = ownerId(input.session);
  await assertRecentAdminAuthentication(input.session);
  if (!ID.test(input.stopRequestId) || !ID.test(input.holdId) ||
      input.ownerConfirmed !== true) {
    throw new AmuxIdeaAnalysisStopError("not_stoppable");
  }
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const prior = await tx.adminAuditLog.findMany({ where: {
    action: AMUX_V19_ANALYSIS_STOP_ACTION,
    targetType: AMUX_V19_ANALYSIS_STOP_TARGET,
    OR: [{ targetId: input.holdId },
      { metadata: { path: ["stopRequestId"], equals: input.stopRequestId } }],
  }, take: 2 });
  if (prior.length) throw new AmuxIdeaAnalysisStopError("conflict");

  const hold = await tx.amuxIdeaAnalysisBudgetHold.findUnique({
    where: { id: input.holdId }, select: { previewId: true, namespace: true },
  });
  const preview = hold && await tx.amuxIdeaTransferPreview.findUnique({
    where: { id: hold.previewId }, select: { id: true, ideaId: true,
      chunkIndex: true, confirmedByUserId: true },
  });
  if (!hold || hold.namespace !== AMUX_V4_ANALYSIS_NAMESPACE || !preview ||
      preview.confirmedByUserId !== actorUserId) {
    throw new AmuxIdeaAnalysisStopError("not_stoppable");
  }
  // Match the result writer's row-lock order: idea, chunk, preview, window,
  // hold. The shared unknown-outcome writer takes the last three.
  const ideaLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaSubmission"
    WHERE "id" = ${preview.ideaId} FOR UPDATE
  `;
  const chunkLock = await tx.$queryRaw<Array<{ state: string;
    currentPreviewId: string | null; leaseGeneration: number }>>`
    SELECT "state", "currentPreviewId", "leaseGeneration"
    FROM "AmuxIdeaAnalysisChunk"
    WHERE "ideaId" = ${preview.ideaId}
      AND "chunkIndex" = ${preview.chunkIndex} FOR UPDATE
  `;
  const idea = await tx.amuxIdeaSubmission.findUnique({
    where: { id: preview.ideaId }, select: { actorUserId: true,
      state: true, cancelledAt: true, analysisCompletedAt: true },
  });
  if (ideaLock.length !== 1 || chunkLock.length !== 1 || !idea ||
      idea.actorUserId !== actorUserId || idea.state !== "analyzing" ||
      idea.cancelledAt !== null || idea.analysisCompletedAt !== null ||
      chunkLock[0]!.state !== "in_flight" ||
      chunkLock[0]!.currentPreviewId !== preview.id ||
      chunkLock[0]!.leaseGeneration !== 1) {
    throw new AmuxIdeaAnalysisStopError("not_stoppable");
  }
  const auditId = await writeAdminAuditLog({ tx,
    session: input.session, request: input.request,
    action: AMUX_V19_ANALYSIS_STOP_ACTION,
    targetType: AMUX_V19_ANALYSIS_STOP_TARGET, targetId: input.holdId,
    summary: "Owner stopped one in-flight AMUX intake analysis.",
    metadata: { stopRequestId: input.stopRequestId,
      previewId: preview.id, ideaId: preview.ideaId,
      chunkIndex: preview.chunkIndex, retryAutomatically: false,
      userCreditLedgerTouched: false },
  });
  try {
    await commitAmuxIdeaAnalysisUnknownOutcome(tx,
      { holdId: input.holdId, reason: "invocation_unverified" });
  } catch (error) {
    if (error instanceof AmuxIdeaAnalysisUnknownOutcomeError) {
      throw new AmuxIdeaAnalysisStopError(error.code === "not_markable"
        ? "not_stoppable" : "integrity_unavailable");
    }
    throw error;
  }
  const stopped = await tx.amuxIdeaAnalysisChunk.updateMany({ where: {
    ideaId: preview.ideaId, chunkIndex: preview.chunkIndex,
    currentPreviewId: preview.id, state: "in_flight", leaseGeneration: 1,
  }, data: { state: "outcome_unknown" } });
  if (stopped.count !== 1) {
    throw new AmuxIdeaAnalysisStopError("integrity_unavailable");
  }
  return { holdId: input.holdId, previewId: preview.id,
    ideaId: preview.ideaId, auditId };
}
