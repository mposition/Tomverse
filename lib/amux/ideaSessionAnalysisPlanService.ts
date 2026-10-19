import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_V4_IDEA_SYSTEM_ACTOR,
  AMUX_V4_INITIAL_SOURCE_PLAN_ACTION,
  AMUX_V4_INITIAL_SOURCE_PLAN_TARGET } from "@/lib/adminAuditSystemActors";
import type { AmuxPermittedTargetRef } from "./ideaAnalysisChunkCore.ts";
import { amuxAnalysisFreeformSubjectId } from "./ideaAnalysisDraftSealCore.ts";
import { prepareAmuxAnalysisPageDraft } from "./ideaAnalysisPageDraftCore.ts";
import { AMUX_V4_ANALYSIS_PROMPT_VERSION, buildAmuxIdeaAnalysisPrompt,
  type AmuxIdeaAnalysisPromptInput,
  type AmuxIdeaAnalysisPromptResult } from "./ideaAnalysisPromptCore.ts";
import { openAmuxContent, sealAmuxContent, verifyAmuxContentDigest,
  type AmuxContentKeys } from "./ideaCrypto.ts";
import { persistAmuxAnalysisPageDraftInTx } from
  "./ideaFirstAnalysisDraftService.ts";
import { AMUX_V4_IDEA_SOURCE_SYSTEM } from "./ideaIdentityCore.ts";
import type { AmuxContentKeyIdentity } from "./ideaKeyStore.ts";
import type { AmuxAnalysisOutputPage } from "./ideaOutputCursorCore.ts";
import { inspectSealedAmuxIdeaSessionInput } from "./ideaSessionSubmissionCore.ts";
import { buildAmuxSourcePlanManifest } from "./ideaSourcePlanManifestCore.ts";
import { readPreviousOutputPage } from "./ideaTransferPreviewService.ts";

type Tx = Prisma.TransactionClient;
type Db = Pick<Tx, "amuxIdeaSubmission" | "amuxIdeaAnalysisChunk" |
  "amuxIdeaDraftUnit">;
const DAY_MS = 24 * 60 * 60_000;

/** The session prompt names the claim as its preview id, so the model's echo
 * and the stored preview row share one identity. */
export const amuxSessionAnalysisPreviewId = (claimId: string): string => claimId;

export type AmuxSessionPlanRefusal =
  "invalid_result" | "needs_owner_input" | "continuation_unavailable";

export type AmuxSessionPlanOutcome =
  | { state: "plan_ready"; planId: string; unitCount: number; auditId: string }
  | { state: "plan_continues"; planId: string; unitCount: number;
      auditId: string; nextChunkIndex: number }
  | { state: "plan_refused"; reason: AmuxSessionPlanRefusal };

/** Where the next session invocation stands in the idea's one source plan:
 * page 0 opens the plan; a later page continues the previous page's
 * unfinished output exactly as the v4 owner path does. */
export type AmuxSessionPageContext = {
  chunkIndex: number;
  planId: string | null;
  continuation: AmuxIdeaAnalysisPromptInput["continuation"];
  permittedTargetRefs: AmuxPermittedTargetRef[];
  history: AmuxAnalysisOutputPage[];
};

export class AmuxSessionAnalysisPlanError extends Error {
  constructor(readonly code: "integrity_unavailable" | "continuation_unavailable") {
    super(code);
    this.name = "AmuxSessionAnalysisPlanError";
  }
}

/** The one pending page of a session plan that already has a first page. */
async function pendingPage(db: Db, ideaId: string, planId: string) {
  const pending = await db.amuxIdeaAnalysisChunk.findMany({
    where: { ideaId, sourcePlanRevisionId: planId, state: "pending" },
    select: { chunkIndex: true }, orderBy: { chunkIndex: "asc" }, take: 2 });
  if (pending.length !== 1 || pending[0]!.chunkIndex < 1) {
    throw new AmuxSessionAnalysisPlanError("continuation_unavailable");
  }
  return pending[0]!.chunkIndex;
}

