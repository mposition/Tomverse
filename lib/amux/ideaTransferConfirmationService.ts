import "server-only";

import { timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { prisma } from "@/lib/prisma";
import { matchesIdeaTransferBrowserDigest } from "./ideaTransferBrowserCore.ts";
import { type AmuxContentKeys, openAmuxContent,
  verifyAmuxContentDigest } from "./ideaCrypto.ts";
import { loadAmuxContentKeyRing } from "./ideaKeyStore.ts";
import { type IdeaTransferConfirmationRequest,
  AMUX_V4_TRANSFER_CONFIRM_WRITE_ENV,
  transferConfirmWritePermitted } from "./ideaTransferConfirmationCore.ts";

export class IdeaTransferConfirmationError extends Error {
  constructor(readonly code: "not_found" | "not_ready" | "expired" |
    "digest_changed" | "browser_mismatch" | "integrity_unavailable" |
    "confirmation_disabled" | "outcome_unknown") {
    super(code);
    this.name = "IdeaTransferConfirmationError";
  }
}

function ownerId(session: Session): string {
  const id = session.user?.id;
  if (!id || !isAdminSession(session) || getAdminRole(session) !== "owner") {
    throw new IdeaTransferConfirmationError("not_found");
  }
  return id;
}

const sameDigest = (left: string, right: string) =>
  /^[a-f0-9]{64}$/.test(left) && /^[a-f0-9]{64}$/.test(right) &&
  timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));

/** A single owner decision, not a model call or permission for the browser to
 * send anything. The future local Agent must separately claim this receipt. */
