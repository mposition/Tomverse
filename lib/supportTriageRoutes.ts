/**
 * The support-triage internal routes' judgement (docs/policy/support-triage.md §3, §5, §7).
 *
 * Each handler takes the request and the environment and returns a status and
 * a body of counts or one boolean: never a report, an id or a secret. The
 * request body is never read. The route files only answer.
 *
 *   * retention: runs one retention run whatever the triage flag says, and
 *     answers non-2xx with SUPPORT_TRIAGE_RETENTION_NOT_PROGRESSING when the
 *     run made no progress while rows were overdue or a row is past its grace,
 *     so the cron run itself fails as a second signal beside the heartbeat.
 *   * heartbeat: `{ stale }` from the newest run rows, for the team 3 watcher.
 *   * run: one worker pass while SUPPORT_TRIAGE_ENABLED is exactly "true";
 *     otherwise `{ result: "ok", enabled: false }` and nothing is written, not
 *     even a run row.
 */
import "server-only";

import { prisma } from "@/lib/prisma";
import { supportTriageHeartbeatStale } from "@/lib/supportTriageCore";
import { runSupportTriageRetention } from "@/lib/supportTriageRetention";
import { runSupportTriageWorker } from "@/lib/supportTriageWorker";
import {
  SUPPORT_TRIAGE_HEARTBEAT_SECRET_ENV,
  SUPPORT_TRIAGE_RETENTION_SECRET_ENV,
  SUPPORT_TRIAGE_RUN_SECRET_ENV,
  isSupportTriageEnabled,
  isSupportTriageRouteAuthorized,
} from "@/lib/supportTriageRouteAuth";
import { SupportTriageTransactionRefused } from "@/lib/supportTriageTransaction";

export type SupportTriageRouteResponse = {
  readonly status: number;
  readonly body: Readonly<Record<string, string | number | boolean>>;
};

type Env = Readonly<Record<string, string | undefined>>;

const unauthorized: SupportTriageRouteResponse = { status: 401, body: { result: "unauthorized" } };

/** The run-row trigger refused a run past the UTC day's cap. */
const isDailyCapExceeded = (error: unknown) =>
  error instanceof Error && error.message.includes("support_triage_run_daily_cap_exceeded");

export const handleSupportTriageRetention = async (
  request: Request,
  { env = process.env as Env }: { env?: Env } = {}
): Promise<SupportTriageRouteResponse> => {
  if (!isSupportTriageRouteAuthorized(request.headers.get("authorization"), SUPPORT_TRIAGE_RETENTION_SECRET_ENV, env)) {
    return unauthorized;
  }
  let result;
  try {
    result = await runSupportTriageRetention();
  } catch (error) {
    if (isDailyCapExceeded(error)) return { status: 429, body: { result: "daily_cap_exceeded" } };
    if (error instanceof SupportTriageTransactionRefused) {
      return { status: 503, body: { result: "transaction_refused", reason: error.reason } };
    }
    throw error;
  }
  const counts = {
    outcome: result.outcome,
    batchesCompleted: result.batchesCompleted,
    deleted: result.deleted,
    blocked: result.blocked,
    overdueRemaining: result.overdueRemaining,
    oldestOverdueAgeSeconds: result.oldestOverdueAgeSeconds,
  };
  if (result.notProgressing) {
    return { status: 503, body: { result: "SUPPORT_TRIAGE_RETENTION_NOT_PROGRESSING", ...counts } };
  }
  return { status: 200, body: { result: "ok", ...counts } };
};

export const handleSupportTriageHeartbeat = async (
  request: Request,
  { env = process.env as Env, now }: { env?: Env; now?: Date } = {}
): Promise<SupportTriageRouteResponse> => {
  if (!isSupportTriageRouteAuthorized(request.headers.get("authorization"), SUPPORT_TRIAGE_HEARTBEAT_SECRET_ENV, env)) {
    return unauthorized;
  }
  const [retentionSuccess, retentionFinished, workerSuccess, clock] = await Promise.all([
    prisma.supportTriageRun.findFirst({
      where: { kind: "retention", outcome: "success" },
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true },
    }),
    prisma.supportTriageRun.findFirst({
      // A run that ended in an exception records no overdue counters; the
      // progress conditions read the newest run that did, and a string of
      // failures is the liveness condition's to catch.
      where: {
        kind: "retention",
        finishedAt: { not: null },
        batchesCompleted: { not: null },
        overdueRemaining: { not: null },
        oldestOverdueAgeSeconds: { not: null },
      },
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true, batchesCompleted: true, overdueRemaining: true, oldestOverdueAgeSeconds: true },
    }),
    prisma.supportTriageRun.findFirst({
      where: { kind: "worker", outcome: "success" },
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true },
    }),
    now
      ? Promise.resolve([{ now }])
      : prisma.$queryRaw<{ now: Date }[]>`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS now`,
  ]);
  const stale = supportTriageHeartbeatStale({
    now: clock[0].now,
    enabled: isSupportTriageEnabled(env),
    retention: {
      latestSuccessAt: retentionSuccess?.finishedAt ?? null,
      latestFinished:
        retentionFinished?.finishedAt != null &&
        retentionFinished.batchesCompleted !== null &&
        retentionFinished.overdueRemaining !== null &&
        retentionFinished.oldestOverdueAgeSeconds !== null
          ? {
              finishedAt: retentionFinished.finishedAt,
              batchesCompleted: retentionFinished.batchesCompleted,
              overdueRemaining: retentionFinished.overdueRemaining,
              oldestOverdueAgeSeconds: retentionFinished.oldestOverdueAgeSeconds,
            }
          : null,
    },
    workerLatestSuccessAt: workerSuccess?.finishedAt ?? null,
  });
  return { status: 200, body: { stale } };
};

export const handleSupportTriageRun = async (
  request: Request,
  { env = process.env as Env }: { env?: Env } = {}
): Promise<SupportTriageRouteResponse> => {
  if (!isSupportTriageRouteAuthorized(request.headers.get("authorization"), SUPPORT_TRIAGE_RUN_SECRET_ENV, env)) {
    return unauthorized;
  }
  if (!isSupportTriageEnabled(env)) return { status: 200, body: { result: "ok", enabled: false } };
  let result;
  try {
    result = await runSupportTriageWorker();
  } catch (error) {
    if (isDailyCapExceeded(error)) return { status: 429, body: { result: "daily_cap_exceeded" } };
    if (error instanceof SupportTriageTransactionRefused) {
      return { status: 503, body: { result: "transaction_refused", reason: error.reason } };
    }
    throw error;
  }
  return {
    status: 200,
    body: {
      result: "ok",
      enabled: true,
      outcome: result.outcome,
      reclaimed: result.reclaimed,
      exhausted: result.exhausted,
      claimed: result.claimed,
      ready: result.ready,
      stale: result.stale,
      superseded: result.superseded,
    },
  };
};
