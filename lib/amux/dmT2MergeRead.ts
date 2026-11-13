import "server-only";

import type { Prisma } from "@prisma/client";

/**
 * The reads of the Decision Maker's develop merge (owner decision 2026-11-13,
 * lib/amux/dmT2MergeCore.ts) that look at the engineering agent's and the
 * merge lane's tables. They live apart from every writer and only read: the
 * binding, run and lane attempt rows stay their own stores'
 * (scripts/check-protected-table-writers-core.mjs). Each function is one
 * statement.
 */

type Reader = Pick<Prisma.TransactionClient, "$queryRaw">;

export type AmuxDmT2MergeApprovalRow = {
  settlementId: string;
  taskId: string;
  attemptId: string;
  bindingId: string;
  prNumber: number;
  headRef: string;
  approvedHeadSha: string;
  approvedDiffDigest: string;
  decidedAt: Date;
};

/**
 * Decision Maker approvals of review pull requests that still hold, as the
 * settlement recorded them (an applied row is never undone when the Task
 * moves, so every condition is read again here): the binding is the open,
 * current one of the settled run, not merged, its verified head and diff
 * digest the approved ones, on an engineering agent branch; the Task is in
 * review, not archived, its newest run the settled one, nothing running. The
 * least recently visited first, so one that cannot move never hides the rest.
 * Narrowed to one settlement, or to some pull request numbers, when given.
 */
export async function readAmuxDmT2MergeApprovals(db: Reader, input: {
  limit: number; settlementId?: string | null; prNumbers?: readonly number[] | null;
}) {
  const settlementId = input.settlementId ?? null;
  const prNumbers = input.prNumbers ? [...input.prNumbers] : null;
  return db.$queryRaw<AmuxDmT2MergeApprovalRow[]>`
    SELECT s."id" AS "settlementId", s."taskId", s."attemptId", s."bindingId", b."prNumber",
      b."ref" AS "headRef", s."approvedHeadSha", s."approvedDiffDigest", s."decidedAt"
    FROM "AmuxDmOwnerSettlement" s
    JOIN "EngineeringAgentBinding" b ON b."id" = s."bindingId"
    JOIN "EngineeringAgentRun" r ON r."id" = b."runId"
    JOIN "AmuxWorkItem" w ON w."id" = s."taskId"
    WHERE s."kind" = 't2_pr' AND s."state" = 'applied' AND s."decision" = 'approve'
      AND (${settlementId}::text IS NULL OR s."id" = ${settlementId}::text)
      AND (${prNumbers}::int[] IS NULL OR b."prNumber" = ANY(${prNumbers}::int[]))
      AND b."state" = 'open' AND b."supersededAt" IS NULL AND b."mergeObservation" IS NULL
      AND b."currentPrNumber" = b."prNumber"
      AND b."verifiedHeadSha" = s."approvedHeadSha"
      AND b."snapshot"->>'diffDigest' = s."approvedDiffDigest"
      AND b."ref" ~ '^agent/engineering/[0-9]{1,20}$'
      AND r."cardId" = s."taskId" AND r."amuxAttemptId" = s."attemptId"
      AND w."status" = 'review' AND w."archivedAt" IS NULL
      AND w."sourceSystem" = 'admin-idea-v4' AND w."cardType" = 'task'
      AND (SELECT x."id" FROM "AmuxExecutionAttempt" x WHERE x."taskId" = w."id"
        ORDER BY x."taskRevision" DESC, x."startedAt" DESC, x."id" DESC LIMIT 1) = s."attemptId"
      AND NOT EXISTS (SELECT 1 FROM "AmuxExecutionAttempt" x
        WHERE x."taskId" = w."id" AND x."endedAt" IS NULL)
    ORDER BY s."updatedAt", s."id"
    LIMIT ${input.limit}`;
}

export type AmuxDmT2MergeObservedFacts = {
  settlementId: string;
  approvedHeadSha: string;
  approvedDiffDigest: string;
  decidedAt: Date;
  /** The merge lane's attempt for this pull request and head: it reported this merge commit, or one is still open. */
  laneMerge: "merged" | "pending" | null;
};

/**
 * For the approval observer, once a binding's pull request merged: the
 * Decision Maker's approval of it (on the settled run, as recorded), and what
 * the merge lane's own attempts for this pull request and head say of this
 * merge commit. Null when the Decision Maker never approved it.
 */
export async function readAmuxDmT2MergeObservedFacts(db: Reader, input: {
  bindingId: string; prNumber: number; headSha: string; mergeCommitSha: string;
}): Promise<AmuxDmT2MergeObservedFacts | null> {
  const rows = await db.$queryRaw<AmuxDmT2MergeObservedFacts[]>`
    SELECT s."id" AS "settlementId", s."approvedHeadSha", s."approvedDiffDigest", s."decidedAt",
      (SELECT CASE WHEN bool_or(a."mergeCommitSha" = ${input.mergeCommitSha}) THEN 'merged'
          WHEN bool_or(a."state" IN ('issued', 'consumed')) THEN 'pending' END
        FROM "QaReleaseMergeAttempt" a
        WHERE a."pullRequestNumber" = ${input.prNumber} AND a."headSha" = ${input.headSha}
          AND a."base" = 'develop') AS "laneMerge"
    FROM "AmuxDmOwnerSettlement" s
    JOIN "EngineeringAgentBinding" b ON b."id" = s."bindingId"
    JOIN "EngineeringAgentRun" r ON r."id" = b."runId"
    WHERE s."bindingId" = ${input.bindingId} AND s."kind" = 't2_pr' AND s."state" = 'applied'
      AND s."decision" = 'approve' AND r."cardId" = s."taskId" AND r."amuxAttemptId" = s."attemptId"
    ORDER BY s."decidedAt" DESC, s."id" DESC
    LIMIT 1`;
  return rows[0] ?? null;
}
