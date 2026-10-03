import "server-only";

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { prisma } from "@/lib/prisma";
import { AMUX_V4_COLLECTION_FIRST_ATTEMPT, AMUX_V4_COLLECTION_SOURCE_BYTE_LIMIT,
  checkAmuxIdeaCollectionSource, inspectAmuxIdeaCollectionRequestInput,
  type AmuxIdeaCollectionRequest } from "./ideaCollectionRequestInputCore.ts";
import { openAmuxContent, verifyAmuxContentDigest,
  type AmuxContentKeys } from "./ideaCrypto.ts";
import { inspectAmuxIdeaInput } from "./ideaInputCore.ts";
import { loadCurrentAmuxContentKeys } from "./ideaKeyConfig.ts";

export const AMUX_V4_COLLECTION_REQUEST_WRITE_CODE_LATCH = false;
export const AMUX_V4_COLLECTION_REQUEST_READ_CODE_LATCH = false;
export const AMUX_V4_COLLECTION_REQUEST_WRITE_ENV = "TOMVERSE_AMUX_V4_COLLECTION_REQUEST_WRITE";
export const AMUX_V4_COLLECTION_REQUEST_READ_ENV = "TOMVERSE_AMUX_V4_COLLECTION_REQUEST_READ";
export const collectionRequestWritePermitted = (value: string | undefined) =>
  AMUX_V4_COLLECTION_REQUEST_WRITE_CODE_LATCH && value === "enabled";
export const collectionRequestReadPermitted = (value: string | undefined) =>
  AMUX_V4_COLLECTION_REQUEST_READ_CODE_LATCH && value === "enabled";

const ACTION = "amux.v4.collection.requested";
const TARGET = "AmuxIdeaCollectionRequest";
const DIGEST_DOMAIN = "amux-v4\0collection_request\0";
const DIGEST = /^[a-f0-9]{64}$/;
const CHOICE_FIELDS = ["schemaVersion", "requestId", "previewId", "ideaId",
  "scopeApprovalId", "frontierApprovalId", "frontierVersion", "provider",
  "modelId", "reasoningEffort", "sourceIndex", "attempt", "sourceByteLimit"] as const;

export class AmuxCollectionRequestError extends Error {
  constructor(readonly code: "not_found" | "not_ready" | "request_exists" |
    "collection_disabled" | "integrity_unavailable" | "outcome_unknown",
    readonly readBack?: "committed" | "partial" | "absent" | "unavailable") {
    super(code);
    this.name = "AmuxCollectionRequestError";
  }
}

const ownerId = (session: Session): string => {
  const id = session.user?.id;
  if (!id || !isAdminSession(session) || getAdminRole(session) !== "owner") {
    throw new AmuxCollectionRequestError("not_found");
  }
  return id;
};

const sameDigest = (left: string, right: string) =>
  DIGEST.test(left) && DIGEST.test(right) &&
  timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));

function normalizedChoice(value: AmuxIdeaCollectionRequest): AmuxIdeaCollectionRequest | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).length !== CHOICE_FIELDS.length ||
        !CHOICE_FIELDS.every((field) => Object.hasOwn(value, field)) ||
        value.attempt !== AMUX_V4_COLLECTION_FIRST_ATTEMPT ||
        value.sourceByteLimit !== AMUX_V4_COLLECTION_SOURCE_BYTE_LIMIT) return null;
    const raw = Object.fromEntries(CHOICE_FIELDS.filter((field) =>
      field !== "attempt" && field !== "sourceByteLimit").map((field) => [field, value[field]]));
    const inspected = inspectAmuxIdeaCollectionRequestInput(JSON.stringify(raw));
    return inspected.ok ? inspected.request : null;
  } catch { return null; }
}

const requestBinding = (choice: AmuxIdeaCollectionRequest,
  ideaDigest: string, scopeDigest: string, keys: AmuxContentKeys) => {
  const canonical = JSON.stringify({
    schemaVersion: 1, requestId: choice.requestId, previewId: choice.previewId,
    ideaId: choice.ideaId, ideaDigest, scopeApprovalId: choice.scopeApprovalId,
    scopeDigest, sourceIndex: choice.sourceIndex, sourceKind: "repository_file",
    sourceByteLimit: choice.sourceByteLimit, frontierApprovalId: choice.frontierApprovalId,
    frontierVersion: choice.frontierVersion, provider: choice.provider,
    modelId: choice.modelId, reasoningEffort: choice.reasoningEffort,
    attempt: choice.attempt,
  });
  return { digest: createHmac("sha256", keys.digestKey)
    .update(DIGEST_DOMAIN).update(choice.requestId).update("\0").update(canonical).digest("hex"),
  digestKeyId: keys.digestKeyId };
};

