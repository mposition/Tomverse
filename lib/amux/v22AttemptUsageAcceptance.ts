import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { prisma } from "@/lib/prisma";

import { BoardImportError } from "./boardImportCore.ts";

/**
 * Owner decision 2026-11-10: the owner may accept that one ended v22 attempt's
 * CLI usage stays unknown, and an owner-approved retry of a Task (recovery
 * approval, one-click pre-approval, review retry) accepts every earlier
 * unknown attempt of that Task. An accepted attempt no longer holds its worker
 * in lib/amux/v22WorkerUsageGate.ts. Nothing about its cost changes: the
 * reserved cap, settled cost, costConfirmed flag and usage rows stay as they
 * are, so an unknown cost is never read as zero.
 *
 * The row is bound in the database to the same-transaction audit that names
 * the attempt (migration 20261110100000_amux_v22_attempt_usage_acceptance).
 */
export const AMUX_V22_USAGE_ACCEPTED_ACTION = "amux.v22.attempt_usage.unknown_accepted";

export type AmuxV22UsageAcceptanceSource = "owner_accept" | "recovery_approval" | "review_retry";

/** The ended attempts of a v4 Task whose CLI usage is absent or partial and
 * not yet accepted: the same unknown-usage rule the worker gate applies. */
export async function amuxV22TaskUnknownUsageAttemptIds(tx: Prisma.TransactionClient,
  taskId: string): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT a."id" FROM "AmuxExecutionAttempt" a
    JOIN "AmuxWorkItem" w ON w."id" = a."taskId"
    WHERE a."taskId" = ${taskId}
      AND a."endedAt" IS NOT NULL
      AND w."sourceSystem" = 'admin-idea-v4'
      AND (NOT EXISTS (SELECT 1 FROM "AmuxCliUsageEvent" u
           WHERE u."attemptId" = a."id")
        OR EXISTS (SELECT 1 FROM "AmuxCliUsageEvent" u
           WHERE u."attemptId" = a."id"
             AND u."completeness" <> 'reported_complete'))
      AND NOT EXISTS (SELECT 1 FROM "AmuxV22AttemptUsageAcceptance" x
        WHERE x."attemptId" = a."id")
    ORDER BY a."startedAt" ASC, a."id" ASC`;
  return rows.map((row) => row.id);
}

/** Records the acceptances an audit written in this transaction names. */
export async function recordAmuxV22UsageAcceptances(tx: Prisma.TransactionClient, input: {
  taskId: string; attemptIds: readonly string[]; source: AmuxV22UsageAcceptanceSource;
  acceptedByUserId: string; auditLogId: string; now: Date;
}) {
  if (!input.attemptIds.length) return;
  await tx.amuxV22AttemptUsageAcceptance.createMany({ data: input.attemptIds.map((attemptId) => ({
    id: randomUUID(), attemptId, taskId: input.taskId, source: input.source,
    acceptedByUserId: input.acceptedByUserId,
    authorizationAuditLogId: input.auditLogId, acceptedAt: input.now })) });
}

async function requireOwner(session: Session) {
  if (!session.user?.id || !isAdminSession(session) || getAdminRole(session) !== "owner")
    throw new BoardImportError("forbidden", 403);
  await assertRecentAdminAuthentication(session);
  return session.user.id;
}

/** The owner's re-authenticated, audited acceptance of one attempt. */
export async function acceptAmuxV22AttemptUnknownUsage(input: {
  session: Session; request: Request; taskId: string; attemptId: string;
}) {
  const ownerId = await requireOwner(input.session);
  return prisma.$transaction(async (tx) => {
    // The Task lock serializes this with a recovery approval or review retry
    // that would accept the same attempt.
    await tx.$queryRaw`SELECT "id" FROM "AmuxWorkItem" WHERE "id" = ${input.taskId} FOR UPDATE`;
    const task = await tx.amuxWorkItem.findUnique({ where: { id: input.taskId },
      select: { id: true, sourceSystem: true } });
    if (!task || task.sourceSystem !== "admin-idea-v4")
      throw new BoardImportError("task_unavailable", 409);
    const existing = await tx.amuxV22AttemptUsageAcceptance.findUnique({
      where: { attemptId: input.attemptId }, select: { taskId: true, source: true, acceptedAt: true } });
    if (existing) {
      if (existing.taskId !== task.id) throw new BoardImportError("attempt_unavailable", 409);
      return { attemptId: input.attemptId, accepted: true, alreadyAccepted: true,
        source: existing.source, acceptedAt: existing.acceptedAt.toISOString() };
    }
    const unknown = await amuxV22TaskUnknownUsageAttemptIds(tx, task.id);
    if (!unknown.includes(input.attemptId))
      throw new BoardImportError("usage_not_unknown", 409);
    const attempt = await tx.amuxExecutionAttempt.findUniqueOrThrow({ where: { id: input.attemptId },
      select: { worker: true, outcome: true, reason: true, reservedCostMicrousd: true,
        settledCostMicrousd: true, costConfirmed: true,
        cliUsageEvents: { select: { completeness: true } } } });
    const now = (await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS "now"`)[0].now;
    const auditLogId = await writeAdminAuditLog({ tx, session: input.session, request: input.request,
      action: AMUX_V22_USAGE_ACCEPTED_ACTION, targetType: "AmuxExecutionAttempt",
      targetId: input.attemptId,
      summary: "Accepted that one ended v22 attempt's CLI usage stays unknown; its reserved cap and cost are unchanged.",
      metadata: { taskId: task.id, attemptId: input.attemptId, worker: attempt.worker,
        outcome: attempt.outcome, reason: attempt.reason,
        reservedCostMicrousd: attempt.reservedCostMicrousd.toString(),
        settledCostMicrousd: attempt.settledCostMicrousd?.toString() ?? null,
        costConfirmed: attempt.costConfirmed,
        usageCompleteness: attempt.cliUsageEvents.map((event) => event.completeness),
        costChanged: false } });
    await recordAmuxV22UsageAcceptances(tx, { taskId: task.id, attemptIds: [input.attemptId],
      source: "owner_accept", acceptedByUserId: ownerId, auditLogId, now });
    return { attemptId: input.attemptId, accepted: true, alreadyAccepted: false,
      source: "owner_accept", acceptedAt: now.toISOString() };
  }, { timeout: 10_000 });
}
