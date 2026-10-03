import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { AMUX_V4_COLLECTION_CLAIM_ACTION, AMUX_V4_COLLECTION_CLAIM_SCOPE,
  AMUX_V4_COLLECTION_RESULT_ACTION, AMUX_V4_COLLECTION_RESULT_TARGET,
  AMUX_V4_IDEA_SYSTEM_ACTOR } from "@/lib/adminAuditSystemActors";
import { prisma } from "@/lib/prisma";
import { collectionRequestDigest, sameCollectionDigest } from "./ideaCollectionClaimCore.ts";
import { checkAmuxIdeaCollectionSource,
  type AmuxIdeaCollectionRequest } from "./ideaCollectionRequestInputCore.ts";
import { type AmuxV4CollectionResultRequest, buildAmuxCollectionResult,
  AMUX_V4_COLLECTION_RESULT_ENV, collectionResultEnabled } from "./ideaCollectionResultCore.ts";
import { openAmuxContent, sealAmuxContent, verifyAmuxContentDigest,
  type AmuxContentKeys } from "./ideaCrypto.ts";
import { inspectAmuxIdeaInput } from "./ideaInputCore.ts";
import { loadCurrentAmuxContentKeys } from "./ideaKeyConfig.ts";

const HASH = /^[a-f0-9]{64}$/;
const MAX_SCOPE_AGE_MS = 15 * 60_000;

export class AmuxCollectionResultError extends Error {
  constructor(readonly code: "not_found" | "not_ready" | "result_disabled" |
    "integrity_unavailable" | "outcome_unknown",
    readonly readBack?: "preview_ready" | "hold" | "claimed" | "other" |
      "partial" | "absent" | "unavailable") {
    super(code);
    this.name = "AmuxCollectionResultError";
  }
}

const metadataOf = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
const validAudit = (row: { entryHash: string | null } | null | undefined) =>
  Boolean(row && typeof row.entryHash === "string" && HASH.test(row.entryHash));

/** The collector has no DB credential. Lock order matches the claim writer:
 * audit chain → idea → scope → frontier → request. No network call in tx. */
