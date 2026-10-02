import "server-only";

import { timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { prisma } from "@/lib/prisma";
import { sealAmuxContent, type AmuxContentKeys } from "./ideaCrypto.ts";
import { loadCurrentAmuxContentKeys } from "./ideaKeyConfig.ts";
import { sourceScopeApprovalWritePermitted,
  AMUX_V4_SOURCE_SCOPE_APPROVAL_WRITE_ENV,
  type AmuxSourceScopeApprovalRequest } from "./ideaSourceScopeApprovalCore.ts";
import { previewAmuxSourceScopeInTransaction } from "./ideaSourceScopePreviewService.ts";

export class AmuxSourceScopeApprovalError extends Error {
  constructor(readonly code: "not_found" | "not_ready" | "preview_changed" |
    "approval_exists" | "approval_disabled" | "integrity_unavailable" | "outcome_unknown") {
    super(code);
    this.name = "AmuxSourceScopeApprovalError";
  }
}

const ownerId = (session: Session): string => {
  const id = session.user?.id;
  if (!id || !isAdminSession(session) || getAdminRole(session) !== "owner") {
    throw new AmuxSourceScopeApprovalError("not_found");
  }
  return id;
};

const sameDigest = (left: string, right: string): boolean =>
  /^[a-f0-9]{64}$/.test(left) && /^[a-f0-9]{64}$/.test(right) &&
  timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));

/** Store only the owner's exact collection scope, never GitHub file bytes.
 * This decision is not a transfer approval or permission to call a model. */
export async function commitAmuxSourceScopeApproval(tx: Prisma.TransactionClient, input: {
  session: Session; request: Request; choice: AmuxSourceScopeApprovalRequest;
  keys: AmuxContentKeys;
}): Promise<{ approvalId: string; ideaId: string; expiresAt: Date;
  ideaDigest: string; previewScopeDigest: string; previewScopeDigestKeyId: string;
  scopeDigest: string; scopeDigestKeyId: string; auditId: string }> {
  const actorUserId = ownerId(input.session);
  const { choice } = input;
  await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
  await takeAuditChainLock(tx);
  const locked = await tx.$queryRaw<Array<{ id: string; analysisDeadlineAt: Date }>>`
    SELECT "id", "analysisDeadlineAt" FROM "AmuxIdeaSubmission"
    WHERE "id" = ${choice.ideaId} AND "actorUserId" = ${actorUserId}
    FOR UPDATE
  `;
  if (locked.length !== 1) throw new AmuxSourceScopeApprovalError("not_found");
  const existing = await tx.amuxIdeaSourceScopeApproval.findUnique({
    where: { id: choice.approvalId }, select: { id: true },
  });
  if (existing) throw new AmuxSourceScopeApprovalError("approval_exists");
  let preview: Awaited<ReturnType<typeof previewAmuxSourceScopeInTransaction>>;
  try {
    preview = await previewAmuxSourceScopeInTransaction(tx, actorUserId,
      { schemaVersion: 1, ideaId: choice.ideaId,
        scopeJson: choice.canonicalScopeJson }, input.keys);
  } catch {
    throw new AmuxSourceScopeApprovalError("not_ready");
  }
  if (preview.canonicalScopeJson !== choice.canonicalScopeJson ||
      !sameDigest(preview.ideaDigest, choice.ideaDigest) ||
      !sameDigest(preview.scopeDigest, choice.scopeDigest) ||
      preview.scopeDigestKeyId !== choice.scopeDigestKeyId) {
    throw new AmuxSourceScopeApprovalError("preview_changed");
  }
  const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = nowRows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new AmuxSourceScopeApprovalError("integrity_unavailable");
  }
  const expiresAt = new Date(Math.min(now.getTime() + 15 * 60_000,
    locked[0].analysisDeadlineAt.getTime()));
  if (expiresAt <= now) throw new AmuxSourceScopeApprovalError("not_ready");
  const scopeBytes = Buffer.from(preview.canonicalScopeJson, "utf8");
  try {
    let sealed: ReturnType<typeof sealAmuxContent>;
    try {
      sealed = sealAmuxContent(scopeBytes, "source_scope", choice.approvalId, input.keys);
    } catch {
      throw new AmuxSourceScopeApprovalError("integrity_unavailable");
    }
    const auditId = await writeAdminAuditLog({ tx, session: input.session,
      request: input.request, action: "amux.v4.source_scope.approved",
      targetType: "AmuxIdeaSourceScopeApproval", targetId: choice.approvalId,
      summary: "Owner approved one exact GitHub collection scope; no files were read or transferred.",
      metadata: { ideaId: choice.ideaId, ideaDigest: choice.ideaDigest,
        previewScopeDigest: choice.scopeDigest,
        previewScopeDigestKeyId: choice.scopeDigestKeyId,
        scopeDigest: sealed.digest, scopeDigestKeyId: sealed.digestKeyId,
        fileCount: preview.fileCount, collectionVerified: false,
        transferAuthorized: false },
    });
    await tx.amuxIdeaSourceScopeApproval.create({ data: {
      id: choice.approvalId, ideaId: choice.ideaId, actorUserId,
      status: "approved", scopeCiphertext: Uint8Array.from(sealed.ciphertext),
      scopeKeyId: sealed.keyId, scopeKeyVersion: sealed.keyVersion,
      scopeDigest: sealed.digest, scopeDigestKeyId: sealed.digestKeyId,
      authorizationAuditLogId: auditId, approvedAt: now, expiresAt,
      scopePurgeAfter: new Date(expiresAt.getTime() + 24 * 60 * 60_000),
    } });
    return { approvalId: choice.approvalId, ideaId: choice.ideaId, expiresAt,
      ideaDigest: choice.ideaDigest, previewScopeDigest: choice.scopeDigest,
      previewScopeDigestKeyId: choice.scopeDigestKeyId,
      scopeDigest: sealed.digest, scopeDigestKeyId: sealed.digestKeyId, auditId };
  } finally { scopeBytes.fill(0); }
}

