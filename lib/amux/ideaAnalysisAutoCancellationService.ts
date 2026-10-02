import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import {
  AMUX_V4_IDEA_AUTO_CANCEL_ACTION,
  AMUX_V4_IDEA_AUTO_CANCEL_TARGET,
  AMUX_V4_IDEA_SYSTEM_ACTOR,
} from "@/lib/adminAuditSystemActors";

const ID = /^[A-Za-z0-9:_-]{1,128}$/;
const UNFINISHED_STATES = ["submitted", "collecting", "awaiting_preview", "analyzing"];

export class AmuxIdeaAutoCancellationError extends Error {
  constructor(readonly code: "not_found" | "not_due" | "integrity_unavailable") {
    super(code);
    this.name = "AmuxIdeaAutoCancellationError";
  }
}

/** Dark transaction body for the approved seven-day retention tick. It
 * terminates analysis eligibility but neither erases the idea nor releases
 * an in-flight/unknown budget hold. Child attempts retain their evidence;
 * any status projection must give this parent cancellation precedence over
 * non-terminal child states. A caller must not blindly retry an
 * uncertain COMMIT; the idea and audit row require a read-back first. */
export async function commitAmuxOverdueIdeaAnalysisCancellation(
  tx: Prisma.TransactionClient, ideaId: string,
): Promise<{ ideaId: string; cancelledAt: string; auditId: string }> {
  if (!ID.test(ideaId)) throw new AmuxIdeaAutoCancellationError("not_found");
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaSubmission" WHERE "id" = ${ideaId} FOR UPDATE
  `;
  if (locked.length !== 1) throw new AmuxIdeaAutoCancellationError("not_found");
  const idea = await tx.amuxIdeaSubmission.findUnique({ where: { id: ideaId } });
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = clock[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !idea ||
      !(idea.analysisDeadlineAt instanceof Date) ||
      !(idea.rawPurgeAfter instanceof Date) ||
      idea.rawPurgeAfter > idea.analysisDeadlineAt) {
    throw new AmuxIdeaAutoCancellationError("integrity_unavailable");
  }
  if (now < idea.analysisDeadlineAt || idea.analysisCompletedAt !== null ||
      idea.cancelledAt !== null || !UNFINISHED_STATES.includes(idea.state)) {
    throw new AmuxIdeaAutoCancellationError("not_due");
  }
  const auditId = await writeSystemAuditLog({
    tx, systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
    action: AMUX_V4_IDEA_AUTO_CANCEL_ACTION,
    targetType: AMUX_V4_IDEA_AUTO_CANCEL_TARGET,
    targetId: ideaId,
    summary: "Stopped an unfinished AMUX v4 idea analysis at its seven-day deadline.",
    metadata: { submittedAt: idea.submittedAt.toISOString(),
      analysisDeadlineAt: idea.analysisDeadlineAt.toISOString(),
      rawPurgeAfter: idea.rawPurgeAfter.toISOString() },
  });
  const updated = await tx.amuxIdeaSubmission.updateMany({
    where: { id: ideaId, state: { in: UNFINISHED_STATES },
      analysisCompletedAt: null, cancelledAt: null,
      analysisDeadlineAt: { lte: now } },
    data: { state: "cancelled", cancelledAt: now },
  });
  if (updated.count !== 1) {
    throw new AmuxIdeaAutoCancellationError("integrity_unavailable");
  }
  return { ideaId, cancelledAt: now.toISOString(), auditId };
}
