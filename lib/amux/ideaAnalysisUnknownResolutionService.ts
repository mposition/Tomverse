import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { AMUX_V4_ANALYSIS_NAMESPACE } from "./ideaAnalysisBudgetCore.ts";

const ID = /^[A-Za-z0-9:_-]{1,128}$/;
const RUNNER_DEADLINE_MS = 11 * 60_000;

export class AmuxIdeaAnalysisUnknownResolutionError extends Error {
  constructor(readonly code: "forbidden" | "not_resolvable" | "integrity_unavailable") {
    super(code);
    this.name = "AmuxIdeaAnalysisUnknownResolutionError";
  }
}

/** An owner may close only a verified-unknown, already-fenced invocation.
 * Spending the entire reservation is deliberately conservative: an unknown
 * provider bill must never be booked as zero or freed for another call. */
export async function commitAmuxIdeaAnalysisUnknownResolution(
  tx: Prisma.TransactionClient,
  input: { session: Session; request: Request; holdId: string; previewId: string;
    runnerStopped: true; readBackChecked: true },
): Promise<{ holdId: string; previewId: string; consumedMicroUsd: string;
  auditId: string }> {
  const actorUserId = input.session.user?.id;
  if (!actorUserId || !isAdminSession(input.session) ||
      getAdminRole(input.session) !== "owner") {
    throw new AmuxIdeaAnalysisUnknownResolutionError("forbidden");
  }
  await assertRecentAdminAuthentication(input.session);
  if (!ID.test(input.holdId) || !ID.test(input.previewId) ||
      input.runnerStopped !== true || input.readBackChecked !== true) {
    throw new AmuxIdeaAnalysisUnknownResolutionError("not_resolvable");
  }
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const identity = await tx.amuxIdeaAnalysisBudgetHold.findUnique({
    where: { id: input.holdId },
    select: { previewId: true, namespace: true, monthStart: true },
  });
  if (!identity || identity.namespace !== AMUX_V4_ANALYSIS_NAMESPACE ||
      identity.previewId !== input.previewId) {
    throw new AmuxIdeaAnalysisUnknownResolutionError("not_resolvable");
  }
  const previewIdentity = await tx.amuxIdeaTransferPreview.findUnique({
    where: { id: input.previewId }, select: { ideaId: true, chunkIndex: true },
  });
  if (!previewIdentity) throw new AmuxIdeaAnalysisUnknownResolutionError("not_resolvable");
  // The result writer pre-locks idea -> chunk -> preview -> window -> hold.
  // Follow that full order, not only the budget writer's lock subset.
  const ideaLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaSubmission"
    WHERE "id" = ${previewIdentity.ideaId} FOR UPDATE
  `;
  const chunkLock = await tx.$queryRaw<Array<{ chunkIndex: number }>>`
    SELECT "chunkIndex" FROM "AmuxIdeaAnalysisChunk"
    WHERE "ideaId" = ${previewIdentity.ideaId}
      AND "chunkIndex" = ${previewIdentity.chunkIndex} FOR UPDATE
  `;
  const previewLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaTransferPreview"
    WHERE "id" = ${input.previewId} FOR UPDATE
  `;
  const windowLock = await tx.$queryRaw<Array<{
    spentMicroUsd: bigint; reservedMicroUsd: bigint }>>`
    SELECT "spentMicroUsd", "reservedMicroUsd" FROM "AmuxIdeaAnalysisBudgetWindow"
    WHERE "namespace" = ${identity.namespace}
      AND "monthStart" = ${identity.monthStart} FOR UPDATE
  `;
  const holdLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaAnalysisBudgetHold"
    WHERE "id" = ${input.holdId} FOR UPDATE
  `;
  if (ideaLock.length !== 1 || chunkLock.length !== 1 ||
      previewLock.length !== 1 || windowLock.length !== 1 || holdLock.length !== 1) {
    throw new AmuxIdeaAnalysisUnknownResolutionError("integrity_unavailable");
  }
  const preview = await tx.amuxIdeaTransferPreview.findUnique({
    where: { id: input.previewId },
  });
  const hold = await tx.amuxIdeaAnalysisBudgetHold.findUnique({
    where: { id: input.holdId },
  });
  if (!preview || !hold || preview.ideaId === "" ||
      preview.ideaId !== previewIdentity.ideaId ||
      preview.chunkIndex !== previewIdentity.chunkIndex ||
      !["outcome_unknown", "in_flight"].includes(preview.state) ||
      preview.consumedAt === null ||
      hold.status !== preview.state || hold.dispatchedAt === null ||
      hold.closedAt !== null || hold.settledMicroUsd !== null ||
      hold.inputTokens !== null || hold.outputTokens !== null ||
      hold.previewId !== preview.id || hold.namespace !== identity.namespace ||
      hold.monthStart.getTime() !== identity.monthStart.getTime()) {
    throw new AmuxIdeaAnalysisUnknownResolutionError("not_resolvable");
  }
  if ((preview.state === "outcome_unknown") !==
      (preview.outcomeUnknownAt !== null)) {
    throw new AmuxIdeaAnalysisUnknownResolutionError("integrity_unavailable");
  }
  const chunk = await tx.amuxIdeaAnalysisChunk.findUnique({
    where: { ideaId_chunkIndex: { ideaId: preview.ideaId,
      chunkIndex: preview.chunkIndex } },
  });
  const idea = await tx.amuxIdeaSubmission.findUnique({ where: { id: preview.ideaId } });
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = clock[0]?.now;
  if (!chunk || !idea ||
      !(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      now.getTime() < hold.dispatchedAt.getTime() + RUNNER_DEADLINE_MS ||
      (preview.outcomeUnknownAt !== null && now < preview.outcomeUnknownAt) ||
      preview.confirmedByUserId !== actorUserId ||
      idea.actorUserId !== actorUserId ||
      chunk.state !== preview.state ||
      chunk.currentPreviewId !== preview.id ||
      chunk.leaseGeneration !== 1 ||
      windowLock[0]!.reservedMicroUsd < hold.reservedMicroUsd ||
      hold.reservedMicroUsd <= BigInt(0)) {
    throw new AmuxIdeaAnalysisUnknownResolutionError("not_resolvable");
  }
  const auditId = await writeAdminAuditLog({
    tx, session: input.session, request: input.request,
    action: "amux.v4.analysis_budget.unknown_owner_consumed",
    targetType: "AmuxIdeaAnalysisBudgetHold", targetId: hold.id,
    summary: "Owner reconciled an unknown AMUX analysis outcome at the full reserved Agent-cost ceiling.",
    metadata: { namespace: hold.namespace, previewId: preview.id,
      ideaId: idea.id, chunkIndex: chunk.chunkIndex,
      consumedMicroUsd: hold.reservedMicroUsd.toString(),
      previousStatus: hold.status,
      runnerStopped: true, readBackChecked: true, retryAutomatically: false },
  });
  const window = await tx.amuxIdeaAnalysisBudgetWindow.updateMany({
    where: { namespace: identity.namespace, monthStart: identity.monthStart,
      spentMicroUsd: windowLock[0]!.spentMicroUsd,
      reservedMicroUsd: windowLock[0]!.reservedMicroUsd },
    data: { spentMicroUsd: { increment: hold.reservedMicroUsd },
      reservedMicroUsd: { decrement: hold.reservedMicroUsd } },
  });
  const closed = await tx.amuxIdeaAnalysisBudgetHold.updateMany({
    where: { id: hold.id, status: hold.status, closedAt: null,
      settledMicroUsd: null, inputTokens: null, outputTokens: null },
    data: { status: "owner_consumed", settledMicroUsd: hold.reservedMicroUsd,
      closedAt: now },
  });
  const rejected = await tx.amuxIdeaTransferPreview.updateMany({
    where: { id: preview.id, state: preview.state,
      consumedAt: { not: null } },
    data: { state: "owner_rejected",
      outcomeUnknownAt: preview.outcomeUnknownAt ?? now },
  });
  const nextChunkState = idea.cancelledAt !== null || idea.state === "cancelled"
    ? "cancelled" : now >= idea.analysisDeadlineAt ? "expired" : "awaiting_preview";
  const resetChunk = await tx.amuxIdeaAnalysisChunk.updateMany({
    where: { ideaId: idea.id, chunkIndex: chunk.chunkIndex,
      state: preview.state, currentPreviewId: preview.id,
      leaseGeneration: 1 },
    data: { state: nextChunkState, leaseGeneration: 0 },
  });
  const resetIdea = nextChunkState === "awaiting_preview" &&
    chunk.chunkIndex === 0 && idea.state === "analyzing" &&
    idea.analysisCompletedAt === null && idea.cancelledAt === null
    ? await tx.amuxIdeaSubmission.updateMany({
      where: { id: idea.id, state: "analyzing", analysisCompletedAt: null,
        cancelledAt: null }, data: { state: "submitted" },
    }) : { count: 1 };
  if ([window, closed, rejected, resetChunk, resetIdea].some((row) => row.count !== 1)) {
    throw new AmuxIdeaAnalysisUnknownResolutionError("integrity_unavailable");
  }
  return { holdId: hold.id, previewId: preview.id,
    consumedMicroUsd: hold.reservedMicroUsd.toString(), auditId };
}
