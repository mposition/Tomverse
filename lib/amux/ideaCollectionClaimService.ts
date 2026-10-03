import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { AMUX_V4_COLLECTION_CLAIM_ACTION, AMUX_V4_COLLECTION_CLAIM_TARGET,
  AMUX_V4_IDEA_SYSTEM_ACTOR } from "@/lib/adminAuditSystemActors";
import { prisma } from "@/lib/prisma";
import { AMUX_V4_COLLECTION_LEASE_MS, collectionClaimEnabled,
  AMUX_V4_COLLECTION_CLAIM_ENV, collectionRequestDigest,
  sameCollectionDigest } from "./ideaCollectionClaimCore.ts";
import { checkAmuxIdeaCollectionSource,
  type AmuxIdeaCollectionRequest } from "./ideaCollectionRequestInputCore.ts";
import { openAmuxContent, verifyAmuxContentDigest,
  type AmuxContentKeys } from "./ideaCrypto.ts";
import { inspectAmuxIdeaInput } from "./ideaInputCore.ts";
import { loadCurrentAmuxContentKeys } from "./ideaKeyConfig.ts";

const HASH = /^[a-f0-9]{64}$/;
const MAX_SCOPE_AGE_MS = 15 * 60_000;

export class AmuxCollectionClaimError extends Error {
  constructor(readonly code: "not_found" | "not_ready" | "claim_disabled" |
    "integrity_unavailable" | "outcome_unknown",
  readonly readBack?: "claimed" | "pending" | "other" | "partial" | "absent" | "unavailable") {
    super(code);
    this.name = "AmuxCollectionClaimError";
  }
}

const metadataOf = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
const validAudit = (row: { entryHash: string | null } | null | undefined): boolean =>
  Boolean(row && typeof row.entryHash === "string" && HASH.test(row.entryHash));

/** Synthetic-test seam. Lock order is audit chain → Idea → Scope → Frontier →
 * Request. A preliminary request identity read is unlocked and never returned.
 * No GitHub or model call occurs within this transaction. */
