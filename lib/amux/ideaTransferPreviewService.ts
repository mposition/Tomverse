import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { auditRowActorKind, AMUX_V4_FIRST_DRAFT_SAVED_ACTION,
  AMUX_V4_FIRST_DRAFT_SAVED_TARGET } from "@/lib/adminAuditSystemActors";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { prisma } from "@/lib/prisma";
import { amuxCanonicalJson } from "./boardImportCore.ts";
import { amuxPermittedTargetRefSafe, inspectAmuxStoredAnalysisUnit,
  snapshotAmuxPermittedTarget,
  type AmuxPermittedTargetRef } from "./ideaAnalysisChunkCore.ts";
import { amuxAnalysisFreeformSubjectId } from "./ideaAnalysisDraftSealCore.ts";
import { matchesAmuxIdeaAnalysisUnitCommitments } from
  "./ideaAnalysisResultReadCore.ts";
import { ideaTransferBrowserDigest } from "./ideaTransferBrowserCore.ts";
import {
  openAmuxContent, sealAmuxContent, verifyAmuxContentDigest,
  type AmuxContentKeys,
} from "./ideaCrypto.ts";
import { readCurrentAmuxIdeaFrontierSelection } from "./ideaFrontierCatalogRead.ts";
import { createAmuxContentKeyRing, loadAmuxContentKeyRing } from "./ideaKeyStore.ts";
import { inspectAmuxIdeaInput } from "./ideaInputCore.ts";
import {
  AMUX_V4_ANALYSIS_PROMPT_VERSION,
  buildAmuxIdeaAnalysisPrompt,
  continuationFromAmuxAnalysisChunk,
} from "./ideaAnalysisPromptCore.ts";
import { matchesInitialPlanSystemAudit } from "./ideaInitialPlanAuditCore.ts";
import { buildAmuxSourcePlanManifest } from "./ideaSourcePlanManifestCore.ts";
import {
  AMUX_V4_TRANSFER_PREVIEW_WRITE_ENV,
  transferPreviewWritePermitted,
  type IdeaOnlyTransferPreviewRequest,
} from "./ideaTransferPreviewInputCore.ts";

export class IdeaTransferPreviewError extends Error {
  constructor(readonly code: "not_found" | "not_ready" | "integrity_unavailable" |
    "model_changed" | "preview_disabled" | "outcome_unknown") {
    super(code);
    this.name = "IdeaTransferPreviewError";
  }
}

type PreviewPayload = {
  version: 1 | 2;
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
  chunkIndex?: number;
};

function ownerId(session: Session): string {
  const id = session.user?.id;
  if (!id || !isAdminSession(session) || getAdminRole(session) !== "owner") {
    throw new IdeaTransferPreviewError("not_found");
  }
  return id;
}

/** Only the immediately preceding, audited output page may feed a new
 * preview. Its ciphertext is data, never an instruction or an approval. */
