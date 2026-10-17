import "server-only";

import type { Prisma } from "@prisma/client";
import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_V4_IDEA_SYSTEM_ACTOR,
  AMUX_V19_SESSION_BUDGET_CLAIM_ACTION,
  AMUX_V19_SESSION_BUDGET_TARGET } from "@/lib/adminAuditSystemActors";
import { auditRowActorKind } from "@/lib/adminAuditSystemActors";
import { AMUX_V4_ANALYSIS_NAMESPACE,
  assessAmuxIdeaAnalysisBudget } from "./ideaAnalysisBudgetCore.ts";
import { readAnalysisMonthlyBudgetSetting } from
  "./ideaAnalysisBudgetSettingStore.ts";
import { readApprovedAmuxIdeaAnalysisPriceVersion } from
  "./ideaAnalysisPriceVersionRead.ts";
import { readAmuxIdeaAnalysisFailureStreak } from
  "./ideaAnalysisFailureStreakService.ts";

type Tx = Prisma.TransactionClient;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AmuxSessionBudgetClaimError extends Error {
  constructor(readonly code: "not_ready" | "budget_hold" | "budget_unavailable" |
    "integrity_unavailable", readonly reason?: string) {
    super(reason ? `${code}:${reason}` : code);
    this.name = "AmuxSessionBudgetClaimError";
  }
}

/** Read-only response-loss check. Even `absent` does not authorize replay:
 * the original transaction may commit after this snapshot. */
