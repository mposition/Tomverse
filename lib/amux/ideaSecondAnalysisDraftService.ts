import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { auditRowActorKind, AMUX_V4_FIRST_DRAFT_SAVED_ACTION,
  AMUX_V4_FIRST_DRAFT_SAVED_TARGET, AMUX_V4_IDEA_SYSTEM_ACTOR,
  AMUX_V4_SECOND_DRAFT_SAVED_ACTION, AMUX_V4_SECOND_DRAFT_SAVED_TARGET } from
  "@/lib/adminAuditSystemActors";
import { AMUX_V4_ANALYSIS_NAMESPACE } from "./ideaAnalysisBudgetCore.ts";
import { readVerifiedAmuxIdeaAnalysisContinuationContext } from
  "./ideaContinuedAnalysisResultReadService.ts";
import { buildIdeaOnlyOutputContinuationPrompt } from "./ideaAnalysisPromptCore.ts";
import { prepareIdeaOnlyOutputAnalysisDraft } from "./ideaSecondAnalysisDraftCore.ts";
import { openAmuxContent, verifyAmuxContentDigest,
  type AmuxContentKeys } from "./ideaCrypto.ts";
import { inspectAmuxIdeaInput } from "./ideaInputCore.ts";

const ID = /^[A-Za-z0-9:_-]{1,128}$/;
const DAY_MS = 24 * 60 * 60_000;

export class AmuxSecondAnalysisDraftError extends Error {
  constructor(readonly code: "not_ready" | "invalid_result" | "integrity_unavailable") {
    super(code);
    this.name = "AmuxSecondAnalysisDraftError";
  }
}

/** Dark app-DB writer. The future route must prove that rawModelOutput came
 * from the exact fenced invocation; this transaction does not authenticate a
 * local runner, call a model, register a card, or authorize another transfer.
 * Unknown COMMIT outcome requires read-back by previewId, not a blind retry. */
export async function commitAmuxSecondIdeaAnalysisDraft(
  tx: Prisma.TransactionClient,
  input: { ideaId: string; previewId: string; holdId: string;
    leaseGeneration: number; rawModelOutput: string; keys: AmuxContentKeys },
): Promise<{ ideaId: string; previewId: string; unitCount: number;
  coverageStatus: "complete" | "more"; nextChunkIndex: number | null;
  analysisCompletedAt: string | null; auditId: string }> {
  return commitAmuxContinuedIdeaAnalysisDraft(tx, { ...input, chunkIndex: 1 });
}

/** Every continuation stays on the original source plan and is independently
 * owner-previewed, charged, audited and sealed. No model is called here. */
