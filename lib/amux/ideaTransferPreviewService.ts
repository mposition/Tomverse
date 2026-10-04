import "server-only";

import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { AMUX_V4_FIRST_DRAFT_SAVED_ACTION,
  AMUX_V4_FIRST_DRAFT_SAVED_TARGET, AMUX_V4_SECOND_DRAFT_SAVED_ACTION,
  AMUX_V4_SECOND_DRAFT_SAVED_TARGET } from "@/lib/adminAuditSystemActors";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { prisma } from "@/lib/prisma";
import { amuxCanonicalJson } from "./boardImportCore.ts";
import { ideaTransferBrowserDigest } from "./ideaTransferBrowserCore.ts";
import {
  amuxContentDigest, openAmuxContent, sealAmuxContent, verifyAmuxContentDigest,
  type AmuxContentKeys,
} from "./ideaCrypto.ts";
import { readCurrentAmuxIdeaFrontierSelection } from "./ideaFrontierCatalogRead.ts";
import { AmuxIdeaAnalysisResultReadError } from "./ideaAnalysisResultReadService.ts";
import { readVerifiedAmuxIdeaAnalysisContinuationContext } from
  "./ideaContinuedAnalysisResultReadService.ts";
import { createAmuxContentKeyRing, loadAmuxContentKeyRing } from "./ideaKeyStore.ts";
import { amuxAnalysisFreeformSubjectId } from "./ideaAnalysisDraftSealCore.ts";
import type { AmuxContentKeyIdentity } from "./ideaKeyStore.ts";
import { inspectAmuxIdeaInput } from "./ideaInputCore.ts";
import {
  AMUX_V4_ANALYSIS_PROMPT_VERSION,
  buildAmuxIdeaAnalysisPrompt,
  buildIdeaOnlyOutputContinuationPrompt,
} from "./ideaAnalysisPromptCore.ts";
import type { AmuxAnalysisChunk } from
  "./ideaAnalysisChunkCore.ts";
import { matchesInitialPlanSystemAudit } from "./ideaInitialPlanAuditCore.ts";
import { buildAmuxSourcePlanManifest } from "./ideaSourcePlanManifestCore.ts";
import {
  AMUX_V4_TRANSFER_PREVIEW_WRITE_ENV,
  transferPreviewWritePermitted,
  type IdeaOnlyTransferPreviewRequest,
} from "./ideaTransferPreviewInputCore.ts";

export class IdeaTransferPreviewError extends Error {
  constructor(readonly code: "not_found" | "not_ready" | "integrity_unavailable" |
    "model_changed" | "preview_disabled" | "outcome_unknown" |
    "reference_selection_required") {
    super(code);
    this.name = "IdeaTransferPreviewError";
  }
}

type PreviewPayload = {
  version: 1;
  previewId: string;
  ideaId: string;
  selection: {
    provider: IdeaOnlyTransferPreviewRequest["provider"];
    modelId: string;
    reasoningEffort: IdeaOnlyTransferPreviewRequest["reasoningEffort"];
    approvalId: string;
    approvalVersion: number;
  };
  templateVersion: typeof AMUX_V4_ANALYSIS_PROMPT_VERSION;
  prompt: string;
};

function ownerId(session: Session): string {
  const id = session.user?.id;
  if (!id || !isAdminSession(session) || getAdminRole(session) !== "owner") {
    throw new IdeaTransferPreviewError("not_found");
  }
  return id;
}

/** One idea-only, non-sending preview. The owner sees the same stored prompt
 * that a future, separately approved runner would have to verify and use. */
