import "server-only";

import type { Prisma } from "@prisma/client";
import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_V4_IDEA_SYSTEM_ACTOR,
  AMUX_V19_SESSION_BUDGET_RESOLVE_ACTION,
  AMUX_V19_SESSION_BUDGET_TARGET,
  auditRowActorKind } from "@/lib/adminAuditSystemActors";
import { AMUX_V4_ANALYSIS_NAMESPACE,
  assessAmuxIdeaAnalysisSettlement } from "./ideaAnalysisBudgetCore.ts";
import { resolveSessionUnknownClaim,
  settleSessionShadowUsage } from "./ideaSessionShadowBudgetCore.ts";
import { AMUX_SESSION_SYSTEM_CLOSURE,
  amuxSessionClaimTakesLateResult } from "./ideaSessionLateResult.ts";

type Tx = Prisma.TransactionClient;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AmuxSessionBudgetSettlementError extends Error {
  constructor(readonly code: "not_settleable" | "usage_hold" |
    "integrity_unavailable", readonly reason?: string) {
    super(reason ? `${code}:${reason}` : code);
    this.name = "AmuxSessionBudgetSettlementError";
  }
}

/** Caller must bind this result to the exact fenced local invocation. A
 * bounded (paid API) claim with an unknown result retains its full monthly
 * reservation and blocks new claims until the owner resolves it. A
 * subscription (max_shadow) claim spends no money: in the same transaction
 * the system closes it at zero, the same result as the owner's "not proven"
 * (operator, 2026-11-16), and its measured result may still arrive late (see
 * amuxSessionClaimTakesLateResult). No raw response or repository path enters
 * the audit chain. */
