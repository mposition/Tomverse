import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_V4_IDEA_SYSTEM_ACTOR,
  AMUX_V4_RETENTION_HOLD_NOTICE_ACTION,
  AMUX_V4_RETENTION_HOLD_NOTICE_TARGET } from
  "@/lib/adminAuditSystemActors";
import { prisma } from "@/lib/prisma";

const BATCH_SIZE = 8;

export class AmuxRetentionHoldNoticeError extends Error {
  constructor(readonly code: "integrity_unavailable" | "outcome_unknown",
    readonly holdId?: string) {
    super(code);
    this.name = "AmuxRetentionHoldNoticeError";
  }
}

export async function commitDueAmuxRetentionHoldNotice(tx: Prisma.TransactionClient,
  holdId: string): Promise<"sent" | "skipped"> {
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const found = await tx.amuxIdeaRetentionHold.findUnique({ where: { id: holdId },
    select: { ideaId: true } });
  if (!found) return "skipped";
  await tx.$queryRaw`
    SELECT "id" FROM "AmuxIdeaSubmission" WHERE "id" = ${found.ideaId}
      FOR UPDATE
  `;
  await tx.$queryRaw`
    SELECT "id" FROM "AmuxIdeaRetentionHold" WHERE "id" = ${holdId}
      AND "ideaId" = ${found.ideaId} FOR UPDATE
  `;
  const row = await tx.amuxIdeaRetentionHold.findUnique({ where: { id: holdId } });
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = clock[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new AmuxRetentionHoldNoticeError("integrity_unavailable", holdId);
  }
  if (!row || row.ideaId !== found.ideaId || row.releasedAt !== null ||
      row.noticeSentAt !== null || now < row.noticeAt) return "skipped";
  const expired = now >= row.expiresAt;
  const notice = await tx.adminNotificationLog.create({ data: {
    channel: "in_app", status: "sent",
    title: expired ? "AMUX retention hold expired" :
      "AMUX retention hold expiring",
    detail: expired ? "An owner-approved hold expired; overdue content is due for cleanup." :
      "An owner-approved hold needs review before its expiry.",
    targetType: "AmuxIdeaRetentionHold", targetId: holdId,
  }, select: { id: true } });
  const auditId = await writeSystemAuditLog({ tx,
    systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
    action: AMUX_V4_RETENTION_HOLD_NOTICE_ACTION,
    targetType: AMUX_V4_RETENTION_HOLD_NOTICE_TARGET,
    targetId: holdId,
    summary: "Placed a content-free AMUX retention hold expiry notice in Admin.",
    metadata: { ideaId: row.ideaId, notificationId: notice.id,
      noticeAt: row.noticeAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(), expired },
  });
  const changed = await tx.amuxIdeaRetentionHold.updateMany({
    where: { id: holdId, ideaId: row.ideaId, releasedAt: null,
      noticeSentAt: null, noticeAt: { lte: now } },
    data: { noticeSentAt: now, noticeAuditLogId: auditId },
  });
  if (changed.count !== 1 || !auditId) {
    throw new AmuxRetentionHoldNoticeError("integrity_unavailable", holdId);
  }
  return "sent";
}

export async function notifyDueAmuxRetentionHolds() {
  const clock = await prisma.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = clock[0]?.now;
  if (!(now instanceof Date)) {
    throw new AmuxRetentionHoldNoticeError("integrity_unavailable");
  }
  const due = await prisma.amuxIdeaRetentionHold.findMany({
    where: { releasedAt: null, noticeSentAt: null,
      noticeAt: { lte: now } },
    orderBy: [{ noticeAt: "asc" }, { id: "asc" }],
    take: BATCH_SIZE, select: { id: true },
  });
  let sent = 0;
  for (const row of due) {
    try {
      const result = await prisma.$transaction((tx) =>
        commitDueAmuxRetentionHoldNotice(tx, row.id),
      { maxWait: 3_000, timeout: 12_000 });
      if (result === "sent") sent += 1;
    } catch {
      // A lost COMMIT may have created both notification and audit. Inspect
      // this exact hold before considering another tick; never blind retry.
      const readBack = await prisma.amuxIdeaRetentionHold.findUnique({
        where: { id: row.id }, select: { noticeSentAt: true,
          noticeAuditLogId: true },
      }).catch(() => null);
      if (readBack?.noticeSentAt && readBack.noticeAuditLogId) {
        sent += 1;
        continue;
      }
      throw new AmuxRetentionHoldNoticeError("outcome_unknown", row.id);
    }
  }
  return { sent, scanned: due.length, batchLimit: BATCH_SIZE };
}
