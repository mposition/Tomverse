import "server-only";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { NOTIFICATION_KIND, enqueueNotificationDelivery } from "@/lib/notificationDeliveries";
import { prisma } from "@/lib/prisma";
import {
  type QaReleaseFreshnessVerdict,
  judgeQaReleaseFreshness,
  qaReleaseStaleReferenceId,
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
 * Monitor runs. The queue's own drain sends it.
 */

/** The Monitor caller's own timeout (policy section 10, proposed 120 s) less a margin. */
const MONITOR_ROUND_BUDGET_MS = 110_000;

/** The read transaction: two statements (A = 2), so 3A + 5 = 11 s; Prisma 5 s more. */
const READ_LIMITS = Object.freeze({ statementMs: 2_000, idleMs: 1_000, prismaMs: 16_000 });

/**
 * The silence-alert write (policy section 10: at most nine statements -- the
 * audit append reads the previous entry only when the integrity key is set --
 * so 3A + 5 =
 * 32 s, Prisma five seconds more, transaction_timeout on PostgreSQL 17+):
 * the limits, the audit chain lock, the existing-alert read, the queue row,
 * the four of the audit append, and the deadline check as the last statement.
 */
export const QA_RELEASE_STALE_WRITE_LIMITS = Object.freeze({
  statementMs: 2_000,
  idleMs: 1_000,
  statements: 9,
  transactionMs: (3 * 9 + 5) * 1_000,
  prismaMs: (3 * 9 + 5) * 1_000 + 5_000,
});
const ALERT_LIMITS = QA_RELEASE_STALE_WRITE_LIMITS;

/** Carries the late answer out of the transaction it rolls back. */
class StaleAlertLate extends Error {}

/**
 * Queues today's silence alert and its system audit entry in one
 * transaction (policy sections 5 and 7). Answers whether this round queued
 * it: a second stale round the same UTC day finds the row and writes nothing.
 */
async function enqueueStaleAlert(dbNowMs: number, roundDeadline: Date): Promise<"queued" | "already_queued"> {
  const referenceId = qaReleaseStaleReferenceId(dbNowMs);
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
      const existing = await tx.notificationDelivery.findUnique({
        where: { kind_referenceId: { kind: NOTIFICATION_KIND.qaReleaseDigestStale, referenceId } },
        select: { id: true },
      });
      // Every path ends with the deadline check, the one that writes nothing too.
      const late = async () => {
        const clock = await tx.$queryRaw<{ late: boolean }[]>`SELECT clock_timestamp() >= ${roundDeadline}::timestamptz AS late`;
        return clock[0]?.late !== false;
      };
      if (existing) {
        if (await late()) throw new StaleAlertLate();
        return "already_queued" as const;
      }
      const queued = await enqueueNotificationDelivery(tx, {
        kind: NOTIFICATION_KIND.qaReleaseDigestStale,
        referenceId,
      });
      // The digest intake's listed actor: the policy names two system actors
      // for this agent, and this is the app side of the digest, not the lane.
      await writeSystemAuditLog({
        tx,
        systemActor: "qa-release-intake",
        action: "qa_release.digest_stale_alerted",
        targetType: "NotificationDelivery",
        targetId: queued.id,
        summary: "Queued the QA-release digest silence alert.",
        metadata: { referenceId },
      });
      // The last statement: a round past its deadline is not recorded as a
      // success (policy section 3); the database clock decides.
      if (await late()) throw new StaleAlertLate();
      return "queued" as const;
    },
    { maxWait: 5_000, timeout: ALERT_LIMITS.prismaMs },
  );
}

export type QaReleaseMonitorAnswer = { status: number; body: Record<string, unknown> };

const answer = (status: number, body: Record<string, unknown>): QaReleaseMonitorAnswer => ({ status, body });

type RoundRead = {
  dbNowMs: number;
  revision: number | null;
  digestEnabled: boolean | null;
  latestDigestCreatedAtMs: number | null;
};

async function readRound(): Promise<RoundRead> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT
        set_config('statement_timeout', ${String(READ_LIMITS.statementMs)}, true),
        set_config('idle_in_transaction_session_timeout', ${String(READ_LIMITS.idleMs)}, true)`;
      // One statement for all three facts, so they share one snapshot and one clock.
      const rows = await tx.$queryRaw<
        { dbNowMs: bigint; revision: number | null; digestEnabled: boolean | null; latestMs: bigint | null }[]
      >`SELECT
          floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "dbNowMs",
          c."revision",
          c."digestEnabled",
          (SELECT floor(extract(epoch FROM max(d."createdAt")) * 1000)::bigint
             FROM "AgentDigestItem" d WHERE d."agentKey" = 'qa-release') AS "latestMs"
        FROM (SELECT 1) one
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
  const readStartedElapsedMs = clock() - startedAt;
  try {
    read = await readRound();
  } catch {
    // Unknown outcome: report, never guess a verdict (policy section 6).
    return answer(503, { error: "monitor_read_failed" });
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
    return answer(admission.reason === "control_revision_unavailable" ? 503 : 409, { error: admission.reason });
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
    return answer(503, { error: "monitor_clock_invalid" });
  }
  if (verdict !== "stale") return answer(200, { verdict });

  if (!qaReleaseTransactionFits("stale_write", clock() - startedAt, MONITOR_ROUND_BUDGET_MS)) {
    return answer(503, { verdict, error: "monitor_budget_exhausted" });
  }
  let queued: "queued" | "already_queued";
  try {
    // The deadline on the database clock, the clock that checks it: the
    // database's time at the read plus what was left of the round then. App
    // and database clocks never meet, so skew between them cannot move it.
    const roundDeadline = new Date(read.dbNowMs + MONITOR_ROUND_BUDGET_MS - readStartedElapsedMs);
    queued = await enqueueStaleAlert(read.dbNowMs, roundDeadline);
  } catch (error) {
    // The verdict stands; the alert was not recorded, and is not retried
    // here -- the next round tries again under the same key.
    return answer(503, { verdict, error: error instanceof StaleAlertLate ? "monitor_deadline_passed" : "alert_enqueue_failed" });
  }
  return answer(200, { verdict, alerted: queued === "queued" });
}
