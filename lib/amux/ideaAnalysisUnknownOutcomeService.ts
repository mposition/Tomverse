import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import {
  AMUX_V4_ANALYSIS_OUTCOME_UNKNOWN_ACTION,
  AMUX_V4_ANALYSIS_OUTCOME_UNKNOWN_TARGET,
  AMUX_V4_IDEA_SYSTEM_ACTOR,
} from "@/lib/adminAuditSystemActors";
import { AMUX_V4_ANALYSIS_NAMESPACE } from "./ideaAnalysisBudgetCore.ts";

const ID = /^[A-Za-z0-9:_-]{1,128}$/;
type UnknownReason = "transport_timeout" | "invocation_unverified" | "usage_unverified";

export class AmuxIdeaAnalysisUnknownOutcomeError extends Error {
  constructor(readonly code: "not_markable" | "integrity_unavailable") {
    super(code);
    this.name = "AmuxIdeaAnalysisUnknownOutcomeError";
  }
}

/** Dark writer for a dispatched attempt whose outcome cannot be proved.
 * It keeps the entire Agent-cost reservation, stops new admissions and leaves
 * the preview in a read-back-only state. A retry is never initiated here. */
export async function commitAmuxIdeaAnalysisUnknownOutcome(
  tx: Prisma.TransactionClient,
  input: { holdId: string; reason: UnknownReason },
): Promise<{ holdId: string; previewId: string; auditId: string }> {
  if (!input || !ID.test(input.holdId) || ![
    "transport_timeout", "invocation_unverified", "usage_unverified",
  ].includes(input.reason)) {
    throw new AmuxIdeaAnalysisUnknownOutcomeError("not_markable");
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
    throw new AmuxIdeaAnalysisUnknownOutcomeError("not_markable");
  }
  // Same order as unused release and known settlement; never lock hold first.
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
    WHERE "id" = ${input.holdId} FOR UPDATE
  `;
  if (previewLock.length !== 1 || windowLock.length !== 1 || holdLock.length !== 1) {
    throw new AmuxIdeaAnalysisUnknownOutcomeError("integrity_unavailable");
  }
  const hold = await tx.amuxIdeaAnalysisBudgetHold.findUnique({
    where: { id: input.holdId },
  });
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
      hold.monthStart.getTime() !== identity.monthStart.getTime() ||
      windowLock[0]!.reservedMicroUsd < hold.reservedMicroUsd) {
    throw new AmuxIdeaAnalysisUnknownOutcomeError("integrity_unavailable");
  }
  if (hold.status !== "in_flight" || hold.dispatchedAt === null ||
      now < hold.dispatchedAt || hold.closedAt !== null ||
      hold.settledMicroUsd !== null || hold.inputTokens !== null ||
      hold.outputTokens !== null || preview.state !== "in_flight" ||
      preview.consumedAt === null || preview.outcomeUnknownAt !== null) {
    throw new AmuxIdeaAnalysisUnknownOutcomeError("not_markable");
  }
  const auditId = await writeSystemAuditLog({
    tx, systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
    action: AMUX_V4_ANALYSIS_OUTCOME_UNKNOWN_ACTION,
    targetType: AMUX_V4_ANALYSIS_OUTCOME_UNKNOWN_TARGET,
    targetId: hold.id,
    summary: "Held an uncertain AMUX v4 analysis result and its full Agent-cost reservation.",
    metadata: { previewId: preview.id, reason: input.reason,
      reservedMicroUsd: hold.reservedMicroUsd.toString(), retryAllowed: false },
  });
  const previewUpdated = await tx.amuxIdeaTransferPreview.updateMany({
    where: { id: preview.id, state: "in_flight", consumedAt: { not: null },
      outcomeUnknownAt: null },
    data: { state: "outcome_unknown", outcomeUnknownAt: now },
  });
  const holdUpdated = await tx.amuxIdeaAnalysisBudgetHold.updateMany({
    where: { id: hold.id, status: "in_flight", closedAt: null,
      settledMicroUsd: null, inputTokens: null, outputTokens: null },
    data: { status: "outcome_unknown" },
  });
  if (previewUpdated.count !== 1 || holdUpdated.count !== 1) {
    throw new AmuxIdeaAnalysisUnknownOutcomeError("integrity_unavailable");
  }
  return { holdId: hold.id, previewId: preview.id, auditId };
}
