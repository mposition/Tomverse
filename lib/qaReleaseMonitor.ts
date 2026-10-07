import "server-only";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { NOTIFICATION_KIND, enqueueNotificationDeliveryOnce } from "@/lib/notificationDeliveries";
import { prisma } from "@/lib/prisma";
import {
  type QaReleaseFreshnessVerdict,
  judgeQaReleaseFreshness,
  qaReleaseStaleReferenceId,
  qaReleaseUtcDateKey,
  qaReleaseTransactionFits,
} from "@/lib/qaReleaseDigestFreshnessCore";
import {
  QA_RELEASE_CONTROL_REVISION_HEADER,
  admitQaReleaseRouteCall,
  isQaReleaseRouteSecret,
} from "@/lib/qaReleaseRouteAuthCore";

/**
 * The Monitor's silence check (docs/policy/qa-release-agent.md sections 3, 6
 * and 7): the Monitor service calls this route on its own cron, and the app
 * judges whether the newest digest is fresh against the database clock.
 *
 * A `stale` verdict enqueues the silence alert on the operator notification
 * queue under `stale:<UTC date of the database clock>`; the queue's (kind,
 * referenceId) unique key makes it at most one per day, however often the
 * Monitor runs. The queue's own drain sends it. A control mismatch -- the
 * digest secret gone while recorded as on, or a caller on another revision
 * than the newest -- queues the needs-a-check alert the same way under
 * `attention:<date>`, and a round that cannot finish queues the
 * monitor-failure alert under `monitor-failure:<date>`.
 */

/** The Monitor caller's own timeout (policy section 10, proposed 120 s) less a margin. */
const MONITOR_ROUND_BUDGET_MS = 110_000;

/** The read transaction: two statements (A = 2), so 3A + 5 = 11 s; Prisma 5 s more. */
const READ_LIMITS = Object.freeze({ statementMs: 2_000, idleMs: 1_000, prismaMs: 16_000 });

/**
 * The silence-alert write (policy section 10: at most nine statements, so
 * 3A + 5 = 32 s, Prisma five seconds more, transaction_timeout on PostgreSQL
 * 17+). It runs eight: the limits, the audit chain lock, the queue row in one
 * statement, the four of the audit append (the previous-entry read only when
 * the integrity key is set), and the deadline check as the last statement.
 * The queue row is not written with Prisma's upsert, which runs three.
 */
export const QA_RELEASE_STALE_WRITE_LIMITS = Object.freeze({
  statementMs: 2_000,
  idleMs: 1_000,
  statements: 9,
  transactionMs: (3 * 9 + 5) * 1_000,
  prismaMs: (3 * 9 + 5) * 1_000 + 5_000,
});
const ALERT_LIMITS = QA_RELEASE_STALE_WRITE_LIMITS;

/** Carries the late answer out of the transaction it rolls back (both writes). */
class StaleAlertLate extends Error {}

/** What a round or the digest intake found that needs an operator: closed names only. */
export type QaReleaseAttentionReason = "control_mismatch" | "control_revision_mismatch" | "digest_conflict";

/**
 * The daily alerts a round may queue. A round reaches at most one of them
 * -- the stale, fresh and control-mismatch verdicts exclude each other, and a
 * revision mismatch ends the round before any verdict -- so all use the one
 * alert-write slot of the round's budget (policy section 10).
 */
type DailyAlert =
  | { which: "stale" }
  | { which: "attention"; reason: QaReleaseAttentionReason }
  | { which: "recorded"; digestCreatedAtMs: number };

