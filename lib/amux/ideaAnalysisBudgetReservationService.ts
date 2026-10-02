import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { auditRowActorKind,
  AMUX_V4_IDEA_SYSTEM_ACTOR,
  AMUX_V4_ANALYSIS_BUDGET_RESERVE_ACTION,
  AMUX_V4_ANALYSIS_BUDGET_RESERVE_TARGET } from "@/lib/adminAuditSystemActors";
import { assessAmuxIdeaAnalysisBudget,
  AMUX_V4_ANALYSIS_MONTHLY_CAP_MICROUSD,
  AMUX_V4_ANALYSIS_NAMESPACE,
  type AmuxIdeaAnalysisBudgetBasis } from "./ideaAnalysisBudgetCore.ts";

/** This transaction body is not a claim or a dispatch permission. It accepts
 * prices and cap evidence only from a future server-owned, versioned resolver;
 * no route, CLI runner or switch calls it. A dispatch must separately prove
 * that the confirmed encrypted selection, Frontier approval, price source,
 * token caps and global halt state are still current. */
export const AMUX_V4_ANALYSIS_BUDGET_RESERVE_CODE_LATCH = false;
const ID = /^[A-Za-z0-9:_-]{1,128}$/;

export type AmuxIdeaAnalysisReservationPricing = Pick<AmuxIdeaAnalysisBudgetBasis,
  "mode" | "provider" | "modelId" | "pricingVersion" |
  "pricingVerifiedAt" | "pricingExpiresAt" | "worstTierVerified" |
  "tokenCapsEnforceable" | "billableToolsDisabled" | "inputTokensCap" |
  "outputTokensCap" | "inputMicroUsdPerMillion" | "outputMicroUsdPerMillion">;

export class AmuxIdeaAnalysisReservationError extends Error {
  constructor(readonly code: "not_ready" | "budget_unavailable" |
    "budget_hold" | "already_reserved" | "integrity_unavailable",
    readonly reason?: string) {
    super(reason ? `${code}:${reason}` : code);
    this.name = "AmuxIdeaAnalysisReservationError";
  }
}

type Tx = Prisma.TransactionClient;
function refuse(code: AmuxIdeaAnalysisReservationError["code"], reason?: string): never {
  throw new AmuxIdeaAnalysisReservationError(code, reason);
}