export async function approveAmuxSourceScope(session: Session, request: Request,
  choice: AmuxSourceScopeApprovalRequest) {
  ownerId(session);
  if (!sourceScopeApprovalWritePermitted(process.env[AMUX_V4_SOURCE_SCOPE_APPROVAL_WRITE_ENV])) {
    throw new AmuxSourceScopeApprovalError("approval_disabled");
  }
  if (adminAuditIntegrityKeys(process.env).length === 0) {
    throw new AmuxSourceScopeApprovalError("integrity_unavailable");
  }
  let keys: AmuxContentKeys;
  try {
    keys = loadCurrentAmuxContentKeys(process.env);
  } catch {
    throw new AmuxSourceScopeApprovalError("integrity_unavailable");
  }
  let callbackReturned = false;
  try {
    return await prisma.$transaction(async (tx) => {
      const result = await commitAmuxSourceScopeApproval(tx,
        { session, request, choice, keys });
      callbackReturned = true;
      return result;
    }, { maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxSourceScopeApprovalError) throw error;
    throw new AmuxSourceScopeApprovalError("outcome_unknown");
  }
}

/** Exact-ID, content-free read-back. An unknown result never authorizes a
 * second POST; the operator must inspect the audit and current DB row. */
export async function readAmuxSourceScopeApproval(session: Session, approvalId: string) {
  const actorUserId = ownerId(session);
  const row = await prisma.amuxIdeaSourceScopeApproval.findUnique({
    where: { id: approvalId },
  });
  if (!row || row.actorUserId !== actorUserId) return { state: "not_visible" } as const;
  const idea = await prisma.amuxIdeaSubmission.findFirst({
    where: { id: row.ideaId, actorUserId },
    select: { id: true, state: true, analysisDeadlineAt: true,
      rawDigest: true, rawPurgedAt: true },
  });
  if (!idea) return { state: "not_visible" } as const;
  const audit = await prisma.adminAuditLog.findUnique({
    where: { id: row.authorizationAuditLogId },
    select: { action: true, actorUserId: true, targetType: true,
      targetId: true, entryHash: true, metadata: true },
  });
  const metadata = audit?.metadata && typeof audit.metadata === "object" &&
    !Array.isArray(audit.metadata)
    ? audit.metadata as Record<string, unknown> : null;
  if (!audit?.entryHash || audit.action !== "amux.v4.source_scope.approved" ||
      audit.actorUserId !== actorUserId ||
      audit.targetType !== "AmuxIdeaSourceScopeApproval" ||
      audit.targetId !== row.id ||
      !metadata ||
      typeof metadata.ideaDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(metadata.ideaDigest) ||
      typeof metadata.previewScopeDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(metadata.previewScopeDigest) ||
      typeof metadata.previewScopeDigestKeyId !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(metadata.previewScopeDigestKeyId) ||
      metadata.ideaId !== row.ideaId ||
      metadata.scopeDigest !== row.scopeDigest ||
      metadata.scopeDigestKeyId !== row.scopeDigestKeyId ||
      metadata.collectionVerified !== false ||
      metadata.transferAuthorized !== false) {
    return { state: "unavailable" } as const;
  }
  const nowRows = await prisma.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = nowRows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    return { state: "unavailable" } as const;
  }
  if ((row.status === "approved" && now >= row.expiresAt) || row.status === "expired") {
    return { state: "expired", approvalId: row.id, ideaId: row.ideaId,
      ideaDigest: metadata.ideaDigest,
      previewScopeDigest: metadata.previewScopeDigest,
      previewScopeDigestKeyId: metadata.previewScopeDigestKeyId,
      expiresAt: row.expiresAt, collectionVerified: false,
      transferAuthorized: false } as const;
  }
  if (idea.state !== "submitted" || idea.rawPurgedAt !== null ||
      metadata.ideaDigest !== idea.rawDigest || now >= idea.analysisDeadlineAt) {
    return { state: "unavailable" } as const;
  }
  if (row.status !== "approved" || row.revokedAt !== null ||
      row.consumedAt !== null || row.scopePurgedAt !== null) {
    return { state: "unavailable" } as const;
  }
  return { state: "approved", approvalId: row.id, ideaId: row.ideaId,
    ideaDigest: metadata.ideaDigest, previewScopeDigest: metadata.previewScopeDigest,
    previewScopeDigestKeyId: metadata.previewScopeDigestKeyId,
    expiresAt: row.expiresAt, scopeDigest: row.scopeDigest,
    scopeDigestKeyId: row.scopeDigestKeyId, collectionVerified: false,
    transferAuthorized: false } as const;
}
