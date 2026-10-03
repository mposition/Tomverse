import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { auditRowActorKind, AMUX_V4_ANALYSIS_CLAIM_ACTION,
  AMUX_V4_ANALYSIS_CLAIM_TARGET,
  AMUX_V4_ANALYSIS_BUDGET_SETTLE_ACTION,
  AMUX_V4_ANALYSIS_BUDGET_SETTLE_TARGET,
  AMUX_V4_IDEA_SYSTEM_ACTOR } from
  "@/lib/adminAuditSystemActors";
import { AMUX_V4_ANALYSIS_NAMESPACE } from "./ideaAnalysisBudgetCore.ts";
import { readApprovedAmuxIdeaAnalysisPriceVersion } from
  "./ideaAnalysisPriceVersionRead.ts";
import { openAmuxContent, verifyAmuxContentDigest,
  type AmuxContentKeys } from "./ideaCrypto.ts";
import { checkAmuxIdeaTransferReceipt } from "./ideaTransferReceiptCore.ts";

const ID = /^[A-Za-z0-9:_-]{1,128}$/;

export class AmuxIdeaAnalysisClaimError extends Error {
  constructor(readonly code: "not_ready" | "integrity_unavailable") {
    super(code);
    this.name = "AmuxIdeaAnalysisClaimError";
  }
}

/** First idea-only attempt. This transaction body has no enabled route and
 * cannot itself launch a CLI. It consumes one owner confirmation and one
 * already-reserved Agent budget hold, then gives the local supervisor only
 * the exact verified prompt. A lost claim response is outcome-unknown: the
 * caller must read back by previewId and must not claim again. */