/** Synthetic-test seam. Its caller owns owner step-up, the closed latch and
 * the transaction; this method never reads GitHub or invokes a model. */
export async function commitAmuxIdeaCollectionRequest(tx: Prisma.TransactionClient,
  input: { session: Session; request: Request; choice: AmuxIdeaCollectionRequest;
    keys: AmuxContentKeys }) {
  const actorUserId = ownerId(input.session);
  const choice = normalizedChoice(input.choice);
  if (!choice) throw new AmuxCollectionRequestError("not_ready");
  await tx.$executeRaw`SELECT set_config('TimeZone', 'UTC', true)`;
  await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
  await takeAuditChainLock(tx);
  const existing = await tx.amuxIdeaCollectionRequest.findFirst({
    where: { OR: [
      { requestId: choice.requestId },
      { previewId: choice.previewId },
      { ideaId: choice.ideaId, sourceScopeApprovalId: choice.scopeApprovalId,
        sourceIndex: choice.sourceIndex, attempt: choice.attempt },
    ] }, select: { id: true },
  });
  if (existing) throw new AmuxCollectionRequestError("request_exists");
  const ideaRows = await tx.$queryRaw<Array<{
    id: string; state: string; analysisDeadlineAt: Date;
    rawCiphertext: Uint8Array | null; rawKeyId: string | null;
    rawKeyVersion: number | null; rawDigest: string | null;
    rawDigestKeyId: string | null; rawPurgedAt: Date | null;
  }>>`
    SELECT "id", "state", "analysisDeadlineAt", "rawCiphertext", "rawKeyId",
           "rawKeyVersion", "rawDigest", "rawDigestKeyId", "rawPurgedAt"
    FROM "AmuxIdeaSubmission"
    WHERE "id" = ${choice.ideaId} AND "actorUserId" = ${actorUserId}
    FOR UPDATE
  `;
  const idea = ideaRows[0];
  if (!idea) throw new AmuxCollectionRequestError("not_found");
  const scopeRows = await tx.$queryRaw<Array<{
    id: string; status: string; approvedAt: Date; expiresAt: Date;
    scopeCiphertext: Uint8Array | null; scopeKeyId: string | null;
    scopeKeyVersion: number | null; scopeDigest: string;
    scopeDigestKeyId: string; consumedAt: Date | null;
    revokedAt: Date | null; scopePurgedAt: Date | null;
    authorizationAuditLogId: string;
  }>>`
    SELECT "id", "status", "approvedAt", "expiresAt", "scopeCiphertext",
           "scopeKeyId", "scopeKeyVersion", "scopeDigest", "scopeDigestKeyId",
           "consumedAt", "revokedAt", "scopePurgedAt", "authorizationAuditLogId"
    FROM "AmuxIdeaSourceScopeApproval"
    WHERE "id" = ${choice.scopeApprovalId} AND "ideaId" = ${choice.ideaId}
      AND "actorUserId" = ${actorUserId}
    FOR UPDATE
  `;
  const scope = scopeRows[0];
  if (!scope) throw new AmuxCollectionRequestError("not_found");
  const frontierRows = await tx.$queryRaw<Array<{
    id: string; version: number; provider: string; modelId: string;
    status: string; allowedEfforts: string[]; approvedAt: Date;
    revokedAt: Date | null;
  }>>`
    SELECT "id", "version", "provider", "modelId", "status",
           "allowedEfforts", "approvedAt", "revokedAt"
    FROM "AmuxIdeaFrontierModelApproval"
    WHERE "id" = ${choice.frontierApprovalId}
    FOR UPDATE
  `;
  const frontier = frontierRows[0];
  if (!frontier) throw new AmuxCollectionRequestError("not_ready");
  const latest = await tx.amuxIdeaFrontierModelApproval.findFirst({
    where: { provider: choice.provider, modelId: choice.modelId },
    orderBy: { version: "desc" }, select: { version: true },
  });
  const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = nowRows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new AmuxCollectionRequestError("integrity_unavailable");
  }
  if (idea.state !== "submitted" || now >= idea.analysisDeadlineAt ||
      idea.rawPurgedAt !== null || !idea.rawCiphertext || !idea.rawKeyId ||
      !idea.rawKeyVersion || !idea.rawDigest || !idea.rawDigestKeyId ||
      scope.status !== "approved" || now < scope.approvedAt ||
      now >= scope.expiresAt || scope.expiresAt.getTime() > scope.approvedAt.getTime() + 15 * 60_000 ||
      scope.consumedAt !== null || scope.revokedAt !== null ||
      scope.scopePurgedAt !== null || !scope.scopeCiphertext ||
      !scope.scopeKeyId || !scope.scopeKeyVersion ||
      frontier.status !== "approved" || frontier.revokedAt !== null ||
      frontier.approvedAt > now || frontier.id !== choice.frontierApprovalId ||
      frontier.version !== choice.frontierVersion || latest?.version !== frontier.version ||
      frontier.provider !== choice.provider || frontier.modelId !== choice.modelId ||
      !frontier.allowedEfforts.includes(choice.reasoningEffort)) {
    throw new AmuxCollectionRequestError("not_ready");
  }
  const ideaAudit = await tx.adminAuditLog.findFirst({
    where: { action: "AMUX_V4_IDEA_SUBMITTED", targetType: "AmuxIdeaSubmission",
      targetId: idea.id, actorUserId },
    select: { id: true, entryHash: true },
  });
  const scopeAudit = await tx.adminAuditLog.findUnique({
    where: { id: scope.authorizationAuditLogId },
    select: { action: true, actorUserId: true, targetType: true,
      targetId: true, entryHash: true, metadata: true },
  });
  const scopeMetadata = scopeAudit?.metadata && typeof scopeAudit.metadata === "object" &&
    !Array.isArray(scopeAudit.metadata)
    ? scopeAudit.metadata as Record<string, unknown> : null;
  if (!ideaAudit?.entryHash || !scopeAudit?.entryHash ||
      scopeAudit.action !== "amux.v4.source_scope.approved" ||
      scopeAudit.actorUserId !== actorUserId ||
      scopeAudit.targetType !== "AmuxIdeaSourceScopeApproval" ||
      scopeAudit.targetId !== scope.id || !scopeMetadata ||
      scopeMetadata.ideaId !== choice.ideaId ||
      scopeMetadata.scopeDigest !== scope.scopeDigest ||
      scopeMetadata.scopeDigestKeyId !== scope.scopeDigestKeyId) {
    throw new AmuxCollectionRequestError("not_ready");
  }
  let ideaPlain: Buffer | null = null;
  let scopePlain: Buffer | null = null;
  try {
    try {
      ideaPlain = openAmuxContent({ ciphertext: Buffer.from(idea.rawCiphertext),
        keyId: idea.rawKeyId, keyVersion: idea.rawKeyVersion },
      "idea_raw", idea.id, input.keys);
      scopePlain = openAmuxContent({ ciphertext: Buffer.from(scope.scopeCiphertext),
        keyId: scope.scopeKeyId, keyVersion: scope.scopeKeyVersion },
      "source_scope", scope.id, input.keys);
    } catch {
      throw new AmuxCollectionRequestError("integrity_unavailable");
    }
    if (!verifyAmuxContentDigest(ideaPlain, "idea_raw", idea.id,
      idea.rawDigest, idea.rawDigestKeyId, input.keys) ||
        !verifyAmuxContentDigest(scopePlain, "source_scope", scope.id,
          scope.scopeDigest, scope.scopeDigestKeyId, input.keys) ||
        typeof scopeMetadata.ideaDigest !== "string" ||
        !sameDigest(scopeMetadata.ideaDigest, idea.rawDigest)) {
      throw new AmuxCollectionRequestError("integrity_unavailable");
    }
    const inspectedIdea = inspectAmuxIdeaInput(ideaPlain.toString("utf8"));
    if (!inspectedIdea.ok) throw new AmuxCollectionRequestError("not_ready");
    const sourceDecision = checkAmuxIdeaCollectionSource(choice, idea.id,
      scopePlain.toString("utf8"), inspectedIdea.input);
    if (sourceDecision.decision !== "eligible") {
      throw new AmuxCollectionRequestError("not_ready");
    }
    const expiresAt = new Date(Math.min(now.getTime() + 15 * 60_000,
      scope.expiresAt.getTime(), idea.analysisDeadlineAt.getTime()));
    if (expiresAt <= now) throw new AmuxCollectionRequestError("not_ready");
    const id = randomUUID();
    const binding = requestBinding(choice, idea.rawDigest, scope.scopeDigest, input.keys);
    const auditId = await writeAdminAuditLog({ tx, session: input.session,
      request: input.request, action: ACTION, targetType: TARGET, targetId: id,
      summary: "Owner requested one bounded repository-file collection; no source was fetched.",
      metadata: { contractVersion: 1, ideaId: idea.id,
        requestId: choice.requestId, previewId: choice.previewId,
        scopeApprovalId: scope.id, frontierApprovalId: frontier.id,
        frontierVersion: frontier.version, sourceIndex: 0,
        sourceKind: "repository_file", sourceByteLimit: 8_192,
        attempt: 1, requestDigest: binding.digest,
        requestDigestKeyId: binding.digestKeyId,
        collectionVerified: false, transferAuthorized: false },
    });
    await tx.amuxIdeaCollectionRequest.create({ data: {
      id, requestId: choice.requestId, ideaId: idea.id, actorUserId,
      sourceScopeApprovalId: scope.id, frontierApprovalId: frontier.id,
      frontierVersion: frontier.version, provider: frontier.provider,
      modelId: frontier.modelId, reasoningEffort: choice.reasoningEffort,
      sourceIndex: 0, sourceKind: "repository_file", sourceByteLimit: 8_192,
      previewId: choice.previewId, attempt: 1,
      requestDigest: binding.digest, requestDigestKeyId: binding.digestKeyId,
      state: "pending", leaseGeneration: 0, expiresAt,
      creationAuditLogId: auditId, createdAt: now, updatedAt: now,
    } });
    return { id, requestId: choice.requestId, previewId: choice.previewId,
      state: "pending" as const, expiresAt, requestDigest: binding.digest,
      requestDigestKeyId: binding.digestKeyId };
  } finally {
    ideaPlain?.fill(0);
    scopePlain?.fill(0);
  }
}

