import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import {
  AMUX_V4_ANALYSIS_BUDGET_SETTLE_ACTION,
  AMUX_V4_ANALYSIS_BUDGET_SETTLE_TARGET,
  AMUX_V4_IDEA_SYSTEM_ACTOR,
} from "@/lib/adminAuditSystemActors";
import { AMUX_V4_ANALYSIS_NAMESPACE,
  assessAmuxIdeaAnalysisSettlement } from "./ideaAnalysisBudgetCore.ts";

const ID = /^[A-Za-z0-9:_-]{1,128}$/;

export class AmuxIdeaAnalysisSettlementError extends Error {
  constructor(readonly code: "not_settleable" | "usage_hold" | "integrity_unavailable",
    readonly reason?: string) {
    super(reason ? `${code}:${reason}` : code);
    this.name = "AmuxIdeaAnalysisSettlementError";
  }
}

/** Dark transaction body for one measured, already-dispatched invocation.
 * A caller must prove usage came from this fenced attempt; this body does
 * not dispatch, accept model output or complete the analysis chunk. A known
 * success leaves its preview in flight until the separate result writer
 * atomically stores the output and closes the preview.
 * Unknown usage leaves the full reservation occupied for read-back/owner
 * resolution, never a zero-cost settlement. */
export async function commitAmuxKnownIdeaAnalysisSettlement(
  tx: Prisma.TransactionClient,
  input: { holdId: string; outcome: "verified_success" | "invocation_failed" | "outcome_unknown";
    inputTokens: number | null; outputTokens: number | null },
): Promise<{ holdId: string; status: "succeeded" | "failed";
  settledMicroUsd: string; releasedMicroUsd: string; auditId: string }> {
  if (!ID.test(input.holdId)) throw new AmuxIdeaAnalysisSettlementError("not_settleable");
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const identity = await tx.amuxIdeaAnalysisBudgetHold.findUnique({
    where: { id: input.holdId }, select: { previewId: true, namespace: true, monthStart: true },
  });
  if (!identity || identity.namespace !== AMUX_V4_ANALYSIS_NAMESPACE) {
    throw new AmuxIdeaAnalysisSettlementError("not_settleable");
  }
  // Keep the preview -> window -> hold order of cancellation and expiry.
  const previewLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaTransferPreview"
    WHERE "id" = ${identity.previewId} FOR UPDATE
  `;
  const windowLock = await tx.$queryRaw<Array<{
    spentMicroUsd: bigint; reservedMicroUsd: bigint;
  }>>`
    SELECT "spentMicroUsd", "reservedMicroUsd"
    FROM "AmuxIdeaAnalysisBudgetWindow"
    WHERE "namespace" = ${identity.namespace}
      AND "monthStart" = ${identity.monthStart} FOR UPDATE
  `;
  const holdLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaAnalysisBudgetHold"
    WHERE "id" = ${input.holdId} FOR UPDATE
  `;
  if (previewLock.length !== 1 || windowLock.length !== 1 || holdLock.length !== 1) {
    throw new AmuxIdeaAnalysisSettlementError("integrity_unavailable");
  }
  const hold = await tx.amuxIdeaAnalysisBudgetHold.findUnique({ where: { id: input.holdId } });
  const preview = await tx.amuxIdeaTransferPreview.findUnique({
    where: { id: identity.previewId },
    select: { id: true, state: true, consumedAt: true, outcomeUnknownAt: true },
  });
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = clock[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !hold || !preview ||
      hold.previewId !== preview.id || hold.namespace !== identity.namespace ||
      hold.monthStart.getTime() !== identity.monthStart.getTime()) {
    throw new AmuxIdeaAnalysisSettlementError("integrity_unavailable");
  }
  if (hold.status !== "in_flight" || hold.dispatchedAt === null ||
      hold.closedAt !== null || hold.settledMicroUsd !== null ||
      hold.inputTokens !== null || hold.outputTokens !== null ||
      preview.state !== "in_flight" || preview.consumedAt === null ||
      preview.outcomeUnknownAt !== null) {
    throw new AmuxIdeaAnalysisSettlementError("not_settleable");
  }
  if (now < hold.dispatchedAt || hold.reservedMicroUsd <= BigInt(0) ||
      windowLock[0]!.reservedMicroUsd < hold.reservedMicroUsd) {
    throw new AmuxIdeaAnalysisSettlementError("integrity_unavailable");
  }
  const decision = assessAmuxIdeaAnalysisSettlement({
    outcome: input.outcome,
    reservedMicroUsd: hold.reservedMicroUsd.toString(),
    inputTokensCap: hold.inputTokensCap, outputTokensCap: hold.outputTokensCap,
    inputMicroUsdPerMillion: hold.inputMicroUsdPerMillion,
    outputMicroUsdPerMillion: hold.outputMicroUsdPerMillion,
    inputTokens: input.inputTokens, outputTokens: input.outputTokens,
  });
  if (decision.decision !== "settlement_candidate") {
    throw new AmuxIdeaAnalysisSettlementError("usage_hold", decision.reason);
  }
  const settled = BigInt(decision.settledMicroUsd);
  const auditId = await writeSystemAuditLog({
    tx, systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
    action: AMUX_V4_ANALYSIS_BUDGET_SETTLE_ACTION,
    targetType: AMUX_V4_ANALYSIS_BUDGET_SETTLE_TARGET,
    targetId: hold.id,
    summary: "Settled one known AMUX v4 analysis invocation against its Agent-only reservation.",
    metadata: { previewId: preview.id, namespace: hold.namespace,
      monthStart: hold.monthStart.toISOString(), mode: hold.mode,
      provider: hold.provider, modelId: hold.modelId,
      amountMeaning: hold.mode === "subscription_cli" ? "cli_api_conversion_estimate" :
        "api_price_estimate", status: decision.status,
      inputTokens: input.inputTokens, outputTokens: input.outputTokens,
      settledMicroUsd: decision.settledMicroUsd,
      releasedMicroUsd: decision.releasedMicroUsd },
  });
  const window = await tx.amuxIdeaAnalysisBudgetWindow.updateMany({
    where: { namespace: hold.namespace, monthStart: hold.monthStart,
      spentMicroUsd: windowLock[0]!.spentMicroUsd,
      reservedMicroUsd: windowLock[0]!.reservedMicroUsd },
    data: { spentMicroUsd: { increment: settled },
      reservedMicroUsd: { decrement: hold.reservedMicroUsd } },
  });
  const updated = await tx.amuxIdeaAnalysisBudgetHold.updateMany({
    where: { id: hold.id, status: "in_flight", closedAt: null,
      settledMicroUsd: null, inputTokens: null, outputTokens: null },
    data: { status: decision.status, settledMicroUsd: settled,
      inputTokens: input.inputTokens, outputTokens: input.outputTokens,
      closedAt: now },
  });
  if (window.count !== 1 || updated.count !== 1) {
    throw new AmuxIdeaAnalysisSettlementError("integrity_unavailable");
  }
  if (decision.status === "failed") {
    const closedPreview = await tx.amuxIdeaTransferPreview.updateMany({
      where: { id: preview.id, state: "in_flight", consumedAt: { not: null },
        outcomeUnknownAt: null },
      data: { state: "provider_failed" },
    });
    if (closedPreview.count !== 1) {
      throw new AmuxIdeaAnalysisSettlementError("integrity_unavailable");
    }
  }
  return { holdId: hold.id, status: decision.status,
    settledMicroUsd: decision.settledMicroUsd,
    releasedMicroUsd: decision.releasedMicroUsd, auditId };
}