export async function commitAmuxIdeaOnlyAnalysisClaim(
  tx: Prisma.TransactionClient,
  input: { previewId: string; keys: AmuxContentKeys },
): Promise<{ previewId: string; ideaId: string; holdId: string;
  leaseGeneration: 1; provider: "openai" | "anthropic"; modelId: string;
  reasoningEffort: string; prompt: string; auditId: string }> {
  if (!input || !ID.test(input.previewId)) {
    throw new AmuxIdeaAnalysisClaimError("not_ready");
  }
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const identity = await tx.amuxIdeaTransferPreview.findUnique({
    where: { id: input.previewId },
    select: { ideaId: true, chunkIndex: true },
  });
  if (!identity || identity.chunkIndex !== 0) {
    throw new AmuxIdeaAnalysisClaimError("not_ready");
  }
  const ideaLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaSubmission"
    WHERE "id" = ${identity.ideaId} FOR UPDATE
  `;
  const chunkLock = await tx.$queryRaw<Array<{ chunkIndex: number }>>`
    SELECT "chunkIndex" FROM "AmuxIdeaAnalysisChunk"
    WHERE "ideaId" = ${identity.ideaId} AND "chunkIndex" = 0 FOR UPDATE
  `;
  const previewLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaTransferPreview"
    WHERE "id" = ${input.previewId} FOR UPDATE
  `;
  if (ideaLock.length !== 1 || chunkLock.length !== 1 || previewLock.length !== 1) {
    throw new AmuxIdeaAnalysisClaimError("not_ready");
  }
  const idea = await tx.amuxIdeaSubmission.findUnique({ where: { id: identity.ideaId } });
  const chunk = await tx.amuxIdeaAnalysisChunk.findUnique({
      where: { ideaId_chunkIndex: { ideaId: identity.ideaId, chunkIndex: 0 } },
    });
  const preview = await tx.amuxIdeaTransferPreview.findUnique({
    where: { id: input.previewId },
  });
  const hold = await tx.amuxIdeaAnalysisBudgetHold.findUnique({
    where: { previewId: input.previewId },
  });
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
    `;
  const now = clock[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !idea || !chunk || !preview || !hold) {
    throw new AmuxIdeaAnalysisClaimError("integrity_unavailable");
  }
  if (idea.state !== "submitted" || idea.cancelledAt !== null ||
      idea.analysisCompletedAt !== null || now >= idea.analysisDeadlineAt ||
      !idea.currentSourcePlanRevisionId ||
      chunk.state !== "awaiting_preview" || chunk.chunkIndex !== 0 ||
      chunk.attempt !== preview.attempt || chunk.leaseGeneration !== 0 ||
      chunk.currentPreviewId !== preview.id ||
      chunk.sourcePlanRevisionId !== idea.currentSourcePlanRevisionId ||
      preview.sourcePlanRevisionId !== idea.currentSourcePlanRevisionId ||
      preview.sourceScopeApprovalId !== null || preview.sourceUnitOrdinal !== 0 ||
      !preview.payloadCiphertext || !preview.payloadKeyId ||
      !preview.payloadKeyVersion || !preview.payloadDigestKeyId ||
      !preview.confirmationAuditLogId || !preview.confirmedByUserId ||
      preview.confirmedByUserId !== idea.actorUserId ||
      hold.status !== "reserved" || hold.dispatchedAt !== null ||
      hold.closedAt !== null || hold.namespace !== AMUX_V4_ANALYSIS_NAMESPACE ||
      hold.modelId !== preview.modelId || !hold.priceVersionId ||
      hold.reservedMicroUsd <= BigInt(0)) {
    throw new AmuxIdeaAnalysisClaimError("not_ready");
  }
  if (preview.state !== "confirmed") throw new AmuxIdeaAnalysisClaimError("not_ready");
  const receipt = checkAmuxIdeaTransferReceipt({ ...preview,
    state: preview.state as "confirmed" }, {
    previewId: preview.id, ideaId: idea.id,
    sourceScopeApprovalId: null, chunkIndex: 0, attempt: preview.attempt,
    actorUserId: idea.actorUserId, modelId: preview.modelId,
    payloadDigest: preview.payloadDigest,
    payloadDigestKeyId: preview.payloadDigestKeyId, databaseNow: now,
  });
  if (receipt.decision !== "receipt_current" ||
      !preview.payloadPurgeAfter || now >= preview.payloadPurgeAfter) {
    throw new AmuxIdeaAnalysisClaimError("not_ready");
  }
  const plan = await tx.amuxIdeaSourcePlanRevision.findUnique({
    where: { id: idea.currentSourcePlanRevisionId },
  });
  const audit = await tx.adminAuditLog.findUnique({
    where: { id: preview.confirmationAuditLogId },
  });
  const metadata = audit?.metadata;
  if (!plan || plan.ideaId !== idea.id || plan.state !== "active" ||
      plan.sourceUnitCount !== 1 || plan.revisionNumber !== 1 ||
      plan.startChunkIndex !== 0 ||
      !audit?.entryHash || auditRowActorKind(audit) !== "human" ||
      audit.actorUserId !== idea.actorUserId ||
      audit.action !== "amux.v4.transfer_preview.confirmed" ||
      audit.targetType !== "AmuxIdeaTransferPreview" ||
      audit.targetId !== preview.id ||
      !metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
      (metadata as Record<string, unknown>).payloadDigest !== preview.payloadDigest ||
      (metadata as Record<string, unknown>).payloadDigestKeyId !==
        preview.payloadDigestKeyId ||
      (metadata as Record<string, unknown>).sourcePlanRevisionId !== plan.id ||
      (metadata as Record<string, unknown>).modelId !== preview.modelId) {
    throw new AmuxIdeaAnalysisClaimError("integrity_unavailable");
  }
  let raw: Buffer;
  try {
    raw = openAmuxContent({ ciphertext: Buffer.from(preview.payloadCiphertext),
      keyId: preview.payloadKeyId, keyVersion: preview.payloadKeyVersion },
    "transfer_payload", preview.id, input.keys);
  } catch { throw new AmuxIdeaAnalysisClaimError("integrity_unavailable"); }
  try {
    if (!verifyAmuxContentDigest(raw, "transfer_payload", preview.id,
      preview.payloadDigest, preview.payloadDigestKeyId, input.keys)) {
      throw new AmuxIdeaAnalysisClaimError("integrity_unavailable");
    }
    const decoded: unknown = JSON.parse(raw.toString("utf8"));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new AmuxIdeaAnalysisClaimError("integrity_unavailable");
    }
    const payload = decoded as Record<string, unknown>;
    const selection = payload.selection;
    if (payload.version !== 1 || payload.previewId !== preview.id ||
        payload.ideaId !== idea.id || payload.templateVersion !== preview.templateVersion ||
        typeof payload.prompt !== "string" ||
        Buffer.byteLength(payload.prompt, "utf8") > 32_768 ||
        !payload.prompt.includes(`"previewId":"${preview.id}"`) ||
        !selection || typeof selection !== "object" || Array.isArray(selection)) {
      throw new AmuxIdeaAnalysisClaimError("integrity_unavailable");
    }
    const selected = selection as Record<string, unknown>;
    if ((selected.provider !== "openai" && selected.provider !== "anthropic") ||
        selected.modelId !== preview.modelId ||
        typeof selected.reasoningEffort !== "string" ||
        typeof selected.approvalId !== "string" ||
        !Number.isSafeInteger(selected.approvalVersion) ||
        (selected.approvalVersion as number) < 1 ||
        hold.provider !== selected.provider) {
      throw new AmuxIdeaAnalysisClaimError("integrity_unavailable");
    }
    const approved = await tx.amuxIdeaFrontierModelApproval.findUnique({
      where: { id: selected.approvalId },
    });
    const latest = await tx.amuxIdeaFrontierModelApproval.findFirst({
      where: { provider: selected.provider, modelId: preview.modelId },
      orderBy: { version: "desc" }, select: { version: true },
    });
    const modelAudit = approved ? await tx.adminAuditLog.findUnique({
      where: { id: approved.approvalAuditLogId },
    }) : null;
    const modelMetadata = modelAudit?.metadata;
    if (!approved || approved.status !== "approved" || approved.revokedAt !== null ||
        approved.provider !== selected.provider || approved.modelId !== preview.modelId ||
        approved.version !== selected.approvalVersion ||
        latest?.version !== approved.version || approved.approvedAt > now ||
        !approved.allowedEfforts.includes(selected.reasoningEffort) ||
        !modelAudit?.entryHash || auditRowActorKind(modelAudit) !== "human" ||
        modelAudit.actorUserId !== approved.approvedByUserId ||
        modelAudit.action !== "amux.idea.frontier_model.approved" ||
        modelAudit.targetType !== "AmuxIdeaFrontierModelApproval" ||
        modelAudit.targetId !== approved.id ||
        !modelMetadata || typeof modelMetadata !== "object" ||
        Array.isArray(modelMetadata) ||
        (modelMetadata as Record<string, unknown>).provider !== approved.provider ||
        (modelMetadata as Record<string, unknown>).modelId !== approved.modelId ||
        (modelMetadata as Record<string, unknown>).version !== approved.version) {
      throw new AmuxIdeaAnalysisClaimError("not_ready");
    }
    const price = await readApprovedAmuxIdeaAnalysisPriceVersion(tx, {
      priceVersionId: hold.priceVersionId,
      provider: selected.provider, modelId: preview.modelId, now,
    });
    if (price.decision !== "ready" || price.price.mode !== hold.mode ||
        price.price.inputTokensCap !== hold.inputTokensCap ||
        price.price.outputTokensCap !== hold.outputTokensCap ||
        price.price.pricingVersion !== hold.pricingVersion) {
      throw new AmuxIdeaAnalysisClaimError("not_ready");
    }
    const unknown = await tx.amuxIdeaAnalysisBudgetHold.findFirst({
      where: { namespace: AMUX_V4_ANALYSIS_NAMESPACE, status: "outcome_unknown" },
      select: { id: true },
    });
    if (unknown) throw new AmuxIdeaAnalysisClaimError("not_ready");
    // A lost result POST/read-back can leave the prior hold in_flight. Until
    // owner resolution, admit at most one analysis invocation Agent-wide.
    const active = await tx.amuxIdeaAnalysisBudgetHold.findFirst({ where: {
      namespace: AMUX_V4_ANALYSIS_NAMESPACE, status: "in_flight",
      id: { not: hold.id },
    }, select: { id: true } });
    if (active) throw new AmuxIdeaAnalysisClaimError("not_ready");
    // Canonical settlement entries are strictly ordered by the audit writer's
    // monotonically increasing createdAt. Refusals/cancellations do not count;
    // one verified success breaks a streak. No new claim after three failures.
    const latestSettlements = await tx.adminAuditLog.findMany({ where: {
      action: AMUX_V4_ANALYSIS_BUDGET_SETTLE_ACTION,
      targetType: AMUX_V4_ANALYSIS_BUDGET_SETTLE_TARGET,
    }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 3 });
    if (latestSettlements.some((entry) => {
      const details = entry.metadata;
      return !entry.entryHash || auditRowActorKind(entry) !== "system" ||
        !details || typeof details !== "object" || Array.isArray(details) ||
        (details as Record<string, unknown>).namespace !==
          AMUX_V4_ANALYSIS_NAMESPACE ||
        !["failed", "succeeded"].includes(String(
          (details as Record<string, unknown>).status));
    })) throw new AmuxIdeaAnalysisClaimError("integrity_unavailable");
    if (latestSettlements.length === 3 && latestSettlements.every((entry) =>
      (entry.metadata as Record<string, unknown>).status === "failed")) {
      throw new AmuxIdeaAnalysisClaimError("not_ready");
    }
    const windowLock = await tx.$queryRaw<Array<{ reservedMicroUsd: bigint }>>`
      SELECT "reservedMicroUsd" FROM "AmuxIdeaAnalysisBudgetWindow"
      WHERE "namespace" = ${hold.namespace} AND "monthStart" = ${hold.monthStart}
      FOR UPDATE
    `;
    const holdLock = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "AmuxIdeaAnalysisBudgetHold"
      WHERE "id" = ${hold.id} FOR UPDATE
    `;
    if (windowLock.length !== 1 ||
        windowLock[0]!.reservedMicroUsd < hold.reservedMicroUsd ||
        holdLock.length !== 1) {
      throw new AmuxIdeaAnalysisClaimError("integrity_unavailable");
    }
    const auditId = await writeSystemAuditLog({ tx,
      systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
      action: AMUX_V4_ANALYSIS_CLAIM_ACTION,
      targetType: AMUX_V4_ANALYSIS_CLAIM_TARGET, targetId: preview.id,
      summary: "Consumed one exact owner-confirmed AMUX v4 analysis preview for a fenced local attempt.",
      metadata: { ideaId: idea.id, chunkIndex: 0, previewId: preview.id,
        holdId: hold.id, payloadDigest: preview.payloadDigest,
        sourcePlanRevisionId: plan.id, leaseGeneration: 1,
        modelId: preview.modelId, modelCallStarted: false },
    });
    const consumed = await tx.amuxIdeaTransferPreview.updateMany({
        where: { id: preview.id, state: "confirmed", consumedAt: null,
          confirmExpiresAt: { gt: now } },
        data: { state: "in_flight", consumedAt: now },
    });
    const dispatched = await tx.amuxIdeaAnalysisBudgetHold.updateMany({
        where: { id: hold.id, status: "reserved", dispatchedAt: null },
        data: { status: "in_flight", dispatchedAt: now },
    });
    const startedChunk = await tx.amuxIdeaAnalysisChunk.updateMany({
        where: { ideaId: idea.id, chunkIndex: 0,
          state: "awaiting_preview", leaseGeneration: 0,
          currentPreviewId: preview.id },
        data: { state: "in_flight", leaseGeneration: 1 },
    });
    const startedIdea = await tx.amuxIdeaSubmission.updateMany({
        where: { id: idea.id, state: "submitted", cancelledAt: null,
          analysisDeadlineAt: { gt: now } },
        data: { state: "analyzing" },
    });
    if ([consumed, dispatched, startedChunk, startedIdea]
      .some((row) => row.count !== 1)) {
      throw new AmuxIdeaAnalysisClaimError("not_ready");
    }
    return { previewId: preview.id, ideaId: idea.id, holdId: hold.id,
      leaseGeneration: 1 as const, provider: selected.provider,
      modelId: preview.modelId, reasoningEffort: selected.reasoningEffort,
      prompt: payload.prompt, auditId };
  } catch (error) {
    if (error instanceof AmuxIdeaAnalysisClaimError) throw error;
    throw new AmuxIdeaAnalysisClaimError("integrity_unavailable");
  } finally { raw.fill(0); }
}
