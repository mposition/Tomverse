import "server-only";

import type { Session } from "next-auth";

import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { AMUX_V4_COLLECTION_RESULT_ACTION, AMUX_V4_COLLECTION_RESULT_SCOPE,
  AMUX_V4_COLLECTION_RESULT_TARGET, AMUX_V4_IDEA_SYSTEM_ACTOR } from
  "@/lib/adminAuditSystemActors";
import { prisma } from "@/lib/prisma";
import { openAmuxContent, verifyAmuxContentDigest } from "./ideaCrypto.ts";
import { loadCurrentAmuxContentKeys } from "./ideaKeyConfig.ts";
import { parseStoredAmuxCollectionPreview } from "./ideaCollectionPreviewCore.ts";

const HASH = /^[a-f0-9]{64}$/;
const MAX_SCOPE_AGE_MS = 15 * 60_000;
const AUDIT_FIELDS = ["actorScope", "collectionRequestId", "collectionVerified",
  "holdCode", "leaseGeneration", "previewId", "promptVersion", "requestDigest",
  "requestId", "resultDigest", "resultDigestKeyId", "sourceByteLimit", "sourceIndex",
  "state", "systemActor",
  "transferAuthorized"].sort().join("\0");

export class AmuxCollectionPreviewError extends Error {
  constructor(readonly code: "not_found" | "not_ready" | "preview_disabled" |
    "integrity_unavailable") {
    super(code);
    this.name = "AmuxCollectionPreviewError";
  }
}