const DAILY_ALERTS = {
  stale: {
    kind: NOTIFICATION_KIND.qaReleaseDigestStale,
    referenceId: (_alert: DailyAlert, dbNowMs: number) => qaReleaseStaleReferenceId(dbNowMs),
    action: "qa_release.digest_stale_alerted",
    summary: "Queued the QA-release digest silence alert.",
  },
  attention: {
    kind: NOTIFICATION_KIND.qaReleaseAttention,
    referenceId: (_alert: DailyAlert, dbNowMs: number) => `attention:${qaReleaseUtcDateKey(dbNowMs)}`,
    action: "qa_release.attention_alerted",
    summary: "Queued the QA-release needs-a-check alert.",
  },
  // Keyed by the digest's UTC day, which the round only acts on when it is
  // also the round's own UTC day (see runQaReleaseMonitor).
  recorded: {
    kind: NOTIFICATION_KIND.qaReleaseDigestRecorded,
    referenceId: (alert: DailyAlert) =>
      `recorded:${qaReleaseUtcDateKey(alert.which === "recorded" ? alert.digestCreatedAtMs : Number.NaN)}`,
    action: "qa_release.digest_recorded_alerted",
    summary: "Queued the QA-release digest recorded notice.",
  },
} as const;

/**
 * Queues today's alert of one kind and its system audit entry in one
 * transaction (policy sections 5 and 7). Answers whether this round queued
 * it: a second round the same UTC day finds the row and writes nothing.
 */
