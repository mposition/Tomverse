import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { AMUX_HOLD_MAX_MS, holdTimeWindow } from "./ideaRetentionCore.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const REASONS = ["legal_request", "dispute", "incident", "other"] as const;
type ReasonCode = typeof REASONS[number];

export class AmuxIdeaRetentionHoldError extends Error {
  constructor(readonly code: "forbidden" | "not_found" | "invalid_hold" |
    "already_held" | "nothing_to_hold" | "not_releasable" |
    "integrity_unavailable") {
    super(code);
    this.name = "AmuxIdeaRetentionHoldError";
  }
}

function owner(session: Session): string {
  const id = session.user?.id;
  if (!id || !isAdminSession(session) || getAdminRole(session) !== "owner") {
    throw new AmuxIdeaRetentionHoldError("forbidden");
  }
  return id;
}

async function dbNow(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  if (!(rows[0]?.now instanceof Date) || !Number.isFinite(rows[0].now.getTime())) {
    throw new AmuxIdeaRetentionHoldError("integrity_unavailable");
  }
  return rows[0].now;
}

async function armAndLockIdea(tx: Prisma.TransactionClient, ideaId: string) {
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaSubmission" WHERE "id" = ${ideaId} FOR UPDATE
  `;
  if (rows.length !== 1) throw new AmuxIdeaRetentionHoldError("not_found");
}

/** A hold affects only body units not already purged. The returned counts
 * make that limit explicit to the owner before the final confirmation. */
export async function readAmuxIdeaRetentionHoldScope(
  tx: Prisma.TransactionClient, ideaId: string,
): Promise<{ remainingBodies: number; alreadyPurgedBodies: number }> {
  const idea = await tx.amuxIdeaSubmission.findUnique({ where: { id: ideaId },
    select: { rawCiphertext: true, rawPurgedAt: true } });
  if (!idea) throw new AmuxIdeaRetentionHoldError("not_found");
  const [previewRemaining, previewPurged, chunkRemaining, chunkPurged,
    draftRemaining, draftPurged] = await Promise.all([
    tx.amuxIdeaTransferPreview.count({ where: { ideaId,
      payloadCiphertext: { not: null } } }),
    tx.amuxIdeaTransferPreview.count({ where: { ideaId,
      payloadPurgedAt: { not: null } } }),
    tx.amuxIdeaAnalysisChunk.count({ where: { ideaId,
      freeformCiphertext: { not: null } } }),
    tx.amuxIdeaAnalysisChunk.count({ where: { ideaId,
      freeformPurgedAt: { not: null } } }),
    tx.amuxIdeaDraftUnit.count({ where: { ideaId,
      bodyCiphertext: { not: null } } }),
    tx.amuxIdeaDraftUnit.count({ where: { ideaId,
      bodyPurgedAt: { not: null } } }),
  ]);
  return { remainingBodies: Number(idea.rawCiphertext !== null) +
      previewRemaining + chunkRemaining + draftRemaining,
    alreadyPurgedBodies: Number(idea.rawPurgedAt !== null) +
      previewPurged + chunkPurged + draftPurged };
}

export async function commitAmuxIdeaRetentionHold(tx: Prisma.TransactionClient,
  input: { session: Session; request: Request; id: string; ideaId: string;
    reasonCode: ReasonCode; days: number; expectedRemainingBodies: number;
    expectedAlreadyPurgedBodies: number; replacesHoldId?: string },
): Promise<{ holdId: string; expiresAt: string; noticeAt: string;
  auditId: string }> {
  const actorUserId = owner(input.session);
  await assertRecentAdminAuthentication(input.session);
  if (!UUID.test(input.id) || !UUID.test(input.ideaId) ||
      (input.replacesHoldId !== undefined &&
        (!UUID.test(input.replacesHoldId) || input.replacesHoldId === input.id)) ||
      !REASONS.includes(input.reasonCode) ||
      !Number.isSafeInteger(input.days) || input.days < 1 || input.days > 90 ||
      !Number.isSafeInteger(input.expectedRemainingBodies) ||
      input.expectedRemainingBodies < 1 ||
      !Number.isSafeInteger(input.expectedAlreadyPurgedBodies) ||
      input.expectedAlreadyPurgedBodies < 0) {
    throw new AmuxIdeaRetentionHoldError("invalid_hold");
  }
  await armAndLockIdea(tx, input.ideaId);
  const now = await dbNow(tx);
  const active = await tx.amuxIdeaRetentionHold.findFirst({
    where: { ideaId: input.ideaId, releasedAt: null,
      expiresAt: { gt: now } }, select: { id: true, expiresAt: true,
        approvalAuditLogId: true },
  });
  if ((active && active.id !== input.replacesHoldId) ||
      (!active && input.replacesHoldId !== undefined)) {
    throw new AmuxIdeaRetentionHoldError("already_held");
  }
  const scope = await readAmuxIdeaRetentionHoldScope(tx, input.ideaId);
  if (scope.remainingBodies === 0) {
    throw new AmuxIdeaRetentionHoldError("nothing_to_hold");
  }
  if (scope.remainingBodies !== input.expectedRemainingBodies ||
      scope.alreadyPurgedBodies !== input.expectedAlreadyPurgedBodies) {
    throw new AmuxIdeaRetentionHoldError("invalid_hold");
  }
  const expiresAt = new Date(now.getTime() + input.days * 24 * 60 * 60_000);
  if (expiresAt.getTime() - now.getTime() > AMUX_HOLD_MAX_MS) {
    throw new AmuxIdeaRetentionHoldError("invalid_hold");
  }
  const window = holdTimeWindow({ createdAt: now, expiresAt });
  if (!window.valid || !window.notifyAt) {
    throw new AmuxIdeaRetentionHoldError("invalid_hold");
  }
  if (active) {
    await tx.$queryRaw`
      SELECT "id" FROM "AmuxIdeaRetentionHold"
      WHERE "id" = ${active.id} AND "ideaId" = ${input.ideaId}
      FOR UPDATE
    `;
    const releaseAuditId = await writeAdminAuditLog({ tx,
      session: input.session, request: input.request,
      action: "amux.v4.retention_hold.renewed_previous_released",
      targetType: "AmuxIdeaRetentionHold", targetId: active.id,
      summary: "Owner atomically replaced an AMUX retention hold before expiry.",
      metadata: { ideaId: input.ideaId, replacementHoldId: input.id,
        originalExpiresAt: active.expiresAt.toISOString(),
        approvalAuditLogId: active.approvalAuditLogId },
    });
    const changed = await tx.amuxIdeaRetentionHold.updateMany({
      where: { id: active.id, ideaId: input.ideaId, releasedAt: null,
        expiresAt: { gt: now } },
      data: { releasedAt: now, releaseAuditLogId: releaseAuditId },
    });
    if (changed.count !== 1) {
      throw new AmuxIdeaRetentionHoldError("integrity_unavailable");
    }
  }
  const auditId = await writeAdminAuditLog({ tx, session: input.session,
    request: input.request, action: "amux.v4.retention_hold.approved",
    targetType: "AmuxIdeaRetentionHold", targetId: input.id,
    summary: "Owner approved a bounded hold of remaining AMUX idea content.",
    metadata: { ideaId: input.ideaId, reasonCode: input.reasonCode,
      scope: "remaining_idea_content", ...scope,
      expiresAt: expiresAt.toISOString(), days: input.days,
      replacesHoldId: input.replacesHoldId ?? null },
  });
  const saved = await tx.amuxIdeaRetentionHold.create({ data: { id: input.id,
    ideaId: input.ideaId, actorUserId, reasonCode: input.reasonCode,
    expiresAt, noticeAt: window.notifyAt,
    approvalAuditLogId: auditId },
    select: { expiresAt: true, noticeAt: true } });
  return { holdId: input.id, expiresAt: saved.expiresAt.toISOString(),
    noticeAt: saved.noticeAt.toISOString(), auditId };
}

export async function commitAmuxIdeaRetentionHoldRelease(
  tx: Prisma.TransactionClient,
  input: { session: Session; request: Request; holdId: string; ideaId: string },
): Promise<{ holdId: string; releasedAt: string; auditId: string }> {
  owner(input.session);
  await assertRecentAdminAuthentication(input.session);
  if (!UUID.test(input.holdId) || !UUID.test(input.ideaId)) {
    throw new AmuxIdeaRetentionHoldError("invalid_hold");
  }
  await armAndLockIdea(tx, input.ideaId);
  await tx.$queryRaw`
    SELECT "id" FROM "AmuxIdeaRetentionHold" WHERE "id" = ${input.holdId}
      AND "ideaId" = ${input.ideaId} FOR UPDATE
  `;
  const hold = await tx.amuxIdeaRetentionHold.findUnique({
    where: { id: input.holdId },
  });
  if (!hold || hold.ideaId !== input.ideaId || hold.releasedAt !== null) {
    throw new AmuxIdeaRetentionHoldError("not_releasable");
  }
  const now = await dbNow(tx);
  const auditId = await writeAdminAuditLog({ tx, session: input.session,
    request: input.request, action: "amux.v4.retention_hold.released",
    targetType: "AmuxIdeaRetentionHold", targetId: hold.id,
    summary: "Owner released an AMUX idea retention hold; original purge clocks remain.",
    metadata: { ideaId: input.ideaId, approvalAuditLogId: hold.approvalAuditLogId,
      expiresAt: hold.expiresAt.toISOString() },
  });
  const changed = await tx.amuxIdeaRetentionHold.updateMany({
    where: { id: hold.id, ideaId: input.ideaId, releasedAt: null },
    data: { releasedAt: now, releaseAuditLogId: auditId },
  });
  if (changed.count !== 1) {
    throw new AmuxIdeaRetentionHoldError("integrity_unavailable");
  }
  return { holdId: hold.id, releasedAt: now.toISOString(), auditId };
}