export async function commitAmuxCollectionResult(tx: Prisma.TransactionClient,
  request: AmuxV4CollectionResultRequest, keys: AmuxContentKeys) {
  await tx.$queryRaw`
    SELECT set_config('TimeZone', 'UTC', true) AS zone,
           set_config('statement_timeout', '3000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '5000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const identity = await tx.amuxIdeaCollectionRequest.findUnique({
    where: { id: request.collectionRequestId },
    select: { id: true, ideaId: true, actorUserId: true,
      sourceScopeApprovalId: true, frontierApprovalId: true },
  });
  if (!identity) throw new AmuxCollectionResultError("not_found");
  const ideas = await tx.$queryRaw<Array<{
    id: string; actorUserId: string; state: string; analysisDeadlineAt: Date;
    rawCiphertext: Uint8Array | null; rawKeyId: string | null;
    rawKeyVersion: number | null; rawDigest: string | null;
    rawDigestKeyId: string | null; rawPurgedAt: Date | null;
  }>>`
    SELECT "id", "actorUserId", "state", "analysisDeadlineAt", "rawCiphertext",
           "rawKeyId", "rawKeyVersion", "rawDigest", "rawDigestKeyId", "rawPurgedAt"
    FROM "AmuxIdeaSubmission" WHERE "id" = ${identity.ideaId}
      AND "actorUserId" = ${identity.actorUserId} FOR UPDATE
  `;
  const idea = ideas[0];
  if (!idea) throw new AmuxCollectionResultError("not_ready");
  const scopes = await tx.$queryRaw<Array<{
    id: string; ideaId: string; actorUserId: string; status: string;
    approvedAt: Date; expiresAt: Date; consumedAt: Date | null;
    revokedAt: Date | null; scopePurgedAt: Date | null;
    scopeCiphertext: Uint8Array | null; scopeKeyId: string | null;
    scopeKeyVersion: number | null; scopeDigest: string;
    scopeDigestKeyId: string; authorizationAuditLogId: string;
  }>>`
    SELECT "id", "ideaId", "actorUserId", "status", "approvedAt", "expiresAt",
           "consumedAt", "revokedAt", "scopePurgedAt", "scopeCiphertext",
           "scopeKeyId", "scopeKeyVersion", "scopeDigest", "scopeDigestKeyId",
           "authorizationAuditLogId"
    FROM "AmuxIdeaSourceScopeApproval"
    WHERE "id" = ${identity.sourceScopeApprovalId} AND "ideaId" = ${idea.id}
      AND "actorUserId" = ${idea.actorUserId} FOR UPDATE
  `;
  const scope = scopes[0];
  if (!scope) throw new AmuxCollectionResultError("not_ready");
  const frontiers = await tx.$queryRaw<Array<{
    id: string; version: number; provider: string; modelId: string;
    status: string; allowedEfforts: string[]; approvedAt: Date;
    approvedByUserId: string; approvalAuditLogId: string; revokedAt: Date | null;
  }>>`
    SELECT "id", "version", "provider", "modelId", "status", "allowedEfforts",
           "approvedAt", "approvedByUserId", "approvalAuditLogId", "revokedAt"
    FROM "AmuxIdeaFrontierModelApproval" WHERE "id" = ${identity.frontierApprovalId}
    FOR UPDATE
  `;
  const frontier = frontiers[0];
  if (!frontier) throw new AmuxCollectionResultError("not_ready");
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaCollectionRequest"
    WHERE "id" = ${request.collectionRequestId} FOR UPDATE
  `;
  if (locked.length !== 1) throw new AmuxCollectionResultError("not_ready");
  const row = await tx.amuxIdeaCollectionRequest.findUnique({
    where: { id: request.collectionRequestId },
  });
  if (!row || row.ideaId !== idea.id || row.actorUserId !== idea.actorUserId ||
      row.sourceScopeApprovalId !== scope.id || row.frontierApprovalId !== frontier.id) {
    throw new AmuxCollectionResultError("not_ready");
  }
  const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = nowRows[0]?.now;
  const latest = await tx.amuxIdeaFrontierModelApproval.findFirst({
    where: { provider: row.provider, modelId: row.modelId },
    orderBy: { version: "desc" }, select: { version: true },
  });
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new AmuxCollectionResultError("integrity_unavailable");
  }
  if (row.requestId !== request.requestId || row.previewId !== request.previewId ||
      !sameCollectionDigest(row.requestDigest, request.requestDigest) ||
      row.state !== "claimed" || row.leaseId !== request.leaseId ||
      row.leaseGeneration !== request.leaseGeneration ||
      !row.leaseExpiresAt || now >= row.leaseExpiresAt || now >= row.expiresAt ||
      row.resultCiphertext !== null || row.resultDigest !== null ||
      !row.transitionAuditLogId ||
      idea.state !== "submitted" || now >= idea.analysisDeadlineAt ||
      idea.rawPurgedAt !== null || !idea.rawCiphertext || !idea.rawKeyId ||
      !idea.rawKeyVersion || !idea.rawDigest || !idea.rawDigestKeyId ||
      scope.status !== "approved" || now < scope.approvedAt || now >= scope.expiresAt ||
      scope.consumedAt !== null || scope.revokedAt !== null ||
      scope.scopePurgedAt !== null || !scope.scopeCiphertext || !scope.scopeKeyId ||
      !scope.scopeKeyVersion ||
      scope.expiresAt.getTime() > scope.approvedAt.getTime() + MAX_SCOPE_AGE_MS ||
      frontier.status !== "approved" || now < frontier.approvedAt ||
      frontier.revokedAt !== null || latest?.version !== frontier.version ||
      frontier.version !== row.frontierVersion || frontier.provider !== row.provider ||
      frontier.modelId !== row.modelId ||
      !frontier.allowedEfforts.includes(row.reasoningEffort) ||
      row.sourceIndex !== 0 || row.sourceKind !== "repository_file" ||
      row.sourceByteLimit !== 8_192 || row.attempt !== 1 ||
      row.requestDigestKeyId !== keys.digestKeyId) {
    throw new AmuxCollectionResultError("not_ready");
  }
  const [ideaAudit, scopeAudit, frontierAudit, requestAudit, claimAudit] = await Promise.all([
    tx.adminAuditLog.findFirst({ where: { action: "AMUX_V4_IDEA_SUBMITTED",
      targetType: "AmuxIdeaSubmission", targetId: idea.id,
      actorUserId: idea.actorUserId }, select: { entryHash: true } }),
    tx.adminAuditLog.findUnique({ where: { id: scope.authorizationAuditLogId },
      select: { action: true, actorUserId: true, targetType: true,
        targetId: true, entryHash: true, metadata: true } }),
    tx.adminAuditLog.findUnique({ where: { id: frontier.approvalAuditLogId },
      select: { action: true, actorUserId: true, targetType: true,
        targetId: true, entryHash: true, metadata: true } }),
    tx.adminAuditLog.findUnique({ where: { id: row.creationAuditLogId },
      select: { action: true, actorUserId: true, targetType: true,
        targetId: true, entryHash: true, metadata: true } }),
    tx.adminAuditLog.findUnique({ where: { id: row.transitionAuditLogId },
      select: { action: true, actorUserId: true, targetType: true,
        targetId: true, entryHash: true, metadata: true } }),
  ]);
  const sm = metadataOf(scopeAudit?.metadata);
  const fm = metadataOf(frontierAudit?.metadata);
  const rm = metadataOf(requestAudit?.metadata);
  const cm = metadataOf(claimAudit?.metadata);
  if (!validAudit(ideaAudit) || !validAudit(scopeAudit) || !validAudit(frontierAudit) ||
      !validAudit(requestAudit) || !validAudit(claimAudit) || !sm || !fm || !rm || !cm ||
      scopeAudit?.action !== "amux.v4.source_scope.approved" ||
      scopeAudit.actorUserId !== idea.actorUserId ||
      scopeAudit.targetType !== "AmuxIdeaSourceScopeApproval" ||
      scopeAudit.targetId !== scope.id || sm.ideaId !== idea.id ||
      sm.scopeDigest !== scope.scopeDigest || sm.scopeDigestKeyId !== scope.scopeDigestKeyId ||
      sm.ideaDigest !== idea.rawDigest || sm.collectionVerified !== false ||
      sm.transferAuthorized !== false ||
      frontierAudit?.action !== "amux.idea.frontier_model.approved" ||
      frontierAudit.actorUserId !== frontier.approvedByUserId ||
      frontierAudit.targetType !== "AmuxIdeaFrontierModelApproval" ||
      frontierAudit.targetId !== frontier.id || fm.provider !== frontier.provider ||
      fm.modelId !== frontier.modelId || fm.version !== frontier.version ||
      !Array.isArray(fm.allowedEfforts) || !fm.allowedEfforts.includes(row.reasoningEffort) ||
      requestAudit?.action !== "amux.v4.collection.requested" ||
      requestAudit.actorUserId !== idea.actorUserId ||
      requestAudit.targetType !== "AmuxIdeaCollectionRequest" ||
      requestAudit.targetId !== row.id || rm.ideaId !== idea.id ||
      rm.requestId !== row.requestId || rm.previewId !== row.previewId ||
      rm.scopeApprovalId !== scope.id || rm.frontierApprovalId !== frontier.id ||
      rm.frontierVersion !== frontier.version || rm.sourceIndex !== 0 ||
      rm.sourceByteLimit !== 8_192 || rm.requestDigest !== row.requestDigest ||
      rm.requestDigestKeyId !== row.requestDigestKeyId ||
      rm.collectionVerified !== false || rm.transferAuthorized !== false ||
      claimAudit?.action !== AMUX_V4_COLLECTION_CLAIM_ACTION ||
      claimAudit.actorUserId !== null ||
      claimAudit.targetType !== "AmuxIdeaCollectionRequest" ||
      claimAudit.targetId !== row.id || cm.systemActor !== AMUX_V4_IDEA_SYSTEM_ACTOR ||
      cm.actorScope !== AMUX_V4_COLLECTION_CLAIM_SCOPE ||
      cm.collectionRequestId !== row.id || cm.requestId !== row.requestId ||
      cm.previewId !== row.previewId || cm.requestDigest !== row.requestDigest ||
      cm.sourceIndex !== 0 || cm.sourceByteLimit !== 8_192 ||
      cm.leaseGeneration !== row.leaseGeneration ||
      cm.collectionVerified !== false || cm.transferAuthorized !== false) {
    throw new AmuxCollectionResultError("integrity_unavailable");
  }
  let ideaPlain: Buffer | null = null;
  let scopePlain: Buffer | null = null;
  let resultPlain: Buffer | null = null;
  try {
    try {
      ideaPlain = openAmuxContent({ ciphertext: Buffer.from(idea.rawCiphertext),
        keyId: idea.rawKeyId, keyVersion: idea.rawKeyVersion },
      "idea_raw", idea.id, keys);
      scopePlain = openAmuxContent({ ciphertext: Buffer.from(scope.scopeCiphertext),
        keyId: scope.scopeKeyId, keyVersion: scope.scopeKeyVersion },
      "source_scope", scope.id, keys);
    } catch { throw new AmuxCollectionResultError("integrity_unavailable"); }
    if (!verifyAmuxContentDigest(ideaPlain, "idea_raw", idea.id,
      idea.rawDigest, idea.rawDigestKeyId, keys) ||
        !verifyAmuxContentDigest(scopePlain, "source_scope", scope.id,
          scope.scopeDigest, scope.scopeDigestKeyId, keys) ||
        !sameCollectionDigest(row.requestDigest,
          collectionRequestDigest(row, idea.rawDigest, scope.scopeDigest, keys.digestKey))) {
      throw new AmuxCollectionResultError("integrity_unavailable");
    }
    const inspectedIdea = inspectAmuxIdeaInput(ideaPlain.toString("utf8"));
    if (!inspectedIdea.ok) throw new AmuxCollectionResultError("not_ready");
    const choice: AmuxIdeaCollectionRequest = {
      schemaVersion: 1, requestId: row.requestId, previewId: row.previewId,
      ideaId: row.ideaId, scopeApprovalId: row.sourceScopeApprovalId,
      frontierApprovalId: row.frontierApprovalId, frontierVersion: row.frontierVersion,
      provider: row.provider as "openai" | "anthropic", modelId: row.modelId,
      reasoningEffort: row.reasoningEffort as AmuxIdeaCollectionRequest["reasoningEffort"],
      sourceIndex: 0, attempt: 1, sourceByteLimit: 8_192,
    };
    const selected = checkAmuxIdeaCollectionSource(choice, idea.id,
      scopePlain.toString("utf8"), inspectedIdea.input);
    if (selected.decision !== "eligible") throw new AmuxCollectionResultError("not_ready");
    let sealed: ReturnType<typeof sealAmuxContent> | null = null;
    let promptVersion: string | null = null;
    if (request.outcome === "preview_candidate") {
      const built = buildAmuxCollectionResult({ request, idea: inspectedIdea.input.idea,
        source: selected.source, model: { provider: choice.provider,
          modelId: row.modelId, reasoningEffort: row.reasoningEffort } });
      if (!built.ok) throw new AmuxCollectionResultError("not_ready");
      resultPlain = Buffer.from(built.result, "utf8");
      sealed = sealAmuxContent(resultPlain, "collection_result", row.id, keys);
      if (sealed.ciphertext.length > 32_768) throw new AmuxCollectionResultError("not_ready");
      promptVersion = built.promptVersion;
    }
    const state = sealed ? "preview_ready" : "hold";
    const auditId = await writeSystemAuditLog({ tx,
      systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
      action: AMUX_V4_COLLECTION_RESULT_ACTION,
      targetType: AMUX_V4_COLLECTION_RESULT_TARGET, targetId: row.id,
      summary: sealed ? "Stored one bounded encrypted collection preview."
        : "Collector held one collection request without source content.",
      metadata: { collectionRequestId: row.id, requestId: row.requestId,
        previewId: row.previewId, requestDigest: row.requestDigest,
        sourceIndex: row.sourceIndex, sourceByteLimit: row.sourceByteLimit,
        leaseGeneration: row.leaseGeneration, state,
        resultDigest: sealed?.digest ?? null,
        resultDigestKeyId: sealed?.digestKeyId ?? null,
        promptVersion, holdCode: request.outcome === "hold" ? request.reason : null,
        collectionVerified: false, transferAuthorized: false },
    });
    // PostgreSQL evaluates the lease deadline at the UPDATE, after prompt
    // construction and audit insertion. The existing trigger separately
    // rejects a late preview_ready; this also fences a late hold.
    const ciphertext = sealed ? new Uint8Array(sealed.ciphertext) : null;
    const changed = await tx.$executeRaw`
      UPDATE "AmuxIdeaCollectionRequest"
      SET "state" = ${state}, "leaseId" = NULL, "leaseExpiresAt" = NULL,
          "resultCiphertext" = ${ciphertext}::bytea,
          "resultKeyId" = ${sealed?.keyId ?? null},
          "resultKeyVersion" = ${sealed?.keyVersion ?? null},
          "resultDigest" = ${sealed?.digest ?? null},
          "resultDigestKeyId" = ${sealed?.digestKeyId ?? null},
          "resultPurgeAfter" = ${sealed ? new Date(now.getTime() + 24 * 60 * 60_000) : null},
          "transitionAuditLogId" = ${auditId}, "updatedAt" = ${now}
      WHERE "id" = ${row.id} AND "state" = 'claimed'
        AND "requestId" = ${request.requestId}::uuid
        AND "previewId" = ${request.previewId}
        AND "requestDigest" = ${request.requestDigest}
        AND "leaseGeneration" = ${request.leaseGeneration}
        AND "leaseId" = ${request.leaseId}
        AND "transitionAuditLogId" = ${row.transitionAuditLogId}
        AND "resultCiphertext" IS NULL AND "resultDigest" IS NULL
        AND "leaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3)
        AND "expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3)
    `;
    if (changed !== 1) throw new AmuxCollectionResultError("not_ready");
    return { collectionRequestId: row.id, requestId: row.requestId,
      previewId: row.previewId, state, resultDigest: sealed?.digest ?? null,
      collectionVerified: false as const, transferAuthorized: false as const };
  } finally {
    ideaPlain?.fill(0); scopePlain?.fill(0); resultPlain?.fill(0);
  }
}