/** Exact-ID readback is content-free. Absence never authorizes a retry. */
export async function readAmuxIdeaCollectionRequest(session: Session, requestId: string) {
  const actorUserId = ownerId(session);
  const row = await prisma.amuxIdeaCollectionRequest.findUnique({
    where: { requestId }, select: { id: true, requestId: true,
      actorUserId: true, ideaId: true, sourceScopeApprovalId: true,
      frontierApprovalId: true, frontierVersion: true, previewId: true,
      requestDigest: true, requestDigestKeyId: true,
      state: true, expiresAt: true, creationAuditLogId: true },
  });
  if (!row || row.actorUserId !== actorUserId) return { requestId, status: "absent" as const };
  const audit = await prisma.adminAuditLog.findUnique({
    where: { id: row.creationAuditLogId },
    select: { action: true, actorUserId: true, targetType: true,
      targetId: true, entryHash: true, metadata: true },
  });
  const metadata = audit?.metadata && typeof audit.metadata === "object" &&
    !Array.isArray(audit.metadata)
    ? audit.metadata as Record<string, unknown> : null;
  if (!audit?.entryHash || audit.action !== ACTION ||
      audit.actorUserId !== actorUserId || audit.targetType !== TARGET ||
      audit.targetId !== row.id || !metadata ||
      metadata.ideaId !== row.ideaId || metadata.requestId !== row.requestId ||
      metadata.previewId !== row.previewId ||
      metadata.scopeApprovalId !== row.sourceScopeApprovalId ||
      metadata.frontierApprovalId !== row.frontierApprovalId ||
      metadata.frontierVersion !== row.frontierVersion ||
      metadata.requestDigest !== row.requestDigest ||
      metadata.requestDigestKeyId !== row.requestDigestKeyId ||
      metadata.collectionVerified !== false || metadata.transferAuthorized !== false) {
    return { requestId, status: "partial" as const, id: row.id };
  }
  return { requestId, status: "committed" as const, id: row.id,
    previewId: row.previewId, state: row.state, expiresAt: row.expiresAt,
    requestDigest: row.requestDigest, requestDigestKeyId: row.requestDigestKeyId,
    collectionVerified: false, transferAuthorized: false };
}

