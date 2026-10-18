import "server-only";

import { prisma } from "@/lib/prisma";
import { buildAmuxSessionAnalysisQueueWhere } from
  "./ideaSessionAnalysisQueueWhereCore.ts";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** Read one intake pin only while its exact reservation is still eligible for
 * the content-free queue. The worker can preflight a checkout before claiming
 * a budget, without accepting a caller-supplied SHA as authority. */
export async function readAmuxSessionReferencePin(input: {
  reservationId: string; ideaId: string; referenceOrdinal: number;
}): Promise<{ referenceCount: number; pinnedCommitSha: string | null } | null> {
  if (!Number.isSafeInteger(input.referenceOrdinal) ||
      input.referenceOrdinal < 0 || input.referenceOrdinal > 2_147_483_647) return null;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT set_config('statement_timeout', '2000', true) AS statement_limit,
             set_config('idle_in_transaction_session_timeout', '3000', true) AS idle_limit
    `;
    const clock = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
    `;
    const now = clock[0]?.now;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("AMUX session pin clock unavailable");
    }
    const latestScope = await tx.amuxIdeaOperatingScopeSetting.findFirst({
      orderBy: { version: "desc" }, select: { id: true },
    });
    if (!latestScope) return null;
    const reservation = await tx.amuxIdeaSessionAnalysisReservation.findFirst({
      where: { ...buildAmuxSessionAnalysisQueueWhere(now, null),
        id: input.reservationId, ideaId: input.ideaId,
        operatingScopeSettingId: latestScope.id },
      select: { idea: { select: { submissionAuditLogId: true } } },
    });
    if (!reservation?.idea.submissionAuditLogId) return null;
    const audit = await tx.adminAuditLog.findUnique({
      where: { id: reservation.idea.submissionAuditLogId },
      select: { action: true, targetType: true, targetId: true,
        entryHash: true, metadata: true },
    });
    const metadata = audit?.metadata;
    if (!audit?.entryHash || audit.action !== "amux.idea.session_submitted" ||
        audit.targetType !== "AmuxIdeaSubmission" ||
        audit.targetId !== input.ideaId ||
        !metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return null;
    }
    const values = metadata as Record<string, unknown>;
    const pins = values.pinnedCommitShas;
    const repositoryCount = values.repositoryCount;
    const pullRequestCount = values.pullRequestCount;
    if (!Array.isArray(pins) ||
        !Number.isSafeInteger(repositoryCount) || (repositoryCount as number) < 0 ||
        !Number.isSafeInteger(pullRequestCount) || (pullRequestCount as number) < 0 ||
        pins.length !== (repositoryCount as number) + (pullRequestCount as number) ||
        !pins.every((sha) => typeof sha === "string" && SHA.test(sha)) ||
        (pins.length === 0 ? input.referenceOrdinal !== 0 :
          input.referenceOrdinal >= pins.length)) return null;
    return { referenceCount: pins.length,
      pinnedCommitSha: pins.length === 0 ? null : pins[input.referenceOrdinal] as string };
  }, { maxWait: 2_000, timeout: 5_000 });
}