export async function commitIdeaOnlyTransferPreview(tx: Prisma.TransactionClient, input: {
  session: Session; request: Request; choice: IdeaOnlyTransferPreviewRequest;
  keys: AmuxContentKeys; browserNonce: string;
}): Promise<{ previewId: string; expiresAt: Date; payload: PreviewPayload;
  payloadDigest: string; payloadDigestKeyId: string }> {
  const actorUserId = ownerId(input.session);
  const { choice } = input;
  await takeAuditChainLock(tx);
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaSubmission"
    WHERE "id" = ${choice.ideaId} AND "actorUserId" = ${actorUserId}
    FOR UPDATE
  `;
  if (locked.length !== 1) throw new IdeaTransferPreviewError("not_found");
  const chunkLock = await tx.$queryRaw<Array<{ chunkIndex: number }>>`
    SELECT "chunkIndex" FROM "AmuxIdeaAnalysisChunk"
    WHERE "ideaId" = ${choice.ideaId} AND "actorUserId" = ${actorUserId}
      AND "chunkIndex" = 0
    FOR UPDATE
  `;
  if (chunkLock.length !== 1) throw new IdeaTransferPreviewError("not_ready");
  if (choice.replacesPreviewId) {
    const previewLock = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "AmuxIdeaTransferPreview"
      WHERE "id" = ${choice.replacesPreviewId} AND "ideaId" = ${choice.ideaId}
      FOR UPDATE
    `;
    if (previewLock.length !== 1) throw new IdeaTransferPreviewError("not_ready");
  }
  const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = nowRows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new IdeaTransferPreviewError("integrity_unavailable");
  }
  const idea = await tx.amuxIdeaSubmission.findUnique({ where: { id: choice.ideaId } });
  const chunk = await tx.amuxIdeaAnalysisChunk.findUnique({
    where: { ideaId_chunkIndex: { ideaId: choice.ideaId, chunkIndex: 0 } },
  });
  const replacedPreview = choice.replacesPreviewId
    ? await tx.amuxIdeaTransferPreview.findUnique({ where: { id: choice.replacesPreviewId } })
    : null;
  const replacedHold = replacedPreview
    ? await tx.amuxIdeaAnalysisBudgetHold.findUnique({
      where: { previewId: replacedPreview.id },
      select: { status: true, closedAt: true },
    }) : null;
  const nextAttempt = replacedPreview ? replacedPreview.attempt + 1 : 1;
  const spentFailure = replacedPreview?.state === "provider_failed" &&
    replacedPreview.consumedAt !== null &&
    replacedPreview.confirmationAuditLogId !== null &&
    replacedHold?.status === "failed" && replacedHold.closedAt !== null;
  const replaceable = choice.replacesPreviewId
    ? replacedPreview?.ideaId === choice.ideaId &&
      replacedPreview?.sourceScopeApprovalId === null &&
      replacedPreview?.sourcePlanRevisionId === idea?.currentSourcePlanRevisionId &&
      replacedPreview?.sourceUnitOrdinal === 0 && replacedPreview?.chunkIndex === 0 &&
      ((replacedPreview?.state === "prepared" &&
        replacedPreview.confirmedAt === null &&
        replacedPreview.confirmationAuditLogId === null &&
        replacedPreview.consumedAt === null && replacedPreview.expiresAt <= now) ||
        spentFailure) &&
      replacedPreview.attempt >= 1 && nextAttempt <= 2_147_483_647 &&
      chunk?.state === "awaiting_preview" &&
      chunk.currentPreviewId === replacedPreview.id &&
      chunk.attempt === replacedPreview.attempt
    : chunk?.state === "pending" && chunk.attempt === 0 &&
      chunk.currentPreviewId === null;
  if (!idea || !chunk || idea.actorUserId !== actorUserId ||
      idea.state !== "submitted" || now >= idea.analysisDeadlineAt ||
      !idea.currentSourcePlanRevisionId || idea.rawPurgedAt !== null ||
      !idea.rawCiphertext || !idea.rawKeyId || !idea.rawKeyVersion ||
      !idea.rawDigest || !idea.rawDigestKeyId ||
      chunk.actorUserId !== actorUserId || !replaceable ||
      chunk.chunkIndex !== 0 || chunk.revisionChunkIndex !== 0 ||
      chunk.planStartChunkIndex !== 0 ||
      chunk.sourcePlanRevisionId !== idea.currentSourcePlanRevisionId) {
    throw new IdeaTransferPreviewError("not_ready");
  }
  const plan = await tx.amuxIdeaSourcePlanRevision.findUnique({
    where: { id: idea.currentSourcePlanRevisionId },
  });
  if (!plan || plan.ideaId !== choice.ideaId || plan.actorUserId !== actorUserId ||
      plan.state !== "active" || plan.revisionNumber !== 1 ||
      plan.startChunkIndex !== 0 || plan.sourceUnitCount !== 1 ||
      plan.unitDigests.length !== 1) {
    throw new IdeaTransferPreviewError("not_ready");
  }
  const audit = await tx.adminAuditLog.findUnique({
    where: { id: plan.creationAuditLogId },
    select: { targetId: true, targetType: true, action: true, entryHash: true, metadata: true },
  });
  if (!audit?.entryHash || audit.targetId !== plan.id ||
      audit.targetType !== "AmuxIdeaSourcePlanRevision" ||
      audit.action !== "AMUX_V4_INITIAL_SOURCE_PLAN_CREATED" ||
      !matchesInitialPlanSystemAudit(audit.metadata, plan.manifestDigest)) {
    throw new IdeaTransferPreviewError("integrity_unavailable");
  }

  let raw: Buffer;
  try {
    raw = openAmuxContent({ ciphertext: Buffer.from(idea.rawCiphertext),
      keyId: idea.rawKeyId, keyVersion: idea.rawKeyVersion },
    "idea_raw", idea.id, input.keys);
  } catch { throw new IdeaTransferPreviewError("integrity_unavailable"); }
  let payloadBytes: Buffer | undefined;
  try {
    if (!verifyAmuxContentDigest(raw, "idea_raw", idea.id,
      idea.rawDigest, idea.rawDigestKeyId, input.keys)) {
      throw new IdeaTransferPreviewError("integrity_unavailable");
    }
    const parsed = inspectAmuxIdeaInput(raw.toString("utf8"));
    if (!parsed.ok || parsed.input.repositories.length !== 0 ||
        parsed.input.pullRequests.length !== 0) {
      throw new IdeaTransferPreviewError("not_ready");
    }
    const ideaBytes = Buffer.from(parsed.input.idea, "utf8");
    try {
      const built = buildAmuxSourcePlanManifest({
        ideaId: idea.id, actorUserId, revisionId: plan.id,
        revisionNumber: 1, startChunkIndex: 0, predecessorId: null,
        orderedUnits: [{ sourceKind: "operator_idea",
          sourceReceiptDigest: idea.rawDigest, bytes: ideaBytes }],
      }, input.keys);
      if (built.decision !== "ready" ||
          built.manifest.manifestDigest !== plan.manifestDigest ||
          built.manifest.manifestDigestKeyId !== plan.manifestDigestKeyId ||
          built.manifest.unitDigests[0] !== plan.unitDigests[0]) {
        throw new IdeaTransferPreviewError("integrity_unavailable");
      }
    } finally { ideaBytes.fill(0); }
    const prompt = buildAmuxIdeaAnalysisPrompt({
      previewId: choice.previewId, chunkIndex: 0, revisionChunkIndex: 0,
      continuation: null,
      sourceTexts: [{ refId: "operator_idea", kind: "operator_idea", text: parsed.input.idea }],
      permittedTargetRefs: [],
    });
    if (prompt.status !== "prompt_candidate") {
      throw new IdeaTransferPreviewError("not_ready");
    }
    const payload: PreviewPayload = {
      version: 1, previewId: choice.previewId, ideaId: choice.ideaId,
      selection: { provider: choice.provider, modelId: choice.modelId,
        reasoningEffort: choice.reasoningEffort, approvalId: choice.approvalId,
        approvalVersion: choice.approvalVersion },
      templateVersion: prompt.version, prompt: prompt.prompt,
    };
    payloadBytes = Buffer.from(amuxCanonicalJson(payload), "utf8");
    const sealed = sealAmuxContent(payloadBytes, "transfer_payload", choice.previewId, input.keys);
    const finalRefs = amuxContentDigest(Buffer.from("[]", "utf8"),
      "transfer_payload", choice.previewId, input.keys);
    const browserBindingDigest = ideaTransferBrowserDigest({
      previewId: choice.previewId, nonce: input.browserNonce,
      authenticatedAt: input.session.user?.authenticatedAt, key: input.keys,
    });
    const expiresAt = new Date(Math.min(now.getTime() + 15 * 60_000,
      idea.analysisDeadlineAt.getTime()));
    if (expiresAt <= now) throw new IdeaTransferPreviewError("not_ready");
    if (replacedPreview && !spentFailure) {
      const expired = await tx.amuxIdeaTransferPreview.updateMany({
        where: { id: replacedPreview.id, ideaId: idea.id, state: "prepared",
          confirmedAt: null, confirmationAuditLogId: null, consumedAt: null,
          expiresAt: { lte: now } },
        // Keep the ciphertext until the retention worker records the purge
        // and retires this preview's external key. Clearing it here would
        // leave a recoverable key beside old DB backups indefinitely.
        data: { state: "expired" },
      });
      if (expired.count !== 1) throw new IdeaTransferPreviewError("not_ready");
    }
    await tx.amuxIdeaTransferPreview.create({ data: {
      id: choice.previewId, ideaId: idea.id,
      sourcePlanRevisionId: plan.id, sourceUnitOrdinal: 0,
      chunkIndex: 0, attempt: nextAttempt, state: "prepared",
      modelId: choice.modelId, templateVersion: prompt.version,
      payloadCiphertext: Uint8Array.from(sealed.ciphertext), payloadKeyId: sealed.keyId,
      payloadKeyVersion: sealed.keyVersion, payloadDigest: sealed.digest,
      payloadDigestKeyId: sealed.digestKeyId, expiresAt,
      payloadPurgeAfter: new Date(expiresAt.getTime() + 24 * 60 * 60_000),
    } });
    const updated = await tx.amuxIdeaAnalysisChunk.updateMany({
      where: { ideaId: idea.id, chunkIndex: 0, actorUserId,
        state: replacedPreview ? "awaiting_preview" : "pending",
        attempt: replacedPreview?.attempt ?? 0,
        currentPreviewId: replacedPreview?.id ?? null,
        sourcePlanRevisionId: plan.id },
      data: { state: "awaiting_preview", attempt: nextAttempt,
        currentPreviewId: choice.previewId },
    });
    if (updated.count !== 1) throw new IdeaTransferPreviewError("not_ready");
    await writeAdminAuditLog({ tx, session: input.session, request: input.request,
      action: "amux.v4.transfer_preview.prepared",
      targetType: "AmuxIdeaTransferPreview", targetId: choice.previewId,
      summary: "Owner prepared one idea-only analysis transfer preview; no model was called.",
      metadata: { ideaId: idea.id, chunkIndex: 0, sourcePlanRevisionId: plan.id,
        modelApprovalId: choice.approvalId, modelApprovalVersion: choice.approvalVersion,
        payloadDigest: sealed.digest, payloadDigestKeyId: sealed.digestKeyId,
        finalPermittedTargetRefs: [],
        finalPermittedTargetRefsDigest: finalRefs.digest,
        finalPermittedTargetRefsDigestKeyId: finalRefs.digestKeyId,
        browserBindingDigest,
        ...(replacedPreview ? { replacesPreviewId: replacedPreview.id } : {}),
        transferAuthorized: false },
    });
    return { previewId: choice.previewId, expiresAt, payload,
      payloadDigest: sealed.digest, payloadDigestKeyId: sealed.digestKeyId };
  } finally {
    payloadBytes?.fill(0);
    raw.fill(0);
  }
}