/** Content keys a continuation page must open: the previous page's freeform,
 * stored prompt and proposal units. Read before the key ring is loaded. */
export async function amuxSessionPageKeyIdentities(db: Db,
  ideaId: string): Promise<AmuxContentKeyIdentity[]> {
  const idea = await db.amuxIdeaSubmission.findUnique({ where: { id: ideaId },
    select: { currentSourcePlanRevisionId: true } });
  if (!idea?.currentSourcePlanRevisionId) return [];
  const chunkIndex = await pendingPage(db, ideaId, idea.currentSourcePlanRevisionId);
  const prior = await db.amuxIdeaAnalysisChunk.findUnique({
    where: { ideaId_chunkIndex: { ideaId, chunkIndex: chunkIndex - 1 } },
    select: { currentPreviewId: true } });
  if (!prior?.currentPreviewId) {
    throw new AmuxSessionAnalysisPlanError("continuation_unavailable");
  }
  const units = await db.amuxIdeaDraftUnit.findMany({ where: { ideaId,
    chunkIndex: chunkIndex - 1, derivationGroupId: null },
  select: { id: true } });
  return [
    { ideaId, purpose: "analysis_freeform",
      subjectId: amuxAnalysisFreeformSubjectId(ideaId, prior.currentPreviewId) },
    { ideaId, purpose: "transfer_payload", subjectId: prior.currentPreviewId },
    ...units.map((unit) => ({ ideaId, purpose: "analysis_draft" as const,
      subjectId: unit.id })),
  ];
}

export async function readAmuxSessionPageContextInTx(tx: Tx, input: {
  ideaId: string; actorUserId: string; planId: string | null; now: Date;
  keys: AmuxContentKeys;
}): Promise<AmuxSessionPageContext> {
  if (input.planId === null) {
    return { chunkIndex: 0, planId: null, continuation: null,
      permittedTargetRefs: [], history: [] };
  }
  const chunkIndex = await pendingPage(tx, input.ideaId, input.planId);
  const earlier = await tx.amuxIdeaAnalysisChunk.findMany({ where: {
    ideaId: input.ideaId, sourcePlanRevisionId: input.planId,
    chunkIndex: { lt: chunkIndex } }, orderBy: { chunkIndex: "asc" } });
  if (earlier.length !== chunkIndex || earlier.some((row, index) =>
    row.chunkIndex !== index || row.state !== "draft_ready" ||
    row.coveredStartOrdinal === null || row.coveredEndOrdinal === null ||
    row.outputPartIndex === null || row.outputPending === null ||
    row.coverageStatus !== "more")) {
    throw new AmuxSessionAnalysisPlanError("continuation_unavailable");
  }
  let previous: Awaited<ReturnType<typeof readPreviousOutputPage>>;
  try {
    previous = await readPreviousOutputPage(tx, { ideaId: input.ideaId,
      actorUserId: input.actorUserId, chunkIndex, planId: input.planId,
      now: input.now, keys: input.keys });
  } catch { throw new AmuxSessionAnalysisPlanError("continuation_unavailable"); }
  return { chunkIndex, planId: input.planId,
    continuation: previous.continuation,
    permittedTargetRefs: previous.permittedTargetRefs,
    history: earlier.map((row) => ({ chunkIndex: row.chunkIndex,
      coveredStartOrdinal: row.coveredStartOrdinal!,
      coveredEndOrdinal: row.coveredEndOrdinal!,
      remainingStartOrdinal: row.remainingStartOrdinal,
      remainingEndOrdinal: row.remainingEndOrdinal,
      coverageStatus: "more" as const,
      outputPartIndex: row.outputPartIndex!, outputPending: row.outputPending! })) };
}

/** The v4 prompt for one session page. The app builds it for the runner and
 * stores the same bytes as that page's preview payload, which the next page
 * reads its inherited references from. */