/** Content-free readback; absence or claimed is not permission to resubmit. */
export async function readAmuxCollectionResultOutcome(request: AmuxV4CollectionResultRequest) {
  const row = await prisma.amuxIdeaCollectionRequest.findUnique({
    where: { id: request.collectionRequestId }, select: { id: true,
      requestId: true, previewId: true, requestDigest: true, state: true,
      sourceIndex: true, sourceByteLimit: true, leaseId: true,
      leaseGeneration: true, resultDigest: true, resultDigestKeyId: true,
      transitionAuditLogId: true },
  });
  if (!row) return { status: "absent" as const };
  if (row.requestId !== request.requestId || row.previewId !== request.previewId ||
      !sameCollectionDigest(row.requestDigest, request.requestDigest)) {
    return { status: "partial" as const };
  }
  if (row.state === "claimed") return { status: row.leaseId === request.leaseId &&
    row.leaseGeneration === request.leaseGeneration ? "claimed" as const : "partial" as const };
  if (row.state !== "preview_ready" && row.state !== "hold") {
    return { status: "other" as const };
  }
  if (row.leaseGeneration !== request.leaseGeneration || !row.transitionAuditLogId ||
      (row.state === "preview_ready") !== (row.resultDigest !== null)) {
    return { status: "partial" as const };
  }
  const audit = await prisma.adminAuditLog.findUnique({
    where: { id: row.transitionAuditLogId }, select: { action: true,
      actorUserId: true, targetType: true, targetId: true,
      entryHash: true, metadata: true },
  });
  const m = metadataOf(audit?.metadata);
  if (!validAudit(audit) || audit?.action !== AMUX_V4_COLLECTION_RESULT_ACTION ||
      audit.actorUserId !== null || audit.targetType !== AMUX_V4_COLLECTION_RESULT_TARGET ||
      audit.targetId !== row.id || !m ||
      m.systemActor !== AMUX_V4_IDEA_SYSTEM_ACTOR ||
      m.actorScope !== "idea-collection-result-v1" ||
      m.collectionRequestId !== row.id || m.requestId !== row.requestId ||
      m.previewId !== row.previewId || m.requestDigest !== row.requestDigest ||
      m.sourceIndex !== row.sourceIndex || m.sourceByteLimit !== row.sourceByteLimit ||
      m.leaseGeneration !== row.leaseGeneration || m.state !== row.state ||
      m.resultDigest !== row.resultDigest || m.collectionVerified !== false ||
      m.resultDigestKeyId !== row.resultDigestKeyId ||
      m.transferAuthorized !== false) return { status: "partial" as const };
  return { status: row.state === "preview_ready" ? "preview_ready" as const : "hold" as const,
    resultDigest: row.resultDigest };
}

export async function submitAmuxCollectionResult(request: AmuxV4CollectionResultRequest) {
  if (!collectionResultEnabled(process.env[AMUX_V4_COLLECTION_RESULT_ENV])) {
    throw new AmuxCollectionResultError("result_disabled");
  }
  if (adminAuditIntegrityKeys(process.env).length === 0) {
    throw new AmuxCollectionResultError("integrity_unavailable");
  }
  let keys: AmuxContentKeys;
  try { keys = loadCurrentAmuxContentKeys(process.env); } catch {
    throw new AmuxCollectionResultError("integrity_unavailable");
  }
  let callbackReturned = false;
  try {
    return await prisma.$transaction(async (tx) => {
      const result = await commitAmuxCollectionResult(tx, request, keys);
      callbackReturned = true;
      return result;
    }, { maxWait: 3_000, timeout: 12_000 });
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxCollectionResultError) throw error;
    let readBack: AmuxCollectionResultError["readBack"] = "unavailable";
    try { readBack = (await readAmuxCollectionResultOutcome(request)).status; }
    catch { /* Never resubmit after an ambiguous commit. */ }
    throw new AmuxCollectionResultError("outcome_unknown", readBack);
  }
}
