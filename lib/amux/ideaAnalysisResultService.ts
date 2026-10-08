import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { auditRowActorKind, AMUX_V4_ANALYSIS_CLAIM_ACTION,
  AMUX_V4_ANALYSIS_RESULT_ACTION, AMUX_V4_ANALYSIS_RESULT_TARGET,
  AMUX_V4_IDEA_SYSTEM_ACTOR } from "@/lib/adminAuditSystemActors";
import { AMUX_V4_ANALYSIS_NAMESPACE,
  assessAmuxIdeaAnalysisSettlement } from "./ideaAnalysisBudgetCore.ts";
import { commitAmuxKnownIdeaAnalysisSettlement } from
  "./ideaAnalysisBudgetSettlementService.ts";
import { commitAmuxIdeaAnalysisUnknownOutcome } from
  "./ideaAnalysisUnknownOutcomeService.ts";
import { amuxContentDigest, type AmuxContentKeys } from "./ideaCrypto.ts";
import { prepareAmuxAnalysisPageDraft } from "./ideaAnalysisPageDraftCore.ts";
import { commitAmuxFirstIdeaAnalysisDraft } from "./ideaFirstAnalysisDraftService.ts";
import { readPreviousOutputPage } from "./ideaTransferPreviewService.ts";

const ID = /^[A-Za-z0-9:_-]{1,128}$/;
type Outcome = "verified_success" | "invocation_failed" | "outcome_unknown";
type Input = { requestId: string; ideaId: string; previewId: string;
  holdId: string; leaseGeneration: number; outcome: Outcome;
  rawModelOutput: string | null; inputTokens: number | null;
  outputTokens: number | null; keys: AmuxContentKeys;
  unitIds?: readonly string[] };
type Receipt = { previewId: string; ideaId: string;
  state: "draft_ready" | "provider_failed" | "outcome_unknown";
  duplicate: boolean; auditId: string };

export class AmuxIdeaAnalysisResultError extends Error {
  constructor(readonly code: "invalid_result" | "not_ready" | "integrity_unavailable") {
    super(code);
    this.name = "AmuxIdeaAnalysisResultError";
  }
}

function validInput(input: Input): boolean {
  if (!input || ![input.requestId, input.ideaId, input.previewId,
    input.holdId].every((id) => typeof id === "string" && ID.test(id)) ||
    input.leaseGeneration !== 1 || ![
      "verified_success", "invocation_failed", "outcome_unknown",
    ].includes(input.outcome)) return false;
  if (input.outcome === "outcome_unknown") {
    return input.rawModelOutput === null && input.inputTokens === null &&
      input.outputTokens === null;
  }
  if (![input.inputTokens, input.outputTokens].every((n) =>
    Number.isSafeInteger(n) && n !== null && n >= 0)) return false;
  return input.outcome === "verified_success"
    ? typeof input.rawModelOutput === "string" &&
      Buffer.byteLength(input.rawModelOutput, "utf8") <= 65_536
    : input.rawModelOutput === null;
}

function contentDigest(input: Input): { digest: string; digestKeyId: string } {
  const bytes = Buffer.from(JSON.stringify({ requestId: input.requestId,
    ideaId: input.ideaId, previewId: input.previewId, holdId: input.holdId,
    leaseGeneration: input.leaseGeneration, outcome: input.outcome,
    rawModelOutput: input.rawModelOutput,
    inputTokens: input.inputTokens, outputTokens: input.outputTokens }), "utf8");
  try { return amuxContentDigest(bytes, "analysis_result", input.previewId, input.keys); }
  finally { bytes.fill(0); }
}

/** Content-free read-back. The audit-chain lock serializes all result writers;
 * requestId and previewId together distinguish replay from conflicting work. */