async function enqueueDailyAlert(
  alert: DailyAlert,
  dbNowMs: number,
  roundDeadline: Date,
): Promise<"queued" | "already_queued"> {
  const spec = DAILY_ALERTS[alert.which];
  const referenceId = spec.referenceId(alert, dbNowMs);
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT
        set_config('statement_timeout', ${String(ALERT_LIMITS.statementMs)}, true),
        set_config('idle_in_transaction_session_timeout', ${String(ALERT_LIMITS.idleMs)}, true),
        CASE WHEN current_setting('server_version_num')::int >= 170000
          THEN set_config('transaction_timeout', ${String(ALERT_LIMITS.transactionMs)}, true)
        END`;
      // Under the statement limit, and before any row: the same order every
      // audit writer takes.
      await takeAuditChainLock(tx);
      const queued = await enqueueNotificationDeliveryOnce(tx, { kind: spec.kind, referenceId });
      // A row committed by a concurrent round after this statement began:
      // not known from here, so not reported as either answer.
      if (queued === null) throw new Error("alert row not visible");
      // Every path ends with the deadline check, the one that writes nothing too.
      const late = async () => {
        const clock = await tx.$queryRaw<{ late: boolean }[]>`SELECT clock_timestamp() >= ${roundDeadline}::timestamptz AS late`;
        return clock[0]?.late !== false;
      };
      if (!queued.inserted) {
        if (await late()) throw new StaleAlertLate();
        return "already_queued" as const;
      }
      // The digest intake's listed actor: the policy names two system actors
      // for this agent, and this is the app side of the digest, not the lane.
      await writeSystemAuditLog({
        tx,
        systemActor: "qa-release-intake",
        action: spec.action,
        targetType: "NotificationDelivery",
        targetId: queued.id,
        summary: spec.summary,
        metadata: alert.which === "attention" ? { referenceId, reason: alert.reason } : { referenceId },
      });
      // The last statement: a round past its deadline is not recorded as a
      // success (policy section 3); the database clock decides.
      if (await late()) throw new StaleAlertLate();
      return "queued" as const;
    },
    { maxWait: 5_000, timeout: ALERT_LIMITS.prismaMs },
  );
}

/**
 * The digest intake's needs-a-check alert (policy sections 6 and 7): a
 * submission refused because it carried another operator control revision
 * than the newest, or a second, different digest for a day that already has
 * one. The Monitor cannot see either -- it checks its own revision and the
 * newest digest's age -- so the intake queues the same daily row and audit
 * entry itself, in its own transaction after the refusal is decided. A
 * failure here never changes the intake's answer.
 */
export async function queueQaReleaseIntakeAttention(
  reason: "control_revision_mismatch" | "digest_conflict",
): Promise<"queued" | "already_queued" | "failed"> {
  try {
    const rows = await prisma.$queryRaw<{ dbNowMs: bigint }[]>`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "dbNowMs"`;
    const dbNowMs = Number(rows[0]?.dbNowMs);
    if (!Number.isFinite(dbNowMs)) return "failed";
    return await enqueueDailyAlert({ which: "attention", reason }, dbNowMs, new Date(dbNowMs + ALERT_LIMITS.transactionMs));
  } catch {
    return "failed";
  }
}

/**
 * The monitor-failure write (policy section 10: seven statements, so 3A + 5
 * = 26 s, Prisma five seconds more): the limits with the database's UTC
 * date, the queue row in one statement, the four of the audit append (its
 * chain lock first), and the deadline check as the last statement.
 *
 * Unlike the silence alert there is no separate chain lock before the row:
 * an eighth statement would exceed the policy's count, and the row write is
 * one statement on its unique key with nothing read before it to serialise.
 * The only other writer of this row is another failed round of the same day,
 * which also takes the row before the chain lock; were two to overlap, the
 * second waits on the first's insert, finds the conflict but not the row
 * (the queue write answers null), and reports failureRecorded: false.
 */
export const QA_RELEASE_FAILURE_WRITE_LIMITS = Object.freeze({
  statementMs: 2_000,
  idleMs: 1_000,
  statements: 7,
  transactionMs: (3 * 7 + 5) * 1_000,
  prismaMs: (3 * 7 + 5) * 1_000 + 5_000,
});
const FAILURE_LIMITS = QA_RELEASE_FAILURE_WRITE_LIMITS;

/** Why a round ended without a verdict or without its alert: closed names only. */
export type QaReleaseMonitorFailure =
  | "monitor_read_failed"
  | "monitor_clock_invalid"
  | "alert_enqueue_failed"
  | "monitor_deadline_passed";

/**
 * Records a round that could not finish (policy section 7, "감시 실패"): the
 * day's monitor-failure alert and a system audit entry naming the closed
 * reason, in one transaction. The queue row is one per UTC day of the
 * database clock; every failed round still leaves its own audit entry,
 * because each is a separate fact.
 *
 * The deadline is anchored the way the read anchors it: the database's time
 * in the first statement plus what is left of the round, measured after that
 * statement returned -- a round whose read failed has no earlier database
 * time to use.
 */
async function recordMonitorFailure(
  failure: QaReleaseMonitorFailure,
  startedAt: number,
  clock: () => number,
): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      // One clock reading for both the date and the deadline, so a round
      // straddling UTC midnight cannot key one day and time another.
      const setup = await tx.$queryRaw<{ day: string; dbNowMs: bigint }[]>`SELECT
        set_config('statement_timeout', ${String(FAILURE_LIMITS.statementMs)}, true),
        set_config('idle_in_transaction_session_timeout', ${String(FAILURE_LIMITS.idleMs)}, true),
        CASE WHEN current_setting('server_version_num')::int >= 170000
          THEN set_config('transaction_timeout', ${String(FAILURE_LIMITS.transactionMs)}, true)
        END,
        to_char(now_.t AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
        floor(extract(epoch FROM now_.t) * 1000)::bigint AS "dbNowMs"
        FROM (SELECT clock_timestamp() AS t) now_`;
      const roundDeadline = new Date(Number(setup[0].dbNowMs) + MONITOR_ROUND_BUDGET_MS - (clock() - startedAt));
      const referenceId = `monitor-failure:${setup[0].day}`;
      const queued = await enqueueNotificationDeliveryOnce(tx, {
        kind: NOTIFICATION_KIND.qaReleaseMonitorFailed,
        referenceId,
      });
      if (queued === null) throw new Error("monitor failure row not visible");
      await writeSystemAuditLog({
        tx,
        systemActor: "qa-release-intake",
        action: "qa_release.monitor_failed",
        targetType: "NotificationDelivery",
        targetId: queued.id,
        summary: "A QA-release Monitor round could not finish.",
        metadata: { referenceId, failure },
      });
      const late = await tx.$queryRaw<{ late: boolean }[]>`SELECT clock_timestamp() >= ${roundDeadline}::timestamptz AS late`;
      if (late[0]?.late !== false) throw new StaleAlertLate();
    },
    { maxWait: 5_000, timeout: FAILURE_LIMITS.prismaMs },
  );
}

/**
 * Answers the failed round and tries to record it, when the round still has
 * room for the write. The answer is the same whether the record landed: the
 * failure is the fact, and `failureRecorded` says only whether it was kept.
 */
async function failRound(
  failure: QaReleaseMonitorFailure,
  startedAt: number,
  clock: () => number,
  extra: Record<string, unknown> = {},
): Promise<QaReleaseMonitorAnswer> {
  let failureRecorded = false;
  if (qaReleaseTransactionFits("failure_write", clock() - startedAt, MONITOR_ROUND_BUDGET_MS)) {
    try {
      await recordMonitorFailure(failure, startedAt, clock);
      failureRecorded = true;
    } catch {
      // Nothing to add: the round already failed, and nothing is retried here.
    }
  }
  return answer(503, { ...extra, error: failure, failureRecorded });
}

export type QaReleaseMonitorAnswer = { status: number; body: Record<string, unknown> };

const answer = (status: number, body: Record<string, unknown>): QaReleaseMonitorAnswer => ({ status, body });

type RoundRead = {
  dbNowMs: number;
  revision: number | null;
  digestEnabled: boolean | null;
  latestDigestCreatedAtMs: number | null;
  /** Whether the newest digest's UTC day already has its recorded alert queued. */
  recordedAlertQueued: boolean;
};

async function readRound(): Promise<RoundRead> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT
        set_config('statement_timeout', ${String(READ_LIMITS.statementMs)}, true),
        set_config('idle_in_transaction_session_timeout', ${String(READ_LIMITS.idleMs)}, true)`;
      // One statement for all the facts, so they share one snapshot and one clock.
      const rows = await tx.$queryRaw<
        {
          dbNowMs: bigint;
          revision: number | null;
          digestEnabled: boolean | null;
          latestMs: bigint | null;
          recordedQueued: boolean;
        }[]
      >`SELECT
          floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "dbNowMs",
          c."revision",
          c."digestEnabled",
          floor(extract(epoch FROM latest.at) * 1000)::bigint AS "latestMs",
          EXISTS (
            SELECT 1 FROM "NotificationDelivery" n
             WHERE n."kind" = ${NOTIFICATION_KIND.qaReleaseDigestRecorded}
               AND n."referenceId" = 'recorded:' || to_char(latest.at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
          ) AS "recordedQueued"
        FROM (SELECT max(d."createdAt") AS at FROM "AgentDigestItem" d WHERE d."agentKey" = 'qa-release') latest
        LEFT JOIN LATERAL (
          SELECT "revision", "digestEnabled" FROM "QaReleaseOperatorControl"
           ORDER BY "revision" DESC LIMIT 1
        ) c ON true`;
      const row = rows[0];
      return {
        dbNowMs: Number(row.dbNowMs),
        revision: row.revision,
        digestEnabled: row.digestEnabled,
        latestDigestCreatedAtMs: row.latestMs === null ? null : Number(row.latestMs),
        recordedAlertQueued: row.recordedQueued,
      };
    },
    { maxWait: 5_000, timeout: READ_LIMITS.prismaMs },
  );
}