export async function commitIdeaTransferConfirmation(tx: Prisma.TransactionClient, input: {
  session: Session; request: Request; choice: IdeaTransferConfirmationRequest;
  browserNonce: string; keys: AmuxContentKeys;
}): Promise<{ previewId: string; ideaId: string; payloadDigest: string;
  payloadDigestKeyId: string; confirmExpiresAt: Date; auditId: string }> {
  const actorUserId = ownerId(input.session);
  const { choice } = input;
  await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
  await takeAuditChainLock(tx);
  const owned = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaSubmission"
    WHERE "id" = ${choice.ideaId} AND "actorUserId" = ${actorUserId}
    FOR UPDATE
  `;
  if (owned.length !== 1) throw new IdeaTransferConfirmationError("not_found");
  const identity = await tx.amuxIdeaTransferPreview.findUnique({
    where: { id: choice.previewId }, select: { ideaId: true, chunkIndex: true },
  });
  if (!identity || identity.ideaId !== choice.ideaId) {
    throw new IdeaTransferConfirmationError("not_found");
  }
  const chunkLock = await tx.$queryRaw<Array<{ chunkIndex: number }>>`
    SELECT "chunkIndex" FROM "AmuxIdeaAnalysisChunk"
    WHERE "ideaId" = ${choice.ideaId} AND "actorUserId" = ${actorUserId}
      AND "chunkIndex" = ${identity.chunkIndex} FOR UPDATE
  `;
  if (chunkLock.length !== 1) throw new IdeaTransferConfirmationError("not_ready");
  const previewLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaTransferPreview"
    WHERE "id" = ${choice.previewId} AND "ideaId" = ${choice.ideaId}
    FOR UPDATE
  `;
  if (previewLock.length !== 1) throw new IdeaTransferConfirmationError("not_found");
  const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = nowRows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new IdeaTransferConfirmationError("integrity_unavailable");
  }
  const [idea, chunk, row] = await Promise.all([
    tx.amuxIdeaSubmission.findUnique({ where: { id: choice.ideaId } }),
    tx.amuxIdeaAnalysisChunk.findUnique({
      where: { ideaId_chunkIndex: { ideaId: choice.ideaId,
        chunkIndex: identity.chunkIndex } },
    }),
    tx.amuxIdeaTransferPreview.findUnique({ where: { id: choice.previewId } }),
  ]);
  if (!idea || !chunk || !row || idea.actorUserId !== actorUserId ||
      row.ideaId !== idea.id || row.sourceScopeApprovalId !== null ||
      !row.sourcePlanRevisionId || !row.payloadCiphertext || !row.payloadKeyId ||
      !row.payloadKeyVersion || row.payloadPurgedAt !== null ||
      idea.state !== (identity.chunkIndex === 0 ? "submitted" : "analyzing") ||
      now >= idea.analysisDeadlineAt ||
      idea.currentSourcePlanRevisionId !== row.sourcePlanRevisionId ||
      chunk.actorUserId !== actorUserId || chunk.state !== "awaiting_preview" ||
      chunk.currentPreviewId !== row.id || chunk.attempt !== row.attempt ||
      chunk.chunkIndex !== row.chunkIndex ||
      chunk.sourcePlanRevisionId !== row.sourcePlanRevisionId ||
      row.state !== "prepared" || row.confirmedAt !== null ||
      row.consumedAt !== null) {
    throw new IdeaTransferConfirmationError("not_ready");
  }
  if (now >= row.expiresAt) throw new IdeaTransferConfirmationError("expired");
  if (!sameDigest(choice.payloadDigest, row.payloadDigest) ||
      choice.payloadDigestKeyId !== row.payloadDigestKeyId) {
    throw new IdeaTransferConfirmationError("digest_changed");
  }
  const plan = await tx.amuxIdeaSourcePlanRevision.findUnique({
    where: { id: row.sourcePlanRevisionId },
  });
  if (!plan || plan.ideaId !== idea.id || plan.actorUserId !== actorUserId ||
      plan.state !== "active" || plan.sourceUnitCount !== 1 ||
      row.sourceUnitOrdinal !== 0) {
    throw new IdeaTransferConfirmationError("not_ready");
  }
  const audit = await tx.adminAuditLog.findFirst({
    where: { action: "amux.v4.transfer_preview.prepared",
      targetType: "AmuxIdeaTransferPreview", targetId: row.id, actorUserId },
    select: { entryHash: true, metadata: true },
  });
  const metadata = audit?.metadata;
  if (!audit?.entryHash || !metadata || typeof metadata !== "object" ||
      Array.isArray(metadata) ||
      (metadata as Record<string, unknown>).payloadDigest !== row.payloadDigest ||
      (metadata as Record<string, unknown>).payloadDigestKeyId !== row.payloadDigestKeyId ||
      (metadata as Record<string, unknown>).sourcePlanRevisionId !== row.sourcePlanRevisionId) {
    throw new IdeaTransferConfirmationError("integrity_unavailable");
  }
  const browserBindingDigest = (metadata as Record<string, unknown>).browserBindingDigest;
  if (typeof browserBindingDigest !== "string" ||
      !matchesIdeaTransferBrowserDigest(browserBindingDigest, {
        previewId: row.id, nonce: input.browserNonce,
        authenticatedAt: input.session.user?.authenticatedAt, key: input.keys,
      })) {
    throw new IdeaTransferConfirmationError("browser_mismatch");
  }
  let raw: Buffer;
  try {
    raw = openAmuxContent({ ciphertext: Buffer.from(row.payloadCiphertext),
      keyId: row.payloadKeyId, keyVersion: row.payloadKeyVersion },
    "transfer_payload", row.id, input.keys);
  } catch { throw new IdeaTransferConfirmationError("integrity_unavailable"); }
  try {
    if (!verifyAmuxContentDigest(raw, "transfer_payload", row.id,
      row.payloadDigest, row.payloadDigestKeyId, input.keys)) {
      throw new IdeaTransferConfirmationError("integrity_unavailable");
    }
    let payload: unknown;
    try { payload = JSON.parse(raw.toString("utf8")); } catch {
      throw new IdeaTransferConfirmationError("integrity_unavailable");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new IdeaTransferConfirmationError("integrity_unavailable");
    }
    const parsed = payload as Record<string, unknown>;
    const selection = parsed.selection;
    if (parsed.version !== (row.chunkIndex === 0 ? 1 : 2) ||
        (row.chunkIndex > 0 && parsed.chunkIndex !== row.chunkIndex) ||
        parsed.previewId !== row.id ||
        parsed.ideaId !== row.ideaId || parsed.templateVersion !== row.templateVersion ||
        typeof parsed.prompt !== "string" ||
        !parsed.prompt.includes(`"previewId":"${row.id}"`) ||
        !selection || typeof selection !== "object" || Array.isArray(selection) ||
        (selection as Record<string, unknown>).modelId !== row.modelId) {
      throw new IdeaTransferConfirmationError("integrity_unavailable");
    }
  } finally { raw.fill(0); }

  const auditId = await writeAdminAuditLog({ tx, session: input.session,
    request: input.request, action: "amux.v4.transfer_preview.confirmed",
    targetType: "AmuxIdeaTransferPreview", targetId: row.id,
    summary: "Owner confirmed one exact AMUX v4 idea-only model input; no model was called.",
    metadata: { ideaId: idea.id, chunkIndex: row.chunkIndex,
      sourcePlanRevisionId: row.sourcePlanRevisionId,
      payloadDigest: row.payloadDigest, payloadDigestKeyId: row.payloadDigestKeyId,
      modelId: row.modelId, modelCallStarted: false },
  });
  const updated = await tx.amuxIdeaTransferPreview.updateMany({
    where: { id: row.id, ideaId: idea.id, state: "prepared", confirmedAt: null,
      consumedAt: null, payloadDigest: row.payloadDigest,
      payloadDigestKeyId: row.payloadDigestKeyId, expiresAt: { gt: now } },
    data: { state: "confirmed", confirmedAt: now,
      confirmExpiresAt: row.expiresAt, confirmedByUserId: actorUserId,
      confirmationAuditLogId: auditId },
  });
  if (updated.count !== 1) throw new IdeaTransferConfirmationError("not_ready");
  return { previewId: row.id, ideaId: idea.id,
    payloadDigest: row.payloadDigest, payloadDigestKeyId: row.payloadDigestKeyId,
    confirmExpiresAt: row.expiresAt, auditId };
}