export async function commitAmuxContinuedIdeaAnalysisDraft(
  tx: Prisma.TransactionClient,
  input: { ideaId: string; previewId: string; holdId: string;
    chunkIndex: number; leaseGeneration: number; rawModelOutput: string;
    keys: AmuxContentKeys },
): Promise<{ ideaId: string; previewId: string; unitCount: number;
  coverageStatus: "complete" | "more"; nextChunkIndex: number | null;
  analysisCompletedAt: string | null; auditId: string }> {
  if (!input || !ID.test(input.ideaId) || !ID.test(input.previewId) ||
      !ID.test(input.holdId) || !Number.isSafeInteger(input.leaseGeneration) ||
      !Number.isSafeInteger(input.chunkIndex) || input.chunkIndex < 1 ||
      input.chunkIndex >= 2_147_483_647 ||
      input.leaseGeneration < 1 || typeof input.rawModelOutput !== "string" ||
      Buffer.byteLength(input.rawModelOutput, "utf8") > 65_536) {
    throw new AmuxSecondAnalysisDraftError("not_ready");
  }
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  const isolation = await tx.$queryRaw<Array<{ level: string }>>`
    SELECT current_setting('transaction_isolation') AS "level"
  `;
  if (isolation[0]?.level !== "read committed") {
    throw new AmuxSecondAnalysisDraftError("not_ready");
  }
  await takeAuditChainLock(tx);
  const ideaLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaSubmission" WHERE "id" = ${input.ideaId} FOR UPDATE
  `;
  const chunkLocks = await tx.$queryRaw<Array<{ chunkIndex: number }>>`
    SELECT "chunkIndex" FROM "AmuxIdeaAnalysisChunk"
    WHERE "ideaId" = ${input.ideaId} AND "chunkIndex" <= ${input.chunkIndex}
    ORDER BY "chunkIndex" FOR UPDATE
  `;
  const previewLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaTransferPreview"
    WHERE "id" = ${input.previewId} FOR UPDATE
  `;
  const holdLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaAnalysisBudgetHold"
    WHERE "id" = ${input.holdId} FOR UPDATE
  `;
  if (ideaLock.length !== 1 || chunkLocks.length !== input.chunkIndex + 1 ||
      chunkLocks.some((row, index) => row.chunkIndex !== index) ||
      previewLock.length !== 1 || holdLock.length !== 1) {
    throw new AmuxSecondAnalysisDraftError("not_ready");
  }
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = clock[0]?.now;
  const [idea, firstChunk, chunk, preview, hold] = await Promise.all([
    tx.amuxIdeaSubmission.findUnique({ where: { id: input.ideaId } }),
    tx.amuxIdeaAnalysisChunk.findUnique({ where: {
      ideaId_chunkIndex: { ideaId: input.ideaId, chunkIndex: 0 },
    } }),
    tx.amuxIdeaAnalysisChunk.findUnique({ where: {
      ideaId_chunkIndex: { ideaId: input.ideaId, chunkIndex: input.chunkIndex },
    } }),
    tx.amuxIdeaTransferPreview.findUnique({ where: { id: input.previewId } }),
    tx.amuxIdeaAnalysisBudgetHold.findUnique({ where: { id: input.holdId } }),
  ]);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !idea || !firstChunk || !chunk || !preview || !hold) {
    throw new AmuxSecondAnalysisDraftError("integrity_unavailable");
  }
  if (idea.state !== "analyzing" || now >= idea.analysisDeadlineAt ||
      idea.analysisCompletedAt !== null || idea.cancelledAt !== null ||
      !idea.currentSourcePlanRevisionId || !idea.rawCiphertext ||
      !idea.rawKeyId || !idea.rawKeyVersion || !idea.rawDigest ||
      !idea.rawDigestKeyId || idea.rawPurgedAt !== null ||
      firstChunk.state !== "draft_ready" || firstChunk.outputPending !== true ||
      firstChunk.coverageStatus !== "more" || firstChunk.continuationKind !== "output" ||
      firstChunk.outputPartIndex !== 0 || firstChunk.coveredStartOrdinal !== 0 ||
      firstChunk.coveredEndOrdinal !== 0 || firstChunk.remainingStartOrdinal !== 0 ||
      firstChunk.remainingEndOrdinal !== 0 || !firstChunk.analysisCompletedAt ||
      firstChunk.sourcePlanRevisionId !== idea.currentSourcePlanRevisionId ||
      chunk.state !== "in_flight" || chunk.chunkIndex !== input.chunkIndex ||
      chunk.actorUserId !== idea.actorUserId ||
      chunk.leaseGeneration !== input.leaseGeneration ||
      chunk.analysisCompletedAt !== null || chunk.freeformCiphertext !== null ||
      chunk.currentPreviewId !== preview.id ||
      chunk.sourcePlanRevisionId !== idea.currentSourcePlanRevisionId ||
      chunk.planStartChunkIndex !== 0 ||
      chunk.revisionChunkIndex !== input.chunkIndex ||
      chunk.attempt !== preview.attempt ||
      preview.state !== "in_flight" || preview.ideaId !== idea.id ||
      preview.chunkIndex !== input.chunkIndex ||
      preview.sourcePlanRevisionId !== idea.currentSourcePlanRevisionId ||
      preview.sourceScopeApprovalId !== null || preview.sourceUnitOrdinal !== 0 ||
      preview.confirmedByUserId !== idea.actorUserId ||
      !preview.confirmedAt || !preview.confirmationAuditLogId ||
      preview.consumedAt === null || preview.outcomeUnknownAt !== null ||
      preview.payloadPurgedAt !== null || !preview.payloadCiphertext ||
      !preview.payloadKeyId || !preview.payloadKeyVersion ||
      !preview.payloadPurgeAfter || now >= preview.payloadPurgeAfter ||
      hold.previewId !== preview.id || hold.namespace !== AMUX_V4_ANALYSIS_NAMESPACE ||
      hold.modelId !== preview.modelId || hold.status !== "succeeded" ||
      hold.dispatchedAt === null || hold.closedAt === null ||
      hold.closedAt > now || hold.settledMicroUsd === null ||
      hold.settledMicroUsd <= BigInt(0)) {
    throw new AmuxSecondAnalysisDraftError("not_ready");
  }
  const plan = await tx.amuxIdeaSourcePlanRevision.findUnique({
    where: { id: idea.currentSourcePlanRevisionId },
  });
  const confirmation = await tx.adminAuditLog.findUnique({
    where: { id: preview.confirmationAuditLogId },
  });
  const preparedAudits = await tx.adminAuditLog.findMany({
    where: { action: "amux.v4.transfer_preview.prepared",
      targetType: "AmuxIdeaTransferPreview", targetId: preview.id,
      actorUserId: idea.actorUserId }, take: 2,
  });
  const priorAudits = await tx.adminAuditLog.findMany({
    where: { action: input.chunkIndex === 1 ? AMUX_V4_FIRST_DRAFT_SAVED_ACTION :
        AMUX_V4_SECOND_DRAFT_SAVED_ACTION,
      targetType: input.chunkIndex === 1 ? AMUX_V4_FIRST_DRAFT_SAVED_TARGET :
        AMUX_V4_SECOND_DRAFT_SAVED_TARGET,
      targetId: `${idea.id}:${input.chunkIndex - 1}` }, take: 2,
  });
  const confirmationMeta = confirmation?.metadata as Record<string, unknown> | null;
  const preparedMeta = preparedAudits[0]?.metadata as Record<string, unknown> | null;
  const priorAuditHash = priorAudits[0]?.entryHash;
  if (!plan || plan.ideaId !== idea.id || plan.actorUserId !== idea.actorUserId ||
      plan.state !== "active" || plan.revisionNumber !== 1 ||
      plan.startChunkIndex !== 0 || plan.sourceUnitCount !== 1 ||
      priorAudits.length !== 1 || !priorAuditHash ||
      preparedAudits.length !== 1 || !preparedAudits[0]?.entryHash ||
      auditRowActorKind(preparedAudits[0]) !== "human" ||
      !preparedMeta || typeof preparedMeta !== "object" ||
      Array.isArray(preparedMeta) ||
      preparedMeta.previousChunkAuditHash !== priorAuditHash ||
      preparedMeta.sourcePlanRevisionId !== plan.id ||
      preparedMeta.payloadDigest !== preview.payloadDigest ||
      preparedMeta.payloadDigestKeyId !== preview.payloadDigestKeyId ||
      preparedMeta.transferAuthorized !== false ||
      !confirmation?.entryHash || auditRowActorKind(confirmation) !== "human" ||
      confirmation.actorUserId !== idea.actorUserId ||
      confirmation.action !== "amux.v4.transfer_preview.confirmed" ||
      confirmation.targetType !== "AmuxIdeaTransferPreview" ||
      confirmation.targetId !== preview.id ||
      !confirmationMeta || typeof confirmationMeta !== "object" ||
      Array.isArray(confirmationMeta) ||
      confirmationMeta.chunkIndex !== input.chunkIndex ||
      confirmationMeta.sourcePlanRevisionId !== plan.id ||
      confirmationMeta.payloadDigest !== preview.payloadDigest ||
      confirmationMeta.payloadDigestKeyId !== preview.payloadDigestKeyId ||
      confirmationMeta.modelId !== preview.modelId ||
      await tx.amuxIdeaDraftUnit.count({ where: { ideaId: idea.id,
        chunkIndex: input.chunkIndex } }) !== 0 ||
      await tx.adminAuditLog.count({ where: {
        action: AMUX_V4_SECOND_DRAFT_SAVED_ACTION,
        targetType: AMUX_V4_SECOND_DRAFT_SAVED_TARGET,
        targetId: `${idea.id}:${input.chunkIndex}`,
      } }) !== 0) {
    throw new AmuxSecondAnalysisDraftError("integrity_unavailable");
  }
  const pinnedTargetRefs = preparedMeta.pinnedTargetRefs === undefined ? [] :
    preparedMeta.pinnedTargetRefs;
  if (!Array.isArray(pinnedTargetRefs) || pinnedTargetRefs.length > 6 ||
      pinnedTargetRefs.some((ref: unknown) => typeof ref !== "string" ||
        !/^c[0-9]+:(?:node|card)-[0-9]+$/.test(ref)) ||
      new Set(pinnedTargetRefs).size !== pinnedTargetRefs.length) {
    throw new AmuxSecondAnalysisDraftError("integrity_unavailable");
  }
  const context = await readVerifiedAmuxIdeaAnalysisContinuationContext(
    tx, idea.actorUserId, idea.id, input.keys, pinnedTargetRefs as string[]);
  if (context.pageCount !== input.chunkIndex || context.complete ||
      !context.previous.remainingScope) {
    throw new AmuxSecondAnalysisDraftError("not_ready");
  }
  const previous = context.previous;
  const previousUnits = previous.units.map((unit) => unit.proposal!);
  const priorTargets = context.priorTargets;
  const historyRows = await tx.amuxIdeaAnalysisChunk.findMany({
    where: { ideaId: idea.id, chunkIndex: { lt: input.chunkIndex } },
    orderBy: { chunkIndex: "asc" },
  });
  if (historyRows.length !== input.chunkIndex || historyRows.some((row, index) =>
    row.chunkIndex !== index || row.state !== "draft_ready" ||
    row.sourcePlanRevisionId !== idea.currentSourcePlanRevisionId ||
    row.outputPending !== true || row.coverageStatus !== "more" ||
    row.continuationKind !== "output" || row.outputPartIndex !== index ||
    row.coveredStartOrdinal !== 0 || row.coveredEndOrdinal !== 0 ||
    row.remainingStartOrdinal !== 0 || row.remainingEndOrdinal !== 0)) {
    throw new AmuxSecondAnalysisDraftError("integrity_unavailable");
  }
  const history = historyRows.map((row) => ({ chunkIndex: row.chunkIndex,
    coveredStartOrdinal: row.coveredStartOrdinal!,
    coveredEndOrdinal: row.coveredEndOrdinal!,
    remainingStartOrdinal: row.remainingStartOrdinal!,
    remainingEndOrdinal: row.remainingEndOrdinal!,
    coverageStatus: "more" as const, outputPartIndex: row.outputPartIndex!,
    outputPending: true as const }));
  let selectedTargets = context.targets;
  let payload: Buffer | undefined;
  let raw: Buffer | undefined;
  try {
    payload = openAmuxContent({ ciphertext: Buffer.from(preview.payloadCiphertext),
      keyId: preview.payloadKeyId, keyVersion: preview.payloadKeyVersion },
    "transfer_payload", preview.id, input.keys);
    raw = openAmuxContent({ ciphertext: Buffer.from(idea.rawCiphertext),
      keyId: idea.rawKeyId, keyVersion: idea.rawKeyVersion },
    "idea_raw", idea.id, input.keys);
    if (!verifyAmuxContentDigest(payload, "transfer_payload", preview.id,
      preview.payloadDigest, preview.payloadDigestKeyId, input.keys) ||
        !verifyAmuxContentDigest(raw, "idea_raw", idea.id,
          idea.rawDigest, idea.rawDigestKeyId, input.keys)) {
      throw new Error("digest mismatch");
    }
    const stored = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
    const parsed = inspectAmuxIdeaInput(raw.toString("utf8"));
    if (!parsed.ok || parsed.input.repositories.length !== 0 ||
        parsed.input.pullRequests.length !== 0) throw new Error("invalid source");
    const priorRaw = JSON.stringify({ schemaVersion: 2, previewId: previous.previewId,
      chunkIndex: input.chunkIndex - 1, outcome: "propose", coverageStatus: "more",
      continuationKind: "output", ownerQuestion: null,
      coveredScope: previous.coveredScope, remainingScope: previous.remainingScope,
      units: previousUnits });
    const rebuilt = buildIdeaOnlyOutputContinuationPrompt({
      previewId: preview.id, previousPreviewId: previous.previewId,
      previousRaw: priorRaw, previousAuditHash: priorAuditHash,
      previousChunkIndex: input.chunkIndex - 1,
      priorPermittedTargetRefs: priorTargets, ideaText: parsed.input.idea,
      previousPagePermittedTargetRefs: context.validationTargets,
      nextPermittedTargetRefs: context.targets,
      pinnedTargetRefs: pinnedTargetRefs as string[],
      omittedTargetSummary: context.omittedTargetSummary,
    });
    if (rebuilt.status !== "prompt_candidate" ||
        stored.version !== 1 || stored.previewId !== preview.id ||
        stored.ideaId !== idea.id || stored.templateVersion !== rebuilt.version ||
        stored.prompt !== rebuilt.prompt || !stored.selection ||
        typeof stored.selection !== "object" || Array.isArray(stored.selection) ||
        (stored.selection as Record<string, unknown>).provider !== hold.provider ||
        (stored.selection as Record<string, unknown>).modelId !== preview.modelId ||
        (stored.selection as Record<string, unknown>).approvalId !==
          preparedMeta.modelApprovalId ||
        (stored.selection as Record<string, unknown>).approvalVersion !==
          preparedMeta.modelApprovalVersion) {
      throw new Error("preview mismatch");
    }
    selectedTargets = rebuilt.selectedTargetRefs ?? context.targets;
  } catch { throw new AmuxSecondAnalysisDraftError("integrity_unavailable"); }
  finally { payload?.fill(0); raw?.fill(0); }
  const prepared = prepareIdeaOnlyOutputAnalysisDraft({
    ideaId: idea.id, previewId: preview.id, raw: input.rawModelOutput,
    keys: input.keys, chunkIndex: input.chunkIndex, history,
    permittedTargetRefs: selectedTargets,
  });
  if (prepared.decision === "hold") {
    throw new AmuxSecondAnalysisDraftError("invalid_result");
  }
  const nextDay = new Date(now.getTime() + DAY_MS);
  const firstDecisionDeadline = new Date(firstChunk.analysisCompletedAt.getTime() + 30 * DAY_MS);
  if (now >= firstDecisionDeadline) {
    throw new AmuxSecondAnalysisDraftError("not_ready");
  }
  const freeformPurgeAfter = prepared.decision === "partial"
    ? new Date(idea.analysisDeadlineAt.getTime() + DAY_MS) : nextDay;
  const payloadPurgeAfter = new Date(Math.min(nextDay.getTime(),
    preview.payloadPurgeAfter.getTime()));
  const auditId = await writeSystemAuditLog({
    tx, systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
    action: AMUX_V4_SECOND_DRAFT_SAVED_ACTION,
    targetType: AMUX_V4_SECOND_DRAFT_SAVED_TARGET,
    targetId: `${idea.id}:${input.chunkIndex}`,
    summary: "Stored one bounded AMUX v4 output continuation as independently purgeable units.",
    metadata: { ideaId: idea.id, previewId: preview.id,
      sourcePlanRevisionId: plan.id, previousChunkAuditHash: priorAuditHash,
      leaseGeneration: chunk.leaseGeneration, unitCount: prepared.draft.units.length,
      outcome: prepared.draft.outcome,
      coverageStatus: prepared.draft.coverageStatus,
      continuationKind: prepared.draft.continuationKind,
      remainingStartOrdinal: prepared.remainingStartOrdinal,
      remainingEndOrdinal: prepared.remainingEndOrdinal,
      nextChunkIndex: prepared.decision === "partial" ? input.chunkIndex + 1 : null,
      freeformDigest: prepared.draft.freeform.digest,
      freeformDigestKeyId: prepared.draft.freeform.digestKeyId,
      unitCommitments: prepared.draft.units.map((unit) => ({
        id: unit.id, localRef: unit.localRef, kind: unit.unitKind,
        digest: unit.body.digest, digestKeyId: unit.body.digestKeyId,
      })), cardRegistrationStarted: false },
  });
  const updatedChunk = await tx.amuxIdeaAnalysisChunk.updateMany({
    where: { ideaId: idea.id, chunkIndex: input.chunkIndex, state: "in_flight",
      currentPreviewId: preview.id, leaseGeneration: input.leaseGeneration,
      analysisCompletedAt: null },
    data: { state: "draft_ready", analysisCompletedAt: now,
      coverageStatus: prepared.draft.coverageStatus,
      continuationKind: prepared.draft.continuationKind,
      outputPartIndex: prepared.outputPartIndex,
      outputPending: prepared.decision === "partial", draftVersion: 2,
      freeformCiphertext: Uint8Array.from(prepared.draft.freeform.ciphertext),
      freeformKeyId: prepared.draft.freeform.keyId,
      freeformKeyVersion: prepared.draft.freeform.keyVersion,
      freeformPurgeAfter, coveredStartOrdinal: prepared.coveredStartOrdinal,
      coveredEndOrdinal: prepared.coveredEndOrdinal,
      remainingStartOrdinal: prepared.remainingStartOrdinal,
      remainingEndOrdinal: prepared.remainingEndOrdinal },
  });
  if (updatedChunk.count !== 1) {
    throw new AmuxSecondAnalysisDraftError("integrity_unavailable");
  }
  if (prepared.draft.units.length > 0) {
    const created = await tx.amuxIdeaDraftUnit.createMany({
      data: prepared.draft.units.map((unit) => ({
        id: unit.id, ideaId: idea.id, actorUserId: idea.actorUserId,
        chunkIndex: input.chunkIndex, unitIndex: unit.unitIndex,
        localRef: unit.localRef, unitKind: unit.unitKind,
        state: "proposed", expiresAt: firstDecisionDeadline,
        bodyCiphertext: Uint8Array.from(unit.body.ciphertext),
        bodyKeyId: unit.body.keyId, bodyKeyVersion: unit.body.keyVersion,
        bodyDigest: unit.body.digest, bodyDigestKeyId: unit.body.digestKeyId,
      })),
    });
    if (created.count !== prepared.draft.units.length) {
      throw new AmuxSecondAnalysisDraftError("integrity_unavailable");
    }
  }
  if (prepared.decision === "partial") {
    await tx.amuxIdeaAnalysisChunk.create({ data: {
      ideaId: idea.id, actorUserId: idea.actorUserId,
      chunkIndex: input.chunkIndex + 1, state: "pending", attempt: 0,
      leaseGeneration: 0,
      sourcePlanRevisionId: plan.id, planStartChunkIndex: 0,
      revisionChunkIndex: input.chunkIndex + 1,
    } });
  }
  const closedPreview = await tx.amuxIdeaTransferPreview.updateMany({
    where: { id: preview.id, state: "in_flight", consumedAt: { not: null },
      outcomeUnknownAt: null },
    data: { state: "completed", payloadPurgeAfter },
  });
  const completedIdea = prepared.decision === "ready"
    ? await tx.amuxIdeaSubmission.updateMany({
      where: { id: idea.id, state: "analyzing", analysisCompletedAt: null,
        cancelledAt: null, analysisDeadlineAt: { gt: now } },
      data: { state: "awaiting_owner", analysisCompletedAt: now,
        rawPurgeAfter: now },
    }) : { count: 1 };
  if (closedPreview.count !== 1 || completedIdea.count !== 1) {
    throw new AmuxSecondAnalysisDraftError("integrity_unavailable");
  }
  if (prepared.decision === "ready") {
    await tx.amuxIdeaAnalysisChunk.updateMany({
      where: { ideaId: idea.id, chunkIndex: { lt: input.chunkIndex },
        state: "draft_ready", outputPending: true,
        freeformPurgeAfter: { gt: nextDay } },
      data: { freeformPurgeAfter: nextDay },
    });
  }
  return { ideaId: idea.id, previewId: preview.id,
    unitCount: prepared.draft.units.length,
    coverageStatus: prepared.decision === "ready" ? "complete" : "more",
    nextChunkIndex: prepared.decision === "partial" ? input.chunkIndex + 1 : null,
    analysisCompletedAt: prepared.decision === "ready" ? now.toISOString() : null,
    auditId };
}
