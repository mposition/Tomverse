import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import {
  auditRowActorKind,
  AMUX_V4_FIRST_DRAFT_SAVED_ACTION,
  AMUX_V4_FIRST_DRAFT_SAVED_TARGET,
  AMUX_V4_IDEA_SYSTEM_ACTOR,
} from "@/lib/adminAuditSystemActors";
import { AMUX_V4_ANALYSIS_NAMESPACE } from "./ideaAnalysisBudgetCore.ts";
import { prepareAmuxAnalysisPageDraft } from "./ideaAnalysisPageDraftCore.ts";
import { readPreviousOutputPage } from "./ideaTransferPreviewService.ts";
import { openAmuxContent, verifyAmuxContentDigest } from "./ideaCrypto.ts";
import type { AmuxContentKeys } from "./ideaCrypto.ts";

const ID = /^[A-Za-z0-9:_-]{1,128}$/;
const DAY_MS = 24 * 60 * 60_000;

export class AmuxFirstAnalysisDraftError extends Error {
  constructor(readonly code: "not_ready" | "invalid_result" | "integrity_unavailable") {
    super(code);
    this.name = "AmuxFirstAnalysisDraftError";
  }
}

/** Dark app-DB writer for one bounded idea-only first response. It does not
 * run a model, grant a card, or authenticate the local Agent's receipt. The
 * future internal route must authenticate the fenced caller and verify that
 * rawModelOutput belongs to this exact invocation before calling this body.
 * Unknown COMMIT outcome requires read-back by previewId, never blind retry. */