/** Prepare the first output continuation without sending it. The previous
 * page is re-read and authenticated under the same locked DB transaction;
 * a stale or purged page cannot silently become a new transfer preview. */
export async function commitFirstOutputContinuationTransferPreview(
  tx: Prisma.TransactionClient, input: {
    session: Session; request: Request; choice: IdeaOnlyTransferPreviewRequest;
    keys: AmuxContentKeys; browserNonce: string;
  },
): Promise<{ previewId: string; expiresAt: Date; payload: PreviewPayload;
  payloadDigest: string; payloadDigestKeyId: string }> {
  const actorUserId = ownerId(input.session);
  const { choice } = input;
  const chunkIndex = choice.chunkIndex ?? 1;
  if (!Number.isSafeInteger(chunkIndex) ||
      chunkIndex < 1 || chunkIndex >= 2_147_483_647) {
    throw new IdeaTransferPreviewError("not_ready");
  }
  await takeAuditChainLock(tx);
  const ideaLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaSubmission"
    WHERE "id" = ${choice.ideaId} AND "actorUserId" = ${actorUserId} FOR UPDATE
  `;
  if (ideaLock.length !== 1) throw new IdeaTransferPreviewError("not_found");
  const chunkLocks = await tx.$queryRaw<Array<{ chunkIndex: number }>>`
    SELECT "chunkIndex" FROM "AmuxIdeaAnalysisChunk"
    WHERE "ideaId" = ${choice.ideaId} AND "actorUserId" = ${actorUserId}
      AND "chunkIndex" <= ${chunkIndex} ORDER BY "chunkIndex" FOR UPDATE
  `;
  if (chunkLocks.length !== chunkIndex + 1 ||
      chunkLocks.some((row, index) => row.chunkIndex !== index)) {
    throw new IdeaTransferPreviewError("not_ready");
  }
  if (choice.replacesPreviewId) {
    const previewLock = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "AmuxIdeaTransferPreview"
      WHERE "id" = ${choice.replacesPreviewId} AND "ideaId" = ${choice.ideaId}
      FOR UPDATE
    `;
    if (previewLock.length !== 1) throw new IdeaTransferPreviewError("not_ready");
  }
  const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = nowRows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new IdeaTransferPreviewError("integrity_unavailable");
  }
  const idea = await tx.amuxIdeaSubmission.findUnique({ where: { id: choice.ideaId } });
  const nextChunk = await tx.amuxIdeaAnalysisChunk.findUnique({
    where: { ideaId_chunkIndex: { ideaId: choice.ideaId, chunkIndex } },
  });
  const replacedPreview = choice.replacesPreviewId
    ? await tx.amuxIdeaTransferPreview.findUnique({ where: { id: choice.replacesPreviewId } })
    : null;
  const existingHold = replacedPreview
    ? await tx.amuxIdeaAnalysisBudgetHold.findUnique({
      where: { previewId: replacedPreview.id }, select: { id: true },
    }) : null;
  const nextAttempt = replacedPreview ? replacedPreview.attempt + 1 : 1;
  const replaceable = choice.replacesPreviewId
    ? replacedPreview?.ideaId === choice.ideaId &&
      replacedPreview.sourcePlanRevisionId === idea?.currentSourcePlanRevisionId &&
      replacedPreview.sourceScopeApprovalId === null &&
      replacedPreview.sourceUnitOrdinal === 0 &&
      replacedPreview.chunkIndex === chunkIndex &&
      ["prepared", "confirmed", "expired"].includes(replacedPreview.state) &&
      replacedPreview.consumedAt === null && replacedPreview.outcomeUnknownAt === null &&
      replacedPreview.expiresAt <= now && existingHold === null &&
      replacedPreview.attempt >= 1 && nextAttempt <= 2_147_483_647 &&
      nextChunk?.state === "awaiting_preview" &&
      nextChunk.currentPreviewId === replacedPreview.id &&
      nextChunk.attempt === replacedPreview.attempt
    : nextChunk?.state === "pending" && nextChunk.attempt === 0 &&
      nextChunk.currentPreviewId === null;
  if (!idea || !nextChunk || idea.state !== "analyzing" ||
      now >= idea.analysisDeadlineAt ||
      idea.analysisCompletedAt !== null || idea.cancelledAt !== null ||
      !idea.currentSourcePlanRevisionId || idea.rawPurgedAt !== null ||
      !idea.rawCiphertext || !idea.rawKeyId || !idea.rawKeyVersion ||
      !idea.rawDigest || !idea.rawDigestKeyId ||
      nextChunk.actorUserId !== actorUserId || !replaceable ||
      nextChunk.sourcePlanRevisionId !== idea.currentSourcePlanRevisionId ||
      nextChunk.planStartChunkIndex !== 0 ||
      nextChunk.revisionChunkIndex !== chunkIndex) {
    throw new IdeaTransferPreviewError("not_ready");
  }
  const plan = await tx.amuxIdeaSourcePlanRevision.findUnique({
    where: { id: idea.currentSourcePlanRevisionId },
  });
  if (!plan || plan.ideaId !== idea.id || plan.actorUserId !== actorUserId ||
      plan.state !== "active" || plan.revisionNumber !== 1 ||
      plan.startChunkIndex !== 0 || plan.sourceUnitCount !== 1 ||
      plan.unitDigests.length !== 1) throw new IdeaTransferPreviewError("not_ready");
  const planAudit = await tx.adminAuditLog.findUnique({
    where: { id: plan.creationAuditLogId },
    select: { targetId: true, targetType: true, action: true, entryHash: true, metadata: true },
  });
  if (!planAudit?.entryHash || planAudit.targetId !== plan.id ||
      planAudit.targetType !== "AmuxIdeaSourcePlanRevision" ||
      planAudit.action !== "AMUX_V4_INITIAL_SOURCE_PLAN_CREATED" ||
      !matchesInitialPlanSystemAudit(planAudit.metadata, plan.manifestDigest)) {
    throw new IdeaTransferPreviewError("integrity_unavailable");
  }
  const context = await readVerifiedAmuxIdeaAnalysisContinuationContext(
    tx, actorUserId, choice.ideaId, input.keys, choice.pinnedTargetRefs ?? [])
    .catch((error: unknown) => {
      if (error instanceof AmuxIdeaAnalysisResultReadError &&
          (error.code === "not_found" ||
            error.code === "reference_selection_required")) {
        throw new IdeaTransferPreviewError("reference_selection_required");
      }
      throw error;
    });
  if (context.pageCount !== chunkIndex || context.complete ||
      !context.previous.remainingScope) {
    throw new IdeaTransferPreviewError("not_ready");
  }
  const previous = context.previous;
  const previousUnits = previous.units.map((unit) => unit.proposal!) as
    AmuxAnalysisChunk["units"];
  const priorPermittedTargetRefs = context.priorTargets;
  const priorAudits = await tx.adminAuditLog.findMany({
    where: { action: chunkIndex === 1 ? AMUX_V4_FIRST_DRAFT_SAVED_ACTION :
        AMUX_V4_SECOND_DRAFT_SAVED_ACTION,
      targetType: chunkIndex === 1 ? AMUX_V4_FIRST_DRAFT_SAVED_TARGET :
        AMUX_V4_SECOND_DRAFT_SAVED_TARGET,
      targetId: `${idea.id}:${chunkIndex - 1}` },
    take: 2, select: { entryHash: true },
  });
  const previousAuditHash = priorAudits[0]?.entryHash;
  if (priorAudits.length !== 1 || !previousAuditHash ||
      !/^[a-f0-9]{64}$/.test(previousAuditHash)) {
    throw new IdeaTransferPreviewError("integrity_unavailable");
  }
  let raw: Buffer;
  try {
    raw = openAmuxContent({ ciphertext: Buffer.from(idea.rawCiphertext),
      keyId: idea.rawKeyId, keyVersion: idea.rawKeyVersion },
    "idea_raw", idea.id, input.keys);
  } catch { throw new IdeaTransferPreviewError("integrity_unavailable"); }
  let payloadBytes: Buffer | undefined;
  try {
    if (!verifyAmuxContentDigest(raw, "idea_raw", idea.id,
      idea.rawDigest, idea.rawDigestKeyId, input.keys)) {
      throw new IdeaTransferPreviewError("integrity_unavailable");
    }
    const parsed = inspectAmuxIdeaInput(raw.toString("utf8"));
    if (!parsed.ok || parsed.input.repositories.length !== 0 ||
        parsed.input.pullRequests.length !== 0) {
      throw new IdeaTransferPreviewError("not_ready");
    }
    const ideaBytes = Buffer.from(parsed.input.idea, "utf8");
    try {
      const built = buildAmuxSourcePlanManifest({
        ideaId: idea.id, actorUserId, revisionId: plan.id,
        revisionNumber: 1, startChunkIndex: 0, predecessorId: null,
        orderedUnits: [{ sourceKind: "operator_idea",
          sourceReceiptDigest: idea.rawDigest, bytes: ideaBytes }],
      }, input.keys);
      if (built.decision !== "ready" ||
          built.manifest.manifestDigest !== plan.manifestDigest ||
          built.manifest.manifestDigestKeyId !== plan.manifestDigestKeyId ||
          built.manifest.unitDigests[0] !== plan.unitDigests[0]) {
        throw new IdeaTransferPreviewError("integrity_unavailable");
      }
    } finally { ideaBytes.fill(0); }
    const prompt = buildIdeaOnlyOutputContinuationPrompt({
      previewId: choice.previewId, previousPreviewId: previous.previewId,
      previousRaw: JSON.stringify({ schemaVersion: 2,
        previewId: previous.previewId, chunkIndex: chunkIndex - 1,
        outcome: "propose",
        coverageStatus: "more", continuationKind: "output", ownerQuestion: null,
        coveredScope: previous.coveredScope, remainingScope: previous.remainingScope,
        units: previousUnits }),
      previousAuditHash, previousChunkIndex: chunkIndex - 1,
      priorPermittedTargetRefs, ideaText: parsed.input.idea,
      previousPagePermittedTargetRefs: context.validationTargets,
      nextPermittedTargetRefs: context.targets,
      pinnedTargetRefs: choice.pinnedTargetRefs,
      omittedTargetSummary: context.omittedTargetSummary,
    });
    if (prompt.status !== "prompt_candidate") {
      throw new IdeaTransferPreviewError(prompt.reason === "required_refs_exceed_limit"
        ? "reference_selection_required" : "not_ready");
    }
    const payload: PreviewPayload = {
      version: 1, previewId: choice.previewId, ideaId: choice.ideaId,
      selection: { provider: choice.provider, modelId: choice.modelId,
        reasoningEffort: choice.reasoningEffort, approvalId: choice.approvalId,
        approvalVersion: choice.approvalVersion },
      templateVersion: prompt.version, prompt: prompt.prompt,
    };
    payloadBytes = Buffer.from(amuxCanonicalJson(payload), "utf8");
    const sealed = sealAmuxContent(payloadBytes, "transfer_payload", choice.previewId, input.keys);
    const finalPermittedTargetRefs = prompt.selectedTargetRefs ?? context.targets;
    const finalRefs = amuxContentDigest(Buffer.from(
      amuxCanonicalJson(finalPermittedTargetRefs), "utf8"),
    "transfer_payload", choice.previewId, input.keys);
    const browserBindingDigest = ideaTransferBrowserDigest({
      previewId: choice.previewId, nonce: input.browserNonce,
      authenticatedAt: input.session.user?.authenticatedAt, key: input.keys,
    });
    const expiresAt = new Date(Math.min(now.getTime() + 15 * 60_000,
      idea.analysisDeadlineAt.getTime()));
    if (expiresAt <= now) throw new IdeaTransferPreviewError("not_ready");
    if (replacedPreview) {
      const expired = await tx.amuxIdeaTransferPreview.updateMany({
        where: { id: replacedPreview.id, ideaId: idea.id,
          state: replacedPreview.state, consumedAt: null, outcomeUnknownAt: null,
          expiresAt: { lte: now } },
        // The retention worker owns the body purge and external key retirement.
        data: { state: "expired" },
      });
      if (expired.count !== 1) throw new IdeaTransferPreviewError("not_ready");
      await writeAdminAuditLog({ tx, session: input.session, request: input.request,
        action: "amux.v4.transfer_preview.expired_for_replacement",
        targetType: "AmuxIdeaTransferPreview", targetId: replacedPreview.id,
        summary: "Owner replaced one expired analysis transfer preview; no model was called.",
        metadata: { ideaId: idea.id, chunkIndex,
          replacementPreviewId: choice.previewId,
          priorState: replacedPreview.state,
          confirmationRecorded: replacedPreview.confirmationAuditLogId !== null },
      });
    }
    await tx.amuxIdeaTransferPreview.create({ data: {
      id: choice.previewId, ideaId: idea.id,
      sourcePlanRevisionId: plan.id, sourceUnitOrdinal: 0,
      chunkIndex, attempt: nextAttempt, state: "prepared",
      modelId: choice.modelId, templateVersion: prompt.version,
      payloadCiphertext: Uint8Array.from(sealed.ciphertext), payloadKeyId: sealed.keyId,
      payloadKeyVersion: sealed.keyVersion, payloadDigest: sealed.digest,
      payloadDigestKeyId: sealed.digestKeyId, expiresAt,
      payloadPurgeAfter: new Date(expiresAt.getTime() + 24 * 60 * 60_000),
    } });
    const updated = await tx.amuxIdeaAnalysisChunk.updateMany({
      where: { ideaId: idea.id, chunkIndex, actorUserId,
        state: replacedPreview ? "awaiting_preview" : "pending",
        attempt: replacedPreview?.attempt ?? 0,
        currentPreviewId: replacedPreview?.id ?? null,
        sourcePlanRevisionId: plan.id },
      data: { state: "awaiting_preview", attempt: nextAttempt,
        currentPreviewId: choice.previewId },
    });
    if (updated.count !== 1) throw new IdeaTransferPreviewError("not_ready");
    await writeAdminAuditLog({ tx, session: input.session, request: input.request,
      action: "amux.v4.transfer_preview.prepared",
      targetType: "AmuxIdeaTransferPreview", targetId: choice.previewId,
      summary: "Owner prepared one output-continuation transfer preview; no model was called.",
      metadata: { ideaId: idea.id, chunkIndex, sourcePlanRevisionId: plan.id,
        previousChunkAuditHash: previousAuditHash,
        pinnedTargetRefs: choice.pinnedTargetRefs ?? [],
        modelApprovalId: choice.approvalId, modelApprovalVersion: choice.approvalVersion,
        payloadDigest: sealed.digest, payloadDigestKeyId: sealed.digestKeyId,
        finalPermittedTargetRefs,
        finalPermittedTargetRefsDigest: finalRefs.digest,
        finalPermittedTargetRefsDigestKeyId: finalRefs.digestKeyId,
        browserBindingDigest,
        ...(replacedPreview ? { replacesPreviewId: replacedPreview.id } : {}),
        transferAuthorized: false },
    });
    return { previewId: choice.previewId, expiresAt, payload,
      payloadDigest: sealed.digest, payloadDigestKeyId: sealed.digestKeyId };
  } finally {
    payloadBytes?.fill(0);
    raw.fill(0);
  }
}