/** Read-only display. It never confirms a model transfer or registers a card. */
export async function readAmuxCollectionPreview(session: Session, requestId: string) {
  const actorUserId = session.user?.id;
  if (!actorUserId || !isAdminSession(session) || getAdminRole(session) !== "owner") {
    throw new AmuxCollectionPreviewError("not_found");
  }
  if (adminAuditIntegrityKeys(process.env).length === 0) {
    throw new AmuxCollectionPreviewError("integrity_unavailable");
  }
  let keys;
  try { keys = loadCurrentAmuxContentKeys(process.env); } catch {
    throw new AmuxCollectionPreviewError("integrity_unavailable");
  }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT set_config('TimeZone', 'UTC', true) AS zone,
             set_config('statement_timeout', '3000', true) AS statement_limit,
             set_config('idle_in_transaction_session_timeout', '5000', true) AS idle_limit
    `;
    const identity = await tx.amuxIdeaCollectionRequest.findUnique({
      where: { requestId },
      select: { id: true, ideaId: true, sourceScopeApprovalId: true,
        frontierApprovalId: true, actorUserId: true },
    });
    if (!identity || identity.actorUserId !== actorUserId) {
      throw new AmuxCollectionPreviewError("not_found");
    }
    const collectionRequestId = identity.id;
    // Match the writer's lock order. Purge or revocation cannot interleave
    // with the checks and decrypt while this short read transaction is open.
    await tx.$queryRaw`SELECT "id" FROM "AmuxIdeaSubmission"
      WHERE "id" = ${identity.ideaId} AND "actorUserId" = ${actorUserId} FOR SHARE`;
    await tx.$queryRaw`SELECT "id" FROM "AmuxIdeaSourceScopeApproval"
      WHERE "id" = ${identity.sourceScopeApprovalId} AND "actorUserId" = ${actorUserId} FOR SHARE`;
    await tx.$queryRaw`SELECT "id" FROM "AmuxIdeaFrontierModelApproval"
      WHERE "id" = ${identity.frontierApprovalId} FOR SHARE`;
    await tx.$queryRaw`SELECT "id" FROM "AmuxIdeaCollectionRequest"
      WHERE "id" = ${collectionRequestId} AND "actorUserId" = ${actorUserId} FOR SHARE`;
    const row = await tx.amuxIdeaCollectionRequest.findUnique({
      where: { id: collectionRequestId }, include: {
        idea: { select: { actorUserId: true, state: true, analysisDeadlineAt: true,
          rawPurgedAt: true } },
        sourceScopeApproval: { select: { actorUserId: true, status: true,
          approvedAt: true, expiresAt: true, revokedAt: true, scopePurgedAt: true } },
        frontierApproval: { select: { status: true, revokedAt: true,
          approvedAt: true, version: true, provider: true, modelId: true,
          allowedEfforts: true } },
      },
    });
    if (!row || row.actorUserId !== actorUserId) {
      throw new AmuxCollectionPreviewError("not_found");
    }
    const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
    `;
    const now = nowRows[0]?.now;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new AmuxCollectionPreviewError("integrity_unavailable");
    }
    const latestFrontier = await tx.amuxIdeaFrontierModelApproval.findFirst({
      where: { provider: row.provider, modelId: row.modelId },
      orderBy: { version: "desc" }, select: { version: true },
    });
    if (row.state !== "preview_ready" || now >= row.expiresAt ||
        row.resultPurgedAt !== null || !row.resultPurgeAfter || now >= row.resultPurgeAfter ||
        !row.resultCiphertext || !row.resultKeyId || !row.resultKeyVersion ||
        !row.resultDigest || !row.resultDigestKeyId || !row.transitionAuditLogId ||
        row.leaseGeneration !== 1 || row.sourceIndex !== 0 ||
        row.sourceKind !== "repository_file" ||
        row.idea.actorUserId !== actorUserId || row.idea.state !== "submitted" ||
        row.idea.rawPurgedAt !== null || now >= row.idea.analysisDeadlineAt ||
        row.sourceScopeApproval.actorUserId !== actorUserId ||
        row.sourceScopeApproval.status !== "approved" ||
        now < row.sourceScopeApproval.approvedAt ||
        row.sourceScopeApproval.revokedAt !== null ||
        row.sourceScopeApproval.scopePurgedAt !== null ||
        now >= row.sourceScopeApproval.expiresAt ||
        row.sourceScopeApproval.expiresAt.getTime() >
          row.sourceScopeApproval.approvedAt.getTime() + MAX_SCOPE_AGE_MS ||
        row.frontierApproval.status !== "approved" ||
        now < row.frontierApproval.approvedAt ||
        row.frontierApproval.revokedAt !== null ||
        row.frontierApproval.provider !== row.provider ||
        row.frontierApproval.modelId !== row.modelId ||
        row.frontierApproval.version !== row.frontierVersion ||
        latestFrontier?.version !== row.frontierVersion ||
        !row.frontierApproval.allowedEfforts.includes(row.reasoningEffort)) {
      throw new AmuxCollectionPreviewError("not_ready");
    }
    const audit = await tx.adminAuditLog.findUnique({
      where: { id: row.transitionAuditLogId },
      select: { action: true, actorUserId: true, targetType: true,
        targetId: true, entryHash: true, metadata: true },
    });
    const meta = audit?.metadata && typeof audit.metadata === "object" &&
      !Array.isArray(audit.metadata) ? audit.metadata as Record<string, unknown> : null;
    if (!audit?.entryHash || !HASH.test(audit.entryHash) ||
        audit.action !== AMUX_V4_COLLECTION_RESULT_ACTION ||
        audit.actorUserId !== null || audit.targetType !== AMUX_V4_COLLECTION_RESULT_TARGET ||
        audit.targetId !== row.id || !meta ||
        Object.keys(meta).sort().join("\0") !== AUDIT_FIELDS ||
        meta.systemActor !== AMUX_V4_IDEA_SYSTEM_ACTOR ||
        meta.actorScope !== AMUX_V4_COLLECTION_RESULT_SCOPE ||
        meta.collectionRequestId !== row.id || meta.requestId !== row.requestId ||
        meta.previewId !== row.previewId || meta.requestDigest !== row.requestDigest ||
        meta.sourceIndex !== row.sourceIndex ||
        meta.sourceByteLimit !== row.sourceByteLimit ||
        meta.leaseGeneration !== row.leaseGeneration || meta.state !== "preview_ready" ||
        meta.resultDigest !== row.resultDigest ||
        meta.resultDigestKeyId !== row.resultDigestKeyId ||
        meta.holdCode !== null || meta.collectionVerified !== false ||
        meta.transferAuthorized !== false || typeof meta.promptVersion !== "string") {
      throw new AmuxCollectionPreviewError("integrity_unavailable");
    }
    let plain: Buffer | null = null;
    try {
      try {
        plain = openAmuxContent({ ciphertext: Buffer.from(row.resultCiphertext),
          keyId: row.resultKeyId, keyVersion: row.resultKeyVersion },
        "collection_result", row.id, keys);
      } catch { throw new AmuxCollectionPreviewError("integrity_unavailable"); }
      if (!verifyAmuxContentDigest(plain, "collection_result", row.id,
        row.resultDigest, row.resultDigestKeyId, keys)) {
        throw new AmuxCollectionPreviewError("integrity_unavailable");
      }
      const preview = parseStoredAmuxCollectionPreview(plain, {
        previewId: row.previewId, provider: row.provider, modelId: row.modelId,
        reasoningEffort: row.reasoningEffort, promptVersion: meta.promptVersion,
      });
      if (!preview || preview.source.sourceIndex !== row.sourceIndex) {
        throw new AmuxCollectionPreviewError("integrity_unavailable");
      }
      const sourceMetadata = {
        sourceIndex: preview.source.sourceIndex,
        repositoryId: preview.source.repositoryId,
        repository: preview.source.repository,
        refName: preview.source.refName,
        refObjectSha: preview.source.refObjectSha,
        refCommitSha: preview.source.refCommitSha,
        commitSha: preview.source.commitSha,
        path: preview.source.path,
        blobSha: preview.source.blobSha,
        fileSha256: preview.source.fileSha256,
        startByte: preview.source.startByte,
        endByte: preview.source.endByte,
      };
      return { collectionRequestId: row.id, requestId: row.requestId,
        previewId: row.previewId, state: "preview_ready" as const,
        promptVersion: preview.templateVersion, prompt: preview.prompt,
        model: preview.model, source: sourceMetadata,
        selectedSourceIndices: preview.selectedSourceIndices,
        unselectedSourceCount: preview.unselectedSourceCount,
        provenance: preview.provenance,
        resultDigest: row.resultDigest, resultDigestKeyId: row.resultDigestKeyId,
        expiresAt: row.expiresAt, resultPurgeAfter: row.resultPurgeAfter,
        collectionVerified: false as const, transferAuthorized: false as const };
    } finally { plain?.fill(0); }
  }, { maxWait: 3_000, timeout: 12_000 });
}
