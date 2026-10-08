import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { AMUX_V4_ANALYSIS_NAMESPACE } from "./ideaAnalysisBudgetCore.ts";

/** Dark transaction body. A reserved hold may be cancelled before dispatch;
 * in-flight or unknown outcomes must retain their full reservation. There is
 * no route to this writer and it cannot authorize an Agent call. Dispatch
 * must require a reserved hold, never only an unconsumed confirmed preview. */
const ID = /^[A-Za-z0-9:_-]{1,128}$/;

export class AmuxIdeaAnalysisCancellationError extends Error {
  constructor(readonly code: "forbidden" | "not_cancellable" | "integrity_unavailable") {
    super(code);
    this.name = "AmuxIdeaAnalysisCancellationError";
  }
}

export async function commitAmuxIdeaAnalysisUnusedReservationCancellation(
  tx: Prisma.TransactionClient,
  input: { session: Session; request: Request; holdId: string },
): Promise<{ holdId: string; releasedMicroUsd: string; auditId: string }> {
  const actorUserId = input.session.user?.id;
  if (!actorUserId || !isAdminSession(input.session) ||
      getAdminRole(input.session) !== "owner") {
    throw new AmuxIdeaAnalysisCancellationError("forbidden");
  }
  await assertRecentAdminAuthentication(input.session);
  if (!ID.test(input.holdId)) {
    throw new AmuxIdeaAnalysisCancellationError("not_cancellable");
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
  if (!identity || identity.namespace !== AMUX_V4_ANALYSIS_NAMESPACE) {
    throw new AmuxIdeaAnalysisCancellationError("not_cancellable");
  }
  // Preserve the reservation/dispatch lock order: preview, budget window,
  // then hold. A future dispatcher must take these locks in the same order.
  const previewLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaTransferPreview"
    WHERE "id" = ${identity.previewId} FOR UPDATE
  `;
  if (previewLock.length !== 1) {
    throw new AmuxIdeaAnalysisCancellationError("integrity_unavailable");
  }
  const windowLock = await tx.$queryRaw<Array<{ reservedMicroUsd: bigint }>>`
    SELECT "reservedMicroUsd" FROM "AmuxIdeaAnalysisBudgetWindow"
    WHERE "namespace" = ${identity.namespace}
      AND "monthStart" = ${identity.monthStart} FOR UPDATE
  `;
  const holdLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaAnalysisBudgetHold"
    WHERE "id" = ${input.holdId} FOR UPDATE
  `;
  if (windowLock.length !== 1 || holdLock.length !== 1) {
    throw new AmuxIdeaAnalysisCancellationError("integrity_unavailable");
  }
  const hold = await tx.amuxIdeaAnalysisBudgetHold.findUnique({
    where: { id: input.holdId },
  });
  const preview = await tx.amuxIdeaTransferPreview.findUnique({
    where: { id: identity.previewId },
    select: { state: true, consumedAt: true, outcomeUnknownAt: true },
  });
  if (!hold || hold.previewId !== identity.previewId ||
      hold.namespace !== identity.namespace ||
      hold.monthStart.getTime() !== identity.monthStart.getTime() ||
      hold.status !== "reserved" || hold.dispatchedAt !== null ||
      hold.closedAt !== null || hold.settledMicroUsd !== null ||
      !preview || !["confirmed", "expired", "owner_rejected"].includes(preview.state) ||
      preview.consumedAt !== null || preview.outcomeUnknownAt !== null) {
    throw new AmuxIdeaAnalysisCancellationError("not_cancellable");
  }
  if (hold.reservedMicroUsd <= BigInt(0) ||
      windowLock[0]!.reservedMicroUsd < hold.reservedMicroUsd) {
    throw new AmuxIdeaAnalysisCancellationError("integrity_unavailable");
  }
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = clock[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      now < hold.createdAt) {
    throw new AmuxIdeaAnalysisCancellationError("integrity_unavailable");
  }
  const auditId = await writeAdminAuditLog({
    tx, session: input.session, request: input.request,
    action: "amux.v4.analysis_budget.unused_reservation_cancelled",
    targetType: "AmuxIdeaAnalysisBudgetHold", targetId: hold.id,
    summary: "Owner cancelled one unused AMUX analysis budget reservation before dispatch.",
    metadata: { namespace: hold.namespace,
      monthStart: hold.monthStart.toISOString(), previewId: hold.previewId,
      releasedMicroUsd: hold.reservedMicroUsd.toString(),
      modelCallStarted: false },
  });
  const window = await tx.amuxIdeaAnalysisBudgetWindow.updateMany({
    where: { namespace: hold.namespace, monthStart: hold.monthStart,
      reservedMicroUsd: windowLock[0]!.reservedMicroUsd },
    data: { reservedMicroUsd: { decrement: hold.reservedMicroUsd } },
  });
  const cancelled = await tx.amuxIdeaAnalysisBudgetHold.updateMany({
    where: { id: hold.id, status: "reserved", dispatchedAt: null,
      closedAt: null, settledMicroUsd: null },
    data: { status: "released", settledMicroUsd: BigInt(0), closedAt: now },
  });
  if (window.count !== 1 || cancelled.count !== 1) {
    throw new AmuxIdeaAnalysisCancellationError("integrity_unavailable");
  }
  return { holdId: hold.id, releasedMicroUsd: hold.reservedMicroUsd.toString(), auditId };
}
