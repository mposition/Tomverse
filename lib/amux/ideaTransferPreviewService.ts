import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { prisma } from "@/lib/prisma";
import { amuxCanonicalJson } from "./boardImportCore.ts";
import {
  openAmuxContent, sealAmuxContent, verifyAmuxContentDigest,
  type AmuxContentKeys,
} from "./ideaCrypto.ts";
import { readCurrentAmuxIdeaFrontierSelection } from "./ideaFrontierCatalogRead.ts";
import { loadCurrentAmuxContentKeys } from "./ideaKeyConfig.ts";
import { inspectAmuxIdeaInput } from "./ideaInputCore.ts";
import {
  AMUX_V4_ANALYSIS_PROMPT_VERSION,
  buildAmuxIdeaAnalysisPrompt,
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
  version: 1;
  previewId: string;
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
  keys: AmuxContentKeys;
}): Promise<{ previewId: string; expiresAt: Date; payload: PreviewPayload }> {
  const actorUserId = ownerId(input.session);
  const { choice } = input;
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
  if (!idea || !chunk || idea.actorUserId !== actorUserId ||
      idea.state !== "submitted" || now >= idea.analysisDeadlineAt ||
      !idea.currentSourcePlanRevisionId || idea.rawPurgedAt !== null ||
      !idea.rawCiphertext || !idea.rawKeyId || !idea.rawKeyVersion ||
      !idea.rawDigest || !idea.rawDigestKeyId ||
      chunk.actorUserId !== actorUserId || chunk.state !== "pending" ||
      chunk.attempt !== 0 || chunk.currentPreviewId !== null ||
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
      version: 1, previewId: choice.previewId,
      selection: { provider: choice.provider, modelId: choice.modelId,
        reasoningEffort: choice.reasoningEffort, approvalId: choice.approvalId,
        approvalVersion: choice.approvalVersion },
      templateVersion: prompt.version, prompt: prompt.prompt,
    };
    payloadBytes = Buffer.from(amuxCanonicalJson(payload), "utf8");
    const sealed = sealAmuxContent(payloadBytes, "transfer_payload", choice.previewId, input.keys);
    const expiresAt = new Date(Math.min(now.getTime() + 15 * 60_000,
      idea.analysisDeadlineAt.getTime()));
    if (expiresAt <= now) throw new IdeaTransferPreviewError("not_ready");
    await tx.amuxIdeaTransferPreview.create({ data: {
      id: choice.previewId, ideaId: idea.id,
      sourcePlanRevisionId: plan.id, sourceUnitOrdinal: 0,
      chunkIndex: 0, attempt: 1, state: "prepared",
      modelId: choice.modelId, templateVersion: prompt.version,
      payloadCiphertext: Uint8Array.from(sealed.ciphertext), payloadKeyId: sealed.keyId,
      payloadKeyVersion: sealed.keyVersion, payloadDigest: sealed.digest,
      payloadDigestKeyId: sealed.digestKeyId, expiresAt,
      payloadPurgeAfter: new Date(expiresAt.getTime() + 24 * 60 * 60_000),
    } });
    const updated = await tx.amuxIdeaAnalysisChunk.updateMany({
      where: { ideaId: idea.id, chunkIndex: 0, actorUserId,
        state: "pending", attempt: 0, currentPreviewId: null,
        sourcePlanRevisionId: plan.id },
      data: { state: "awaiting_preview", attempt: 1, currentPreviewId: choice.previewId },
    });
    if (updated.count !== 1) throw new IdeaTransferPreviewError("not_ready");
    await writeAdminAuditLog({ tx, session: input.session, request: input.request,
      action: "amux.v4.transfer_preview.prepared",
      targetType: "AmuxIdeaTransferPreview", targetId: choice.previewId,
      summary: "Owner prepared one idea-only analysis transfer preview; no model was called.",
      metadata: { ideaId: idea.id, chunkIndex: 0, sourcePlanRevisionId: plan.id,
        modelApprovalId: choice.approvalId, modelApprovalVersion: choice.approvalVersion,
        payloadDigest: sealed.digest, payloadDigestKeyId: sealed.digestKeyId,
        transferAuthorized: false },
    });
    return { previewId: choice.previewId, expiresAt, payload };
  } finally {
    payloadBytes?.fill(0);
    raw.fill(0);
  }
}

/** Read-back does not reauthorize a stale model or permit a transfer. */
export async function readIdeaOnlyTransferPreview(session: Session, previewId: string): Promise<
  | { state: "not_visible" | "unavailable" | "expired"; transferAuthorized: false }
  | { state: "prepared"; previewId: string; expiresAt: Date;
      payload: PreviewPayload; transferAuthorized: false }
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
      (auditMetadata as Record<string, unknown>).sourcePlanRevisionId !== row.sourcePlanRevisionId ||
      (auditMetadata as Record<string, unknown>).transferAuthorized !== false) {
    return { state: "unavailable", transferAuthorized: false };
  }
  const keys = loadCurrentAmuxContentKeys(process.env);
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
        payload.selection?.modelId !== row.modelId ||
        payload.templateVersion !== row.templateVersion ||
        typeof payload.prompt !== "string" ||
        !payload.prompt.includes(`"previewId":"${row.id}"`)) {
      return { state: "unavailable", transferAuthorized: false };
    }
    return { state: "prepared", previewId: row.id, expiresAt: row.expiresAt,
      payload, transferAuthorized: false };
  } catch { return { state: "unavailable", transferAuthorized: false }; }
  finally { raw.fill(0); }
}

export async function prepareIdeaOnlyTransferPreview(
  session: Session, request: Request, choice: IdeaOnlyTransferPreviewRequest,
) {
  ownerId(session);
  if (!transferPreviewWritePermitted(process.env[AMUX_V4_TRANSFER_PREVIEW_WRITE_ENV])) {
    throw new IdeaTransferPreviewError("preview_disabled");
  }
  if (adminAuditIntegrityKeys(process.env).length === 0) {
    throw new IdeaTransferPreviewError("integrity_unavailable");
  }
  const selected = await readCurrentAmuxIdeaFrontierSelection(choice);
  if (selected.decision === "hold") {
    throw new IdeaTransferPreviewError("integrity_unavailable");
  }
  if (selected.decision !== "selection_current" ||
      selected.approvalId !== choice.approvalId ||
      selected.approvalVersion !== choice.approvalVersion) {
    throw new IdeaTransferPreviewError("model_changed");
  }
  const keys = loadCurrentAmuxContentKeys(process.env);
  let callbackReturned = false;
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
      const result = await commitIdeaOnlyTransferPreview(tx, { session, request, choice, keys });
      callbackReturned = true;
      return result;
    }, { maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    if (!callbackReturned && error instanceof IdeaTransferPreviewError) throw error;
    throw new IdeaTransferPreviewError("outcome_unknown");
  }
}