export async function readPreviousOutputPage(tx: Prisma.TransactionClient, input: {
  ideaId: string; actorUserId: string; chunkIndex: number;
  planId: string; now: Date; keys: AmuxContentKeys;
}): Promise<{ continuation: NonNullable<Parameters<typeof buildAmuxIdeaAnalysisPrompt>[0]["continuation"]>;
  permittedTargetRefs: AmuxPermittedTargetRef[] }> {
  const priorIndex = input.chunkIndex - 1;
  const prior = await tx.amuxIdeaAnalysisChunk.findUnique({
    where: { ideaId_chunkIndex: { ideaId: input.ideaId, chunkIndex: priorIndex } },
  });
  if (!prior || prior.actorUserId !== input.actorUserId ||
      prior.sourcePlanRevisionId !== input.planId ||
      prior.chunkIndex !== priorIndex || prior.state !== "draft_ready" ||
      prior.coverageStatus !== "more" || prior.continuationKind !== "output" ||
      !prior.outputPending || prior.remainingStartOrdinal !== 0 ||
      prior.remainingEndOrdinal !== 0 || !prior.currentPreviewId ||
      prior.freeformPurgedAt !== null || !prior.freeformCiphertext ||
      !prior.freeformKeyId || !prior.freeformKeyVersion ||
      !prior.freeformPurgeAfter || input.now >= prior.freeformPurgeAfter) {
    throw new IdeaTransferPreviewError("not_ready");
  }
  const audits = await tx.adminAuditLog.findMany({ where: {
    action: AMUX_V4_FIRST_DRAFT_SAVED_ACTION,
    targetType: AMUX_V4_FIRST_DRAFT_SAVED_TARGET,
    targetId: `${input.ideaId}:${priorIndex}`,
  }, take: 2 });
  const audit = audits[0];
  const metadata = audit?.metadata;
  if (audits.length !== 1 || !audit?.entryHash ||
      auditRowActorKind(audit) !== "system" ||
      !metadata || typeof metadata !== "object" ||
      Array.isArray(metadata) ||
      (metadata as Record<string, unknown>).ideaId !== input.ideaId ||
      (metadata as Record<string, unknown>).previewId !== prior.currentPreviewId ||
      (metadata as Record<string, unknown>).sourcePlanRevisionId !== input.planId ||
      (metadata as Record<string, unknown>).chunkIndex !== priorIndex) {
    throw new IdeaTransferPreviewError("integrity_unavailable");
  }
  const meta = metadata as Record<string, unknown>;
  const freeformSubject = amuxAnalysisFreeformSubjectId(input.ideaId, prior.currentPreviewId);
  let freeform: Buffer;
  try {
    freeform = openAmuxContent({ ciphertext: Buffer.from(prior.freeformCiphertext),
      keyId: prior.freeformKeyId, keyVersion: prior.freeformKeyVersion },
    "analysis_freeform", freeformSubject, input.keys);
  } catch { throw new IdeaTransferPreviewError("integrity_unavailable"); }
  let priorFreeform: Record<string, unknown>;
  try {
    if (!verifyAmuxContentDigest(freeform, "analysis_freeform", freeformSubject,
      meta.freeformDigest as string, meta.freeformDigestKeyId as string, input.keys)) {
      throw new IdeaTransferPreviewError("integrity_unavailable");
    }
    const parsed: unknown = JSON.parse(freeform.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new IdeaTransferPreviewError("integrity_unavailable");
    }
    priorFreeform = parsed as Record<string, unknown>;
  } finally { freeform.fill(0); }
  if (priorFreeform.chunkIndex !== priorIndex ||
      priorFreeform.previewId !== prior.currentPreviewId ||
      priorFreeform.coverageStatus !== "more" ||
      priorFreeform.continuationKind !== "output" ||
      typeof priorFreeform.coveredScope !== "string" ||
      typeof priorFreeform.remainingScope !== "string") {
    throw new IdeaTransferPreviewError("integrity_unavailable");
  }
  const continuation = continuationFromAmuxAnalysisChunk(
    priorFreeform as unknown as Parameters<typeof continuationFromAmuxAnalysisChunk>[0],
    audit.entryHash);
  if (!continuation) throw new IdeaTransferPreviewError("integrity_unavailable");
  const priorPreview = await tx.amuxIdeaTransferPreview.findUnique({
    where: { id: prior.currentPreviewId },
  });
  if (!priorPreview || priorPreview.ideaId !== input.ideaId ||
      priorPreview.chunkIndex !== priorIndex ||
      priorPreview.sourcePlanRevisionId !== input.planId ||
      priorPreview.state !== "completed" || !priorPreview.payloadCiphertext ||
      !priorPreview.payloadKeyId || !priorPreview.payloadKeyVersion ||
      priorPreview.payloadPurgedAt !== null ||
      !priorPreview.payloadPurgeAfter || input.now >= priorPreview.payloadPurgeAfter) {
    throw new IdeaTransferPreviewError("not_ready");
  }
  let priorPayload: Buffer;
  try {
    priorPayload = openAmuxContent({ ciphertext: Buffer.from(priorPreview.payloadCiphertext),
      keyId: priorPreview.payloadKeyId, keyVersion: priorPreview.payloadKeyVersion },
    "transfer_payload", priorPreview.id, input.keys);
  } catch { throw new IdeaTransferPreviewError("integrity_unavailable"); }
  let inherited: AmuxPermittedTargetRef[];
  try {
    if (!verifyAmuxContentDigest(priorPayload, "transfer_payload", priorPreview.id,
      priorPreview.payloadDigest, priorPreview.payloadDigestKeyId, input.keys)) {
      throw new IdeaTransferPreviewError("integrity_unavailable");
    }
    const payload: unknown = JSON.parse(priorPayload.toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
        (payload as Record<string, unknown>).previewId !== priorPreview.id ||
        typeof (payload as Record<string, unknown>).prompt !== "string") {
      throw new IdeaTransferPreviewError("integrity_unavailable");
    }
    const prompt = (payload as { prompt: string }).prompt;
    const match = /\nBEGIN_CONFIRMED_DATA_JSON\n([^\n]+)\nEND_CONFIRMED_DATA_JSON\n$/.exec(prompt);
    if (!match) throw new IdeaTransferPreviewError("integrity_unavailable");
    const data: unknown = JSON.parse(match[1]!);
    const dataRecord = data && typeof data === "object" && !Array.isArray(data)
      ? data as Record<string, unknown> : null;
    if (dataRecord?.previewId !== priorPreview.id ||
        dataRecord.chunkIndex !== priorIndex ||
        dataRecord.revisionChunkIndex !== priorIndex) {
      throw new IdeaTransferPreviewError("integrity_unavailable");
    }
    const refs = dataRecord.permittedTargetRefs;
    if (!Array.isArray(refs) || refs.length > 96) {
      throw new IdeaTransferPreviewError("integrity_unavailable");
    }
    inherited = refs.map((raw) => snapshotAmuxPermittedTarget(raw)).filter((ref):
      ref is AmuxPermittedTargetRef => ref !== null);
    if (inherited.length !== refs.length || inherited.some((ref) =>
      !amuxPermittedTargetRefSafe(ref, input.chunkIndex))) {
      throw new IdeaTransferPreviewError("integrity_unavailable");
    }
  } finally { priorPayload.fill(0); }
  const units = await tx.amuxIdeaDraftUnit.findMany({
    where: { ideaId: input.ideaId, actorUserId: input.actorUserId,
      chunkIndex: priorIndex, derivationGroupId: null },
    orderBy: { unitIndex: "asc" },
  });
  if (!matchesAmuxIdeaAnalysisUnitCommitments(meta.unitCommitments, units)) {
    throw new IdeaTransferPreviewError("integrity_unavailable");
  }
  const targets: AmuxPermittedTargetRef[] = [];
  for (const [index, unit] of units.entries()) {
    if (unit.unitIndex !== index || !unit.bodyCiphertext || !unit.bodyKeyId ||
        !unit.bodyKeyVersion || unit.bodyPurgedAt !== null) {
      throw new IdeaTransferPreviewError("not_ready");
    }
    let body: Buffer;
    try {
      body = openAmuxContent({ ciphertext: Buffer.from(unit.bodyCiphertext),
        keyId: unit.bodyKeyId, keyVersion: unit.bodyKeyVersion },
      "analysis_draft", unit.id, input.keys);
    } catch { throw new IdeaTransferPreviewError("integrity_unavailable"); }
    try {
      if (!verifyAmuxContentDigest(body, "analysis_draft", unit.id,
        unit.bodyDigest, unit.bodyDigestKeyId, input.keys)) {
        throw new IdeaTransferPreviewError("integrity_unavailable");
      }
      const parsed = inspectAmuxStoredAnalysisUnit({ raw: body.toString("utf8"),
        chunkIndex: priorIndex, permittedSourceRefIds: ["operator_idea"] });
      if (!parsed.ok || parsed.unit.localId !== unit.localRef ||
          parsed.unit.kind !== unit.unitKind) {
        throw new IdeaTransferPreviewError("integrity_unavailable");
      }
      if (parsed.unit.kind === "node") targets.push({ ref: unit.localRef!,
        kind: "node", level: parsed.unit.level });
      else if (parsed.unit.kind === "card") targets.push({ ref: unit.localRef!,
        kind: "card", cardType: parsed.unit.cardType,
        storyKind: parsed.unit.storyKind, featureRef: parsed.unit.featureRef });
    } finally { body.fill(0); }
  }
  const combined = [...inherited, ...targets];
  const unique = new Map(combined.map((target) => [target.ref, target]));
  const nodes = [...unique.values()].filter((target) => target.kind === "node");
  const cards = [...unique.values()].filter((target) => target.kind === "card");
  const permittedTargetRefs = [...nodes.slice(-64),
    ...cards.slice(-(96 - Math.min(64, nodes.length)))];
  if (permittedTargetRefs.length > 96 || permittedTargetRefs.some((target) =>
      !amuxPermittedTargetRefSafe(target, input.chunkIndex))) {
    throw new IdeaTransferPreviewError("integrity_unavailable");
  }
  return { continuation, permittedTargetRefs };
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
  const chunkIndex = choice.chunkIndex ?? 0;
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 ||
      chunkIndex >= 2_147_483_647) {
    throw new IdeaTransferPreviewError("not_ready");
  }
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
      AND "chunkIndex" = ${chunkIndex}
    FOR UPDATE
  `;
  if (chunkLock.length !== 1) throw new IdeaTransferPreviewError("not_ready");
  const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = nowRows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new IdeaTransferPreviewError("integrity_unavailable");
  }
  const idea = await tx.amuxIdeaSubmission.findUnique({ where: { id: choice.ideaId } });
  const chunk = await tx.amuxIdeaAnalysisChunk.findUnique({
    where: { ideaId_chunkIndex: { ideaId: choice.ideaId, chunkIndex } },
  });
  const firstAttempt = chunk?.state === "pending" && chunk.attempt === 0 &&
    chunk.currentPreviewId === null;
  const retryAttempt = chunk?.state === "awaiting_preview" &&
    Number.isSafeInteger(chunk.attempt) && chunk.attempt > 0 &&
    chunk.attempt < 2_147_483_647 && chunk.currentPreviewId !== null &&
    chunk.leaseGeneration === 0;
  if (!idea || !chunk || idea.actorUserId !== actorUserId ||
      idea.state !== (chunkIndex === 0 ? "submitted" : "analyzing") ||
      now >= idea.analysisDeadlineAt ||
      !idea.currentSourcePlanRevisionId || idea.rawPurgedAt !== null ||
      !idea.rawCiphertext || !idea.rawKeyId || !idea.rawKeyVersion ||
      !idea.rawDigest || !idea.rawDigestKeyId ||
      chunk.actorUserId !== actorUserId || (!firstAttempt && !retryAttempt) ||
      chunk.chunkIndex !== chunkIndex ||
      chunk.revisionChunkIndex !== chunkIndex ||
      chunk.planStartChunkIndex !== 0 ||
      chunk.sourcePlanRevisionId !== idea.currentSourcePlanRevisionId) {
    throw new IdeaTransferPreviewError("not_ready");
  }
  if (retryAttempt) {
    const previous = await tx.amuxIdeaTransferPreview.findUnique({
      where: { id: chunk.currentPreviewId! },
      select: { ideaId: true, chunkIndex: true, attempt: true, state: true,
        consumedAt: true },
    });
    const settled = await tx.amuxIdeaAnalysisBudgetHold.findUnique({
      where: { previewId: chunk.currentPreviewId! },
      select: { status: true, closedAt: true },
    });
    const ownerResolved = previous?.state === "owner_resolved" &&
      ["owner_consumed", "owner_released_unstarted"].includes(settled?.status ?? "");
    if (!previous || previous.ideaId !== idea.id ||
        previous.chunkIndex !== chunkIndex || previous.attempt !== chunk.attempt ||
        !previous.consumedAt || !settled?.closedAt ||
        !((previous.state === "provider_failed" && settled.status === "failed") ||
          ownerResolved)) {
      throw new IdeaTransferPreviewError("not_ready");
    }
  }
  const nextAttempt = chunk.attempt + 1;
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
    select: { targetId: true, targetType: true, action: true, entryHash: true,
      actorUserId: true, actorEmail: true, ipAddress: true, userAgent: true,
      metadata: true },
  });
  if (!audit?.entryHash || audit.targetId !== plan.id ||
      audit.targetType !== "AmuxIdeaSourcePlanRevision" ||
      audit.action !== "AMUX_V4_INITIAL_SOURCE_PLAN_CREATED" ||
      !matchesInitialPlanSystemAudit(audit, plan.manifestDigest)) {
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
    const previous = chunkIndex > 0
      ? await readPreviousOutputPage(tx, { ideaId: idea.id, actorUserId,
        chunkIndex, planId: plan.id, now, keys: input.keys })
      : null;
    const prompt = buildAmuxIdeaAnalysisPrompt({
      previewId: choice.previewId, chunkIndex,
      revisionChunkIndex: chunkIndex,
      continuation: previous?.continuation ?? null,
      sourceTexts: [{ refId: "operator_idea", kind: "operator_idea", text: parsed.input.idea }],
      permittedTargetRefs: previous?.permittedTargetRefs ?? [],
    });
    if (prompt.status !== "prompt_candidate") {
      throw new IdeaTransferPreviewError("not_ready");
    }
    const payload: PreviewPayload = {
      version: chunkIndex === 0 ? 1 : 2,
      previewId: choice.previewId, ideaId: choice.ideaId,
      ...(chunkIndex > 0 ? { chunkIndex } : {}),
      selection: { provider: choice.provider, modelId: choice.modelId,
        reasoningEffort: choice.reasoningEffort, approvalId: choice.approvalId,
        approvalVersion: choice.approvalVersion },
      templateVersion: prompt.version, prompt: prompt.prompt,
    };
    payloadBytes = Buffer.from(amuxCanonicalJson(payload), "utf8");
    const sealed = sealAmuxContent(payloadBytes, "transfer_payload", choice.previewId, input.keys);
    const browserBindingDigest = ideaTransferBrowserDigest({
      previewId: choice.previewId, nonce: input.browserNonce,
      authenticatedAt: input.session.user?.authenticatedAt, key: input.keys,
    });
    const expiresAt = new Date(Math.min(now.getTime() + 15 * 60_000,
      idea.analysisDeadlineAt.getTime()));
    if (expiresAt <= now) throw new IdeaTransferPreviewError("not_ready");
    await tx.amuxIdeaTransferPreview.create({ data: {
      id: choice.previewId, ideaId: idea.id,
      sourcePlanRevisionId: plan.id, sourceUnitOrdinal: 0,
      chunkIndex, attempt: nextAttempt, state: "prepared",
      modelId: choice.modelId, templateVersion: prompt.version,
      payloadCiphertext: Uint8Array.from(sealed.ciphertext), payloadKeyId: sealed.keyId,
      payloadKeyVersion: sealed.keyVersion, payloadDigest: sealed.digest,
      payloadDigestKeyId: sealed.digestKeyId, expiresAt,
      // A consumed page may supply references to the next bounded page.
      // Unused previews are retired at expiresAt by the purge worker.
      payloadPurgeAfter: new Date(idea.analysisDeadlineAt.getTime() + 24 * 60 * 60_000),
    } });
    const updated = await tx.amuxIdeaAnalysisChunk.updateMany({
      where: { ideaId: idea.id, chunkIndex, actorUserId,
        state: chunk.state, attempt: chunk.attempt,
        currentPreviewId: chunk.currentPreviewId,
        leaseGeneration: 0,
        sourcePlanRevisionId: plan.id },
      data: { state: "awaiting_preview", attempt: nextAttempt,
        currentPreviewId: choice.previewId },
    });
    if (updated.count !== 1) throw new IdeaTransferPreviewError("not_ready");
    await writeAdminAuditLog({ tx, session: input.session, request: input.request,
      action: "amux.v4.transfer_preview.prepared",
      targetType: "AmuxIdeaTransferPreview", targetId: choice.previewId,
      summary: "Owner prepared one idea-only analysis transfer preview; no model was called.",
      metadata: { ideaId: idea.id, chunkIndex, sourcePlanRevisionId: plan.id,
        modelApprovalId: choice.approvalId, modelApprovalVersion: choice.approvalVersion,
        payloadDigest: sealed.digest, payloadDigestKeyId: sealed.digestKeyId,
        browserBindingDigest,
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
    if (payload.version !== (row.chunkIndex === 0 ? 1 : 2) ||
        (row.chunkIndex > 0 && payload.chunkIndex !== row.chunkIndex) ||
        payload.previewId !== row.id ||
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
  const chunkIndex = choice.chunkIndex ?? 0;
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 ||
      chunkIndex >= 2_147_483_647) {
    throw new IdeaTransferPreviewError("not_ready");
  }
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
    const previous = chunkIndex > 0
      ? await prisma.amuxIdeaAnalysisChunk.findUnique({ where: {
        ideaId_chunkIndex: { ideaId: choice.ideaId,
          chunkIndex: chunkIndex - 1 },
      }, select: { currentPreviewId: true } }) : null;
    if (chunkIndex > 0 && !previous?.currentPreviewId) {
      throw new Error("missing previous output");
    }
    const priorUnits = chunkIndex > 0
      ? await prisma.amuxIdeaDraftUnit.findMany({ where: {
        ideaId: choice.ideaId, chunkIndex: chunkIndex - 1,
        derivationGroupId: null,
      }, select: { id: true } }) : [];
    keys = await createAmuxContentKeyRing([
      { ideaId: choice.ideaId, purpose: "idea_raw", subjectId: choice.ideaId },
      ...(previous?.currentPreviewId ? [{ ideaId: choice.ideaId,
        purpose: "analysis_freeform" as const,
        subjectId: amuxAnalysisFreeformSubjectId(choice.ideaId,
          previous.currentPreviewId) }] : []),
      ...(previous?.currentPreviewId ? [{ ideaId: choice.ideaId,
        purpose: "transfer_payload" as const,
        subjectId: previous.currentPreviewId }] : []),
      ...priorUnits.map((unit) => ({ ideaId: choice.ideaId,
        purpose: "analysis_draft" as const, subjectId: unit.id })),
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
