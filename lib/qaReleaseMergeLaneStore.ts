import "server-only";

import { randomUUID } from "node:crypto";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { NOTIFICATION_KIND, enqueueNotificationDeliveryOnce } from "@/lib/notificationDeliveries";
import { prisma } from "@/lib/prisma";
import {
  type QaReleaseConsumeRefusal,
  type QaReleaseIssueRefusal,
  judgeQaReleaseInstructionConsume,
  judgeQaReleaseInstructionIssue,
} from "@/lib/qaReleaseMergeLaneInstructionCore";
import type { QaReleaseMergeLaneLatchReason } from "@/lib/qaReleaseMergeLaneLatchCore";
import {
  type QaReleaseMergeReport,
  qaReleaseReportEffect,
  qaReleaseReportEffectUnderRevision,
} from "@/lib/qaReleaseMergeLaneReportCore";

/**
 * The merge lane service's writer of QaReleaseMergeAttempt and
 * QaReleaseMergeLaneLatch -- the other is a person's latch release,
 * lib/qaReleaseMergeLaneRelease.ts, kept apart so no module writes both a
 * system and an administrator audit row
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

export const QA_RELEASE_MERGE_ATTEMPT_CONSUMED_ACTION = "qa_release.merge_attempt_consumed";

/**
 * Instruction consume (policy section 10): nine statements -- the limits,
 * the audit chain lock, one read of the attempt (locked) with the newest
 * operator control revision, switch and latch event, the four of the audit
 * append, the conditional update and the deadline check -- so 3A + 5 = 32 s.
 */
export const QA_RELEASE_CONSUME_LIMITS = Object.freeze({
  statementMs: 2_000,
  idleMs: 1_000,
  statements: 9,
  transactionMs: (3 * 9 + 5) * 1_000,
  prismaMs: (3 * 9 + 5) * 1_000 + 5_000,
});
const CONSUME = QA_RELEASE_CONSUME_LIMITS;

export type QaReleaseConsumeResult = { consumed: true } | { consumed: false; reason: QaReleaseConsumeRefusal };

type ConsumeRead = {
  dbNowMs: bigint;
  revision: number | null;
  developLaneOn: boolean | null;
  latched: boolean | null;
  attemptId: string | null;
  pullRequestNumber: number | null;
  headSha: string | null;
  base: string | null;
  attemptRevision: number | null;
  expiresAtMs: bigint | null;
  state: string | null;
};

/**
 * Lets the service merge exactly what was issued, once (policy section 3,
 * step 2). The service sends what it re-read from GitHub; the app judges
 * only what it can read itself, and the conditional update succeeds for an
 * attempt still issued. The database refuses a consume past the expiry on
 * its own clock as well. A refusal writes nothing.
 */