export async function createAmuxIdeaCollectionRequest(input: {
  session: Session; request: Request; choice: AmuxIdeaCollectionRequest;
}) {
  ownerId(input.session);
  if (!collectionRequestWritePermitted(process.env[AMUX_V4_COLLECTION_REQUEST_WRITE_ENV])) {
    throw new AmuxCollectionRequestError("collection_disabled");
  }
  if (adminAuditIntegrityKeys(process.env).length === 0) {
    throw new AmuxCollectionRequestError("integrity_unavailable");
  }
  let keys: AmuxContentKeys;
  try { keys = loadCurrentAmuxContentKeys(process.env); } catch {
    throw new AmuxCollectionRequestError("integrity_unavailable");
  }
  let callbackReturned = false;
  try {
    return await prisma.$transaction(async (tx) => {
      const committed = await commitAmuxIdeaCollectionRequest(tx, { ...input, keys });
      callbackReturned = true;
      return committed;
    }, { maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxCollectionRequestError) throw error;
    // A callback return is not proof of durable COMMIT. Read once by the
    // caller's request ID, then stop regardless of what this read observes.
    let readBack: "committed" | "partial" | "absent" | "unavailable" = "unavailable";
    try {
      readBack = (await readAmuxIdeaCollectionRequest(input.session,
        input.choice.requestId)).status;
    } catch { /* Read-back may fail or race COMMIT; never start another write. */ }
    throw new AmuxCollectionRequestError("outcome_unknown", readBack);
  }
}