/** Read-back does not reauthorize a stale model or permit a transfer. */
export async function readIdeaOnlyTransferPreview(session: Session, previewId: string): Promise<
  | { state: "not_visible" | "unavailable" | "expired"; transferAuthorized: false }
  | { state: "prepared"; previewId: string; expiresAt: Date;
      payload: PreviewPayload; payloadDigest: string; payloadDigestKeyId: string;
      transferAuthorized: false }
> {
  const actorUserId = ownerId(session);
  const row = await prisma.amuxIdeaTransferPreview.findUnique({
    where: { id: previewId },
  });
  if (!row) return { state: "not_visible", transferAuthorized: false };
  const idea = await prisma.amuxIdeaSubmission.findFirst({
    where: { id: row.ideaId, actorUserId }, select: { id: true },
  });
  if (!idea) return { state: "not_visible", transferAuthorized: false };
  const nowRows = await prisma.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = nowRows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    return { state: "unavailable", transferAuthorized: false };
  }
  if (now >= row.expiresAt) return { state: "expired", transferAuthorized: false };
  if (row.state !== "prepared" || row.sourceScopeApprovalId !== null ||
      !row.payloadCiphertext || !row.payloadKeyId || !row.payloadKeyVersion ||
      row.payloadPurgedAt !== null) {
    return { state: "unavailable", transferAuthorized: false };
  }
  const audit = await prisma.adminAuditLog.findFirst({
    where: { action: "amux.v4.transfer_preview.prepared",
      targetType: "AmuxIdeaTransferPreview", targetId: row.id,
      actorUserId },
    select: { entryHash: true, metadata: true },
  });
  const auditMetadata = audit?.metadata;
  if (!audit?.entryHash || !auditMetadata || typeof auditMetadata !== "object" ||
      Array.isArray(auditMetadata) ||
      (auditMetadata as Record<string, unknown>).payloadDigest !== row.payloadDigest ||
      (auditMetadata as Record<string, unknown>).payloadDigestKeyId !== row.payloadDigestKeyId ||
      typeof (auditMetadata as Record<string, unknown>).browserBindingDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test((auditMetadata as Record<string, string>).browserBindingDigest) ||
      (auditMetadata as Record<string, unknown>).sourcePlanRevisionId !== row.sourcePlanRevisionId ||
      (auditMetadata as Record<string, unknown>).transferAuthorized !== false) {
    return { state: "unavailable", transferAuthorized: false };
  }
  let keys: AmuxContentKeys;
  try {
    keys = await loadAmuxContentKeyRing([{ ideaId: row.ideaId,
      purpose: "transfer_payload", subjectId: row.id }]);
  } catch { return { state: "unavailable", transferAuthorized: false }; }
  let raw: Buffer;
  try {
    raw = openAmuxContent({ ciphertext: Buffer.from(row.payloadCiphertext),
      keyId: row.payloadKeyId, keyVersion: row.payloadKeyVersion },
    "transfer_payload", row.id, keys);
  } catch { return { state: "unavailable", transferAuthorized: false }; }
  try {
    if (!verifyAmuxContentDigest(raw, "transfer_payload", row.id,
      row.payloadDigest, row.payloadDigestKeyId, keys)) {
      return { state: "unavailable", transferAuthorized: false };
    }
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { state: "unavailable", transferAuthorized: false };
    }
    const payload = parsed as PreviewPayload;
    if (payload.version !== 1 || payload.previewId !== row.id ||
        payload.ideaId !== row.ideaId ||
        payload.selection?.modelId !== row.modelId ||
        payload.templateVersion !== row.templateVersion ||
        typeof payload.prompt !== "string" ||
        !payload.prompt.includes(`"previewId":"${row.id}"`)) {
      return { state: "unavailable", transferAuthorized: false };
    }
    return { state: "prepared", previewId: row.id, expiresAt: row.expiresAt,
      payload, payloadDigest: row.payloadDigest,
      payloadDigestKeyId: row.payloadDigestKeyId, transferAuthorized: false };
  } catch { return { state: "unavailable", transferAuthorized: false }; }
  finally { raw.fill(0); }
}