export async function consumeQaReleaseMergeInstruction(input: {
  callerRevision: number | null;
  request: { attemptId: string; pullRequestNumber: number; headSha: string; base: string };
  budget: QaReleaseRoundBudget;
}): Promise<QaReleaseConsumeResult> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT
        set_config('statement_timeout', ${String(CONSUME.statementMs)}, true),
        set_config('idle_in_transaction_session_timeout', ${String(CONSUME.idleMs)}, true),
        CASE WHEN current_setting('server_version_num')::int >= 170000
          THEN set_config('transaction_timeout', ${String(CONSUME.transactionMs)}, true)
        END`;
      await takeAuditChainLock(tx);
      // One statement: the attempt, locked, and the lane facts beside it.
      const [read] = await tx.$queryRaw<ConsumeRead[]>`SELECT
          floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "dbNowMs",
          c."revision",
          c."developLaneOn",
          (SELECT l."latched" FROM "QaReleaseMergeLaneLatch" l ORDER BY l."sequence" DESC LIMIT 1) AS "latched",
          a."id" AS "attemptId",
          a."pullRequestNumber",
          a."headSha",
          a."base",
          a."controlRevision" AS "attemptRevision",
          floor(extract(epoch FROM a."expiresAt") * 1000)::bigint AS "expiresAtMs",
          a."state"
        FROM (SELECT 1) one
        LEFT JOIN LATERAL (
          SELECT "revision", "developLaneOn" FROM "QaReleaseOperatorControl" ORDER BY "revision" DESC LIMIT 1
        ) c ON true
        LEFT JOIN LATERAL (
          SELECT * FROM "QaReleaseMergeAttempt" WHERE "id" = ${input.request.attemptId} FOR UPDATE
        ) a ON true`;
      const deadline = new Date(Number(read.dbNowMs) + input.budget.budgetMs - (input.budget.clock() - input.budget.startedAt));

      const judgement = judgeQaReleaseInstructionConsume({
        instruction:
          read.attemptId === null
            ? null
            : {
                attemptId: read.attemptId,
                pullRequestNumber: read.pullRequestNumber ?? 0,
                headSha: read.headSha ?? "",
                base: read.base ?? "",
                revision: read.attemptRevision ?? -1,
                expiresAtMs: Number(read.expiresAtMs),
                // Anything past issued has been consumed (or moved on).
                consumed: read.state !== "issued",
              },
        request: input.request,
        control: read.revision === null || read.developLaneOn === null ? null : { revision: read.revision, developLaneOn: read.developLaneOn },
        callerRevision: input.callerRevision,
        latched: read.latched === null ? false : read.latched,
        dbNowMs: Number(read.dbNowMs),
      });
      if (!judgement.consume) return { consumed: false as const, reason: judgement.reason };

      const auditLogId = await writeSystemAuditLog({
        tx,
        systemActor: "qa-release-merge-lane",
        action: QA_RELEASE_MERGE_ATTEMPT_CONSUMED_ACTION,
        targetType: "QaReleaseMergeAttempt",
        targetId: input.request.attemptId,
        summary: `Let the merge lane merge pull request #${input.request.pullRequestNumber}.`,
        metadata: { pullRequestNumber: input.request.pullRequestNumber, headSha: input.request.headSha },
      });
      const changed = await tx.$executeRaw`UPDATE "QaReleaseMergeAttempt"
          SET "state" = 'consumed', "lastAuditLogId" = ${auditLogId}
        WHERE "id" = ${input.request.attemptId} AND "state" = 'issued'`;
      // Under the lock the row read issued, so anything else is not this
      // module's to explain: fail rather than report a consume that did not happen.
      if (changed !== 1) throw new Error("qa_release_merge_attempt_consume_lost");
      const [clock] = await tx.$queryRaw<{ late: boolean }[]>`SELECT clock_timestamp() >= ${deadline}::timestamptz AS late`;
      if (clock?.late !== false) throw new QaReleaseMergeLaneLate();
      return { consumed: true as const };
    },
    { maxWait: 5_000, timeout: CONSUME.prismaMs },
  );
}

export const QA_RELEASE_MERGE_ATTEMPT_REPORTED_ACTION = "qa_release.merge_attempt_reported";

/** No result report within this long of issue makes an attempt "unreported" (policy section 8 item 5). */
export const QA_RELEASE_UNREPORTED_AFTER_MS = 12 * 60 * 1000;

/**
 * Result report (policy section 10): at most ten statements -- the limits,
 * the audit chain lock, the four of the audit append, one statement that
 * reads the newest revision and the attempt and makes the conditional move,
 * the latch event, the latch alert's queue row and the deadline check -- so
 * 3A + 5 = 35 s, and the limits are always armed for ten.
 */
export const QA_RELEASE_REPORT_LIMITS = Object.freeze({
  statementMs: 2_000,
  idleMs: 1_000,
  statements: 10,
  transactionMs: (3 * 10 + 5) * 1_000,
  prismaMs: (3 * 10 + 5) * 1_000 + 5_000,
});
const REPORT = QA_RELEASE_REPORT_LIMITS;

export type QaReleaseReportRefusal = "attempt_unknown" | "state_moved" | "too_early";

export type QaReleaseReportResult =
  | { recorded: true; moved: boolean; latched: QaReleaseMergeLaneLatchReason | null; revisionMatched: boolean }
  | { recorded: false; reason: QaReleaseReportRefusal };

/** Carries a refusal out of the transaction it rolls back (the audit row goes with it). */
class ReportRefused extends Error {
  constructor(readonly reason: QaReleaseReportRefusal) {
    super(reason);
  }
}

type ReportRead = {
  dbNowMs: bigint;
  newestRevision: number | null;
  state: string | null;
  issuedAtMs: bigint | null;
  moved: number;
};

/**
 * Records a result report for one attempt (policy section 8 item 5): moves
 * the attempt only from a state the report is about, latches when the
 * report or a revision mismatch calls for it, queues the day's latch alert,
 * and is never refused for a revision mismatch (section 6) -- the report is
 * kept and latches instead. A report about a state the attempt is no longer
 * in, about an unknown attempt, or an "unreported" claim before twelve
 * minutes, records nothing.
 */
