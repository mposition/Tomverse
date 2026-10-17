import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ACTION = "amux.idea.session_cancelled_before_analysis";

export class AmuxIdeaSessionCancellationError extends Error {
  constructor(readonly code: "forbidden" | "not_found" | "not_cancellable" | "integrity_unavailable") {
    super(code);
    this.name = "AmuxIdeaSessionCancellationError";
  }
}

/** The append-only queue receipt remains evidence. Changing the locked idea
 * state removes it from queue polling without rewriting that receipt. */
export async function commitAmuxIdeaSessionCancellation(
  tx: Prisma.TransactionClient,
  input: { session: Session; request: Request; ideaId: string; ownerConfirmed: true },
): Promise<{ ideaId: string; cancelledAt: string; auditId: string }> {
  const actorId = input.session.user?.id;
  if (!actorId || !isAdminSession(input.session) || getAdminRole(input.session) !== "owner") {
    throw new AmuxIdeaSessionCancellationError("forbidden");
  }
  await assertRecentAdminAuthentication(input.session);
  if (!UUID.test(input.ideaId) || input.ownerConfirmed !== true) {
    throw new AmuxIdeaSessionCancellationError("not_cancellable");
  }
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true),
           set_config('idle_in_transaction_session_timeout', '10000', true)
  `;
  await takeAuditChainLock(tx);
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaSubmission" WHERE "id" = ${input.ideaId} FOR UPDATE
  `;
  if (locked.length !== 1) throw new AmuxIdeaSessionCancellationError("not_found");
  const idea = await tx.amuxIdeaSubmission.findUnique({
    where: { id: input.ideaId },
    select: { id: true, actorUserId: true, requestId: true, submissionOrigin: true,
      state: true, cancelledAt: true, analysisCompletedAt: true,
      analysisDeadlineAt: true, rawPurgeAfter: true, rawPurgedAt: true,
      currentSourcePlanRevisionId: true,
      sessionAnalysisReservation: { select: { id: true, status: true } },
      _count: { select: { chunks: true, previews: true } } },
  });
  if (!idea || idea.actorUserId !== actorId || idea.submissionOrigin !== "session") {
    throw new AmuxIdeaSessionCancellationError("not_found");
  }
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = clock[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !(idea.analysisDeadlineAt instanceof Date) || !(idea.rawPurgeAfter instanceof Date)) {
    throw new AmuxIdeaSessionCancellationError("integrity_unavailable");
  }
  if (idea.state !== "submitted" || idea.cancelledAt !== null ||
      idea.analysisCompletedAt !== null || idea.rawPurgedAt !== null ||
      idea.currentSourcePlanRevisionId !== null ||
      idea._count.chunks !== 0 || idea._count.previews !== 0 ||
      idea.sessionAnalysisReservation?.status !== "queued" ||
      now >= idea.analysisDeadlineAt) {
    throw new AmuxIdeaSessionCancellationError("not_cancellable");
  }
  const auditId = await writeAdminAuditLog({ tx, session: input.session,
    request: input.request, action: ACTION, targetType: "AmuxIdeaSubmission",
    targetId: idea.id,
    summary: "Owner cancelled one queued AMUX session idea before analysis began.",
    metadata: { policyVersion: 19, requestId: idea.requestId,
      reservationId: idea.sessionAnalysisReservation.id,
      cancelledAt: now.toISOString() } });
  // The existing raw-purge worker now sees this terminal idea as due. Its
  // ciphertext and external content key are retired by the normal path.
  const updated = await tx.amuxIdeaSubmission.updateMany({
    where: { id: idea.id, actorUserId: actorId, submissionOrigin: "session",
      state: "submitted", cancelledAt: null, analysisCompletedAt: null,
      rawPurgedAt: null },
    data: { state: "cancelled", cancelledAt: now, rawPurgeAfter: now },
  });
  if (updated.count !== 1) {
    throw new AmuxIdeaSessionCancellationError("integrity_unavailable");
  }
  return { ideaId: idea.id, cancelledAt: now.toISOString(), auditId };
}

/** Read-only reconciliation after an uncertain COMMIT. Absence is not an
 * instruction to repeat the cancellation request. */
export async function readAmuxIdeaSessionCancellationReceipt(
  tx: Prisma.TransactionClient, session: Session, ideaId: string,
): Promise<{ state: "cancelled"; ideaId: string; cancelledAt: string;
  auditId: string; retryWrite: false } | { state: "not_visible"; retryWrite: false }> {
  const actorId = session.user?.id;
  if (!actorId || !isAdminSession(session) || getAdminRole(session) !== "owner") {
    throw new AmuxIdeaSessionCancellationError("forbidden");
  }
  await assertRecentAdminAuthentication(session);
  if (!UUID.test(ideaId)) throw new AmuxIdeaSessionCancellationError("not_found");
  const idea = await tx.amuxIdeaSubmission.findUnique({ where: { id: ideaId },
    select: { actorUserId: true, submissionOrigin: true, state: true,
      requestId: true, cancelledAt: true,
      sessionAnalysisReservation: { select: { id: true } } } });
  if (!idea || idea.actorUserId !== actorId || idea.submissionOrigin !== "session" ||
      idea.state !== "cancelled" || !idea.cancelledAt ||
      !idea.sessionAnalysisReservation) return { state: "not_visible", retryWrite: false };
  const audit = await tx.adminAuditLog.findFirst({ where: {
    action: ACTION, targetType: "AmuxIdeaSubmission", targetId: ideaId,
    actorUserId: actorId }, orderBy: { createdAt: "desc" },
    select: { id: true, entryHash: true, metadata: true } });
  const metadata = audit?.metadata;
  if (!audit?.entryHash || !metadata || typeof metadata !== "object" ||
      Array.isArray(metadata) ||
      (metadata as Record<string, unknown>).requestId !== idea.requestId ||
      (metadata as Record<string, unknown>).reservationId !==
        idea.sessionAnalysisReservation.id ||
      (metadata as Record<string, unknown>).cancelledAt !==
        idea.cancelledAt.toISOString()) {
    return { state: "not_visible", retryWrite: false };
  }
  return { state: "cancelled", ideaId, cancelledAt: idea.cancelledAt.toISOString(),
    auditId: audit.id, retryWrite: false };
}
