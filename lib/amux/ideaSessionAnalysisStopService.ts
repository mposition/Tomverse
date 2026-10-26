import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { AMUX_V19_SESSION_BUDGET_TARGET } from "@/lib/adminAuditSystemActors";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { AmuxSessionBudgetSettlementError,
  commitAmuxSessionBudgetOutcome } from "./ideaSessionAnalysisBudgetSettlementService.ts";

type Tx = Prisma.TransactionClient;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const AMUX_V19_SESSION_ANALYSIS_STOP_ACTION = "amux.v19.session_analysis.stopped";

export class AmuxIdeaSessionAnalysisStopError extends Error {
  constructor(readonly code: "forbidden" | "not_found" | "not_stoppable" |
    "integrity_unavailable") {
    super(code);
    this.name = "AmuxIdeaSessionAnalysisStopError";
  }
}

function ownerId(session: Session): string {
  const id = session.user?.id;
  if (!id || !isAdminSession(session) || getAdminRole(session) !== "owner") {
    throw new AmuxIdeaSessionAnalysisStopError("forbidden");
  }
  return id;
}

/** docs/policy/amux-intake.md v19 item 3: the owner stops one in-flight v19
 * session analysis. The stop is a human audit entry, and in the same
 * transaction the claim becomes outcome_unknown through the ordinary system
 * settlement, which keeps the full reserved cost. From then on the database
 * refuses that claim's result row and any success or failure settlement, the
 * runner's stop poll answers stop, and nothing is sent again. */
export async function commitAmuxIdeaSessionAnalysisStop(tx: Tx, input: {
  session: Session; request: Request; ideaId: string; claimId: string;
  ownerConfirmed: true;
}): Promise<{ ideaId: string; claimId: string; auditId: string;
  resolutionAuditId: string }> {
  const actorId = ownerId(input.session);
  await assertRecentAdminAuthentication(input.session);
  if (!UUID.test(input.ideaId) || !UUID.test(input.claimId) ||
      input.ownerConfirmed !== true) {
    throw new AmuxIdeaSessionAnalysisStopError("not_stoppable");
  }
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit,
           set_config('TimeZone', 'UTC', true) AS transaction_zone
  `;
  // Every claim writer takes this chain lock first, so the claim cannot move
  // between this read and the settlement below, which locks the row itself.
  await takeAuditChainLock(tx);
  const claim = await tx.amuxIdeaSessionAnalysisBudgetClaim.findUnique({
    where: { id: input.claimId },
    select: { id: true, status: true, closedAt: true, resolutionAuditLogId: true,
      reservationId: true, invocationOrdinal: true, requestId: true,
      reservation: { select: { ideaId: true, actorUserId: true,
        idea: { select: { submissionOrigin: true } } } } },
  });
  if (!claim || claim.reservation.ideaId !== input.ideaId ||
      claim.reservation.actorUserId !== actorId ||
      claim.reservation.idea.submissionOrigin !== "session") {
    throw new AmuxIdeaSessionAnalysisStopError("not_found");
  }
  if (claim.status !== "in_flight" || claim.closedAt !== null ||
      claim.resolutionAuditLogId !== null) {
    throw new AmuxIdeaSessionAnalysisStopError("not_stoppable");
  }
  const auditId = await writeAdminAuditLog({ tx, session: input.session,
    request: input.request, action: AMUX_V19_SESSION_ANALYSIS_STOP_ACTION,
    targetType: AMUX_V19_SESSION_BUDGET_TARGET, targetId: claim.id,
    summary: "Owner stopped one in-flight AMUX v19 session analysis.",
    metadata: { policyVersion: 19, ideaId: input.ideaId,
      reservationId: claim.reservationId,
      invocationOrdinal: claim.invocationOrdinal,
      outcome: "outcome_unknown", retryAutomatically: false,
      userCreditLedgerTouched: false } });
  let resolutionAuditId: string;
  try {
    resolutionAuditId = (await commitAmuxSessionBudgetOutcome(tx, {
      claimId: claim.id, outcome: "outcome_unknown",
      inputTokens: null, outputTokens: null,
      exactAgentClaim: { requestId: claim.requestId,
        reservationId: claim.reservationId, ideaId: input.ideaId,
        invocationOrdinal: claim.invocationOrdinal },
    })).auditId;
  } catch (error) {
    if (error instanceof AmuxSessionBudgetSettlementError) {
      throw new AmuxIdeaSessionAnalysisStopError(error.code === "not_settleable"
        ? "not_stoppable" : "integrity_unavailable");
    }
    throw error;
  }
  return { ideaId: input.ideaId, claimId: claim.id, auditId, resolutionAuditId };
}

/** Read-only state for the stop control and for reconciling an uncertain
 * stop. Absence of a receipt is never an instruction to stop again. */
export async function readAmuxIdeaSessionAnalysisStopState(
  tx: Tx, session: Session, ideaId: string,
): Promise<
  | { state: "running"; ideaId: string; claimId: string; startedAt: string;
      retryWrite: false }
  | { state: "stopped"; ideaId: string; claimId: string; stoppedAt: string;
      auditId: string; retryWrite: false }
  | { state: "not_visible"; retryWrite: false }> {
  const actorId = ownerId(session);
  await assertRecentAdminAuthentication(session);
  if (!UUID.test(ideaId)) throw new AmuxIdeaSessionAnalysisStopError("not_stoppable");
  const reservation = await tx.amuxIdeaSessionAnalysisReservation.findUnique({
    where: { ideaId }, select: { actorUserId: true,
      idea: { select: { submissionOrigin: true } },
      budgetClaims: { orderBy: { invocationOrdinal: "desc" }, take: 1,
        select: { id: true, status: true, closedAt: true,
          resolutionAuditLogId: true, createdAt: true } } },
  });
  const latest = reservation?.budgetClaims[0];
  if (!reservation || reservation.actorUserId !== actorId ||
      reservation.idea.submissionOrigin !== "session" || !latest) {
    return { state: "not_visible", retryWrite: false };
  }
  if (latest.status === "in_flight" && latest.closedAt === null &&
      latest.resolutionAuditLogId === null) {
    return { state: "running", ideaId, claimId: latest.id,
      startedAt: latest.createdAt.toISOString(), retryWrite: false };
  }
  if (latest.status !== "outcome_unknown" && latest.status !== "released" &&
      latest.status !== "owner_consumed") {
    return { state: "not_visible", retryWrite: false };
  }
  const audit = await tx.adminAuditLog.findFirst({ where: {
    action: AMUX_V19_SESSION_ANALYSIS_STOP_ACTION,
    targetType: AMUX_V19_SESSION_BUDGET_TARGET, targetId: latest.id,
    actorUserId: actorId }, orderBy: { createdAt: "desc" },
    select: { id: true, entryHash: true, createdAt: true, metadata: true } });
  const metadata = audit?.metadata;
  if (!audit?.entryHash || !metadata || typeof metadata !== "object" ||
      Array.isArray(metadata) ||
      (metadata as Record<string, unknown>).ideaId !== ideaId) {
    return { state: "not_visible", retryWrite: false };
  }
  return { state: "stopped", ideaId, claimId: latest.id,
    stoppedAt: audit.createdAt.toISOString(), auditId: audit.id,
    retryWrite: false };
}
