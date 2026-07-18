import "server-only";

import type { Session } from "next-auth";
import type { Prisma } from "@prisma/client";
import { getTrustedClientIp } from "@/lib/clientIp";
import { prisma } from "@/lib/prisma";
import { computeAdminAuditEntryHash } from "@/lib/adminAuditIntegrityCore";

type AuditInput = {
  session: Session;
  request?: Request;
  action: string;
  targetType: string;
  targetId?: string | null;
  summary: string;
  metadata?: Prisma.InputJsonValue | null;
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
}: AuditInput) {
  const actorUserId = session.user?.id || null;
    const actorEmail = session.user?.email || null;
    const normalizedTargetId = targetId || null;
    const normalizedSummary = safeSummary(summary);
    const ipAddress = request ? getTrustedClientIp(request) : null;
    const userAgent = request?.headers.get("user-agent")?.slice(0, 500) || null;
    const integritySecret =
      process.env.ADMIN_AUDIT_INTEGRITY_KEY || process.env.NEXTAUTH_SECRET;
  await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('tomverse-admin-audit-chain'))`;
      const timestampRows = await tx.$queryRaw<Array<{ createdAt: Date }>>`
        SELECT clock_timestamp() AS "createdAt"
      `;
      const createdAt = timestampRows[0]?.createdAt || new Date();
      const previous = integritySecret
        ? await tx.adminAuditLog.findFirst({
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
      await tx.adminAuditLog.create({ data: {
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
      } });
  });
}
