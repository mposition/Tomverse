import "server-only";

import type { Session } from "next-auth";
import type { Prisma } from "@prisma/client";
import { getTrustedClientIp } from "@/lib/clientIp";
import { prisma } from "@/lib/prisma";
import {
  adminAuditIntegrityKeys,
  computeAdminAuditEntryHash,
} from "@/lib/adminAuditIntegrityCore";

type AuditFields = {
  request?: Request;
  action: string;
  targetType: string;
  targetId?: string | null;
  summary: string;
  metadata?: Prisma.InputJsonValue | null;

  /**
   * Writes the entry inside a transaction the caller already owns.
   *
   * The advisory lock is transaction-scoped, so callers must keep the
   * transaction short and perform no external I/O while holding it.
   */
  tx?: Prisma.TransactionClient;
};

type AuditInput = AuditFields & {
  session: Session;
};

type SystemAuditInput = AuditFields;

type AuditIdentity = {
  actorUserId: string | null;
  actorEmail: string | null;
};

const safeSummary = (value: string) =>
  value.trim().slice(0, 500);

const writeAuditEntry = async ({
  actorUserId,
  actorEmail,
  request,
  action,
  targetType,
  targetId,
  summary,
  metadata,
  tx,
}: AuditFields & AuditIdentity): Promise<string> => {
  const normalizedTargetId = targetId || null;
  const normalizedSummary = safeSummary(summary);
  const ipAddress = request
    ? getTrustedClientIp(request)
    : null;
  const userAgent =
    request?.headers.get("user-agent")?.slice(0, 500) || null;

  /*
   * Only the first configured key signs new entries. Historical keys exist
   * solely so older spans can still be verified.
   */
  const integritySecret =
    adminAuditIntegrityKeys(process.env)[0];

  const write = async (
    client: Prisma.TransactionClient,
  ) => {
    await client.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext('tomverse-admin-audit-chain')
      )
    `;

    const timestampRows =
      await client.$queryRaw<Array<{ createdAt: Date }>>`
        SELECT clock_timestamp() AS "createdAt"
      `;

    const createdAt =
      timestampRows[0]?.createdAt || new Date();

    const previous = integritySecret
      ? await client.adminAuditLog.findFirst({
          where: {
            entryHash: {
              not: null,
            },
          },
          orderBy: [
            { createdAt: "desc" },
            { id: "desc" },
          ],
          select: {
            entryHash: true,
          },
        })
      : null;

    const previousHash =
      previous?.entryHash || null;

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
            metadata: metadata ?? null,
            ipAddress,
            userAgent,
            createdAt: createdAt.toISOString(),
          },
          integritySecret,
        )
      : null;

    const created =
      await client.adminAuditLog.create({
        select: {
          id: true,
        },
        data: {
          actorUserId,
          actorEmail,
          action,
          targetType,
          targetId: normalizedTargetId,
          summary: normalizedSummary,
          metadata: metadata ?? undefined,
          ipAddress,
          userAgent,
          previousHash,
          entryHash,
          createdAt,
        },
      });

    return created.id;
  };

  if (tx) {
    return write(tx);
  }

  return prisma.$transaction(write);
};

/**
 * Human/admin action. Attribution comes only from the authenticated session.
 */
export async function writeAdminAuditLog({
  session,
  ...input
}: AuditInput): Promise<string> {
  return writeAuditEntry({
    ...input,
    actorUserId: session.user?.id || null,
    actorEmail: session.user?.email || null,
  });
}

/**
 * Server-owned automation action.
 *
 * actorUserId/actorEmail deliberately remain null rather than inventing a
 * human identity. The action and bounded metadata identify the automation.
 */
export async function writeSystemAdminAuditLog(
  input: SystemAuditInput,
): Promise<string> {
  return writeAuditEntry({
    ...input,
    actorUserId: null,
    actorEmail: null,
  });
}