export async function commitAmuxSessionBudgetOutcome(tx: Tx, input: {
  claimId: string;
  outcome: "verified_success" | "invocation_failed" | "outcome_unknown";
  inputTokens: number | null;
  outputTokens: number | null;
  requiredBudgetMode?: "bounded" | "max_shadow";
  exactAgentClaim?: { requestId: string; reservationId: string;
    ideaId: string; invocationOrdinal: number };
  /** A subscription CLI result's channel, model attestation and CLI sha256,
   * recorded with the settlement it measured (owner decision 2026-10-20). */
  cliAttestation?: { provider: string; modelAttestation: "served" | "requested";
    cliSha256: string };
}): Promise<{ claimId: string; status: "succeeded" | "failed" |
  "outcome_unknown" | "owner_consumed"; settledMicroUsd: string | null;
  auditId: string }> {
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
  const open = claim?.status === "in_flight" && claim.closedAt === null &&
    claim.resolutionAuditLogId === null;
  const late = !!claim && !open && input.outcome !== "outcome_unknown" &&
    await amuxSessionClaimTakesLateResult(tx, claim);
  if (!claim || claim.namespace !== AMUX_V4_ANALYSIS_NAMESPACE ||
      (input.requiredBudgetMode &&
        claim.budgetMode !== input.requiredBudgetMode) ||
      !(open || late) ||
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
  // A paid (bounded) claim is judged by its API ceiling; a subscription claim
  // by its measured shadow usage only (it may have reserved nothing).
  const shadow = claim.budgetMode === "max_shadow";
  const boundedDecision = shadow ? null : assessAmuxIdeaAnalysisSettlement({
    outcome: input.outcome,
    reservedMicroUsd: claim.reservedMicroUsd.toString(),
    inputTokensCap: claim.inputTokensCap,
    outputTokensCap: claim.outputTokensCap,
    inputMicroUsdPerMillion: claim.inputMicroUsdPerMillion,
    outputMicroUsdPerMillion: claim.outputMicroUsdPerMillion,
    inputTokens: input.inputTokens, outputTokens: input.outputTokens,
  });
  const shadowDecision = shadow && input.outcome !== "outcome_unknown"
    ? settleSessionShadowUsage({
      reservedMicroUsd: claim.reservedMicroUsd.toString(),
      inputTokens: input.inputTokens, outputTokens: input.outputTokens,
      inputMicroUsdPerMillion: claim.inputMicroUsdPerMillion,
      outputMicroUsdPerMillion: claim.outputMicroUsdPerMillion,
    }) : null;
  const measured = shadowDecision?.decision === "measured" ||
    boundedDecision?.decision === "settlement_candidate";
  const unknownTaken = input.outcome === "outcome_unknown" && (shadow ||
    (boundedDecision?.decision === "hold" && boundedDecision.reason === "usage_unknown"));
  if (!measured && !unknownTaken) {
    throw new AmuxSessionBudgetSettlementError("usage_hold",
      shadowDecision?.decision === "hold" ? shadowDecision.reason :
        boundedDecision?.decision === "hold" ? boundedDecision.reason : undefined);
  }
  const status = input.outcome === "outcome_unknown"
    ? "outcome_unknown" as const : input.outcome === "verified_success"
      ? "succeeded" as const : "failed" as const;
  const settledMicroUsd = shadowDecision?.decision === "measured"
    ? shadowDecision.settledMicroUsd : boundedDecision?.decision === "settlement_candidate"
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
  // A paid claim's late usage still holds for the owner. A subscription
  // claim's measured usage is a fact whatever the idea did since, so it is
  // recorded rather than dropped (operator, 2026-11-16).
  if (input.outcome !== "outcome_unknown" && claim.budgetMode !== "max_shadow" &&
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
      ? claim.budgetMode === "max_shadow"
        ? "Recorded an unknown subscription CLI outcome; the system closes it at zero."
        : "Held the full v19 session cost after an unknown CLI outcome."
      : late
        ? "Settled a late subscription CLI result for a claim the system had closed unknown."
        : "Settled one known v19 session CLI usage against the Agent monthly budget.",
    metadata: { reservationId: claim.reservationId,
      namespace: AMUX_V4_ANALYSIS_NAMESPACE,
      monthStart: claim.monthStart.toISOString(), status,
      inputTokens: status === "outcome_unknown" ? null : input.inputTokens,
      outputTokens: status === "outcome_unknown" ? null : input.outputTokens,
      settledMicroUsd,
      reservedMicroUsd: claim.reservedMicroUsd.toString(),
      budgetMode: claim.budgetMode,
      ...(claim.budgetMode === "max_shadow" ? {
        shadowOverrunMicroUsd: shadowOverrun.toString(),
        monthlyShadowExceeded: measured &&
          window.spentMicroUsd + boundedSpent + window.shadowOverrunMicroUsd +
            shadowOverrun >= window.limitMicroUsd,
      } : {}),
      ...(late ? { lateAfterUnknown: true,
        previousResolutionAuditLogId: claim.resolutionAuditLogId } : {}),
      ...(input.cliAttestation ? { cliProvider: input.cliAttestation.provider,
        modelAttestation: input.cliAttestation.modelAttestation,
        cliSha256: input.cliAttestation.cliSha256 } : {}),
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
    where: { id: claim.id, status: claim.status, closedAt: claim.closedAt,
      resolutionAuditLogId: claim.resolutionAuditLogId },
    data: { status, resolutionAuditLogId: auditId,
      settledMicroUsd: settledMicroUsd === null ? null : BigInt(settledMicroUsd),
      inputTokens: status === "outcome_unknown" ? null : input.inputTokens,
      outputTokens: status === "outcome_unknown" ? null : input.outputTokens,
      closedAt: status === "outcome_unknown" ? null : now },
  });
  if (updated.count !== 1) {
    throw new AmuxSessionBudgetSettlementError("integrity_unavailable");
  }
  if (status === "outcome_unknown" && claim.budgetMode === "max_shadow") {
    const closed = await closeAmuxSessionShadowUnknownClaimInTx(tx, claim.id);
    return { claimId: claim.id, status: "owner_consumed",
      settledMicroUsd: closed.settledMicroUsd, auditId: closed.auditId };
  }
  return { claimId: claim.id, status, settledMicroUsd, auditId };
}

/**
 * The system's closure of one unknown subscription (max_shadow) claim at zero
 * (operator, 2026-11-16): the same result as the owner's "not proven" in
 * Admin, written by the system actor in the caller's transaction. Its shadow
 * usage stays unknown and nothing it held counts as the month's usage. The
 * caller holds the audit-chain lock. A bounded claim is refused: its unknown
 * outcome may have spent money and stays for the owner.
 */
export async function closeAmuxSessionShadowUnknownClaimInTx(tx: Tx,
  claimId: string): Promise<{ claimId: string; status: "owner_consumed";
    settledMicroUsd: "0"; auditId: string }> {
  if (!UUID.test(claimId)) throw new AmuxSessionBudgetSettlementError("not_settleable");
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaSessionAnalysisBudgetClaim"
    WHERE "id" = ${claimId} FOR UPDATE
  `;
  const claim = locked.length === 1
    ? await tx.amuxIdeaSessionAnalysisBudgetClaim.findUnique({ where: { id: claimId } })
    : null;
  if (!claim || claim.namespace !== AMUX_V4_ANALYSIS_NAMESPACE ||
      claim.budgetMode !== "max_shadow" || claim.status !== "outcome_unknown" ||
      claim.closedAt !== null || claim.settledMicroUsd !== null ||
      !claim.resolutionAuditLogId) {
    throw new AmuxSessionBudgetSettlementError("not_settleable");
  }
  const prior = await tx.adminAuditLog.findUnique({
    where: { id: claim.resolutionAuditLogId },
    select: { action: true, targetType: true, targetId: true, entryHash: true,
      metadata: true, actorUserId: true, actorEmail: true, ipAddress: true,
      userAgent: true },
  });
  const priorMetadata = prior?.metadata && typeof prior.metadata === "object" &&
    !Array.isArray(prior.metadata) ? prior.metadata as Record<string, unknown> : null;
  if (!prior?.entryHash || prior.action !== AMUX_V19_SESSION_BUDGET_RESOLVE_ACTION ||
      prior.targetType !== AMUX_V19_SESSION_BUDGET_TARGET ||
      prior.targetId !== claim.id || auditRowActorKind(prior) !== "system" ||
      priorMetadata?.status !== "outcome_unknown" ||
      priorMetadata.reservationId !== claim.reservationId ||
      priorMetadata.reservedMicroUsd !== claim.reservedMicroUsd.toString() ||
      priorMetadata.settledMicroUsd !== null) {
    throw new AmuxSessionBudgetSettlementError("integrity_unavailable");
  }
  const resolution = resolveSessionUnknownClaim({ budgetMode: claim.budgetMode,
    verification: "not_proven", reservedMicroUsd: claim.reservedMicroUsd.toString() });
  if (resolution.decision !== "resolve" || resolution.status !== "owner_consumed" ||
      resolution.settledMicroUsd !== "0" || resolution.shadowUsage !== "unknown") {
    throw new AmuxSessionBudgetSettlementError("integrity_unavailable");
  }
  const windowRows = await tx.$queryRaw<Array<{ spentMicroUsd: bigint;
    reservedMicroUsd: bigint }>>`
    SELECT "spentMicroUsd", "reservedMicroUsd"
    FROM "AmuxIdeaAnalysisBudgetWindow"
    WHERE "namespace" = ${claim.namespace}
      AND "monthStart" = ${claim.monthStart} FOR UPDATE
  `;
  const window = windowRows[0];
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = clock[0]?.now;
  if (!window || window.reservedMicroUsd < claim.reservedMicroUsd ||
      !(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      now < claim.createdAt) {
    throw new AmuxSessionBudgetSettlementError("integrity_unavailable");
  }
  const auditId = await writeSystemAuditLog({
    tx, systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
    action: AMUX_V19_SESSION_BUDGET_RESOLVE_ACTION,
    targetType: AMUX_V19_SESSION_BUDGET_TARGET, targetId: claim.id,
    summary: "System closed one unknown subscription CLI claim at zero; shadow usage unknown, headroom not counted.",
    metadata: { reservationId: claim.reservationId,
      previousResolutionAuditLogId: claim.resolutionAuditLogId,
      verification: "not_proven", closedBy: AMUX_SESSION_SYSTEM_CLOSURE,
      status: "owner_consumed", settledMicroUsd: "0",
      reservedMicroUsd: claim.reservedMicroUsd.toString(),
      namespace: AMUX_V4_ANALYSIS_NAMESPACE,
      monthStart: claim.monthStart.toISOString(),
      modelCallStarted: "unproven",
      // The database binds these three fields to a zero settlement (owner
      // decision 2026-10-20).
      budgetMode: "max_shadow", shadowUsage: "unknown", headroomCounted: false },
  });
  const moved = await tx.amuxIdeaAnalysisBudgetWindow.updateMany({
    where: { namespace: claim.namespace, monthStart: claim.monthStart,
      spentMicroUsd: window.spentMicroUsd,
      reservedMicroUsd: window.reservedMicroUsd },
    data: { reservedMicroUsd: { decrement: claim.reservedMicroUsd } },
  });
  const updated = await tx.amuxIdeaSessionAnalysisBudgetClaim.updateMany({
    where: { id: claim.id, status: "outcome_unknown", closedAt: null,
      resolutionAuditLogId: claim.resolutionAuditLogId },
    data: { status: "owner_consumed", settledMicroUsd: BigInt(0),
      resolutionAuditLogId: auditId, closedAt: now },
  });
  if (moved.count !== 1 || updated.count !== 1) {
    throw new AmuxSessionBudgetSettlementError("integrity_unavailable");
  }
  return { claimId: claim.id, status: "owner_consumed", settledMicroUsd: "0",
    auditId };
}

/** Closes every subscription claim still held as outcome_unknown, oldest
 * first: rows written before 2026-11-16, when the owner closed them by hand.
 * New unknown subscription outcomes are closed as they are recorded. The
 * caller holds the audit-chain lock. */
export async function closeOpenAmuxSessionShadowUnknownClaimsInTx(tx: Tx):
  Promise<number> {
  const open = await tx.amuxIdeaSessionAnalysisBudgetClaim.findMany({
    where: { namespace: AMUX_V4_ANALYSIS_NAMESPACE, budgetMode: "max_shadow",
      status: "outcome_unknown", closedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true },
  });
  for (const row of open) await closeAmuxSessionShadowUnknownClaimInTx(tx, row.id);
  return open.length;
}