export async function reportQaReleaseMergeResult(input: {
  callerRevision: number | null;
  attemptId: string;
  report: QaReleaseMergeReport;
  budget: QaReleaseRoundBudget;
}): Promise<QaReleaseReportResult> {
  const own = qaReleaseReportEffect(input.report);
  // Whether the move is the one a revision mismatch withholds.
  const closesAsSuccess = own.move?.to === "closed" && own.move.outcome === "deployed";
  const unreportedInterval = `${QA_RELEASE_UNREPORTED_AFTER_MS} milliseconds`;
  // A deploy report records what the lane observed even when the attempt
  // stays where it is (a wait, or a success withheld for another revision).
  const observation = input.report.kind === "deploy" ? JSON.stringify(input.report.observation) : null;
  const writes = own.move !== null || observation !== null;
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT
          set_config('statement_timeout', ${String(REPORT.statementMs)}, true),
          set_config('idle_in_transaction_session_timeout', ${String(REPORT.idleMs)}, true),
          CASE WHEN current_setting('server_version_num')::int >= 170000
            THEN set_config('transaction_timeout', ${String(REPORT.transactionMs)}, true)
          END`;
        await takeAuditChainLock(tx);
        // One audit row for the attempt change and the latch event both:
        // the two tables' triggers accept a row targeting this attempt.
        const auditLogId = await writeSystemAuditLog({
          tx,
          systemActor: "qa-release-merge-lane",
          action: QA_RELEASE_MERGE_ATTEMPT_REPORTED_ACTION,
          targetType: "QaReleaseMergeAttempt",
          targetId: input.attemptId,
          summary: `Recorded a merge lane ${input.report.kind} report.`,
          metadata: { report: input.report, callerRevision: input.callerRevision },
        });
        // One statement: the newest revision, the attempt (locked) and the
        // conditional move, decided on what that same statement reads. A
        // success from another revision is withheld: the attempt stays and
        // only the observation is recorded.
        const [read] = await tx.$queryRaw<ReportRead[]>`WITH c AS (
            SELECT "revision" FROM "QaReleaseOperatorControl" ORDER BY "revision" DESC LIMIT 1
          ), cur AS (
            SELECT "id", "state", "issuedAt" FROM "QaReleaseMergeAttempt" WHERE "id" = ${input.attemptId} FOR UPDATE
          ), u AS (
            UPDATE "QaReleaseMergeAttempt" a
               SET "state" = CASE WHEN (${closesAsSuccess} AND (SELECT "revision" FROM c) IS DISTINCT FROM ${input.callerRevision}::int) THEN cur."state" ELSE ${own.move?.to ?? "awaiting_deploy"} END,
                   "outcome" = CASE WHEN (${closesAsSuccess} AND (SELECT "revision" FROM c) IS DISTINCT FROM ${input.callerRevision}::int) THEN NULL ELSE ${own.move?.outcome ?? null} END,
                   "mergeCommitSha" = coalesce(${own.move?.mergeCommitSha ?? null}, a."mergeCommitSha"),
                   "deployObservation" = coalesce(${observation}::jsonb, a."deployObservation"),
                   "lastAuditLogId" = ${auditLogId}
              FROM cur
             WHERE a."id" = cur."id"
               AND ${writes}
               AND cur."state" = ANY(${[...own.from]}::text[])
               AND (${input.report.kind !== "unreported"} OR cur."issuedAt" <= clock_timestamp() - ${unreportedInterval}::interval)
            RETURNING a."state"
          )
          SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "dbNowMs",
                 (SELECT "revision" FROM c) AS "newestRevision",
                 (SELECT "state" FROM cur) AS "state",
                 (SELECT floor(extract(epoch FROM "issuedAt") * 1000)::bigint FROM cur) AS "issuedAtMs",
                 (SELECT count(*)::int FROM u WHERE u."state" IS DISTINCT FROM (SELECT "state" FROM cur)) AS "moved"`;
        const deadline = new Date(Number(read.dbNowMs) + input.budget.budgetMs - (input.budget.clock() - input.budget.startedAt));

        if (read.state === null) throw new ReportRefused("attempt_unknown");
        if (!(own.from as readonly string[]).includes(read.state)) throw new ReportRefused("state_moved");
        if (input.report.kind === "unreported" && Number(read.dbNowMs) - Number(read.issuedAtMs) < QA_RELEASE_UNREPORTED_AFTER_MS) {
          throw new ReportRefused("too_early");
        }
        const revisionMatched = read.newestRevision !== null && read.newestRevision === input.callerRevision;
        const effect = qaReleaseReportEffectUnderRevision(own, revisionMatched);
        const moved = read.moved === 1;
        // The statement moved exactly when the effect says it should.
        if (moved !== (effect.move !== null)) throw new Error("qa_release_merge_report_move_mismatch");

        if (effect.latch !== null) {
          await tx.$executeRaw`INSERT INTO "QaReleaseMergeLaneLatch" ("sequence", "latched", "reason", "attemptId", "auditLogId")
            SELECT coalesce(max("sequence"), 0) + 1, true, ${effect.latch}, ${input.attemptId}, ${auditLogId}
              FROM "QaReleaseMergeLaneLatch"`;
          const queued = await enqueueNotificationDeliveryOnce(tx, {
            kind: NOTIFICATION_KIND.qaReleaseMergeLaneLatched,
            referenceId: `merge-lane-latch:${new Date(Number(read.dbNowMs)).toISOString().slice(0, 10)}`,
          });
          if (queued === null) throw new Error("qa_release_merge_lane_alert_not_visible");
        }
        const [clock] = await tx.$queryRaw<{ late: boolean }[]>`SELECT clock_timestamp() >= ${deadline}::timestamptz AS late`;
        if (clock?.late !== false) throw new QaReleaseMergeLaneLate();
        return { recorded: true as const, moved, latched: effect.latch, revisionMatched };
      },
      { maxWait: 5_000, timeout: REPORT.prismaMs },
    );
  } catch (error) {
    if (error instanceof ReportRefused) return { recorded: false, reason: error.reason };
    throw error;
  }
}

/** The lane as the service sees it at the start of a round: one statement, no write, on the database clock. */
export async function readQaReleaseMergeLaneState(): Promise<{
  dbNowMs: number;
  latched: boolean;
  openAttempt: {
    id: string;
    state: "issued" | "consumed" | "awaiting_deploy";
    pullRequestNumber: number;
    headSha: string;
    mergeCommitSha: string | null;
    issuedAtMs: number;
    mergeNotBeforeMs: number;
  } | null;
}> {
  const [row] = await prisma.$queryRaw<
    {
      dbNowMs: bigint;
      latched: boolean | null;
      id: string | null;
      state: string | null;
      pullRequestNumber: number | null;
      headSha: string | null;
      mergeCommitSha: string | null;
      issuedAtMs: bigint | null;
      consumedAtMs: bigint | null;
    }[]
  >`SELECT
      floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "dbNowMs",
      (SELECT l."latched" FROM "QaReleaseMergeLaneLatch" l ORDER BY l."sequence" DESC LIMIT 1) AS "latched",
      a."id", a."state", a."pullRequestNumber", a."headSha", a."mergeCommitSha",
      floor(extract(epoch FROM a."issuedAt") * 1000)::bigint AS "issuedAtMs",
      floor(extract(epoch FROM a."consumedAt") * 1000)::bigint AS "consumedAtMs"
    FROM (SELECT 1) one
    LEFT JOIN LATERAL (
      SELECT * FROM "QaReleaseMergeAttempt" WHERE "state" IN ('issued', 'consumed', 'awaiting_deploy') LIMIT 1
    ) a ON true`;
  const issuedAtMs = row.issuedAtMs === null ? null : Number(row.issuedAtMs);
  return {
    dbNowMs: Number(row.dbNowMs),
    latched: row.latched === true,
    openAttempt:
      row.id === null || issuedAtMs === null
        ? null
        : {
            id: row.id,
            state: row.state as "issued" | "consumed" | "awaiting_deploy",
            pullRequestNumber: row.pullRequestNumber ?? 0,
            headSha: row.headSha ?? "",
            mergeCommitSha: row.mergeCommitSha,
            issuedAtMs,
            // The earliest the merge can have happened: its consume, or its
            // issue when it was never consumed (an unreported merge placed by a
            // re-read). Earlier is the safe side: waits run out sooner.
            mergeNotBeforeMs: row.consumedAtMs === null ? issuedAtMs : Number(row.consumedAtMs),
          },
  };
}
