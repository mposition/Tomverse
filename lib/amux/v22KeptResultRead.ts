import { Prisma } from "@prisma/client";

/**
 * The reads behind a kept v22 result (lib/amux/v22KeptResultCore.ts): which
 * Tasks hold one, and which of them may be published now. Reads only, so the
 * Decision Maker's owner settlement can leave such a Task out with the same
 * definition the publication round uses.
 */

/**
 * The card `w`'s review attempt, joined as `ra`: its newest attempt that ended
 * `succeeded` into `review` (amuxV22ReviewAttempt), or nulls when it has none.
 * The publication round, the Decision Maker's owner settlement and the review
 * pull request's binding all read the same one.
 */
export const amuxV22ReviewAttemptLateralSql = Prisma.sql`LEFT JOIN LATERAL (
      SELECT x."id", x."endedAt" FROM "AmuxExecutionAttempt" x
      WHERE x."taskId" = w."id" AND x."outcome" = 'succeeded' AND x."toStatus" = 'review'
        AND x."v22AssignmentId" IS NOT NULL AND x."endedAt" IS NOT NULL
      ORDER BY x."attemptNumber" DESC NULLS LAST, x."startedAt" DESC, x."id" DESC LIMIT 1
    ) ra ON true`;

/**
 * Given `ra` (amuxV22ReviewAttemptLateralSql), the card `w` holds a kept
 * result: its review attempt stored a patch whose body is still there, and no
 * engineering run was ever opened for that attempt -- publication never had
 * its chance. A person who sent that result back (an escalation resolved as
 * retry or block after it ended, by anyone but the system) rejected it, and
 * it is not kept; a system resolver's -- the Decision Maker's owner
 * settlement (`system:amux-dm-owner-settlement`) included -- is not a
 * rejection: running a reviewed result again for want of a pull request was
 * the misrouted step this definition ends (AMUX-IMGOUT-003). It reuses `ra`
 * rather than finding the attempt again: the owner settlement's scan runs
 * under AMUX's statement timeout, planning included.
 */
export const amuxV22KeptResultExistsSql = Prisma.sql`(ra."id" IS NOT NULL
    AND EXISTS (SELECT 1 FROM "AmuxV22TaskPatch" kp
      WHERE kp."attemptId" = ra."id" AND kp."taskId" = w."id" AND kp."bodyPurgedAt" IS NULL)
    AND NOT EXISTS (SELECT 1 FROM "EngineeringAgentRun" kr WHERE kr."amuxAttemptId" = ra."id")
    AND NOT EXISTS (SELECT 1 FROM "AmuxHumanEscalation" ke
      WHERE ke."taskId" = w."id" AND ke."resolutionOutcome" IN ('retry', 'block')
        AND ke."resolvedAt" >= ra."endedAt"
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
 * first, leaving out `skipTaskIds` (the ones a recent round found waiting, so
 * the oldest never hold the rest back); with `taskId`, that Task only (read
 * again under its row lock). A Task qualifies while it waits for a person --
 * in review, or blocked once its budget is spent -- with nothing of it
 * running or queued, no owner question of a later run waiting, and no
 * publication of any of its runs still under way: an open pull request
 * binding, or a publish, draft, decision or mismatch item not yet settled.
 */
export async function readAmuxV22KeptResultCandidates(
  tx: Prisma.TransactionClient, limit: number, taskId: string | null = null, skipTaskIds: readonly string[] = [],
): Promise<AmuxV22KeptResultCandidate[]> {
  return tx.$queryRaw<AmuxV22KeptResultCandidate[]>`
    SELECT w."id" AS "taskId", w."status" AS "taskStatus", ra."id" AS "attemptId", p."baseSha",
      w."kind" AS "cardKind"
    FROM "AmuxWorkItem" w
    ${amuxV22ReviewAttemptLateralSql}
    JOIN "AmuxV22TaskPatch" p ON p."attemptId" = ra."id" AND p."taskId" = w."id"
    WHERE w."sourceSystem" = 'admin-idea-v4' AND w."cardType" = 'task' AND w."archivedAt" IS NULL
      AND (${taskId}::text IS NULL OR w."id" = ${taskId})
      AND NOT (w."id" = ANY(${[...skipTaskIds]}::text[]))
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
    ORDER BY ra."endedAt", w."id"
    LIMIT ${limit}`;
}