export async function prepareIdeaOnlyTransferPreview(
  session: Session, request: Request, choice: IdeaOnlyTransferPreviewRequest,
  browserNonce: string,
) {
  const actorUserId = ownerId(session);
  if (!transferPreviewWritePermitted(process.env[AMUX_V4_TRANSFER_PREVIEW_WRITE_ENV])) {
    throw new IdeaTransferPreviewError("preview_disabled");
  }
  if (adminAuditIntegrityKeys(process.env).length === 0) {
    throw new IdeaTransferPreviewError("integrity_unavailable");
  }
  const owned = await prisma.amuxIdeaSubmission.findFirst({
    where: { id: choice.ideaId, actorUserId }, select: { id: true },
  });
  if (!owned) throw new IdeaTransferPreviewError("not_found");
  const selected = await readCurrentAmuxIdeaFrontierSelection(choice);
  if (selected.decision === "hold") {
    throw new IdeaTransferPreviewError("integrity_unavailable");
  }
  if (selected.decision !== "selection_current" ||
      selected.approvalId !== choice.approvalId ||
      selected.approvalVersion !== choice.approvalVersion) {
    throw new IdeaTransferPreviewError("model_changed");
  }
  let keys: AmuxContentKeys;
  try {
    keys = await createAmuxContentKeyRing([
      { ideaId: choice.ideaId, purpose: "idea_raw", subjectId: choice.ideaId },
    ], [{ ideaId: choice.ideaId, purpose: "transfer_payload",
      subjectId: choice.previewId }]);
  } catch { throw new IdeaTransferPreviewError("integrity_unavailable"); }
  let callbackReturned = false;
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
      const result = await commitIdeaOnlyTransferPreview(tx, {
        session, request, choice, keys, browserNonce,
      });
      callbackReturned = true;
      return result;
    }, { maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    if (!callbackReturned && error instanceof IdeaTransferPreviewError) throw error;
    throw new IdeaTransferPreviewError("outcome_unknown");
  }
}