export async function commitAmuxIdeaAnalysisBudgetReservation(tx: Tx, input: {
  holdId: string;
  previewId: string;
  /** Never sourced from the Agent request. The future caller must load the
   * approved price and runner-capability snapshots inside this transaction. */
  pricing: AmuxIdeaAnalysisReservationPricing;
}): Promise<{ holdId: string; previewId: string; reservedMicroUsd: string;
  auditId: string }> {
  if (!ID.test(input.holdId) || !ID.test(input.previewId)) refuse("not_ready");
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const identity = await tx.amuxIdeaTransferPreview.findUnique({
    where: { id: input.previewId },
    select: { ideaId: true, chunkIndex: true },
  });
  if (!identity || identity.chunkIndex !== 0) refuse("not_ready");
  const ideaLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaSubmission"
    WHERE "id" = ${identity.ideaId} FOR UPDATE
  `;
  if (ideaLock.length !== 1) refuse("not_ready");
  const chunkLock = await tx.$queryRaw<Array<{ chunkIndex: number }>>`
    SELECT "chunkIndex" FROM "AmuxIdeaAnalysisChunk"
    WHERE "ideaId" = ${identity.ideaId} AND "chunkIndex" = 0 FOR UPDATE
  `;
  if (chunkLock.length !== 1) refuse("not_ready");
  const previewLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaTransferPreview"
    WHERE "id" = ${input.previewId} AND "ideaId" = ${identity.ideaId}
    FOR UPDATE
  `;
  if (previewLock.length !== 1) refuse("not_ready");
  const clock = await tx.$queryRaw<Array<{ persistedNow: Date; utcNow: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "persistedNow",
           clock_timestamp() AS "utcNow"
  `;
  // Existing AMUX timestamp columns are UTC stored as timestamp-without-zone.
  // The Prisma adapter reads those in the host timezone, so compare like with
  // like. Use the absolute timestamptz clock only for UTC month and price TTL.
  const persistedNow = clock[0]?.persistedNow;
  const now = clock[0]?.utcNow;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !(persistedNow instanceof Date) || !Number.isFinite(persistedNow.getTime())) {
    refuse("integrity_unavailable");
  }
  const idea = await tx.amuxIdeaSubmission.findUnique({ where: { id: identity.ideaId } });
  const chunk = await tx.amuxIdeaAnalysisChunk.findUnique({
    where: { ideaId_chunkIndex: { ideaId: identity.ideaId, chunkIndex: 0 } },
  });
  const preview = await tx.amuxIdeaTransferPreview.findUnique({
    where: { id: input.previewId },
  });
  if (!idea || !chunk || !preview || idea.state !== "submitted" ||
      persistedNow >= idea.analysisDeadlineAt ||
      !idea.currentSourcePlanRevisionId ||
      chunk.state !== "awaiting_preview" ||
      chunk.currentPreviewId !== preview.id ||
      chunk.attempt !== preview.attempt ||
      chunk.sourcePlanRevisionId !== idea.currentSourcePlanRevisionId ||
      preview.ideaId !== idea.id || preview.chunkIndex !== 0 ||
      preview.sourcePlanRevisionId !== idea.currentSourcePlanRevisionId ||
      preview.sourceScopeApprovalId !== null ||
      preview.sourceUnitOrdinal !== 0 ||
      preview.state !== "confirmed" || !preview.confirmedAt ||
      !preview.confirmedByUserId || !preview.confirmationAuditLogId ||
      preview.consumedAt !== null || preview.outcomeUnknownAt !== null ||
      !preview.payloadCiphertext || preview.payloadPurgedAt !== null ||
      !preview.confirmExpiresAt || persistedNow >= preview.confirmExpiresAt ||
      persistedNow >= preview.expiresAt || preview.modelId !== input.pricing.modelId) {
    refuse("not_ready");
  }
  const plan = await tx.amuxIdeaSourcePlanRevision.findUnique({
    where: { id: idea.currentSourcePlanRevisionId },
  });
  const confirmation = await tx.adminAuditLog.findUnique({
    where: { id: preview.confirmationAuditLogId },
  });
  const confirmationMetadata = confirmation?.metadata;
  if (!plan || plan.state !== "active" || plan.ideaId !== idea.id ||
      plan.sourceUnitCount !== 1 || plan.startChunkIndex !== 0 ||
      !confirmation?.entryHash ||
      confirmation.action !== "amux.v4.transfer_preview.confirmed" ||
      confirmation.targetType !== "AmuxIdeaTransferPreview" ||
      confirmation.targetId !== preview.id ||
      confirmation.actorUserId !== preview.confirmedByUserId ||
      auditRowActorKind(confirmation) !== "human" ||
      !confirmationMetadata || typeof confirmationMetadata !== "object" ||
      Array.isArray(confirmationMetadata) ||
      (confirmationMetadata as Record<string, unknown>).payloadDigest !== preview.payloadDigest ||
      (confirmationMetadata as Record<string, unknown>).payloadDigestKeyId !== preview.payloadDigestKeyId ||
      (confirmationMetadata as Record<string, unknown>).sourcePlanRevisionId !== preview.sourcePlanRevisionId ||
      (confirmationMetadata as Record<string, unknown>).modelId !== preview.modelId) {
    refuse("integrity_unavailable");
  }
  if (await tx.amuxIdeaAnalysisBudgetHold.findUnique({
    where: { previewId: preview.id }, select: { id: true },
  })) refuse("already_reserved");
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lockedWindow = await tx.$queryRaw<Array<{
    spentMicroUsd: bigint; reservedMicroUsd: bigint; limitMicroUsd: bigint;
  }>>`
    SELECT "spentMicroUsd", "reservedMicroUsd", "limitMicroUsd"
    FROM "AmuxIdeaAnalysisBudgetWindow"
    WHERE "namespace" = ${AMUX_V4_ANALYSIS_NAMESPACE}
      AND "monthStart" = ${monthStart}
    FOR UPDATE
  `;
  const window = lockedWindow[0];
  if (!window || window.limitMicroUsd !== BigInt(AMUX_V4_ANALYSIS_MONTHLY_CAP_MICROUSD)) {
    refuse("budget_unavailable");
  }
  const unknown = await tx.amuxIdeaAnalysisBudgetHold.findFirst({
    where: { namespace: AMUX_V4_ANALYSIS_NAMESPACE, status: "outcome_unknown" },
    select: { id: true },
  });
  const decision = assessAmuxIdeaAnalysisBudget({
    ...input.pricing,
    namespace: AMUX_V4_ANALYSIS_NAMESPACE,
    asOfIso: now.toISOString(),
    windowStartsAtIso: monthStart.toISOString(),
    consumedMicroUsd: window.spentMicroUsd.toString(),
    reservedMicroUsd: window.reservedMicroUsd.toString(),
    usageState: unknown ? "unknown" : "known",
  });
  if (decision.decision !== "reservation_candidate") refuse("budget_hold", decision.reason);
  const reserve = BigInt(decision.worstCaseMicroUsd);
  const auditId = await writeSystemAuditLog({
    tx, systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
    action: AMUX_V4_ANALYSIS_BUDGET_RESERVE_ACTION,
    targetType: AMUX_V4_ANALYSIS_BUDGET_RESERVE_TARGET,
    targetId: input.holdId,
    summary: "Reserved one AMUX v4 analysis Agent cost ceiling; no model was called.",
    metadata: { previewId: preview.id, namespace: AMUX_V4_ANALYSIS_NAMESPACE,
      monthStart: monthStart.toISOString(), provider: decision.provider,
      modelId: decision.modelId, pricingVersion: decision.pricingVersion,
      reservedMicroUsd: decision.worstCaseMicroUsd,
      amountMeaning: decision.amountMeaning, modelCallStarted: false },
  });
  const updated = await tx.amuxIdeaAnalysisBudgetWindow.updateMany({
    where: { namespace: AMUX_V4_ANALYSIS_NAMESPACE, monthStart,
      spentMicroUsd: window.spentMicroUsd,
      reservedMicroUsd: window.reservedMicroUsd },
    data: { reservedMicroUsd: { increment: reserve } },
  });
  if (updated.count !== 1) refuse("budget_unavailable");
  await tx.amuxIdeaAnalysisBudgetHold.create({ data: {
    id: input.holdId, previewId: preview.id,
    namespace: AMUX_V4_ANALYSIS_NAMESPACE, monthStart,
    mode: decision.mode, provider: decision.provider, modelId: decision.modelId,
    pricingVersion: decision.pricingVersion,
    inputTokensCap: input.pricing.inputTokensCap,
    outputTokensCap: input.pricing.outputTokensCap,
    inputMicroUsdPerMillion: input.pricing.inputMicroUsdPerMillion,
    outputMicroUsdPerMillion: input.pricing.outputMicroUsdPerMillion,
    reservedMicroUsd: reserve, status: "reserved",
  } });
  return { holdId: input.holdId, previewId: preview.id,
    reservedMicroUsd: decision.worstCaseMicroUsd, auditId };
}
