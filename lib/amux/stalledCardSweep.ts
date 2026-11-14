import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/amux/auditContract";
import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { openAmuxHumanEscalation } from "@/lib/amux/escalation";
import { AMUX_MAX_EXECUTION_ATTEMPTS } from "@/lib/amux/executionBudgetCore";

/**
 * One definition of a stopped card (owner decision 2026-11-14, AMUX process
 * audit bundle 2, AMUXFLOW/B2). The owner queue and the Decision Maker's
 * owner settlement read a v22 Task that is blocked or in review with an open
 * escalation. Two kinds of card could never get there and sat on no screen:
 *
 * - a `todo` Task whose attempt budget is spent: every claim's start refuses
 *   it (AMUX-GENFILE-002 was assigned 172 times, then sat 162 h unseen);
 * - a `backlog` Task behind a dependency that was archived without being
 *   done: it can never become ready (13 of 35 backlog Tasks on 2026-11-14).
 *
 * This sweep moves each to `blocked` with an open escalation, so it joins the
 * same queue and the same Decision Maker path as every other stopped card,
 * where retry, done, close or remake settles it. It only moves a card's state
 * the way settlement already does; it deletes nothing and runs nothing. Off
 * unless TOMVERSE_AMUX_STALLED_CARD_SWEEP=enabled.
 */
export const AMUX_STALLED_CARD_SWEEP_ENV = "TOMVERSE_AMUX_STALLED_CARD_SWEEP";
export const amuxStalledCardSweepEnabled = (
  value: string | undefined = process.env[AMUX_STALLED_CARD_SWEEP_ENV],
) => value?.trim() === "enabled";

export const AMUX_STALLED_BUDGET_REASON = "attempt_budget_exhausted";
export const AMUX_STALLED_DEPENDENCY_REASON = "dependency_closed";
export const AMUX_STALLED_CARD_SWEPT_ACTION = "amux.v22.stalled_card.blocked";
const SWEEPER = "system:amux-stalled-card-sweep";

export type AmuxStalledCardCandidate = {
  id: string;
  reason: typeof AMUX_STALLED_BUDGET_REASON | typeof AMUX_STALLED_DEPENDENCY_REASON;
};

/** The cards a sweep moves, oldest first, at most `limit`; with `taskId`, that card only. A read. */
export async function readAmuxStalledCards(
  tx: { $queryRaw: <T>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T> },
  limit: number, taskId: string | null = null,
): Promise<AmuxStalledCardCandidate[]> {
  return tx.$queryRaw<AmuxStalledCardCandidate[]>`
    SELECT w."id", CASE WHEN w."status" = 'todo' THEN ${AMUX_STALLED_BUDGET_REASON}
      ELSE ${AMUX_STALLED_DEPENDENCY_REASON} END AS "reason"
    FROM "AmuxWorkItem" w
    WHERE w."sourceSystem" = 'admin-idea-v4' AND w."cardType" = 'task'
      AND (${taskId}::text IS NULL OR w."id" = ${taskId})
      AND w."archivedAt" IS NULL AND w."v22AssignmentId" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "AmuxHumanEscalation" e
        WHERE e."taskId" = w."id" AND e."status" IN ('open', 'acknowledged'))
      AND ((w."status" = 'todo'
          AND (SELECT GREATEST(COUNT(*), COALESCE(MAX(a."attemptNumber"), 0))
            FROM "AmuxExecutionAttempt" a WHERE a."taskId" = w."id")
            >= ${AMUX_MAX_EXECUTION_ATTEMPTS})
        OR (w."status" = 'backlog' AND EXISTS (
          SELECT 1 FROM "AmuxWorkDependency" d
          JOIN "AmuxWorkItem" dep ON dep."id" = d."dependencyId"
          WHERE d."taskId" = w."id" AND dep."archivedAt" IS NOT NULL
            AND dep."status" <> 'done')))
    ORDER BY w."updatedAt", w."id"
    LIMIT ${limit}`;
}

/**
 * Moves up to `limit` stopped cards to the owner queue, each in its own
 * transaction so one card never holds the rest. Returns the ids it moved.
 */
export async function sweepAmuxStalledCards(limit = 5): Promise<string[]> {
  if (!amuxStalledCardSweepEnabled()) return [];
  const candidates = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.executionRecoveryRead,
    (tx) => readAmuxStalledCards(tx, Math.min(Math.max(limit, 1), 20)));
  const moved: string[] = [];
  for (const candidate of candidates) {
    try {
      const done = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.executionRecoveryWrite,
        async (tx) => {
          await takeAuditChainLock(tx);
          // Read again under the row lock: the card may have moved since.
          await tx.$queryRaw`SELECT "id" FROM "AmuxWorkItem" WHERE "id" = ${candidate.id} FOR UPDATE`;
          const [again] = await readAmuxStalledCards(tx, 1, candidate.id);
          if (!again) return false;
          const task = await tx.amuxWorkItem.update({ where: { id: candidate.id },
            data: { status: "blocked", owner: null, claimedAt: null, revision: { increment: 1 } },
            select: { revision: true } });
          await openAmuxHumanEscalation(tx, { taskId: candidate.id,
            specialty: "execution-recovery", reason: again.reason, openedBy: SWEEPER });
          await writeSystemAuditLog({ tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
            action: AMUX_STALLED_CARD_SWEPT_ACTION,
            targetType: "AmuxWorkItem", targetId: candidate.id,
            summary: "Moved a stopped AMUX v22 Task to the owner queue.",
            metadata: { reason: again.reason, taskRevision: task.revision } });
          return true;
        });
      if (done) moved.push(candidate.id);
    } catch (error) {
      // One card's failure never stops the sweep of the others.
      console.error("amux stalled card sweep: one card was not moved",
        { taskId: candidate.id, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return moved;
}
