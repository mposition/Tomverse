import "server-only";

import type { Prisma } from "@prisma/client";
import { auditRowActorKind, AMUX_V19_SESSION_BUDGET_RESOLVE_ACTION,
  AMUX_V19_SESSION_BUDGET_TARGET } from "@/lib/adminAuditSystemActors";

/** The owner's stop of one in-flight subscription analysis (a human audit row
 * on the claim). Kept here, beside the one rule that reads it, so the stop
 * service and the settlement writer do not import each other. */
export const AMUX_V19_SESSION_ANALYSIS_STOP_ACTION = "amux.v19.session_analysis.stopped";

/** What the system writes when it closes an unknown subscription claim. */
export const AMUX_SESSION_SYSTEM_CLOSURE = "system" as const;

export type AmuxSessionLateResultClaim = {
  id: string; reservationId: string; invocationOrdinal: number;
  budgetMode: string; status: string; reservedMicroUsd: bigint;
  settledMicroUsd: bigint | null; closedAt: Date | null;
  resolutionAuditLogId: string | null;
};

/**
 * Operator, 2026-11-16: an unknown subscription (max_shadow) outcome is closed
 * by the system at zero, and a result that arrives after that is still taken.
 * Such a late answer is the CLI's own write that the app finished after the
 * runner reported the outcome unknown; it settles the claim with its measured
 * usage instead of being dropped.
 *
 * Only a claim the system closed that way qualifies, and only while it is
 * still the newest claim of its idea and the owner did not stop it: a stop is
 * the owner's decision, not an unknown outcome. A claim that reserved money
 * (any bounded claim, or a subscription claim from before 2026-11-16, which
 * held monthly headroom) never qualifies. The database repeats this rule
 * (amux_v19_session_budget_claim_guard and the result guard).
 */
export async function amuxSessionClaimTakesLateResult(tx: Prisma.TransactionClient,
  claim: AmuxSessionLateResultClaim): Promise<boolean> {
  if (claim.budgetMode !== "max_shadow" || claim.status !== "owner_consumed" ||
      claim.reservedMicroUsd !== BigInt(0) || claim.settledMicroUsd !== BigInt(0) ||
      claim.closedAt === null || !claim.resolutionAuditLogId) return false;
  const [closure, newer, stopped] = await Promise.all([
    tx.adminAuditLog.findUnique({ where: { id: claim.resolutionAuditLogId },
      select: { action: true, targetType: true, targetId: true, entryHash: true,
        metadata: true, actorUserId: true, actorEmail: true, ipAddress: true,
        userAgent: true } }),
    tx.amuxIdeaSessionAnalysisBudgetClaim.findFirst({ where: {
      reservationId: claim.reservationId,
      invocationOrdinal: { gt: claim.invocationOrdinal } }, select: { id: true } }),
    tx.adminAuditLog.findFirst({ where: { action: AMUX_V19_SESSION_ANALYSIS_STOP_ACTION,
      targetType: AMUX_V19_SESSION_BUDGET_TARGET, targetId: claim.id },
    select: { id: true } }),
  ]);
  const metadata = closure?.metadata && typeof closure.metadata === "object" &&
    !Array.isArray(closure.metadata)
    ? closure.metadata as Record<string, unknown> : null;
  return !!closure?.entryHash && newer === null && stopped === null &&
    closure.action === AMUX_V19_SESSION_BUDGET_RESOLVE_ACTION &&
    closure.targetType === AMUX_V19_SESSION_BUDGET_TARGET &&
    closure.targetId === claim.id && auditRowActorKind(closure) === "system" &&
    metadata?.status === "owner_consumed" &&
    metadata.closedBy === AMUX_SESSION_SYSTEM_CLOSURE &&
    metadata.verification === "not_proven" && metadata.settledMicroUsd === "0";
}
