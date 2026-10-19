import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_V4_IDEA_SYSTEM_ACTOR,
  AMUX_V4_INITIAL_SOURCE_PLAN_ACTION,
  AMUX_V4_INITIAL_SOURCE_PLAN_TARGET } from "@/lib/adminAuditSystemActors";
import { prepareAmuxAnalysisPageDraft } from "./ideaAnalysisPageDraftCore.ts";
import { AMUX_V4_ANALYSIS_PROMPT_VERSION } from "./ideaAnalysisPromptCore.ts";
import { amuxContentDigest, openAmuxContent, verifyAmuxContentDigest,
  type AmuxContentKeys } from "./ideaCrypto.ts";
import { persistAmuxAnalysisPageDraftInTx } from
  "./ideaFirstAnalysisDraftService.ts";
import { AMUX_V4_IDEA_SOURCE_SYSTEM } from "./ideaIdentityCore.ts";
import { inspectSealedAmuxIdeaSessionInput } from "./ideaSessionSubmissionCore.ts";
import { buildAmuxSourcePlanManifest } from "./ideaSourcePlanManifestCore.ts";

type Tx = Prisma.TransactionClient;

/** The session prompt names the claim as its preview id, so the model's echo
 * and the stored preview row share one identity. */
export const amuxSessionAnalysisPreviewId = (claimId: string): string => claimId;

export type AmuxSessionPlanRefusal =
  "invalid_result" | "needs_owner_input" | "continuation_unsupported" |
  "plan_already_bound";

export type AmuxSessionPlanPreparation =
  | { decision: "ready"; prepared: Extract<
      ReturnType<typeof prepareAmuxAnalysisPageDraft>, { decision: "ready" }> }
  | { decision: "refused"; reason: AmuxSessionPlanRefusal };

export class AmuxSessionAnalysisPlanError extends Error {
  constructor(readonly code: "integrity_unavailable") {
    super(code);
    this.name = "AmuxSessionAnalysisPlanError";
  }
}

/** Pure: one session invocation is one complete idea-only page. A page that
 * asks the owner a question or continues on a later page is refused here; the
 * session queue has no continuation path yet, and a refused plan must leave
 * the queue instead of buying another invocation. */
export function prepareAmuxSessionAnalysisPlan(input: { ideaId: string;
  claimId: string; rawModelOutput: string; keys: AmuxContentKeys;
  unitIds?: readonly string[] }): AmuxSessionPlanPreparation {
  const prepared = prepareAmuxAnalysisPageDraft({ ideaId: input.ideaId,
    previewId: amuxSessionAnalysisPreviewId(input.claimId),
    raw: input.rawModelOutput, keys: input.keys, unitIds: input.unitIds,
    chunkIndex: 0, revisionChunkIndex: 0,
    permittedSourceRefIds: ["operator_idea"], permittedTargetRefs: [],
    sourceUnitCount: 1, coveredStartOrdinal: 0, coveredEndOrdinal: 0,
    history: [], templateVersion: AMUX_V4_ANALYSIS_PROMPT_VERSION });
  if (prepared.decision === "hold") {
    return { decision: "refused", reason: "invalid_result" };
  }
  if (prepared.decision === "needs_owner_input") {
    return { decision: "refused", reason: "needs_owner_input" };
  }
  if (prepared.nextCursor !== null) {
    return { decision: "refused", reason: "continuation_unsupported" };
  }
  return { decision: "ready", prepared };
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

/** Turns one committed session result into the same plan, chunk, completed
 * preview and proposal rows the v4 owner path leaves, so the result reader and
 * the system registration writer need no session branch. Every outcome moves
 * the idea out of `analyzing`: a refused plan waits for the operator with no
 * plan rows, and nothing here re-queues a paid invocation. The caller holds
 * the audit-chain lock and has already committed the result and settlement in
 * this transaction. */
export async function commitAmuxSessionAnalysisPlanInTx(tx: Tx, input: {
  ideaId: string; claimId: string; resultAuditId: string; modelId: string;
  plan: AmuxSessionPlanPreparation; keys: AmuxContentKeys;
}): Promise<{ state: "plan_ready"; planId: string; unitCount: number;
  auditId: string } | { state: "plan_refused"; reason: AmuxSessionPlanRefusal }> {
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
  const refusal: AmuxSessionPlanRefusal | null =
    idea.currentSourcePlanRevisionId !== null ? "plan_already_bound" :
    input.plan.decision === "refused" ? input.plan.reason : null;
  if (refusal !== null || input.plan.decision !== "ready") {
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
    return { state: "plan_refused", reason: refusal ?? "invalid_result" };
  }
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
    // Repositories are read by the CLI from pinned checkouts (v19 item 3), so
    // the source plan carries only the operator's idea as its one unit.
    ideaBytes = Buffer.from(inspected.input.idea, "utf8");
    const planId = randomUUID();
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
    const previewId = amuxSessionAnalysisPreviewId(input.claimId);
    const payload = Buffer.from(JSON.stringify({ previewId, ideaId: idea.id,
      templateVersion: AMUX_V4_ANALYSIS_PROMPT_VERSION,
      modelId: input.modelId }), "utf8");
    let payloadDigest: { digest: string; digestKeyId: string };
    try {
      payloadDigest = amuxContentDigest(payload, "transfer_payload", previewId,
        input.keys);
    } finally { payload.fill(0); }
    // The owner's one approval is the operating scope behind the session
    // submission (v19 item 2); the claim-bound result audit stands in for the
    // per-preview confirmation the v4 path collects.
    const confirmUntil = new Date(now.getTime() + 24 * 60 * 60_000);
    await tx.amuxIdeaTransferPreview.create({ data: { id: previewId,
      ideaId: idea.id, sourcePlanRevisionId: planId, sourceUnitOrdinal: 0,
      chunkIndex: 0, attempt: 1, state: "in_flight", modelId: input.modelId,
      templateVersion: AMUX_V4_ANALYSIS_PROMPT_VERSION,
      payloadDigest: payloadDigest.digest,
      payloadDigestKeyId: payloadDigest.digestKeyId,
      expiresAt: confirmUntil, confirmedAt: now, confirmExpiresAt: confirmUntil,
      confirmedByUserId: idea.actorUserId,
      confirmationAuditLogId: input.resultAuditId, consumedAt: now } });
    const started = await tx.amuxIdeaAnalysisChunk.updateMany({
      where: { ideaId: idea.id, chunkIndex: 0, state: "pending",
        currentPreviewId: null, sourcePlanRevisionId: planId },
      data: { state: "in_flight", attempt: 1, leaseGeneration: 1,
        currentPreviewId: previewId },
    });
    const bound = await tx.amuxIdeaSubmission.updateMany({
      where: { id: idea.id, state: "analyzing",
        currentSourcePlanRevisionId: null },
      data: { currentSourcePlanRevisionId: planId },
    });
    if (started.count !== 1 || bound.count !== 1) {
      throw new AmuxSessionAnalysisPlanError("integrity_unavailable");
    }
    const saved = await persistAmuxAnalysisPageDraftInTx(tx, { idea, planId,
      chunkIndex: 0, previewId, leaseGeneration: 1,
      prepared: input.plan.prepared, history: [], now,
      previewPayloadPurgeAfter: null });
    return { state: "plan_ready", planId, unitCount: saved.unitCount,
      auditId: saved.auditId };
  } finally {
    ideaBytes?.fill(0);
    plain.fill(0);
  }
}