export async function readAmuxSessionBudgetClaimReceipt(tx: Tx, input: {
  requestId: string; reservationId: string; invocationOrdinal: number;
}): Promise<{ status: "committed" | "absent" | "partial";
  claimId?: string; claimStatus?: string }> {
  if (!UUID.test(input.requestId) || !UUID.test(input.reservationId) ||
      !Number.isSafeInteger(input.invocationOrdinal) ||
      input.invocationOrdinal < 0) {
    throw new AmuxSessionBudgetClaimError("not_ready");
  }
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit,
           set_config('TimeZone', 'UTC', true) AS transaction_zone
  `;
  const [claim, audits] = await Promise.all([
    tx.amuxIdeaSessionAnalysisBudgetClaim.findUnique({
      where: { requestId: input.requestId },
    }),
    tx.adminAuditLog.findMany({ where: {
      action: AMUX_V19_SESSION_BUDGET_CLAIM_ACTION,
      targetType: AMUX_V19_SESSION_BUDGET_TARGET,
      metadata: { path: ["requestId"], equals: input.requestId },
    }, take: 2 }),
  ]);
  if (!claim && audits.length === 0) return { status: "absent" };
  const audit = audits[0];
  const metadata = audit?.metadata;
  if (!claim || audits.length !== 1 || !audit?.entryHash ||
      auditRowActorKind(audit) !== "system" ||
      claim.reservationId !== input.reservationId ||
      claim.invocationOrdinal !== input.invocationOrdinal ||
      claim.claimAuditLogId !== audit.id || audit.targetId !== claim.id ||
      !metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
      (metadata as Record<string, unknown>).reservationId !== input.reservationId ||
      (metadata as Record<string, unknown>).invocationOrdinal !== input.invocationOrdinal ||
      (metadata as Record<string, unknown>).reservedMicroUsd !==
        claim.reservedMicroUsd.toString()) {
    return { status: "partial" };
  }
  return { status: "committed", claimId: claim.id,
    claimStatus: claim.status };
}

/** One invocation of a session reservation becomes one priced claim. This is a dark transaction
 * body: only the eventual trusted app dispatch writer may supply measured
 * runner capabilities. It does not start the CLI or accept model output. A
 * lost response must be read back by requestId; it must never be re-POSTed. */
export async function commitAmuxSessionBudgetClaim(tx: Tx, input: {
  claimId: string;
  requestId: string;
  reservationId: string;
  invocationOrdinal: number;
  priceVersionId: string;
  runner: { tokenCapsEnforceable: boolean; billableToolsDisabled: boolean };
}): Promise<{ claimId: string; reservationId: string; requestId: string;
  invocationOrdinal: number; reservedMicroUsd: string; auditId: string }> {
  if (!UUID.test(input.claimId) || !UUID.test(input.requestId) ||
      !UUID.test(input.reservationId) ||
      !Number.isSafeInteger(input.invocationOrdinal) ||
      input.invocationOrdinal < 0 ||
      !/^[A-Za-z0-9:_-]{1,128}$/.test(input.priceVersionId)) {
    throw new AmuxSessionBudgetClaimError("not_ready");
  }
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit,
           set_config('TimeZone', 'UTC', true) AS transaction_zone
  `;
  await takeAuditChainLock(tx);
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = clock[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new AmuxSessionBudgetClaimError("integrity_unavailable");
  }
  const reservationLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaSessionAnalysisReservation"
    WHERE "id" = ${input.reservationId} FOR UPDATE
  `;
  if (reservationLock.length !== 1) throw new AmuxSessionBudgetClaimError("not_ready");
  const reservation = await tx.amuxIdeaSessionAnalysisReservation.findUnique({
    where: { id: input.reservationId },
    include: { idea: { select: { state: true, cancelledAt: true,
      analysisDeadlineAt: true, analysisCompletedAt: true,
      submissionOrigin: true } } },
  });
  // Presence only: no unbounded idea or provenance plaintext/ciphertext enters
  // this cost writer. The migration repeats the predicate at the write fence.
  const rawAvailable = reservation ?
    await tx.amuxIdeaSubmission.findFirst({
      where: { id: reservation.ideaId, rawCiphertext: { not: null },
        rawPurgedAt: null, sourceProvenanceCiphertext: { not: null } },
      select: { id: true },
    }) : null;
  const latestClaim = await tx.amuxIdeaSessionAnalysisBudgetClaim.findFirst({
    where: { reservationId: input.reservationId },
    orderBy: { invocationOrdinal: "desc" },
    select: { invocationOrdinal: true, status: true },
  });
  if (!reservation || reservation.status !== "queued" ||
      reservation.idea.submissionOrigin !== "session" ||
      reservation.idea.state !==
        (input.invocationOrdinal === 0 ? "submitted" : "analyzing") ||
      reservation.idea.cancelledAt !== null ||
      reservation.idea.analysisCompletedAt !== null ||
      rawAvailable === null ||
      now >= reservation.idea.analysisDeadlineAt ||
      (input.invocationOrdinal === 0
        ? latestClaim !== null
        : !latestClaim || latestClaim.status !== "succeeded" ||
          latestClaim.invocationOrdinal !== input.invocationOrdinal - 1)) {
    throw new AmuxSessionBudgetClaimError("not_ready");
  }
  const latestScope = await tx.amuxIdeaOperatingScopeSetting.findFirst({
    orderBy: { version: "desc" }, select: { id: true },
  });
  if (latestScope?.id !== reservation.operatingScopeSettingId) {
    throw new AmuxSessionBudgetClaimError("not_ready");
  }
  const price = await readApprovedAmuxIdeaAnalysisPriceVersion(tx, {
    priceVersionId: input.priceVersionId,
    provider: reservation.modelProvider,
    modelId: reservation.modelId, now,
  });
  if (price.decision !== "ready" || price.price.mode !== "subscription_cli") {
    throw new AmuxSessionBudgetClaimError("budget_hold",
      price.decision === "hold" ? price.reason : "price_unverified");
  }
  const setting = await readAnalysisMonthlyBudgetSetting(tx);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  await tx.amuxIdeaAnalysisBudgetWindow.createMany({
    data: [{ namespace: AMUX_V4_ANALYSIS_NAMESPACE, monthStart,
      limitMicroUsd: BigInt(setting.limitMicroUsd), spentMicroUsd: BigInt(0),
      reservedMicroUsd: BigInt(0) }], skipDuplicates: true,
  });
  const rows = await tx.$queryRaw<Array<{ limitMicroUsd: bigint;
    spentMicroUsd: bigint; reservedMicroUsd: bigint }>>`
    SELECT "limitMicroUsd", "spentMicroUsd", "reservedMicroUsd"
    FROM "AmuxIdeaAnalysisBudgetWindow"
    WHERE "namespace" = ${AMUX_V4_ANALYSIS_NAMESPACE}
      AND "monthStart" = ${monthStart} FOR UPDATE
  `;
  const window = rows[0];
  if (!window || window.limitMicroUsd !== BigInt(setting.limitMicroUsd)) {
    throw new AmuxSessionBudgetClaimError("budget_unavailable");
  }
  const [v4Unknown, sessionUnknown] = await Promise.all([
    tx.amuxIdeaAnalysisBudgetHold.findFirst({ where: {
      namespace: AMUX_V4_ANALYSIS_NAMESPACE, status: "outcome_unknown",
    }, select: { id: true } }),
    tx.amuxIdeaSessionAnalysisBudgetClaim.findFirst({ where: {
      namespace: AMUX_V4_ANALYSIS_NAMESPACE, status: "outcome_unknown",
    }, select: { id: true } }),
  ]);
  const [v4Active, sessionActive] = await Promise.all([
    tx.amuxIdeaAnalysisBudgetHold.findFirst({ where: {
      namespace: AMUX_V4_ANALYSIS_NAMESPACE, status: "in_flight",
    }, select: { id: true } }),
    tx.amuxIdeaSessionAnalysisBudgetClaim.findFirst({ where: {
      namespace: AMUX_V4_ANALYSIS_NAMESPACE, status: "in_flight",
    }, select: { id: true } }),
  ]);
  if (v4Active || sessionActive) {
    throw new AmuxSessionBudgetClaimError("not_ready");
  }
  const failureStreak = await readAmuxIdeaAnalysisFailureStreak(tx);
  if (failureStreak !== "ready") {
    throw new AmuxSessionBudgetClaimError(failureStreak === "stopped"
      ? "not_ready" : "integrity_unavailable");
  }
  const decision = assessAmuxIdeaAnalysisBudget({
    ...price.price, ...input.runner,
    namespace: AMUX_V4_ANALYSIS_NAMESPACE,
    asOfIso: now.toISOString(),
    windowStartsAtIso: monthStart.toISOString(),
    consumedMicroUsd: window.spentMicroUsd.toString(),
    reservedMicroUsd: window.reservedMicroUsd.toString(),
    monthlyLimitMicroUsd: window.limitMicroUsd.toString(),
    usageState: v4Unknown || sessionUnknown ? "unknown" : "known",
  });
  if (decision.decision !== "reservation_candidate") {
    throw new AmuxSessionBudgetClaimError("budget_hold", decision.reason);
  }
  const auditId = await writeSystemAuditLog({
    tx, systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
    action: AMUX_V19_SESSION_BUDGET_CLAIM_ACTION,
    targetType: AMUX_V19_SESSION_BUDGET_TARGET, targetId: input.claimId,
    summary: "Claimed one bounded v19 session analysis against the shared Agent monthly budget.",
    metadata: { reservationId: input.reservationId,
      invocationOrdinal: input.invocationOrdinal,
      requestId: input.requestId, namespace: AMUX_V4_ANALYSIS_NAMESPACE,
      monthStart: monthStart.toISOString(), priceVersionId: input.priceVersionId,
      modelId: reservation.modelId,
      reservedMicroUsd: decision.worstCaseMicroUsd,
      amountMeaning: decision.amountMeaning, modelCallStarted: false },
  });
  const incremented = await tx.amuxIdeaAnalysisBudgetWindow.updateMany({
    where: { namespace: AMUX_V4_ANALYSIS_NAMESPACE, monthStart,
      limitMicroUsd: window.limitMicroUsd,
      spentMicroUsd: window.spentMicroUsd,
      reservedMicroUsd: window.reservedMicroUsd },
    data: { reservedMicroUsd: { increment: BigInt(decision.worstCaseMicroUsd) } },
  });
  if (incremented.count !== 1) {
    throw new AmuxSessionBudgetClaimError("budget_unavailable");
  }
  await tx.amuxIdeaSessionAnalysisBudgetClaim.create({ data: {
    id: input.claimId, requestId: input.requestId,
    reservationId: input.reservationId, namespace: AMUX_V4_ANALYSIS_NAMESPACE,
    invocationOrdinal: input.invocationOrdinal,
    monthStart, priceVersionId: input.priceVersionId,
    provider: reservation.modelProvider, modelId: reservation.modelId,
    inputTokensCap: price.price.inputTokensCap,
    outputTokensCap: price.price.outputTokensCap,
    inputMicroUsdPerMillion: price.price.inputMicroUsdPerMillion,
    outputMicroUsdPerMillion: price.price.outputMicroUsdPerMillion,
    reservedMicroUsd: BigInt(decision.worstCaseMicroUsd),
    status: "in_flight", claimAuditLogId: auditId,
  } });
  return { claimId: input.claimId, reservationId: input.reservationId,
    requestId: input.requestId, invocationOrdinal: input.invocationOrdinal,
    reservedMicroUsd: decision.worstCaseMicroUsd,
    auditId };
}
