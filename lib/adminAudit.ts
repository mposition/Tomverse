import "server-only";

import type { Session } from "next-auth";
import type { Prisma } from "@prisma/client";
import { getTrustedClientIp } from "@/lib/clientIp";
import { prisma } from "@/lib/prisma";
import {
  adminAuditIntegrityKeys,
  computeAdminAuditEntryHash,
} from "@/lib/adminAuditIntegrityCore";

type AuditInput = {
  session: Session;
  request?: Request;
  action: string;
  targetType: string;
  targetId?: string | null;
  summary: string;
  metadata?: Prisma.InputJsonValue | null;
  /**
   * Writes the entry inside a transaction the caller already owns, instead of
   * opening one here.
   *
   * Use this when the audit row has to commit or roll back with the change it
   * describes. A separate transaction means an action can succeed with no
   * record of who took it -- which is exactly the failure the refund decision
   * path had.
   *
   * Two constraints come with it. The chain's advisory lock is transaction
   * scoped, so it is held until the *caller's* transaction ends: only pass a
   * transaction that is short and does no external I/O, or audit writes across
   * the process will queue behind it. And a caller that rolls back after this
   * returns silently discards the entry, which is the point -- the action is
   * discarded too.
   */
  tx?: Prisma.TransactionClient;
};

const safeSummary = (value: string) => value.trim().slice(0, 500);

export async function writeAdminAuditLog({
  session,
  request,
  action,
  targetType,
  targetId,
  summary,
  metadata,
  tx,
}: AuditInput) {
  const actorUserId = session.user?.id || null;
  const actorEmail = session.user?.email || null;
  const normalizedTargetId = targetId || null;
  const normalizedSummary = safeSummary(summary);
  const ipAddress = request ? getTrustedClientIp(request) : null;
  const userAgent = request?.headers.get("user-agent")?.slice(0, 500) || null;
  // The first key, never a historical one: `ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS`
  // exists so old entries can still be *verified*, and signing a new entry with
  // a retired key would put fresh rows in a span that is on its way out.
  const integritySecret = adminAuditIntegrityKeys(process.env)[0];

  const write = async (client: Prisma.TransactionClient) => {
    await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('tomverse-admin-audit-chain'))`;
    const timestampRows = await client.$queryRaw<Array<{ createdAt: Date }>>`
      SELECT clock_timestamp() AS "createdAt"
    `;
    const createdAt = timestampRows[0]?.createdAt || new Date();
    const previous = integritySecret
      ? await client.adminAuditLog.findFirst({
          where: { entryHash: { not: null } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { entryHash: true },
        })
      : null;
    const previousHash = previous?.entryHash || null;
    const entryHash = integritySecret
      ? computeAdminAuditEntryHash(
          {
            previousHash,
            actorUserId,
            actorEmail,
            action,
            targetType,
            targetId: normalizedTargetId,
            summary: normalizedSummary,
            metadata: metadata || null,
            ipAddress,
            userAgent,
            createdAt: createdAt.toISOString(),
          },
          integritySecret
        )
      : null;
    await client.adminAuditLog.create({
      data: {
        actorUserId,
        actorEmail,
        action,
        targetType,
        targetId: normalizedTargetId,
        summary: normalizedSummary,
        metadata: metadata || undefined,
        ipAddress,
        userAgent,
        previousHash,
        entryHash,
        createdAt,
      },
    });
  };

  if (tx) {
    await write(tx);
    return;
  }
  await prisma.$transaction(write);
}
