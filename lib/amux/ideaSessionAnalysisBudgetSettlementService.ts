import "server-only";

import type { Prisma } from "@prisma/client";
import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_V4_IDEA_SYSTEM_ACTOR,
  AMUX_V19_SESSION_BUDGET_RESOLVE_ACTION,
  AMUX_V19_SESSION_BUDGET_TARGET } from "@/lib/adminAuditSystemActors";
import { AMUX_V4_ANALYSIS_NAMESPACE,
  assessAmuxIdeaAnalysisSettlement } from "./ideaAnalysisBudgetCore.ts";
import { settleSessionShadowUsage } from "./ideaSessionShadowBudgetCore.ts";

type Tx = Prisma.TransactionClient;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AmuxSessionBudgetSettlementError extends Error {
  constructor(readonly code: "not_settleable" | "usage_hold" |
    "integrity_unavailable", readonly reason?: string) {
    super(reason ? `${code}:${reason}` : code);
    this.name = "AmuxSessionBudgetSettlementError";
  }
}

/** Caller must bind this result to the exact fenced local invocation. An
 * unknown result retains the full monthly reservation and blocks new claims.
 * No raw response or repository path enters the audit chain. */
export async function commitAmuxSessionBudgetOutcome(tx: Tx, input: {
  claimId: string;
  outcome: "verified_success" | "invocation_failed" | "outcome_unknown";
  inputTokens: number | null;
  outputTokens: number | null;
  exactAgentClaim?: { requestId: string; reservationId: string;
    ideaId: string; invocationOrdinal: number };
}): Promise<{ claimId: string; status: "succeeded" | "failed" |
  "outcome_unknown"; settledMicroUsd: string | null; auditId: string }> {
  if (!UUID.test(input.claimId) || (input.exactAgentClaim &&
      (!UUID.test(input.exactAgentClaim.requestId) ||
       !UUID.test(input.exactAgentClaim.reservationId) ||
       !UUID.test(input.exactAgentClaim.ideaId) ||
       !Number.isSafeInteger(input.exactAgentClaim.invocationOrdinal) ||
       input.exactAgentClaim.invocationOrdinal < 0))) {
    throw new AmuxSessionBudgetSettlementError("not_settleable");
  }
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit,
           set_config('TimeZone', 'UTC', true) AS transaction_zone
  `;
  await takeAuditChainLock(tx);
  const claimLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaSessionAnalysisBudgetClaim"
    WHERE "id" = ${input.claimId} FOR UPDATE
  `;
  if (claimLock.length !== 1) {
    throw new AmuxSessionBudgetSettlementError("not_settleable");
  }
  const claim = await tx.amuxIdeaSessionAnalysisBudgetClaim.findUnique({
    where: { id: input.claimId },
    include: { reservation: { select: { idea: { select: {
      state: true, cancelledAt: true, analysisDeadlineAt: true,
    } }, ideaId: true } } },
  });
  if (!claim || claim.namespace !== AMUX_V4_ANALYSIS_NAMESPACE ||
      claim.status !== "in_flight" || claim.closedAt !== null ||
      claim.resolutionAuditLogId !== null ||
      (input.exactAgentClaim &&
        (claim.requestId !== input.exactAgentClaim.requestId ||
         claim.reservationId !== input.exactAgentClaim.reservationId ||
         claim.reservation.ideaId !== input.exactAgentClaim.ideaId ||
         claim.invocationOrdinal !== input.exactAgentClaim.invocationOrdinal))) {
    throw new AmuxSessionBudgetSettlementError("not_settleable");
  }
  const windowRows = await tx.$queryRaw<Array<{ spentMicroUsd: bigint;
    reservedMicroUsd: bigint; shadowOverrunMicroUsd: bigint; limitMicroUsd: bigint }>>`
    SELECT "spentMicroUsd", "reservedMicroUsd", "shadowOverrunMicroUsd", "limitMicroUsd"
    FROM "AmuxIdeaAnalysisBudgetWindow"
    WHERE "namespace" = ${claim.namespace}
      AND "monthStart" = ${claim.monthStart} FOR UPDATE
  `;
  const window = windowRows[0];
  if (!window || window.reservedMicroUsd < claim.reservedMicroUsd) {
    throw new AmuxSessionBudgetSettlementError("integrity_unavailable");
  }
  const boundedDecision = assessAmuxIdeaAnalysisSettlement({
    outcome: input.outcome,
    reservedMicroUsd: claim.reservedMicroUsd.toString(),
    inputTokensCap: claim.inputTokensCap,
    outputTokensCap: claim.outputTokensCap,
    inputMicroUsdPerMillion: claim.inputMicroUsdPerMillion,
    outputMicroUsdPerMillion: claim.outputMicroUsdPerMillion,
    inputTokens: input.inputTokens, outputTokens: input.outputTokens,
  });
  const shadowDecision = claim.budgetMode === "max_shadow" &&
    input.outcome !== "outcome_unknown"
    ? settleSessionShadowUsage({
      reservedMicroUsd: claim.reservedMicroUsd.toString(),
      inputTokens: input.inputTokens, outputTokens: input.outputTokens,
      inputMicroUsdPerMillion: claim.inputMicroUsdPerMillion,
      outputMicroUsdPerMillion: claim.outputMicroUsdPerMillion,
    }) : null;
  const measured = shadowDecision?.decision === "measured" ||
    (shadowDecision === null && boundedDecision.decision === "settlement_candidate");
  if (!measured &&
      !(input.outcome === "outcome_unknown" &&
        boundedDecision.decision === "hold" && boundedDecision.reason === "usage_unknown")) {
    throw new AmuxSessionBudgetSettlementError("usage_hold",
      shadowDecision?.decision === "hold" ? shadowDecision.reason :
        boundedDecision.decision === "hold" ? boundedDecision.reason : undefined);
  }
  const status = input.outcome === "outcome_unknown"
    ? "outcome_unknown" as const : input.outcome === "verified_success"
      ? "succeeded" as const : "failed" as const;
  const settledMicroUsd = shadowDecision?.decision === "measured"
    ? shadowDecision.settledMicroUsd : boundedDecision.decision === "settlement_candidate"
      ? boundedDecision.settledMicroUsd : null;
  const boundedSpent = shadowDecision?.decision === "measured"
    ? BigInt(shadowDecision.boundedSpentMicroUsd) : settledMicroUsd === null
      ? BigInt(0) : BigInt(settledMicroUsd);
  const shadowOverrun = shadowDecision?.decision === "measured"
    ? BigInt(shadowDecision.shadowOverrunMicroUsd) : BigInt(0);
  if (measured && (window.spentMicroUsd + window.reservedMicroUsd -
      claim.reservedMicroUsd + boundedSpent > window.limitMicroUsd ||
      window.shadowOverrunMicroUsd + shadowOverrun > BigInt("9223372036854775807") -
        window.spentMicroUsd - boundedSpent)) {
    throw new AmuxSessionBudgetSettlementError("integrity_unavailable");
  }
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = clock[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      now < claim.createdAt) {
    throw new AmuxSessionBudgetSettlementError("integrity_unavailable");
  }
  if (input.outcome !== "outcome_unknown" &&
      (claim.reservation.idea.cancelledAt !== null ||
       now >= claim.reservation.idea.analysisDeadlineAt ||
       !["submitted", "analyzing"].includes(claim.reservation.idea.state))) {
    throw new AmuxSessionBudgetSettlementError("usage_hold", "outcome_unknown");
  }
  const auditId = await writeSystemAuditLog({
    tx, systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
    action: AMUX_V19_SESSION_BUDGET_RESOLVE_ACTION,
    targetType: AMUX_V19_SESSION_BUDGET_TARGET, targetId: claim.id,
    summary: status === "outcome_unknown"
      ? "Held the full v19 session cost after an unknown CLI outcome."
      : "Settled one known v19 session CLI usage against the Agent monthly budget.",
    metadata: { reservationId: claim.reservationId,
      namespace: AMUX_V4_ANALYSIS_NAMESPACE,
      monthStart: claim.monthStart.toISOString(), status,
      inputTokens: status === "outcome_unknown" ? null : input.inputTokens,
      outputTokens: status === "outcome_unknown" ? null : input.outputTokens,
      settledMicroUsd,
      reservedMicroUsd: claim.reservedMicroUsd.toString(),
      budgetMode: claim.budgetMode,
      shadowOverrunMicroUsd: shadowOverrun.toString(),
      monthlyShadowExceeded: measured &&
        window.spentMicroUsd + boundedSpent + window.shadowOverrunMicroUsd +
          shadowOverrun >= window.limitMicroUsd,
      amountMeaning: claim.budgetMode === "max_shadow"
        ? "cli_shadow_observed_not_ceiling" : "cli_api_conversion_estimate" },
  });
  if (measured) {
    const moved = await tx.amuxIdeaAnalysisBudgetWindow.updateMany({
      where: { namespace: claim.namespace, monthStart: claim.monthStart,
        spentMicroUsd: window.spentMicroUsd,
        reservedMicroUsd: window.reservedMicroUsd,
        shadowOverrunMicroUsd: window.shadowOverrunMicroUsd },
      data: { spentMicroUsd: { increment: boundedSpent },
        reservedMicroUsd: { decrement: claim.reservedMicroUsd },
        ...(shadowOverrun > BigInt(0)
          ? { shadowOverrunMicroUsd: { increment: shadowOverrun } } : {}) },
    });
    if (moved.count !== 1) {
      throw new AmuxSessionBudgetSettlementError("integrity_unavailable");
    }
  }
  const updated = await tx.amuxIdeaSessionAnalysisBudgetClaim.updateMany({
    where: { id: claim.id, status: "in_flight", closedAt: null,
      resolutionAuditLogId: null },
    data: { status, resolutionAuditLogId: auditId,
      settledMicroUsd: settledMicroUsd === null ? null : BigInt(settledMicroUsd),
      inputTokens: status === "outcome_unknown" ? null : input.inputTokens,
      outputTokens: status === "outcome_unknown" ? null : input.outputTokens,
      closedAt: status === "outcome_unknown" ? null : now },
  });
  if (updated.count !== 1) {
    throw new AmuxSessionBudgetSettlementError("integrity_unavailable");
  }
  return { claimId: claim.id, status, settledMicroUsd, auditId };
}
