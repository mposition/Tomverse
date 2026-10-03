import "server-only";

import { randomUUID } from "node:crypto";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import {
  type QaReleaseIssueRefusal,
  judgeQaReleaseInstructionIssue,
} from "@/lib/qaReleaseMergeLaneInstructionCore";

/**
 * The only writer of QaReleaseMergeAttempt and QaReleaseMergeLaneLatch
 * (docs/policy/qa-release-agent.md version 4, sections 3, 8 and 10;
 * scripts/check-protected-table-writers-core.mjs names this file).
 *
 * Every write is a service-called transaction bound by the statement and idle
 * limits and a last-statement deadline check on the database clock, so a
 * round past its deadline is never recorded as a success (section 3).
 */

export const QA_RELEASE_MERGE_ATTEMPT_ISSUED_ACTION = "qa_release.merge_attempt_issued";

/**
 * Instruction issue (policy section 10): nine statements -- the limits, the
 * audit chain lock, the lane read, the four of the audit append, the attempt
 * insert and the deadline check -- so 3A + 5 = 32 s, Prisma five more.
 */
export const QA_RELEASE_ISSUE_LIMITS = Object.freeze({
  statementMs: 2_000,
  idleMs: 1_000,
  statements: 9,
  transactionMs: (3 * 9 + 5) * 1_000,
  prismaMs: (3 * 9 + 5) * 1_000 + 5_000,
});
const ISSUE = QA_RELEASE_ISSUE_LIMITS;

/** Carries a late answer out of the transaction it rolls back. */
export class QaReleaseMergeLaneLate extends Error {
  constructor() {
    super("qa_release_merge_lane_deadline_passed");
    this.name = "QaReleaseMergeLaneLate";
  }
}

/**
 * The round's remaining budget, measured by the caller: the deadline is the
 * database's time in the lane read plus what is left of the budget after
 * that read returned, so app and database clocks never meet.
 */
export type QaReleaseRoundBudget = { startedAt: number; budgetMs: number; clock: () => number };

export type QaReleaseIssueResult =
  | { issued: true; attemptId: string; controlRevision: number; expiresAt: Date }
  | { issued: false; reason: QaReleaseIssueRefusal };

type LaneRead = {
  dbNowMs: bigint;
  revision: number | null;
  developLaneOn: boolean | null;
  latched: boolean | null;
  attemptOpen: boolean;
};

/**
 * Issues an instruction for one develop pull request: opens the lane's
 * attempt after the app's own judgement of the newest operator control
 * revision, the develop lane switch, the latch and the open attempt
 * (lib/qaReleaseMergeLaneInstructionCore.ts). A refusal writes nothing.
 */
export async function issueQaReleaseMergeInstruction(input: {
  callerRevision: number | null;
  pullRequest: { number: number; headSha: string };
  budget: QaReleaseRoundBudget;
}): Promise<QaReleaseIssueResult> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT
        set_config('statement_timeout', ${String(ISSUE.statementMs)}, true),
        set_config('idle_in_transaction_session_timeout', ${String(ISSUE.idleMs)}, true),
        CASE WHEN current_setting('server_version_num')::int >= 170000
          THEN set_config('transaction_timeout', ${String(ISSUE.transactionMs)}, true)
        END`;
      // Under the statement limit, and before the read: it serializes every
      // audit writer, so two rounds cannot both read the lane as free.
      await takeAuditChainLock(tx);
      // One statement for every fact the judgement needs, one snapshot.
      const [read] = await tx.$queryRaw<LaneRead[]>`SELECT
          floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "dbNowMs",
          c."revision",
          c."developLaneOn",
          (SELECT l."latched" FROM "QaReleaseMergeLaneLatch" l ORDER BY l."sequence" DESC LIMIT 1) AS "latched",
          EXISTS (
            SELECT 1 FROM "QaReleaseMergeAttempt" a WHERE a."state" IN ('issued', 'consumed', 'awaiting_deploy')
          ) AS "attemptOpen"
        FROM (SELECT 1) one
        LEFT JOIN LATERAL (
          SELECT "revision", "developLaneOn" FROM "QaReleaseOperatorControl" ORDER BY "revision" DESC LIMIT 1
        ) c ON true`;
      const deadline = new Date(Number(read.dbNowMs) + input.budget.budgetMs - (input.budget.clock() - input.budget.startedAt));

      const judgement = judgeQaReleaseInstructionIssue({
        control: read.revision === null || read.developLaneOn === null ? null : { revision: read.revision, developLaneOn: read.developLaneOn },
        callerRevision: input.callerRevision,
        // No latch event yet is not latched.
        latched: read.latched === null ? false : read.latched,
        attemptOpen: read.attemptOpen,
        pullRequest: { ...input.pullRequest, base: "develop" },
      });
      if (!judgement.issue) return { issued: false as const, reason: judgement.reason };

      const attemptId = randomUUID();
      const auditLogId = await writeSystemAuditLog({
        tx,
        systemActor: "qa-release-merge-lane",
        action: QA_RELEASE_MERGE_ATTEMPT_ISSUED_ACTION,
        targetType: "QaReleaseMergeAttempt",
        targetId: attemptId,
        summary: `Issued a merge instruction for pull request #${input.pullRequest.number}.`,
        metadata: {
          pullRequestNumber: input.pullRequest.number,
          headSha: input.pullRequest.headSha,
          controlRevision: judgement.revision,
        },
      });
      const [inserted] = await tx.$queryRaw<{ expiresAt: Date }[]>`INSERT INTO "QaReleaseMergeAttempt"
          ("id", "pullRequestNumber", "headSha", "base", "controlRevision", "state", "lastAuditLogId")
        VALUES (${attemptId}, ${input.pullRequest.number}, ${input.pullRequest.headSha}, 'develop',
                ${judgement.revision}, 'issued', ${auditLogId})
        RETURNING "expiresAt"`;
      // The last statement: a late round is not recorded (section 3).
      const [clock] = await tx.$queryRaw<{ late: boolean }[]>`SELECT clock_timestamp() >= ${deadline}::timestamptz AS late`;
      if (clock?.late !== false) throw new QaReleaseMergeLaneLate();
      return { issued: true as const, attemptId, controlRevision: judgement.revision, expiresAt: inserted.expiresAt };
    },
    { maxWait: 5_000, timeout: ISSUE.prismaMs },
  );
}
