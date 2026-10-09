import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_V4_ANALYSIS_BUDGET_EXPIRE_ACTION,
  AMUX_V4_ANALYSIS_BUDGET_EXPIRE_TARGET,
  AMUX_V4_IDEA_SYSTEM_ACTOR } from "@/lib/adminAuditSystemActors";
import { AMUX_V4_ANALYSIS_NAMESPACE } from "./ideaAnalysisBudgetCore.ts";
import { AmuxIdeaAnalysisCancellationError } from "./ideaAnalysisBudgetCancellationService.ts";

const ID = /^[A-Za-z0-9:_-]{1,128}$/;

/** Dark transaction body for a retention tick. Expiry frees only an unused
 * reservation; it neither cancels the idea nor deletes text. The eventual
 * scheduler must read back an uncertain commit instead of retrying blindly. */
export async function commitAmuxExpiredIdeaAnalysisReservationRelease(
  tx: Prisma.TransactionClient, holdId: string,
): Promise<{ holdId: string; releasedMicroUsd: string; auditId: string }> {
  if (!ID.test(holdId)) throw new AmuxIdeaAnalysisCancellationError("not_cancellable");
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const identity = await tx.amuxIdeaAnalysisBudgetHold.findUnique({
    where: { id: holdId }, select: { previewId: true, namespace: true, monthStart: true },
  });
  if (!identity || identity.namespace !== AMUX_V4_ANALYSIS_NAMESPACE) {
    throw new AmuxIdeaAnalysisCancellationError("not_cancellable");
  }
  // Match the owner-cancellation lock order so a concurrent owner decision
  // cannot release the same reservation twice or invert window/hold locks.
  const previewLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaTransferPreview"
    WHERE "id" = ${identity.previewId} FOR UPDATE
  `;
  const windowLock = await tx.$queryRaw<Array<{ reservedMicroUsd: bigint }>>`
    SELECT "reservedMicroUsd" FROM "AmuxIdeaAnalysisBudgetWindow"
    WHERE "namespace" = ${identity.namespace}
      AND "monthStart" = ${identity.monthStart} FOR UPDATE
  `;
  const holdLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaAnalysisBudgetHold"
    WHERE "id" = ${holdId} FOR UPDATE
  `;
  if (previewLock.length !== 1 || windowLock.length !== 1 || holdLock.length !== 1) {
    throw new AmuxIdeaAnalysisCancellationError("integrity_unavailable");
  }
  const hold = await tx.amuxIdeaAnalysisBudgetHold.findUnique({ where: { id: holdId } });
  const preview = await tx.amuxIdeaTransferPreview.findUnique({
    where: { id: identity.previewId },
    select: { id: true, state: true, expiresAt: true, consumedAt: true,
      outcomeUnknownAt: true },
  });
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = clock[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !hold || !preview || hold.previewId !== preview.id ||
      hold.namespace !== identity.namespace ||
      hold.monthStart.getTime() !== identity.monthStart.getTime()) {
    throw new AmuxIdeaAnalysisCancellationError("integrity_unavailable");
  }
  if (now < preview.expiresAt || now < hold.createdAt ||
      hold.status !== "reserved" || hold.dispatchedAt !== null ||
      hold.closedAt !== null || hold.settledMicroUsd !== null ||
      !["confirmed", "expired", "owner_rejected"].includes(preview.state) ||
      preview.consumedAt !== null || preview.outcomeUnknownAt !== null) {
    throw new AmuxIdeaAnalysisCancellationError("not_cancellable");
  }
  if (hold.reservedMicroUsd <= BigInt(0) ||
      windowLock[0]!.reservedMicroUsd < hold.reservedMicroUsd) {
    throw new AmuxIdeaAnalysisCancellationError("integrity_unavailable");
  }
  const auditId = await writeSystemAuditLog({
    tx, systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
    action: AMUX_V4_ANALYSIS_BUDGET_EXPIRE_ACTION,
    targetType: AMUX_V4_ANALYSIS_BUDGET_EXPIRE_TARGET,
    targetId: holdId,
    summary: "Released an expired, unused AMUX v4 analysis cost reservation; no model was called.",
    metadata: { namespace: hold.namespace, monthStart: hold.monthStart.toISOString(),
      previewId: preview.id, releasedMicroUsd: hold.reservedMicroUsd.toString(),
      modelCallStarted: false },
  });
  const window = await tx.amuxIdeaAnalysisBudgetWindow.updateMany({
    where: { namespace: hold.namespace, monthStart: hold.monthStart,
      reservedMicroUsd: windowLock[0]!.reservedMicroUsd },
    data: { reservedMicroUsd: { decrement: hold.reservedMicroUsd } },
  });
  const released = await tx.amuxIdeaAnalysisBudgetHold.updateMany({
    where: { id: holdId, status: "reserved", dispatchedAt: null,
      closedAt: null, settledMicroUsd: null },
    data: { status: "released", settledMicroUsd: BigInt(0), closedAt: now },
  });
  if (window.count !== 1 || released.count !== 1) {
    throw new AmuxIdeaAnalysisCancellationError("integrity_unavailable");
  }
  return { holdId, releasedMicroUsd: hold.reservedMicroUsd.toString(), auditId };
}