export function buildAmuxSessionPagePrompt(input: { claimId: string;
  idea: string; context: AmuxSessionPageContext }): AmuxIdeaAnalysisPromptResult {
  return buildAmuxIdeaAnalysisPrompt({
    previewId: amuxSessionAnalysisPreviewId(input.claimId),
    chunkIndex: input.context.chunkIndex,
    revisionChunkIndex: input.context.chunkIndex,
    continuation: input.context.continuation,
    sourceTexts: [{ refId: "operator_idea", kind: "operator_idea",
      text: input.idea }],
    permittedTargetRefs: input.context.permittedTargetRefs });
}

async function databaseNow(tx: Tx): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = rows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new AmuxSessionAnalysisPlanError("integrity_unavailable");
  }
  return now;
}

/** Turns one committed session result into the plan page it answered: the
 * same plan, chunk, completed preview and proposal rows the v4 owner path
 * leaves, so the result reader and the system registration writer need no
 * session branch. A finished plan moves the idea to `awaiting_owner`; an
 * output continuation leaves it `analyzing` with the next page pending, which
 * the session queue claims as the next invocation (v19 item 4). An answer that
 * cannot become a page parks the idea for the operator, so no paid invocation
 * is ever bought for an answer that was refused. The caller holds the
 * audit-chain lock and has already committed the result and settlement in
 * this transaction. */