export async function runQaReleaseMonitor(
  request: Request,
  env: Readonly<Record<string, string | undefined>> = process.env,
  clock: () => number = Date.now,
): Promise<QaReleaseMonitorAnswer> {
  const startedAt = clock();
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  if (!isQaReleaseRouteSecret("monitor", bearer, env)) return answer(401, { error: "unauthorized" });

  if (!qaReleaseTransactionFits("read", clock() - startedAt, MONITOR_ROUND_BUDGET_MS)) {
    return answer(503, { error: "monitor_budget_exhausted" });
  }
  let read: RoundRead;
  try {
    read = await readRound();
  } catch {
    // Unknown outcome: report, never guess a verdict (policy section 6).
    return failRound("monitor_read_failed", startedAt, clock);
  }

  const admission = admitQaReleaseRouteCall({
    role: "monitor",
    authorization,
    revisionHeader: request.headers.get(QA_RELEASE_CONTROL_REVISION_HEADER),
    latestRevision: read.revision,
    env,
  });
  if (!admission.ok) {
    if (admission.reason === "unauthorized") return answer(401, { error: "unauthorized" });
    if (admission.reason === "control_revision_unavailable") return answer(503, { error: admission.reason });
    // A service running another revision than the newest recorded one is
    // refused and reported (policy section 6).
    return alertRound({ which: "attention", reason: "control_revision_mismatch" }, read, startedAt, clock, 409, {
      error: admission.reason,
    });
  }

  let verdict: QaReleaseFreshnessVerdict;
  try {
    verdict = judgeQaReleaseFreshness({
      // Configured means usable: the same 32-character floor the route's own
      // authentication applies, so a short secret reads as a mismatch.
      digestSecretConfigured: (env.QA_RELEASE_DIGEST_SECRET ?? "").length >= 32,
      desiredEnabled: read.digestEnabled,
      latestDigestCreatedAtMs: read.latestDigestCreatedAtMs,
      dbNowMs: read.dbNowMs,
    });
  } catch {
    return failRound("monitor_clock_invalid", startedAt, clock);
  }
  if (verdict === "stale") return alertRound({ which: "stale" }, read, startedAt, clock, 200, { verdict });
  // The day's digest is recorded (policy section 7): one notice per digest
  // day, written only when the read found it not yet queued, so a quiet
  // fresh round takes no lock and writes nothing. Only a digest of the
  // round's own UTC day is announced: a digest stored just before midnight
  // and first seen after it goes without a notice rather than giving the
  // next day two, which the policy's one-per-kind-per-day cap forbids.
  if (
    verdict === "fresh" &&
    read.latestDigestCreatedAtMs !== null &&
    !read.recordedAlertQueued &&
    qaReleaseUtcDateKey(read.latestDigestCreatedAtMs) === qaReleaseUtcDateKey(read.dbNowMs)
  ) {
    const digestCreatedAtMs = read.latestDigestCreatedAtMs;
    return alertRound({ which: "recorded", digestCreatedAtMs }, read, startedAt, clock, 200, { verdict });
  }
  // The digest secret gone while the agent is recorded as on (policy section 6).
  if (verdict === "control_mismatch") {
    return alertRound({ which: "attention", reason: "control_mismatch" }, read, startedAt, clock, 200, { verdict });
  }
  return answer(200, { verdict });
}