export async function confirmIdeaTransferPreview(session: Session, request: Request,
  choice: IdeaTransferConfirmationRequest, browserNonce: string) {
  const actorUserId = ownerId(session);
  if (!transferConfirmWritePermitted(process.env[AMUX_V4_TRANSFER_CONFIRM_WRITE_ENV])) {
    throw new IdeaTransferConfirmationError("confirmation_disabled");
  }
  if (adminAuditIntegrityKeys(process.env).length === 0) {
    throw new IdeaTransferConfirmationError("integrity_unavailable");
  }
  const owned = await prisma.amuxIdeaSubmission.findFirst({
    where: { id: choice.ideaId, actorUserId }, select: { id: true },
  });
  if (!owned) throw new IdeaTransferConfirmationError("not_found");
  let keys: AmuxContentKeys;
  try {
    keys = await loadAmuxContentKeyRing([{ ideaId: choice.ideaId,
      purpose: "transfer_payload", subjectId: choice.previewId }]);
  } catch { throw new IdeaTransferConfirmationError("integrity_unavailable"); }
  let callbackReturned = false;
  try {
    return await prisma.$transaction(async (tx) => {
      const result = await commitIdeaTransferConfirmation(tx,
        { session, request, choice, browserNonce, keys });
      callbackReturned = true;
      return result;
    }, { maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    if (!callbackReturned && error instanceof IdeaTransferConfirmationError) throw error;
    throw new IdeaTransferConfirmationError("outcome_unknown");
  }
}

/** Exact-ID read-back reports a committed human decision, never permission to
 * retry an ambiguous POST or to send the payload from the browser. */
export async function readIdeaTransferConfirmation(session: Session, previewId: string) {
  const actorUserId = ownerId(session);
  const row = await prisma.amuxIdeaTransferPreview.findUnique({ where: { id: previewId } });
  if (!row) return { state: "not_visible", modelCallStarted: false } as const;
  const idea = await prisma.amuxIdeaSubmission.findFirst({
    where: { id: row.ideaId, actorUserId }, select: { id: true },
  });
  if (!idea) return { state: "not_visible", modelCallStarted: false } as const;
  const nowRows = await prisma.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  if (!(nowRows[0]?.now instanceof Date)) {
    return { state: "unavailable", modelCallStarted: false } as const;
  }
  if (row.state === "prepared" && !row.confirmationAuditLogId) {
    return { state: nowRows[0].now >= row.expiresAt ? "expired" : "not_confirmed",
      modelCallStarted: false } as const;
  }
  if (row.state !== "confirmed" || !row.confirmedAt || !row.confirmExpiresAt ||
      row.confirmedByUserId !== actorUserId || !row.confirmationAuditLogId ||
      row.consumedAt !== null) {
    return { state: "unavailable", modelCallStarted: false } as const;
  }
  const audit = await prisma.adminAuditLog.findUnique({
    where: { id: row.confirmationAuditLogId },
    select: { action: true, actorUserId: true, targetType: true,
      targetId: true, entryHash: true, metadata: true },
  });
  if (!audit?.entryHash || audit.action !== "amux.v4.transfer_preview.confirmed" ||
      audit.actorUserId !== actorUserId ||
      audit.targetType !== "AmuxIdeaTransferPreview" || audit.targetId !== row.id ||
      !audit.metadata || typeof audit.metadata !== "object" ||
      Array.isArray(audit.metadata) ||
      (audit.metadata as Record<string, unknown>).payloadDigest !== row.payloadDigest ||
      (audit.metadata as Record<string, unknown>).payloadDigestKeyId !== row.payloadDigestKeyId ||
      (audit.metadata as Record<string, unknown>).modelCallStarted !== false) {
    return { state: "unavailable", modelCallStarted: false } as const;
  }
  if (nowRows[0].now >= row.confirmExpiresAt) {
    return { state: "expired", modelCallStarted: false } as const;
  }
  return { state: "confirmed", previewId: row.id, ideaId: row.ideaId,
    payloadDigest: row.payloadDigest, payloadDigestKeyId: row.payloadDigestKeyId,
    confirmExpiresAt: row.confirmExpiresAt, modelCallStarted: false } as const;
}