export async function commitAmuxCollectionClaim(tx: Prisma.TransactionClient,
  collectionRequestId: string, keys: AmuxContentKeys) {
  await tx.$queryRaw`
    SELECT set_config('TimeZone', 'UTC', true) AS zone,
           set_config('statement_timeout', '3000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '5000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const identity = await tx.amuxIdeaCollectionRequest.findUnique({
    where: { id: collectionRequestId },
    select: { id: true, ideaId: true, actorUserId: true,
      sourceScopeApprovalId: true, frontierApprovalId: true },
  });
  if (!identity) throw new AmuxCollectionClaimError("not_found");
  const ideaRows = await tx.$queryRaw<Array<{
    id: string; actorUserId: string; state: string; analysisDeadlineAt: Date;
    rawCiphertext: Uint8Array | null; rawKeyId: string | null;
    rawKeyVersion: number | null; rawDigest: string | null;
    rawDigestKeyId: string | null; rawPurgedAt: Date | null;
  }>>`
    SELECT "id", "actorUserId", "state", "analysisDeadlineAt",
           "rawCiphertext", "rawKeyId", "rawKeyVersion", "rawDigest",
           "rawDigestKeyId", "rawPurgedAt"
    FROM "AmuxIdeaSubmission"
    WHERE "id" = ${identity.ideaId} AND "actorUserId" = ${identity.actorUserId}
    FOR UPDATE
  `;
  const idea = ideaRows[0];
  if (!idea) throw new AmuxCollectionClaimError("not_ready");
  const scopeRows = await tx.$queryRaw<Array<{
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
      AND "actorUserId" = ${idea.actorUserId}
    FOR UPDATE
  `;
  const scope = scopeRows[0];
  if (!scope) throw new AmuxCollectionClaimError("not_ready");
  const frontierRows = await tx.$queryRaw<Array<{
    id: string; version: number; provider: string; modelId: string;
    status: string; allowedEfforts: string[]; approvedAt: Date;
    approvedByUserId: string; approvalAuditLogId: string;
    revokedAt: Date | null;
  }>>`
    SELECT "id", "version", "provider", "modelId", "status", "allowedEfforts",
           "approvedAt", "approvedByUserId", "approvalAuditLogId", "revokedAt"
    FROM "AmuxIdeaFrontierModelApproval"
    WHERE "id" = ${identity.frontierApprovalId}
    FOR UPDATE
  `;
  const frontier = frontierRows[0];
  if (!frontier) throw new AmuxCollectionClaimError("not_ready");
  const lockedRequest = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaCollectionRequest"
    WHERE "id" = ${collectionRequestId} FOR UPDATE
  `;
  if (lockedRequest.length !== 1) throw new AmuxCollectionClaimError("not_ready");
  const row = await tx.amuxIdeaCollectionRequest.findUnique({ where: { id: collectionRequestId } });
  if (!row || row.ideaId !== idea.id || row.actorUserId !== idea.actorUserId ||
      row.sourceScopeApprovalId !== scope.id || row.frontierApprovalId !== frontier.id) {
    throw new AmuxCollectionClaimError("not_ready");
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
    throw new AmuxCollectionClaimError("integrity_unavailable");
  }
  if (row.state !== "pending" || row.leaseGeneration !== 0 ||
      row.leaseId !== null || row.leaseExpiresAt !== null ||
      row.transitionAuditLogId !== null || row.resultCiphertext !== null ||
      row.resultDigest !== null || now >= row.expiresAt ||
      idea.state !== "submitted" || now >= idea.analysisDeadlineAt ||
      idea.rawPurgedAt !== null || !idea.rawCiphertext || !idea.rawKeyId ||
      !idea.rawKeyVersion || !idea.rawDigest || !idea.rawDigestKeyId ||
      scope.status !== "approved" || now < scope.approvedAt ||
      now >= scope.expiresAt || scope.consumedAt !== null ||
      scope.revokedAt !== null || scope.scopePurgedAt !== null ||
      !scope.scopeCiphertext || !scope.scopeKeyId || !scope.scopeKeyVersion ||
      scope.expiresAt.getTime() > scope.approvedAt.getTime() + MAX_SCOPE_AGE_MS ||
      frontier.status !== "approved" || now < frontier.approvedAt ||
      frontier.revokedAt !== null || latest?.version !== frontier.version ||
      frontier.version !== row.frontierVersion || frontier.provider !== row.provider ||
      frontier.modelId !== row.modelId || !frontier.allowedEfforts.includes(row.reasoningEffort) ||
      row.sourceIndex !== 0 || row.sourceKind !== "repository_file" ||
      row.sourceByteLimit !== 8_192 || row.attempt !== 1 ||
      row.requestDigestKeyId !== keys.digestKeyId) {
    throw new AmuxCollectionClaimError("not_ready");
  }
  const [ideaAudit, scopeAudit, frontierAudit, requestAudit] = await Promise.all([
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
  ]);
  const scopeMetadata = metadataOf(scopeAudit?.metadata);
  const frontierMetadata = metadataOf(frontierAudit?.metadata);
  const requestMetadata = metadataOf(requestAudit?.metadata);
  if (!validAudit(ideaAudit) || !validAudit(scopeAudit) || !validAudit(frontierAudit) ||
      !validAudit(requestAudit) || !scopeMetadata || !frontierMetadata || !requestMetadata ||
      scopeAudit?.action !== "amux.v4.source_scope.approved" ||
      scopeAudit.actorUserId !== idea.actorUserId ||
      scopeAudit.targetType !== "AmuxIdeaSourceScopeApproval" ||
      scopeAudit.targetId !== scope.id || scopeMetadata.ideaId !== idea.id ||
      scopeMetadata.scopeDigest !== scope.scopeDigest ||
      scopeMetadata.scopeDigestKeyId !== scope.scopeDigestKeyId ||
      scopeMetadata.ideaDigest !== idea.rawDigest ||
      scopeMetadata.collectionVerified !== false ||
      scopeMetadata.transferAuthorized !== false ||
      frontierAudit?.action !== "amux.idea.frontier_model.approved" ||
      frontierAudit.actorUserId !== frontier.approvedByUserId ||
      frontierAudit.targetType !== "AmuxIdeaFrontierModelApproval" ||
      frontierAudit.targetId !== frontier.id ||
      frontierMetadata.provider !== frontier.provider ||
      frontierMetadata.modelId !== frontier.modelId ||
      frontierMetadata.version !== frontier.version ||
      !Array.isArray(frontierMetadata.allowedEfforts) ||
      !frontierMetadata.allowedEfforts.includes(row.reasoningEffort) ||
      requestAudit?.action !== "amux.v4.collection.requested" ||
      requestAudit.actorUserId !== idea.actorUserId ||
      requestAudit.targetType !== "AmuxIdeaCollectionRequest" ||
      requestAudit.targetId !== row.id || requestMetadata.ideaId !== idea.id ||
      requestMetadata.requestId !== row.requestId ||
      requestMetadata.previewId !== row.previewId ||
      requestMetadata.scopeApprovalId !== scope.id ||
      requestMetadata.frontierApprovalId !== frontier.id ||
      requestMetadata.frontierVersion !== frontier.version ||
      requestMetadata.sourceIndex !== 0 ||
      requestMetadata.sourceByteLimit !== 8_192 ||
      requestMetadata.requestDigest !== row.requestDigest ||
      requestMetadata.requestDigestKeyId !== row.requestDigestKeyId ||
      requestMetadata.collectionVerified !== false ||
      requestMetadata.transferAuthorized !== false) {
    throw new AmuxCollectionClaimError("integrity_unavailable");
  }
  let ideaPlain: Buffer | null = null;
  let scopePlain: Buffer | null = null;
  try {
    try {
      ideaPlain = openAmuxContent({ ciphertext: Buffer.from(idea.rawCiphertext),
        keyId: idea.rawKeyId, keyVersion: idea.rawKeyVersion },
      "idea_raw", idea.id, keys);
      scopePlain = openAmuxContent({ ciphertext: Buffer.from(scope.scopeCiphertext),
        keyId: scope.scopeKeyId, keyVersion: scope.scopeKeyVersion },
      "source_scope", scope.id, keys);
    } catch { throw new AmuxCollectionClaimError("integrity_unavailable"); }
    if (!verifyAmuxContentDigest(ideaPlain, "idea_raw", idea.id,
      idea.rawDigest, idea.rawDigestKeyId, keys) ||
        !verifyAmuxContentDigest(scopePlain, "source_scope", scope.id,
          scope.scopeDigest, scope.scopeDigestKeyId, keys) ||
        !sameCollectionDigest(row.requestDigest,
          collectionRequestDigest(row, idea.rawDigest, scope.scopeDigest, keys.digestKey))) {
      throw new AmuxCollectionClaimError("integrity_unavailable");
    }
    const inspectedIdea = inspectAmuxIdeaInput(ideaPlain.toString("utf8"));
    if (!inspectedIdea.ok) throw new AmuxCollectionClaimError("not_ready");
    const choice: AmuxIdeaCollectionRequest = {
      schemaVersion: 1, requestId: row.requestId, previewId: row.previewId,
      ideaId: row.ideaId, scopeApprovalId: row.sourceScopeApprovalId,
      frontierApprovalId: row.frontierApprovalId,
      frontierVersion: row.frontierVersion,
      provider: row.provider as "openai" | "anthropic", modelId: row.modelId,
      reasoningEffort: row.reasoningEffort as AmuxIdeaCollectionRequest["reasoningEffort"],
      sourceIndex: 0, attempt: 1, sourceByteLimit: 8_192,
    };
    const sourceDecision = checkAmuxIdeaCollectionSource(choice, idea.id,
      scopePlain.toString("utf8"), inspectedIdea.input);
    if (sourceDecision.decision !== "eligible") {
      throw new AmuxCollectionClaimError("not_ready");
    }
    const leaseExpiresAt = new Date(Math.min(now.getTime() + AMUX_V4_COLLECTION_LEASE_MS,
      row.expiresAt.getTime(), scope.expiresAt.getTime(), idea.analysisDeadlineAt.getTime()));
    if (leaseExpiresAt.getTime() - now.getTime() < 10_000) {
      throw new AmuxCollectionClaimError("not_ready");
    }
    const leaseId = randomUUID();
    const transitionAuditLogId = await writeSystemAuditLog({ tx,
      systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
      action: AMUX_V4_COLLECTION_CLAIM_ACTION,
      targetType: AMUX_V4_COLLECTION_CLAIM_TARGET, targetId: row.id,
      summary: "Claimed one owner-approved repository file for isolated collection.",
      metadata: { collectionRequestId: row.id, requestId: row.requestId,
        requestDigest: row.requestDigest, previewId: row.previewId,
        sourceIndex: 0, sourceByteLimit: 8_192,
        leaseGeneration: 1, collectionVerified: false,
        transferAuthorized: false },
    });
    const changed = await tx.amuxIdeaCollectionRequest.updateMany({
      where: { id: row.id, state: "pending", leaseGeneration: 0,
        leaseId: null, leaseExpiresAt: null, transitionAuditLogId: null,
        expiresAt: { gt: now } },
      data: { state: "claimed", leaseGeneration: 1, leaseId,
        leaseExpiresAt, transitionAuditLogId, updatedAt: now },
    });
    if (changed.count !== 1) throw new AmuxCollectionClaimError("not_ready");
    return { collectionRequestId: row.id, requestId: row.requestId,
      previewId: row.previewId, requestDigest: row.requestDigest,
      leaseGeneration: 1 as const, leaseId, leaseExpiresAt,
      sourceByteLimit: 8_192 as const, idea: inspectedIdea.input.idea,
      source: sourceDecision.source, collectionVerified: false as const,
      transferAuthorized: false as const };
  } finally {
    ideaPlain?.fill(0);
    scopePlain?.fill(0);
  }
}

/** Content-free exact-ID reconciliation after a possibly committed claim. */
export async function readAmuxCollectionClaimOutcome(collectionRequestId: string) {
  const row = await prisma.amuxIdeaCollectionRequest.findUnique({
    where: { id: collectionRequestId }, select: { id: true, requestId: true,
      requestDigest: true, previewId: true, sourceIndex: true,
      sourceByteLimit: true, state: true, leaseGeneration: true,
      transitionAuditLogId: true },
  });
  if (!row) return { status: "absent" as const, collectionRequestId };
  if (row.state === "pending" && row.leaseGeneration === 0) {
    return { status: "pending" as const, collectionRequestId, requestId: row.requestId };
  }
  if (row.state !== "claimed" || row.leaseGeneration !== 1 ||
      !row.transitionAuditLogId) {
    return { status: "other" as const, collectionRequestId, requestId: row.requestId };
  }
  const audit = await prisma.adminAuditLog.findUnique({
    where: { id: row.transitionAuditLogId },
    select: { action: true, actorUserId: true, targetType: true,
      targetId: true, entryHash: true, metadata: true },
  });
  const metadata = metadataOf(audit?.metadata);
  if (!validAudit(audit) || audit?.action !== AMUX_V4_COLLECTION_CLAIM_ACTION ||
      audit.actorUserId !== null || audit.targetType !== AMUX_V4_COLLECTION_CLAIM_TARGET ||
      audit.targetId !== row.id || !metadata ||
      metadata.systemActor !== AMUX_V4_IDEA_SYSTEM_ACTOR ||
      metadata.actorScope !== "idea-collection-claim-v1" ||
      metadata.collectionRequestId !== row.id ||
      metadata.requestId !== row.requestId ||
      metadata.requestDigest !== row.requestDigest ||
      metadata.previewId !== row.previewId ||
      metadata.sourceIndex !== row.sourceIndex ||
      metadata.sourceByteLimit !== row.sourceByteLimit ||
      metadata.leaseGeneration !== 1 ||
      metadata.collectionVerified !== false ||
      metadata.transferAuthorized !== false) {
    return { status: "partial" as const, collectionRequestId, requestId: row.requestId };
  }
  return { status: "claimed" as const, collectionRequestId, requestId: row.requestId,
    leaseGeneration: 1 as const };
}

export async function claimAmuxCollection(collectionRequestId: string) {
  if (!collectionClaimEnabled(process.env[AMUX_V4_COLLECTION_CLAIM_ENV])) {
    throw new AmuxCollectionClaimError("claim_disabled");
  }
  if (adminAuditIntegrityKeys(process.env).length === 0) {
    throw new AmuxCollectionClaimError("integrity_unavailable");
  }
  let keys: AmuxContentKeys;
  try { keys = loadCurrentAmuxContentKeys(process.env); } catch {
    throw new AmuxCollectionClaimError("integrity_unavailable");
  }
  let callbackReturned = false;
  try {
    return await prisma.$transaction(async (tx) => {
      const claimed = await commitAmuxCollectionClaim(tx, collectionRequestId, keys);
      callbackReturned = true;
      return claimed;
    }, { maxWait: 3_000, timeout: 12_000 });
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxCollectionClaimError) throw error;
    let readBack: "claimed" | "pending" | "other" | "partial" | "absent" |
      "unavailable" = "unavailable";
    try { readBack = (await readAmuxCollectionClaimOutcome(collectionRequestId)).status; }
    catch { /* A failed readback never starts another write. */ }
    throw new AmuxCollectionClaimError("outcome_unknown", readBack);
  }
}
