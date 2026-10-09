import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { auditRowActorKind } from "@/lib/adminAuditSystemActors";
import { openAmuxContent, verifyAmuxContentDigest,
  type AmuxContentKeys } from "./ideaCrypto.ts";
import { assessAmuxIdeaAnalysisBudget,
  AMUX_V4_ANALYSIS_MONTHLY_CAP_MICROUSD,
  AMUX_V4_ANALYSIS_NAMESPACE } from "./ideaAnalysisBudgetCore.ts";
import { readApprovedAmuxIdeaAnalysisPriceVersion } from "./ideaAnalysisPriceVersionRead.ts";
import { writeAmuxAnalysisBudgetSystemAudit } from "./ideaAnalysisBudgetSystemAudit.ts";

/** This reservation service is not a claim or a dispatch permission. The
 * owner-only reservation route calls it after its independent environment
 * switch; no CLI runner or switch calls it directly. A dispatch must separately
 * prove that the selected Frontier approval, runner capability, token caps and
 * halt state are current. */
export const AMUX_V4_ANALYSIS_BUDGET_RESERVE_CODE_LATCH = true;
const ID = /^[A-Za-z0-9:_-]{1,128}$/;

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
  session: Session;
  request: Request;
  holdId: string;
  previewId: string;
  priceVersionId: string;
  /** The future caller must derive both facts from a measured, isolated runner
   * profile; these booleans are not accepted from an Agent HTTP request. */
  runner: { tokenCapsEnforceable: boolean; billableToolsDisabled: boolean };
  keys: AmuxContentKeys;
}): Promise<{ holdId: string; previewId: string; reservedMicroUsd: string;
  auditId: string }> {
  if (!ID.test(input.holdId) || !ID.test(input.previewId) ||
      !ID.test(input.priceVersionId)) refuse("not_ready");
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const identity = await tx.amuxIdeaTransferPreview.findUnique({
    where: { id: input.previewId },
    select: { ideaId: true, chunkIndex: true },
  });
  if (!identity) refuse("not_ready");
  const ideaLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaSubmission"
    WHERE "id" = ${identity.ideaId} FOR UPDATE
  `;
  if (ideaLock.length !== 1) refuse("not_ready");
  const chunkLock = await tx.$queryRaw<Array<{ chunkIndex: number }>>`
    SELECT "chunkIndex" FROM "AmuxIdeaAnalysisChunk"
    WHERE "ideaId" = ${identity.ideaId}
      AND "chunkIndex" = ${identity.chunkIndex} FOR UPDATE
  `;
  if (chunkLock.length !== 1) refuse("not_ready");
  const previewLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaTransferPreview"
    WHERE "id" = ${input.previewId} AND "ideaId" = ${identity.ideaId}
    FOR UPDATE
  `;
  if (previewLock.length !== 1) refuse("not_ready");
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  // The raw adapter on this host misreads a returned timestamptz as local
  // wall time. AMUX timestamps use UTC timestamp-without-zone, so normalize
  // the DB clock to that same representation before comparing TTL or month.
  const now = clock[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    refuse("integrity_unavailable");
  }
  const idea = await tx.amuxIdeaSubmission.findUnique({ where: { id: identity.ideaId } });
  const chunk = await tx.amuxIdeaAnalysisChunk.findUnique({
    where: { ideaId_chunkIndex: { ideaId: identity.ideaId,
      chunkIndex: identity.chunkIndex } },
  });
  const preview = await tx.amuxIdeaTransferPreview.findUnique({
    where: { id: input.previewId },
  });
  if (!idea || !chunk || !preview ||
      idea.state !== (identity.chunkIndex === 0 ? "submitted" : "analyzing") ||
      !input.session.user?.id || !isAdminSession(input.session) ||
      getAdminRole(input.session) !== "owner" ||
      input.session.user.id !== idea.actorUserId ||
      input.session.user.id !== preview.confirmedByUserId ||
      now >= idea.analysisDeadlineAt ||
      !idea.currentSourcePlanRevisionId ||
      chunk.state !== "awaiting_preview" ||
      chunk.currentPreviewId !== preview.id ||
      chunk.attempt !== preview.attempt ||
      chunk.sourcePlanRevisionId !== idea.currentSourcePlanRevisionId ||
      preview.ideaId !== idea.id || preview.chunkIndex !== identity.chunkIndex ||
      preview.sourcePlanRevisionId !== idea.currentSourcePlanRevisionId ||
      preview.sourceScopeApprovalId !== null ||
      preview.sourceUnitOrdinal !== 0 ||
      preview.state !== "confirmed" || !preview.confirmedAt ||
      !preview.confirmedByUserId || !preview.confirmationAuditLogId ||
      preview.consumedAt !== null || preview.outcomeUnknownAt !== null ||
      !preview.payloadCiphertext || !preview.payloadKeyId ||
      !preview.payloadKeyVersion || preview.payloadPurgedAt !== null ||
      !preview.confirmExpiresAt || now >= preview.confirmExpiresAt ||
      now >= preview.expiresAt) {
    refuse("not_ready");
  }
  const plan = await tx.amuxIdeaSourcePlanRevision.findUnique({
    where: { id: idea.currentSourcePlanRevisionId },
  });
  const confirmation = await tx.adminAuditLog.findUnique({
    where: { id: preview.confirmationAuditLogId },
  });
  const preparedRows = await tx.adminAuditLog.findMany({
    where: { action: "amux.v4.transfer_preview.prepared",
      targetType: "AmuxIdeaTransferPreview", targetId: preview.id,
      actorUserId: idea.actorUserId },
    take: 2,
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
  const prepared = preparedRows[0];
  const preparedMetadata = prepared?.metadata;
  if (preparedRows.length !== 1 || !prepared?.entryHash ||
      auditRowActorKind(prepared) !== "human" ||
      !preparedMetadata || typeof preparedMetadata !== "object" ||
      Array.isArray(preparedMetadata) ||
      (preparedMetadata as Record<string, unknown>).ideaId !== idea.id ||
      (preparedMetadata as Record<string, unknown>).chunkIndex !== identity.chunkIndex ||
      (preparedMetadata as Record<string, unknown>).sourcePlanRevisionId !==
        preview.sourcePlanRevisionId ||
      (preparedMetadata as Record<string, unknown>).payloadDigest !== preview.payloadDigest ||
      (preparedMetadata as Record<string, unknown>).payloadDigestKeyId !==
        preview.payloadDigestKeyId ||
      (preparedMetadata as Record<string, unknown>).transferAuthorized !== false) {
    refuse("integrity_unavailable");
  }
  let raw: Buffer;
  let confirmedProvider: unknown;
  let confirmedModelId: unknown;
  try {
    raw = openAmuxContent({ ciphertext: Buffer.from(preview.payloadCiphertext),
      keyId: preview.payloadKeyId, keyVersion: preview.payloadKeyVersion },
    "transfer_payload", preview.id, input.keys);
  } catch { refuse("integrity_unavailable"); }
  try {
    if (!verifyAmuxContentDigest(raw, "transfer_payload", preview.id,
      preview.payloadDigest, preview.payloadDigestKeyId, input.keys)) {
      refuse("integrity_unavailable");
    }
    const payload: unknown = JSON.parse(raw.toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      refuse("integrity_unavailable");
    }
    const record = payload as Record<string, unknown>;
    const selection = record.selection;
    if (record.version !== (identity.chunkIndex === 0 ? 1 : 2) ||
        (identity.chunkIndex > 0 && record.chunkIndex !== identity.chunkIndex) ||
        record.previewId !== preview.id ||
        record.ideaId !== idea.id || record.templateVersion !== preview.templateVersion ||
        typeof record.prompt !== "string" ||
        !record.prompt.includes(`"previewId":"${preview.id}"`) ||
        !selection || typeof selection !== "object" || Array.isArray(selection)) {
      refuse("integrity_unavailable");
    }
    const choice = selection as Record<string, unknown>;
    if (typeof choice.provider !== "string" ||
        choice.modelId !== preview.modelId ||
        choice.approvalId !==
          (preparedMetadata as Record<string, unknown>).modelApprovalId ||
        choice.approvalVersion !==
          (preparedMetadata as Record<string, unknown>).modelApprovalVersion) {
      refuse("integrity_unavailable");
    }
    confirmedProvider = choice.provider;
    confirmedModelId = choice.modelId;
  } catch {
    refuse("integrity_unavailable");
  } finally { raw.fill(0); }
  const priceRead = await readApprovedAmuxIdeaAnalysisPriceVersion(tx, {
    priceVersionId: input.priceVersionId,
    provider: confirmedProvider, modelId: confirmedModelId, now,
  });
  if (priceRead.decision !== "ready") refuse("budget_hold", priceRead.reason);
  const pricing = priceRead.price;
  if (await tx.amuxIdeaAnalysisBudgetHold.findUnique({
    where: { previewId: preview.id }, select: { id: true },
  })) refuse("already_reserved");
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  // First reservation in a UTC month creates its own capped ledger row. The
  // audit-chain lock serializes this with other reservation writers, while
  // the unique month key remains the database backstop.
  await tx.amuxIdeaAnalysisBudgetWindow.createMany({
    data: [{ namespace: AMUX_V4_ANALYSIS_NAMESPACE, monthStart,
      limitMicroUsd: BigInt(AMUX_V4_ANALYSIS_MONTHLY_CAP_MICROUSD),
      spentMicroUsd: BigInt(0), reservedMicroUsd: BigInt(0) }],
    skipDuplicates: true,
  });
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
    ...pricing,
    ...input.runner,
    namespace: AMUX_V4_ANALYSIS_NAMESPACE,
    asOfIso: now.toISOString(),
    windowStartsAtIso: monthStart.toISOString(),
    consumedMicroUsd: window.spentMicroUsd.toString(),
    reservedMicroUsd: window.reservedMicroUsd.toString(),
    usageState: unknown ? "unknown" : "known",
  });
  if (decision.decision !== "reservation_candidate") refuse("budget_hold", decision.reason);
  const reserve = BigInt(decision.worstCaseMicroUsd);
  const auditId = await writeAmuxAnalysisBudgetSystemAudit({
    tx, holdId: input.holdId, previewId: preview.id,
    monthStartIso: monthStart.toISOString(), provider: decision.provider,
    modelId: decision.modelId, pricingVersion: decision.pricingVersion,
    priceVersionId: input.priceVersionId,
    reservedMicroUsd: decision.worstCaseMicroUsd,
    amountMeaning: decision.amountMeaning,
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
    priceVersionId: input.priceVersionId,
    inputTokensCap: pricing.inputTokensCap,
    outputTokensCap: pricing.outputTokensCap,
    inputMicroUsdPerMillion: pricing.inputMicroUsdPerMillion,
    outputMicroUsdPerMillion: pricing.outputMicroUsdPerMillion,
    reservedMicroUsd: reserve, status: "reserved",
  } });
  await writeAdminAuditLog({
    tx, session: input.session, request: input.request,
    action: "amux.v4.analysis_budget.reserved",
    targetType: "AmuxIdeaAnalysisBudgetHold", targetId: input.holdId,
    summary: "Owner reserved one bounded AMUX v4 Agent analysis cost ceiling.",
    metadata: { previewId: preview.id, priceVersionId: input.priceVersionId,
      systemAuditId: auditId, reservedMicroUsd: decision.worstCaseMicroUsd,
      namespace: AMUX_V4_ANALYSIS_NAMESPACE, modelCallStarted: false },
  });
  return { holdId: input.holdId, previewId: preview.id,
    reservedMicroUsd: decision.worstCaseMicroUsd, auditId };
}