export async function commitAmuxSessionAnalysisPlanInTx(tx: Tx, input: {
  ideaId: string; claimId: string; resultAuditId: string; modelId: string;
  rawModelOutput: string; keys: AmuxContentKeys; unitIds?: readonly string[];
}): Promise<AmuxSessionPlanOutcome> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaSubmission" WHERE "id" = ${input.ideaId} FOR UPDATE
  `;
  const idea = locked.length === 1 ? await tx.amuxIdeaSubmission.findUnique({
    where: { id: input.ideaId },
    select: { id: true, actorUserId: true, state: true, submissionOrigin: true,
      analysisDeadlineAt: true, currentSourcePlanRevisionId: true,
      submissionAuditLogId: true, rawCiphertext: true, rawKeyId: true,
      rawKeyVersion: true, rawDigest: true, rawDigestKeyId: true,
      rawPurgedAt: true },
  }) : null;
  if (!idea || idea.submissionOrigin !== "session" ||
      idea.state !== "analyzing") {
    throw new AmuxSessionAnalysisPlanError("integrity_unavailable");
  }
  const now = await databaseNow(tx);
  const park = async (reason: AmuxSessionPlanRefusal) => {
    const parked = await tx.amuxIdeaSubmission.updateMany({
      where: { id: idea.id, state: "analyzing", analysisCompletedAt: null,
        cancelledAt: null, analysisDeadlineAt: { gt: now } },
      // Completion ends the raw idea's clock, as on the v4 path (DB check).
      data: { state: "awaiting_owner", analysisCompletedAt: now,
        rawPurgeAfter: now },
    });
    if (parked.count !== 1) {
      throw new AmuxSessionAnalysisPlanError("integrity_unavailable");
    }
    return { state: "plan_refused" as const, reason };
  };
  let context: AmuxSessionPageContext;
  try {
    context = await readAmuxSessionPageContextInTx(tx, { ideaId: idea.id,
      actorUserId: idea.actorUserId, planId: idea.currentSourcePlanRevisionId,
      now, keys: input.keys });
  } catch (error) {
    if (error instanceof AmuxSessionAnalysisPlanError &&
        error.code === "continuation_unavailable") {
      return park("continuation_unavailable");
    }
    throw error;
  }
  const previewId = amuxSessionAnalysisPreviewId(input.claimId);
  const prepared = prepareAmuxAnalysisPageDraft({ ideaId: idea.id, previewId,
    raw: input.rawModelOutput, keys: input.keys, unitIds: input.unitIds,
    chunkIndex: context.chunkIndex, revisionChunkIndex: context.chunkIndex,
    permittedSourceRefIds: ["operator_idea"],
    permittedTargetRefs: context.permittedTargetRefs,
    sourceUnitCount: 1, coveredStartOrdinal: 0, coveredEndOrdinal: 0,
    history: context.history, templateVersion: AMUX_V4_ANALYSIS_PROMPT_VERSION });
  if (prepared.decision === "hold") return park("invalid_result");
  // No owner is present during a session analysis (v19 item 4).
  if (prepared.decision === "needs_owner_input") return park("needs_owner_input");
  if (!idea.rawCiphertext || !idea.rawKeyId || !idea.rawKeyVersion ||
      !idea.rawDigest || !idea.rawDigestKeyId || idea.rawPurgedAt !== null ||
      !idea.submissionAuditLogId) {
    throw new AmuxSessionAnalysisPlanError("integrity_unavailable");
  }
  let plain: Buffer;
  try {
    plain = openAmuxContent({ ciphertext: Buffer.from(idea.rawCiphertext),
      keyId: idea.rawKeyId, keyVersion: idea.rawKeyVersion },
    "idea_raw", idea.id, input.keys);
  } catch { throw new AmuxSessionAnalysisPlanError("integrity_unavailable"); }
  let ideaBytes: Buffer | undefined;
  let payload: Buffer | undefined;
  try {
    if (!verifyAmuxContentDigest(plain, "idea_raw", idea.id, idea.rawDigest,
      idea.rawDigestKeyId, input.keys)) {
      throw new AmuxSessionAnalysisPlanError("integrity_unavailable");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(plain.toString("utf8")); }
    catch { throw new AmuxSessionAnalysisPlanError("integrity_unavailable"); }
    const inspected = inspectSealedAmuxIdeaSessionInput(parsed);
    if (!inspected.ok) throw new AmuxSessionAnalysisPlanError("integrity_unavailable");
    let planId = context.planId;
    if (planId === null) {
      // Repositories are read by the CLI from pinned checkouts (v19 item 3),
      // so the source plan carries only the operator's idea as its one unit.
      ideaBytes = Buffer.from(inspected.input.idea, "utf8");
      planId = randomUUID();
      const built = buildAmuxSourcePlanManifest({ ideaId: idea.id,
        actorUserId: idea.actorUserId, revisionId: planId, revisionNumber: 1,
        startChunkIndex: 0, predecessorId: null,
        orderedUnits: [{ sourceKind: "operator_idea",
          sourceReceiptDigest: idea.rawDigest, bytes: ideaBytes }] }, input.keys);
      if (built.decision !== "ready") {
        throw new AmuxSessionAnalysisPlanError("integrity_unavailable");
      }
      const { manifest } = built;
      const planAuditId = await writeSystemAuditLog({ tx,
        systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
        action: AMUX_V4_INITIAL_SOURCE_PLAN_ACTION,
        targetType: AMUX_V4_INITIAL_SOURCE_PLAN_TARGET, targetId: planId,
        summary: "Bound one session analysis result to an operator-idea source plan.",
        metadata: { policyVersion: 19, sourceSystem: AMUX_V4_IDEA_SOURCE_SYSTEM,
          ideaId: idea.id, submittedAuditId: idea.submissionAuditLogId,
          sessionClaimId: input.claimId, sessionResultAuditId: input.resultAuditId,
          revisionNumber: 1, sourceUnitCount: manifest.sourceUnitCount,
          initialChunkIndex: 0, manifestDigest: manifest.manifestDigest,
          manifestDigestKeyId: manifest.manifestDigestKeyId,
          transferAuthorized: false },
      });
      await tx.amuxIdeaSourcePlanRevision.create({ data: { id: planId,
        ideaId: idea.id, actorUserId: idea.actorUserId, revisionNumber: 1,
        startChunkIndex: 0, sourceUnitCount: manifest.sourceUnitCount,
        unitDigests: manifest.unitDigests,
        manifestDigest: manifest.manifestDigest,
        manifestDigestKeyId: manifest.manifestDigestKeyId,
        state: "prepared", creationAuditLogId: planAuditId } });
      await tx.amuxIdeaSourcePlanRevision.update({ where: { id: planId },
        data: { state: "active" } });
      await tx.amuxIdeaAnalysisChunk.create({ data: { ideaId: idea.id,
        actorUserId: idea.actorUserId, chunkIndex: 0, state: "pending",
        attempt: 0, leaseGeneration: 0, sourcePlanRevisionId: planId,
        planStartChunkIndex: 0, revisionChunkIndex: 0 } });
    }
    const prompt = buildAmuxSessionPagePrompt({ claimId: input.claimId,
      idea: inspected.input.idea, context: { ...context, planId } });
    if (prompt.status !== "prompt_candidate") {
      throw new AmuxSessionAnalysisPlanError("integrity_unavailable");
    }
    payload = Buffer.from(JSON.stringify({ previewId, ideaId: idea.id,
      templateVersion: AMUX_V4_ANALYSIS_PROMPT_VERSION,
      modelId: input.modelId, prompt: prompt.prompt }), "utf8");
    const sealed = sealAmuxContent(payload, "transfer_payload", previewId,
      input.keys);
    // The owner's one approval is the operating scope behind the session
    // submission (v19 item 2); the claim-bound result audit stands in for the
    // per-preview confirmation the v4 path collects.
    const confirmUntil = new Date(now.getTime() + DAY_MS);
    const payloadPurgeAfter = new Date(idea.analysisDeadlineAt.getTime() + DAY_MS);
    await tx.amuxIdeaTransferPreview.create({ data: { id: previewId,
      ideaId: idea.id, sourcePlanRevisionId: planId, sourceUnitOrdinal: 0,
      chunkIndex: context.chunkIndex, attempt: 1, state: "in_flight",
      modelId: input.modelId, templateVersion: AMUX_V4_ANALYSIS_PROMPT_VERSION,
      payloadCiphertext: Uint8Array.from(sealed.ciphertext),
      payloadKeyId: sealed.keyId, payloadKeyVersion: sealed.keyVersion,
      payloadDigest: sealed.digest, payloadDigestKeyId: sealed.digestKeyId,
      payloadPurgeAfter, expiresAt: confirmUntil, confirmedAt: now,
      confirmExpiresAt: confirmUntil, confirmedByUserId: idea.actorUserId,
      confirmationAuditLogId: input.resultAuditId, consumedAt: now } });
    const started = await tx.amuxIdeaAnalysisChunk.updateMany({
      where: { ideaId: idea.id, chunkIndex: context.chunkIndex,
        state: "pending", currentPreviewId: null, sourcePlanRevisionId: planId },
      data: { state: "in_flight", attempt: 1, leaseGeneration: 1,
        currentPreviewId: previewId },
    });
    const bound = context.planId !== null ? { count: 1 } :
      await tx.amuxIdeaSubmission.updateMany({
        where: { id: idea.id, state: "analyzing",
          currentSourcePlanRevisionId: null },
        data: { currentSourcePlanRevisionId: planId },
      });
    if (started.count !== 1 || bound.count !== 1) {
      throw new AmuxSessionAnalysisPlanError("integrity_unavailable");
    }
    const saved = await persistAmuxAnalysisPageDraftInTx(tx, { idea, planId,
      chunkIndex: context.chunkIndex, previewId, leaseGeneration: 1,
      prepared, history: context.history, now,
      previewPayloadPurgeAfter: payloadPurgeAfter });
    return saved.nextCursor === null
      ? { state: "plan_ready", planId, unitCount: saved.unitCount,
        auditId: saved.auditId }
      : { state: "plan_continues", planId, unitCount: saved.unitCount,
        auditId: saved.auditId, nextChunkIndex: saved.nextCursor.outputPartIndex };
  } finally {
    ideaBytes?.fill(0);
    payload?.fill(0);
    plain.fill(0);
  }
}