export async function prepareFirstOutputContinuationTransferPreview(
  session: Session, request: Request, choice: IdeaOnlyTransferPreviewRequest,
  browserNonce: string,
) {
  const actorUserId = ownerId(session);
  if (!transferPreviewWritePermitted(process.env[AMUX_V4_TRANSFER_PREVIEW_WRITE_ENV])) {
    throw new IdeaTransferPreviewError("preview_disabled");
  }
  if (adminAuditIntegrityKeys(process.env).length === 0) {
    throw new IdeaTransferPreviewError("integrity_unavailable");
  }
  const owned = await prisma.amuxIdeaSubmission.findFirst({
    where: { id: choice.ideaId, actorUserId }, select: { id: true },
  });
  if (!owned) throw new IdeaTransferPreviewError("not_found");
  const selected = await readCurrentAmuxIdeaFrontierSelection(choice);
  if (selected.decision === "hold") {
    throw new IdeaTransferPreviewError("integrity_unavailable");
  }
  if (selected.decision !== "selection_current" ||
      selected.approvalId !== choice.approvalId ||
      selected.approvalVersion !== choice.approvalVersion) {
    throw new IdeaTransferPreviewError("model_changed");
  }
  const [priorChunks, priorUnits] = await Promise.all([
    prisma.amuxIdeaAnalysisChunk.findMany({ where: { ideaId: choice.ideaId,
      freeformCiphertext: { not: null } },
      select: { currentPreviewId: true } }),
    prisma.amuxIdeaDraftUnit.findMany({ where: { ideaId: choice.ideaId,
      bodyCiphertext: { not: null } }, select: { id: true } }),
  ]);
  const existing: AmuxContentKeyIdentity[] = [{ ideaId: choice.ideaId,
    purpose: "idea_raw", subjectId: choice.ideaId }];
  for (const chunk of priorChunks) {
    if (chunk.currentPreviewId) existing.push({ ideaId: choice.ideaId,
      purpose: "analysis_freeform",
      subjectId: amuxAnalysisFreeformSubjectId(choice.ideaId,
        chunk.currentPreviewId) });
  }
  for (const unit of priorUnits) existing.push({ ideaId: choice.ideaId,
    purpose: "analysis_draft", subjectId: unit.id });
  let keys: AmuxContentKeys;
  try {
    keys = await createAmuxContentKeyRing(existing, [{ ideaId: choice.ideaId,
      purpose: "transfer_payload", subjectId: choice.previewId }]);
  } catch { throw new IdeaTransferPreviewError("integrity_unavailable"); }
  let callbackReturned = false;
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
               set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
      `;
      const result = await commitFirstOutputContinuationTransferPreview(tx, {
        session, request, choice, keys, browserNonce,
      });
      callbackReturned = true;
      return result;
    // The budget writer takes the same audit/idea locks. READ COMMITTED must
    // observe a hold that committed while this writer waited for those locks.
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    if (!callbackReturned && error instanceof IdeaTransferPreviewError) throw error;
    throw new IdeaTransferPreviewError("outcome_unknown");
  }
}