/** Queues the round's one daily alert and answers with `alerted` beside `body`. */
async function alertRound(
  alert: DailyAlert,
  read: RoundRead,
  startedAt: number,
  clock: () => number,
  status: number,
  body: Record<string, unknown>,
): Promise<QaReleaseMonitorAnswer> {
  if (!qaReleaseTransactionFits("stale_write", clock() - startedAt, MONITOR_ROUND_BUDGET_MS)) {
    return answer(503, { ...body, error: "monitor_budget_exhausted" });
  }
  let queued: "queued" | "already_queued";
  try {
    // The deadline on the database clock, the clock that checks it: the
    // database's time during the read plus what is left of the round now,
    // measured after the read returned. The elapsed time is the later of the
    // two app-side readings, so any wait before the database took its time
    // shortens the deadline rather than lengthening it. App and database
    // clocks never meet, so skew between them cannot move it.
    const elapsedAfterReadMs = clock() - startedAt;
    const roundDeadline = new Date(read.dbNowMs + MONITOR_ROUND_BUDGET_MS - elapsedAfterReadMs);
    queued = await enqueueDailyAlert(alert, read.dbNowMs, roundDeadline);
  } catch (error) {
    // The finding stands; this round recorded nothing (a late round rolls
    // back, and an earlier round's alert stays as it was), and nothing is
    // retried here -- the next round tries again under the same key. A
    // refusal keeps its own name beside the failure.
    const { error: refused, ...rest } = body;
    return failRound(
      error instanceof StaleAlertLate ? "monitor_deadline_passed" : "alert_enqueue_failed",
      startedAt,
      clock,
      refused === undefined ? rest : { ...rest, refused },
    );
  }
  return answer(status, { ...body, alerted: queued === "queued" });
}