async function receiptFor(tx: Prisma.TransactionClient, input: Input,
  digest: { digest: string; digestKeyId: string }): Promise<Receipt | null> {
  const rows = await tx.adminAuditLog.findMany({
    where: { action: AMUX_V4_ANALYSIS_RESULT_ACTION,
      targetType: AMUX_V4_ANALYSIS_RESULT_TARGET,
      OR: [{ targetId: input.previewId },
        { metadata: { path: ["requestId"], equals: input.requestId } }] },
    take: 3,
  });
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new AmuxIdeaAnalysisResultError("integrity_unavailable");
  const row = rows[0]!;
  const metadata = row.metadata;
  if (!row.entryHash || auditRowActorKind(row) !== "system" ||
      row.targetId !== input.previewId || !metadata ||
      typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new AmuxIdeaAnalysisResultError("integrity_unavailable");
  }
  const record = metadata as Record<string, unknown>;
  if (record.requestId !== input.requestId || record.ideaId !== input.ideaId ||
      record.holdId !== input.holdId ||
      record.leaseGeneration !== input.leaseGeneration ||
      record.resultDigest !== digest.digest ||
      record.resultDigestKeyId !== digest.digestKeyId ||
      record.outcome !== input.outcome) {
    throw new AmuxIdeaAnalysisResultError("not_ready");
  }
  const state = record.state;
  if (state !== "draft_ready" && state !== "provider_failed" &&
      state !== "outcome_unknown") {
    throw new AmuxIdeaAnalysisResultError("integrity_unavailable");
  }
  return { previewId: input.previewId, ideaId: input.ideaId,
    state, duplicate: true, auditId: row.id };
}

/** One content-free lookup after a lost HTTP response. Absence is not
 * permission to resubmit; the supervisor still stops for owner resolution. */
export async function readAmuxIdeaAnalysisResultReceipt(
  tx: Prisma.TransactionClient,
  input: { requestId: string; previewId: string },
): Promise<{ status: "absent" } | ({ status: "committed" } & Receipt)> {
  if (!ID.test(input.requestId) || !ID.test(input.previewId)) {
    throw new AmuxIdeaAnalysisResultError("invalid_result");
  }
  const rows = await tx.adminAuditLog.findMany({ where: {
    action: AMUX_V4_ANALYSIS_RESULT_ACTION,
    targetType: AMUX_V4_ANALYSIS_RESULT_TARGET,
    targetId: input.previewId,
  }, take: 2 });
  if (rows.length === 0) return { status: "absent" };
  const row = rows[0]!;
  const metadata = row.metadata;
  if (rows.length !== 1 || !row.entryHash ||
      auditRowActorKind(row) !== "system" || !metadata ||
      typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new AmuxIdeaAnalysisResultError("integrity_unavailable");
  }
  const record = metadata as Record<string, unknown>;
  if (record.requestId !== input.requestId ||
      typeof record.ideaId !== "string" || !ID.test(record.ideaId) ||
      typeof record.holdId !== "string" || !ID.test(record.holdId) ||
      record.leaseGeneration !== 1 || !["draft_ready", "provider_failed",
        "outcome_unknown"].includes(String(record.state))) {
    throw new AmuxIdeaAnalysisResultError("integrity_unavailable");
  }
  const preview = await tx.amuxIdeaTransferPreview.findUnique({
    where: { id: input.previewId },
    select: { ideaId: true, chunkIndex: true, attempt: true, state: true },
  });
  const hold = await tx.amuxIdeaAnalysisBudgetHold.findUnique({
    where: { id: record.holdId }, select: { previewId: true, status: true },
  });
  const chunk = preview ? await tx.amuxIdeaAnalysisChunk.findUnique({
    where: { ideaId_chunkIndex: { ideaId: record.ideaId,
      chunkIndex: preview.chunkIndex } },
    select: { state: true, leaseGeneration: true,
      currentPreviewId: true, attempt: true },
  }) : null;
  const state = record.state as Receipt["state"];
  const newerPreview = state === "provider_failed" && chunk && preview &&
    chunk.currentPreviewId !== input.previewId && chunk.currentPreviewId
    ? await tx.amuxIdeaTransferPreview.findUnique({
      where: { id: chunk.currentPreviewId },
      select: { ideaId: true, chunkIndex: true, attempt: true },
    }) : null;
  const failedPositionValid = chunk && preview && (
    (chunk.currentPreviewId === input.previewId &&
      chunk.state === "awaiting_preview" && chunk.leaseGeneration === 0 &&
      chunk.attempt === preview.attempt) ||
    (newerPreview && newerPreview.ideaId === record.ideaId &&
      newerPreview.chunkIndex === preview.chunkIndex &&
      newerPreview.attempt === chunk.attempt &&
      newerPreview.attempt > preview.attempt));
  if (!preview || preview.ideaId !== record.ideaId || !hold ||
      hold.previewId !== input.previewId || !chunk ||
      (state === "draft_ready" && (preview.state !== "completed" ||
        hold.status !== "succeeded" || chunk.state !== "draft_ready" ||
        chunk.leaseGeneration !== 1 ||
        chunk.currentPreviewId !== input.previewId ||
        chunk.attempt !== preview.attempt)) ||
      (state === "provider_failed" && (preview.state !== "provider_failed" ||
        hold.status !== "failed" || !failedPositionValid)) ||
      (state === "outcome_unknown" && (preview.state !== "outcome_unknown" ||
        hold.status !== "outcome_unknown" || chunk.state !== "outcome_unknown" ||
        chunk.leaseGeneration !== 1 ||
        chunk.currentPreviewId !== input.previewId ||
        chunk.attempt !== preview.attempt))) {
    throw new AmuxIdeaAnalysisResultError("integrity_unavailable");
  }
  return { status: "committed", previewId: input.previewId,
    ideaId: record.ideaId, state, duplicate: true, auditId: row.id };
}

