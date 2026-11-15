import { Prisma } from "@prisma/client";

/**
 * The reads behind a kept v22 result (lib/amux/v22KeptResultCore.ts): which
 * Tasks hold one, and which of them may be published now. Reads only, so the
 * Decision Maker's owner settlement can leave such a Task out with the same
 * definition the publication round uses.
 */

/**
 * The Task `w` holds a kept result: its newest attempt that ended
 * `succeeded` into `review` stored a patch whose body is still there, and no
 * engineering run was ever opened for that attempt -- publication never had
 * its chance. A person who sent that result back (an escalation resolved as
 * retry or block after it ended, by anyone but the system) rejected it, and
 * it is not kept; a system resolver's -- the Decision Maker's owner
 * settlement (`system:amux-dm-owner-settlement`) included -- is not a
 * rejection: running a reviewed result again for want of a pull request was
 * the misrouted step this definition ends (AMUX-IMGOUT-003).
 */
export const amuxV22KeptResultExistsSql = Prisma.sql`EXISTS (
  SELECT 1 FROM "AmuxExecutionAttempt" ka
  JOIN "AmuxV22TaskPatch" kp ON kp."attemptId" = ka."id" AND kp."taskId" = ka."taskId"
    AND kp."bodyPurgedAt" IS NULL
  WHERE ka."id" = (
      SELECT kx."id" FROM "AmuxExecutionAttempt" kx
      WHERE kx."taskId" = w."id" AND kx."outcome" = 'succeeded' AND kx."toStatus" = 'review'
        AND kx."v22AssignmentId" IS NOT NULL AND kx."endedAt" IS NOT NULL
      ORDER BY kx."attemptNumber" DESC NULLS LAST, kx."startedAt" DESC, kx."id" DESC LIMIT 1)
    AND NOT EXISTS (SELECT 1 FROM "EngineeringAgentRun" kr WHERE kr."amuxAttemptId" = ka."id")
    AND NOT EXISTS (SELECT 1 FROM "AmuxHumanEscalation" ke
      WHERE ke."taskId" = w."id" AND ke."resolutionOutcome" IN ('retry', 'block')
        AND ke."resolvedAt" >= ka."endedAt"
        AND ke."resolvedById" NOT LIKE 'system:%'))`;

export type AmuxV22KeptResultCandidate = {
  taskId: string;
  taskStatus: string;
  attemptId: string;
  baseSha: string;
  cardKind: string;
};

/**
 * Up to `limit` Tasks whose kept result could be published now, oldest result
 * first; with `taskId`, that Task only (read again under its row lock). A
 * Task qualifies while it waits for a person -- in review, or blocked once its
 * budget is spent -- with nothing of it running or queued, no owner question
 * of a later run waiting, and no publication of any of its runs still under
 * way: an open pull request binding, or a publish, draft, decision or
 * mismatch item not yet settled.
 */
export async function readAmuxV22KeptResultCandidates(
  tx: Prisma.TransactionClient, limit: number, taskId: string | null = null,
): Promise<AmuxV22KeptResultCandidate[]> {
  return tx.$queryRaw<AmuxV22KeptResultCandidate[]>`
    SELECT w."id" AS "taskId", w."status" AS "taskStatus", a."id" AS "attemptId", p."baseSha",
      w."kind" AS "cardKind"
    FROM "AmuxWorkItem" w
    JOIN LATERAL (
      SELECT x."id", x."endedAt" FROM "AmuxExecutionAttempt" x
      WHERE x."taskId" = w."id" AND x."outcome" = 'succeeded' AND x."toStatus" = 'review'
        AND x."v22AssignmentId" IS NOT NULL AND x."endedAt" IS NOT NULL
      ORDER BY x."attemptNumber" DESC NULLS LAST, x."startedAt" DESC, x."id" DESC LIMIT 1
    ) a ON true
    JOIN "AmuxV22TaskPatch" p ON p."attemptId" = a."id" AND p."taskId" = w."id"
    WHERE w."sourceSystem" = 'admin-idea-v4' AND w."cardType" = 'task' AND w."archivedAt" IS NULL
      AND (${taskId}::text IS NULL OR w."id" = ${taskId})
      AND w."status" IN ('review', 'blocked') AND w."owner" IS NULL AND w."v22AssignmentId" IS NULL
      AND ${amuxV22KeptResultExistsSql}
      AND NOT EXISTS (SELECT 1 FROM "AmuxExecutionAttempt" o
        WHERE o."taskId" = w."id" AND o."endedAt" IS NULL)
      AND NOT EXISTS (SELECT 1 FROM "AmuxWorkDelivery" d
        WHERE d."taskId" = w."id" AND d."status" IN ('queued', 'leased'))
      AND NOT EXISTS (SELECT 1 FROM "AmuxV22TaskQuestion" q
        WHERE q."taskId" = w."id" AND q."state" IN ('open', 'answered'))
      AND NOT EXISTS (SELECT 1 FROM "EngineeringAgentBinding" b
        JOIN "EngineeringAgentRun" r ON r."id" = b."runId"
        WHERE r."cardId" = w."id" AND b."state" = 'open' AND b."supersededAt" IS NULL)
      AND NOT EXISTS (SELECT 1 FROM "EngineeringAgentWorkItem" i
        JOIN "EngineeringAgentRun" r ON r."id" = i."runId"
        WHERE r."cardId" = w."id" AND (
          (i."kind" IN ('publish', 'expire_close', 'prune') AND
            i."state" IN ('queued', 'claimed', 'needs_lookup', 'outcome_unknown')) OR
          (i."kind" IN ('t2_draft', 'decision', 'state_mismatch') AND i."state" = 'open')))
    ORDER BY a."endedAt", w."id"
    LIMIT ${limit}`;
}