export async function commitAmuxFirstIdeaAnalysisDraft(
  tx: Prisma.TransactionClient,
  input: { ideaId: string; previewId: string; holdId: string;
    leaseGeneration: number; rawModelOutput: string; keys: AmuxContentKeys;
    unitIds?: readonly string[]; chunkIndex?: number },
): Promise<{ ideaId: string; previewId: string; unitCount: number;
  analysisCompletedAt: string; auditId: string;
  nextCursor: { sourceOrdinal: number; outputPartIndex: number } | null }> {
  if (!input || !ID.test(input.ideaId) || !ID.test(input.previewId) ||
      !ID.test(input.holdId) || !Number.isSafeInteger(input.leaseGeneration) ||
      input.leaseGeneration < 1 || typeof input.rawModelOutput !== "string" ||
      Buffer.byteLength(input.rawModelOutput, "utf8") > 65_536) {
    throw new AmuxFirstAnalysisDraftError("not_ready");
  }
  const chunkIndex = input.chunkIndex ?? 0;
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
    throw new AmuxFirstAnalysisDraftError("not_ready");
  }
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const ideaLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaSubmission" WHERE "id" = ${input.ideaId} FOR UPDATE
  `;
  const chunkLock = await tx.$queryRaw<Array<{ chunkIndex: number }>>`
    SELECT "chunkIndex" FROM "AmuxIdeaAnalysisChunk"
    WHERE "ideaId" = ${input.ideaId} AND "chunkIndex" = ${chunkIndex} FOR UPDATE
  `;
  const previewLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaTransferPreview"
    WHERE "id" = ${input.previewId} FOR UPDATE
  `;
  const holdLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaAnalysisBudgetHold"
    WHERE "id" = ${input.holdId} FOR UPDATE
  `;
  if (ideaLock.length !== 1 || chunkLock.length !== 1 ||
      previewLock.length !== 1 || holdLock.length !== 1) {
    throw new AmuxFirstAnalysisDraftError("not_ready");
  }
  const idea = await tx.amuxIdeaSubmission.findUnique({ where: { id: input.ideaId } });
  const chunk = await tx.amuxIdeaAnalysisChunk.findUnique({
    where: { ideaId_chunkIndex: { ideaId: input.ideaId, chunkIndex } },
  });
  const preview = await tx.amuxIdeaTransferPreview.findUnique({
    where: { id: input.previewId },
  });
  const hold = await tx.amuxIdeaAnalysisBudgetHold.findUnique({
    where: { id: input.holdId },
  });
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = clock[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !idea || !chunk || !preview || !hold) {
    throw new AmuxFirstAnalysisDraftError("integrity_unavailable");
  }
  if (idea.state !== "analyzing" || now >= idea.analysisDeadlineAt ||
      idea.analysisCompletedAt !== null || idea.cancelledAt !== null ||
      !idea.currentSourcePlanRevisionId ||
      chunk.state !== "in_flight" || chunk.chunkIndex !== chunkIndex ||
      chunk.actorUserId !== idea.actorUserId ||
      chunk.leaseGeneration !== input.leaseGeneration ||
      chunk.analysisCompletedAt !== null || chunk.freeformCiphertext !== null ||
      chunk.currentPreviewId !== preview.id ||
      chunk.sourcePlanRevisionId !== idea.currentSourcePlanRevisionId ||
      preview.state !== "in_flight" || preview.ideaId !== idea.id ||
      preview.chunkIndex !== chunkIndex || preview.attempt !== chunk.attempt ||
      preview.sourcePlanRevisionId !== idea.currentSourcePlanRevisionId ||
      preview.sourceScopeApprovalId !== null || preview.sourceUnitOrdinal !== 0 ||
      preview.confirmedByUserId !== idea.actorUserId ||
      !preview.confirmationAuditLogId || !preview.confirmedAt ||
      preview.consumedAt === null || preview.outcomeUnknownAt !== null ||
      preview.payloadPurgedAt !== null || !preview.payloadCiphertext ||
      !preview.payloadKeyId || !preview.payloadKeyVersion ||
      !preview.payloadPurgeAfter ||
      hold.previewId !== preview.id || hold.namespace !== AMUX_V4_ANALYSIS_NAMESPACE ||
      hold.modelId !== preview.modelId || hold.status !== "succeeded" ||
      hold.dispatchedAt === null || hold.closedAt === null ||
      hold.closedAt > now || hold.settledMicroUsd === null ||
      hold.settledMicroUsd <= BigInt(0)) {
    throw new AmuxFirstAnalysisDraftError("not_ready");
  }
  const plan = await tx.amuxIdeaSourcePlanRevision.findUnique({
    where: { id: idea.currentSourcePlanRevisionId },
  });
  const confirmation = await tx.adminAuditLog.findUnique({
    where: { id: preview.confirmationAuditLogId },
  });
  const metadata = confirmation?.metadata;
  if (!plan || plan.ideaId !== idea.id || plan.actorUserId !== idea.actorUserId ||
      plan.state !== "active" || plan.revisionNumber !== 1 ||
      plan.startChunkIndex !== 0 || plan.sourceUnitCount !== 1 ||
      chunk.revisionChunkIndex !== chunkIndex || chunk.planStartChunkIndex !== 0 ||
      !confirmation?.entryHash || auditRowActorKind(confirmation) !== "human" ||
      confirmation.actorUserId !== idea.actorUserId ||
      confirmation.action !== "amux.v4.transfer_preview.confirmed" ||
      confirmation.targetType !== "AmuxIdeaTransferPreview" ||
      confirmation.targetId !== preview.id ||
      !metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
      (metadata as Record<string, unknown>).payloadDigest !== preview.payloadDigest ||
      (metadata as Record<string, unknown>).payloadDigestKeyId !== preview.payloadDigestKeyId ||
      (metadata as Record<string, unknown>).sourcePlanRevisionId !== plan.id ||
      (metadata as Record<string, unknown>).modelId !== preview.modelId ||
      await tx.amuxIdeaDraftUnit.count({ where: { ideaId: idea.id, chunkIndex } }) !== 0) {
    throw new AmuxFirstAnalysisDraftError("integrity_unavailable");
  }
  let payload: Buffer;
  try {
    payload = openAmuxContent({ ciphertext: Buffer.from(preview.payloadCiphertext),
      keyId: preview.payloadKeyId, keyVersion: preview.payloadKeyVersion },
    "transfer_payload", preview.id, input.keys);
  } catch { throw new AmuxFirstAnalysisDraftError("integrity_unavailable"); }
  try {
    if (!verifyAmuxContentDigest(payload, "transfer_payload", preview.id,
      preview.payloadDigest, preview.payloadDigestKeyId, input.keys)) {
      throw new AmuxFirstAnalysisDraftError("integrity_unavailable");
    }
    const parsed: unknown = JSON.parse(payload.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        (parsed as Record<string, unknown>).previewId !== preview.id ||
        (parsed as Record<string, unknown>).ideaId !== idea.id ||
        (parsed as Record<string, unknown>).templateVersion !== preview.templateVersion ||
        !((parsed as Record<string, unknown>).selection) ||
        typeof (parsed as Record<string, unknown>).selection !== "object" ||
        ((parsed as Record<string, unknown>).selection as Record<string, unknown>).modelId !==
          preview.modelId ||
        ((parsed as Record<string, unknown>).selection as Record<string, unknown>).provider !==
          hold.provider) {
      throw new AmuxFirstAnalysisDraftError("integrity_unavailable");
    }
  } catch { throw new AmuxFirstAnalysisDraftError("integrity_unavailable"); }
  finally { payload.fill(0); }
  const preceding = chunkIndex > 0 ? await tx.amuxIdeaAnalysisChunk.findMany({
    where: { ideaId: idea.id, sourcePlanRevisionId: plan.id,
      chunkIndex: { lt: chunkIndex } }, orderBy: { chunkIndex: "asc" },
  }) : [];
  if (preceding.length !== chunkIndex || preceding.some((page, index) =>
    page.chunkIndex !== index || page.state !== "draft_ready" ||
    page.coveredStartOrdinal === null || page.coveredEndOrdinal === null ||
    page.outputPartIndex === null || page.outputPending === null ||
    !["complete", "more", "needs_owner_input"].includes(String(page.coverageStatus)))) {
    throw new AmuxFirstAnalysisDraftError("integrity_unavailable");
  }
  const previous = chunkIndex > 0
    ? await readPreviousOutputPage(tx, { ideaId: idea.id,
      actorUserId: idea.actorUserId, chunkIndex, planId: plan.id, now,
      keys: input.keys }) : null;
  const history = preceding.map((page) => ({ chunkIndex: page.chunkIndex,
    coveredStartOrdinal: page.coveredStartOrdinal!,
    coveredEndOrdinal: page.coveredEndOrdinal!,
    remainingStartOrdinal: page.remainingStartOrdinal,
    remainingEndOrdinal: page.remainingEndOrdinal,
    coverageStatus: page.coverageStatus as "complete" | "more" | "needs_owner_input",
    outputPartIndex: page.outputPartIndex!, outputPending: page.outputPending! }));
  const prepared = prepareAmuxAnalysisPageDraft({
    ideaId: idea.id, previewId: preview.id, raw: input.rawModelOutput,
    keys: input.keys, unitIds: input.unitIds,
    chunkIndex, revisionChunkIndex: chunkIndex,
    permittedSourceRefIds: ["operator_idea"],
    permittedTargetRefs: previous?.permittedTargetRefs ?? [],
    sourceUnitCount: 1, coveredStartOrdinal: 0, coveredEndOrdinal: 0,
    history,
  });
  if (prepared.decision === "hold") {
    throw new AmuxFirstAnalysisDraftError("invalid_result");
  }
  const needsOwnerInput = prepared.decision === "needs_owner_input";
  const page = prepared.decision === "ready" ? prepared.page : {
    chunkIndex, coveredStartOrdinal: prepared.coveredStartOrdinal,
    coveredEndOrdinal: prepared.coveredEndOrdinal,
    remainingStartOrdinal: null,
    remainingEndOrdinal: null, coverageStatus: "needs_owner_input" as const,
    outputPartIndex: history.at(-1)?.outputPending
      ? history.at(-1)!.outputPartIndex + 1 : 0,
    outputPending: false,
  };
  const nextCursor = prepared.decision === "ready" ? prepared.nextCursor : null;
  const nextMonth = new Date(now.getTime() + 30 * DAY_MS);
  const finishesAnalysis = nextCursor === null && !needsOwnerInput;
  const activeAnalysisPurgeAfter = new Date(idea.analysisDeadlineAt.getTime() + DAY_MS);
  // The next page needs both the preceding freeform and transfer text.
  // Completion advances all page bodies to the next purge tick.
  const payloadPurgeAfter = new Date(Math.min(
    (finishesAnalysis ? now : activeAnalysisPurgeAfter).getTime(),
    preview.payloadPurgeAfter.getTime()));
  const auditId = await writeSystemAuditLog({
    tx, systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
    action: AMUX_V4_FIRST_DRAFT_SAVED_ACTION,
    targetType: AMUX_V4_FIRST_DRAFT_SAVED_TARGET,
    targetId: `${idea.id}:${chunkIndex}`,
    summary: "Stored one bounded AMUX v4 idea analysis page as independently purgeable proposal units.",
    metadata: { ideaId: idea.id, chunkIndex,
      previewId: preview.id, sourcePlanRevisionId: plan.id,
      leaseGeneration: chunk.leaseGeneration, unitCount: prepared.draft.units.length,
      outcome: prepared.draft.outcome,
      coverageStatus: prepared.draft.coverageStatus,
      continuationKind: prepared.draft.continuationKind,
      coveredStartOrdinal: page.coveredStartOrdinal,
      coveredEndOrdinal: page.coveredEndOrdinal,
      remainingStartOrdinal: page.remainingStartOrdinal,
      remainingEndOrdinal: page.remainingEndOrdinal,
      outputPartIndex: page.outputPartIndex,
      outputPending: page.outputPending,
      nextSourceOrdinal: nextCursor?.sourceOrdinal ?? null,
      freeformDigest: prepared.draft.freeform.digest,
      freeformDigestKeyId: prepared.draft.freeform.digestKeyId,
      unitCommitments: prepared.draft.units.map((unit) => ({
        id: unit.id, localRef: unit.localRef, kind: unit.unitKind,
        digest: unit.body.digest, digestKeyId: unit.body.digestKeyId,
      })),
      cardRegistrationStarted: false },
  });
  const completedChunk = await tx.amuxIdeaAnalysisChunk.updateMany({
    where: { ideaId: idea.id, chunkIndex, state: "in_flight",
      currentPreviewId: preview.id, leaseGeneration: input.leaseGeneration,
      analysisCompletedAt: null },
    data: { state: "draft_ready", analysisCompletedAt: now,
      coverageStatus: prepared.draft.coverageStatus,
      continuationKind: needsOwnerInput ? null : prepared.draft.continuationKind,
      outputPartIndex: page.outputPartIndex,
      outputPending: page.outputPending, draftVersion: 2,
      freeformCiphertext: Uint8Array.from(prepared.draft.freeform.ciphertext),
      freeformKeyId: prepared.draft.freeform.keyId,
      freeformKeyVersion: prepared.draft.freeform.keyVersion,
      freeformPurgeAfter: finishesAnalysis ? now : activeAnalysisPurgeAfter,
      coveredStartOrdinal: page.coveredStartOrdinal,
      coveredEndOrdinal: page.coveredEndOrdinal,
      remainingStartOrdinal: page.remainingStartOrdinal,
      remainingEndOrdinal: page.remainingEndOrdinal },
  });
  if (completedChunk.count !== 1) {
    throw new AmuxFirstAnalysisDraftError("integrity_unavailable");
  }
  if (prepared.draft.units.length > 0) {
    const created = await tx.amuxIdeaDraftUnit.createMany({
      data: prepared.draft.units.map((unit) => ({
        id: unit.id, ideaId: idea.id, actorUserId: idea.actorUserId,
        chunkIndex, unitIndex: unit.unitIndex,
        localRef: unit.localRef, unitKind: unit.unitKind,
        state: "proposed", expiresAt: nextMonth,
        bodyCiphertext: Uint8Array.from(unit.body.ciphertext), bodyKeyId: unit.body.keyId,
        bodyKeyVersion: unit.body.keyVersion,
        bodyDigest: unit.body.digest, bodyDigestKeyId: unit.body.digestKeyId,
      })),
    });
    if (created.count !== prepared.draft.units.length) {
      throw new AmuxFirstAnalysisDraftError("integrity_unavailable");
    }
  }
  const closedPreview = await tx.amuxIdeaTransferPreview.updateMany({
    where: { id: preview.id, state: "in_flight", consumedAt: { not: null },
      outcomeUnknownAt: null },
    data: { state: "completed", payloadPurgeAfter },
  });
  if (closedPreview.count !== 1) {
    throw new AmuxFirstAnalysisDraftError("integrity_unavailable");
  }
  if (nextCursor !== null) {
    // The first idea-only source is one ordinal. A ninth proposed card opens
    // another output page, not a new source or an idea-wide rejection. The
    // next page still needs its own owner-confirmed preview and budget hold.
    if (nextCursor.sourceOrdinal !== 0 ||
        nextCursor.outputPartIndex !== chunkIndex + 1 ||
        !Number.isSafeInteger(chunkIndex + 1)) {
      throw new AmuxFirstAnalysisDraftError("integrity_unavailable");
    }
    await tx.amuxIdeaAnalysisChunk.create({ data: {
      ideaId: idea.id, actorUserId: idea.actorUserId,
      chunkIndex: chunkIndex + 1, state: "pending", attempt: 0, leaseGeneration: 0,
      sourcePlanRevisionId: plan.id, planStartChunkIndex: 0,
      revisionChunkIndex: chunkIndex + 1,
    } });
  } else if (!needsOwnerInput) {
    const completedIdea = await tx.amuxIdeaSubmission.updateMany({
      where: { id: idea.id, state: "analyzing", analysisCompletedAt: null,
        cancelledAt: null, analysisDeadlineAt: { gt: now } },
      data: { state: "awaiting_owner", analysisCompletedAt: now,
        rawPurgeAfter: now },
    });
    if (completedIdea.count !== 1) {
      throw new AmuxFirstAnalysisDraftError("integrity_unavailable");
    }
    // End the retention clock for every earlier page in the same transaction.
    // The database allows deadlines to move earlier, never later.
    await tx.amuxIdeaAnalysisChunk.updateMany({ where: { ideaId: idea.id,
      chunkIndex: { lt: chunkIndex }, freeformCiphertext: { not: null },
      freeformPurgeAfter: { gt: now } },
    data: { freeformPurgeAfter: now } });
    await tx.amuxIdeaTransferPreview.updateMany({ where: { ideaId: idea.id,
      payloadCiphertext: { not: null },
      payloadPurgeAfter: { gt: now } },
    data: { payloadPurgeAfter: now } });
  }
  return { ideaId: idea.id, previewId: preview.id,
    unitCount: prepared.draft.units.length,
    analysisCompletedAt: now.toISOString(), auditId,
    nextCursor };
}