/** A single app-DB writer for a fenced first-page result. It never launches a
 * model and the route remains dark. Settlement, proposal persistence and the
 * canonical receipt commit together; a lost response is read back, not retried. */
export async function commitAmuxIdeaAnalysisResult(
  tx: Prisma.TransactionClient, input: Input,
): Promise<Receipt> {
  if (!validInput(input)) throw new AmuxIdeaAnalysisResultError("invalid_result");
  const digest = contentDigest(input);
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const prior = await receiptFor(tx, input, digest);
  if (prior) return prior;
  const identity = await tx.amuxIdeaTransferPreview.findUnique({
    where: { id: input.previewId },
    select: { ideaId: true, chunkIndex: true },
  });
  const holdIdentity = await tx.amuxIdeaAnalysisBudgetHold.findUnique({
    where: { id: input.holdId },
    select: { previewId: true, namespace: true, monthStart: true },
  });
  if (!identity || identity.ideaId !== input.ideaId ||
      !holdIdentity || holdIdentity.previewId !== input.previewId ||
      holdIdentity.namespace !== AMUX_V4_ANALYSIS_NAMESPACE) {
    throw new AmuxIdeaAnalysisResultError("not_ready");
  }
  // Pre-lock in the shared order before calling the existing settlement and
  // draft writers, whose individual lock subsets otherwise differ.
  const ideaLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaSubmission"
    WHERE "id" = ${input.ideaId} FOR UPDATE
  `;
  const chunkLock = await tx.$queryRaw<Array<{ leaseGeneration: number;
    currentPreviewId: string | null; state: string }>>`
    SELECT "leaseGeneration", "currentPreviewId", "state"
    FROM "AmuxIdeaAnalysisChunk"
    WHERE "ideaId" = ${input.ideaId}
      AND "chunkIndex" = ${identity.chunkIndex} FOR UPDATE
  `;
  const previewLock = await tx.$queryRaw<Array<{ state: string }>>`
    SELECT "state" FROM "AmuxIdeaTransferPreview"
    WHERE "id" = ${input.previewId} FOR UPDATE
  `;
  const windowLock = await tx.$queryRaw<Array<{ namespace: string }>>`
    SELECT "namespace" FROM "AmuxIdeaAnalysisBudgetWindow"
    WHERE "namespace" = ${holdIdentity.namespace}
      AND "monthStart" = ${holdIdentity.monthStart} FOR UPDATE
  `;
  const holdLock = await tx.$queryRaw<Array<{ status: string }>>`
    SELECT "status" FROM "AmuxIdeaAnalysisBudgetHold"
    WHERE "id" = ${input.holdId} FOR UPDATE
  `;
  if (ideaLock.length !== 1 || chunkLock.length !== 1 ||
      previewLock.length !== 1 || windowLock.length !== 1 || holdLock.length !== 1 ||
      chunkLock[0]!.state !== "in_flight" ||
      chunkLock[0]!.currentPreviewId !== input.previewId ||
      chunkLock[0]!.leaseGeneration !== input.leaseGeneration ||
      previewLock[0]!.state !== "in_flight" ||
      holdLock[0]!.status !== "in_flight") {
    throw new AmuxIdeaAnalysisResultError("not_ready");
  }
  const claims = await tx.adminAuditLog.findMany({ where: {
    action: AMUX_V4_ANALYSIS_CLAIM_ACTION,
    targetType: "AmuxIdeaTransferPreview", targetId: input.previewId,
  }, take: 2 });
  const claim = claims[0];
  const claimMetadata = claim?.metadata;
  if (claims.length !== 1 || !claim?.entryHash ||
      auditRowActorKind(claim) !== "system" ||
      !claimMetadata || typeof claimMetadata !== "object" ||
      Array.isArray(claimMetadata) ||
      (claimMetadata as Record<string, unknown>).holdId !== input.holdId ||
      (claimMetadata as Record<string, unknown>).ideaId !== input.ideaId ||
      (claimMetadata as Record<string, unknown>).chunkIndex !== identity.chunkIndex ||
      (claimMetadata as Record<string, unknown>).leaseGeneration !==
        input.leaseGeneration) {
    throw new AmuxIdeaAnalysisResultError("integrity_unavailable");
  }
  // A verified invocation can still produce unusable text. It consumed real
  // tokens, so settle its measured cost as a failed invocation instead of
  // rolling the reservation back to in_flight. The response body is not saved.
  const idea = await tx.amuxIdeaSubmission.findUnique({ where: { id: input.ideaId } });
  if (!idea || !idea.currentSourcePlanRevisionId) {
    throw new AmuxIdeaAnalysisResultError("integrity_unavailable");
  }
  const earlier = identity.chunkIndex > 0
    ? await tx.amuxIdeaAnalysisChunk.findMany({ where: { ideaId: input.ideaId,
      sourcePlanRevisionId: idea.currentSourcePlanRevisionId,
      chunkIndex: { lt: identity.chunkIndex } }, orderBy: { chunkIndex: "asc" } })
    : [];
  if (earlier.length !== identity.chunkIndex || earlier.some((row, index) =>
    row.chunkIndex !== index || row.coveredStartOrdinal === null ||
    row.coveredEndOrdinal === null || row.outputPartIndex === null ||
    row.outputPending === null || !["complete", "more", "needs_owner_input"]
      .includes(String(row.coverageStatus)))) {
    throw new AmuxIdeaAnalysisResultError("integrity_unavailable");
  }
  const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = nowRows[0]?.now;
  if (!(now instanceof Date)) throw new AmuxIdeaAnalysisResultError("integrity_unavailable");
  const previous = input.outcome === "verified_success" && identity.chunkIndex > 0
    ? await readPreviousOutputPage(tx, { ideaId: input.ideaId,
      actorUserId: idea.actorUserId, chunkIndex: identity.chunkIndex,
      planId: idea.currentSourcePlanRevisionId, now, keys: input.keys }) : null;
  const prepared = input.outcome === "verified_success"
    ? prepareAmuxAnalysisPageDraft({ ideaId: input.ideaId,
      previewId: input.previewId, raw: input.rawModelOutput!, keys: input.keys,
      unitIds: input.unitIds, chunkIndex: identity.chunkIndex,
      revisionChunkIndex: identity.chunkIndex,
      permittedSourceRefIds: ["operator_idea"],
      permittedTargetRefs: previous?.permittedTargetRefs ?? [],
      sourceUnitCount: 1, coveredStartOrdinal: 0, coveredEndOrdinal: 0,
      history: earlier.map((row) => ({ chunkIndex: row.chunkIndex,
        coveredStartOrdinal: row.coveredStartOrdinal!,
        coveredEndOrdinal: row.coveredEndOrdinal!,
        remainingStartOrdinal: row.remainingStartOrdinal,
        remainingEndOrdinal: row.remainingEndOrdinal,
        coverageStatus: row.coverageStatus as "complete" | "more" | "needs_owner_input",
        outputPartIndex: row.outputPartIndex!, outputPending: row.outputPending! })) })
    : null;
  const invalidReason = prepared?.decision === "hold" ? prepared.reason :
    null;
  const proposedOutcome = invalidReason ? "invocation_failed" : input.outcome;
  const basis = await tx.amuxIdeaAnalysisBudgetHold.findUnique({
    where: { id: input.holdId },
  });
  if (!basis) throw new AmuxIdeaAnalysisResultError("integrity_unavailable");
  const charge = proposedOutcome === "outcome_unknown" ? null :
    assessAmuxIdeaAnalysisSettlement({ outcome: proposedOutcome,
      reservedMicroUsd: basis.reservedMicroUsd.toString(),
      inputTokensCap: basis.inputTokensCap,
      outputTokensCap: basis.outputTokensCap,
      inputMicroUsdPerMillion: basis.inputMicroUsdPerMillion,
      outputMicroUsdPerMillion: basis.outputMicroUsdPerMillion,
      inputTokens: input.inputTokens, outputTokens: input.outputTokens });
  // A usage report outside the approved cap is not a zero-cost failure.
  // Preserve the full hold and stop Agent-wide until a human resolves it.
  const usageUnverified = charge !== null &&
    charge.decision !== "settlement_candidate";
  const effectiveOutcome = usageUnverified ? "outcome_unknown" : proposedOutcome;
  const state = effectiveOutcome === "verified_success" ? "draft_ready" :
    effectiveOutcome === "invocation_failed" ? "provider_failed" : "outcome_unknown";
  const auditId = await writeSystemAuditLog({ tx,
    systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
    action: AMUX_V4_ANALYSIS_RESULT_ACTION,
    targetType: AMUX_V4_ANALYSIS_RESULT_TARGET,
    targetId: input.previewId,
    summary: "Accepted one fenced AMUX v4 analysis result with no source text in audit.",
    metadata: { requestId: input.requestId, ideaId: input.ideaId,
      holdId: input.holdId, leaseGeneration: input.leaseGeneration,
      resultDigest: digest.digest, resultDigestKeyId: digest.digestKeyId,
      outcome: input.outcome, effectiveOutcome, state,
      failureReason: usageUnverified ? "usage_unverified" : invalidReason ??
        (effectiveOutcome === "invocation_failed" ? "invocation_failed" : null),
      retryAutomatically: false },
  });
  if (effectiveOutcome === "outcome_unknown") {
    await commitAmuxIdeaAnalysisUnknownOutcome(tx,
      { holdId: input.holdId,
        reason: usageUnverified ? "usage_unverified" : "invocation_unverified" });
    const halted = await tx.amuxIdeaAnalysisChunk.updateMany({ where: {
      ideaId: input.ideaId, chunkIndex: identity.chunkIndex, state: "in_flight",
      currentPreviewId: input.previewId,
      leaseGeneration: input.leaseGeneration,
    }, data: { state: "outcome_unknown" } });
    if (halted.count !== 1) {
      throw new AmuxIdeaAnalysisResultError("integrity_unavailable");
    }
  } else {
    await commitAmuxKnownIdeaAnalysisSettlement(tx, { holdId: input.holdId,
      outcome: effectiveOutcome, inputTokens: input.inputTokens,
      outputTokens: input.outputTokens });
    if (effectiveOutcome === "verified_success") {
      await commitAmuxFirstIdeaAnalysisDraft(tx, {
        ideaId: input.ideaId, previewId: input.previewId,
        holdId: input.holdId, leaseGeneration: input.leaseGeneration,
        rawModelOutput: input.rawModelOutput!, keys: input.keys,
        unitIds: input.unitIds, chunkIndex: identity.chunkIndex,
      });
    } else {
      // Return to an owner-only re-preview boundary, not an executable retry.
      // A new attempt needs a new preview id, owner confirmation and budget.
      const stoppedChunk = await tx.amuxIdeaAnalysisChunk.updateMany({ where: {
        ideaId: input.ideaId, chunkIndex: identity.chunkIndex, state: "in_flight",
        currentPreviewId: input.previewId,
        leaseGeneration: input.leaseGeneration,
      }, data: { state: "awaiting_preview", leaseGeneration: 0 } });
      const stoppedIdea = identity.chunkIndex === 0
        ? await tx.amuxIdeaSubmission.updateMany({ where: {
            id: input.ideaId, state: "analyzing", cancelledAt: null,
            analysisCompletedAt: null,
          }, data: { state: "submitted" } })
        : { count: idea.state === "analyzing" ? 1 : 0 };
      if (stoppedChunk.count !== 1 || stoppedIdea.count !== 1) {
        throw new AmuxIdeaAnalysisResultError("integrity_unavailable");
      }
    }
  }
  return { previewId: input.previewId, ideaId: input.ideaId,
    state, duplicate: false, auditId };
}
