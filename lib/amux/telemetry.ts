import "server-only";

import { Prisma } from "@prisma/client";
import {
  calibrateAmuxHistory,
  confidenceAdjustedMetric,
  evaluateAmuxQuotaTelemetry,
  type AmuxObservedMetric,
} from "@/lib/amux/planningCore";
import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { prisma } from "@/lib/prisma";

type WorkerIdentity = { worker_name: string; provider: string };
type HistoricalAttemptRow = {
  worker: string;
  outcome: string | null;
  toStatus: string | null;
  startedAt: Date;
  endedAt: Date | null;
  settledCostMicrousd: bigint | null;
  costConfirmed: boolean;
};
type QuotaObservationRow = {
  worker: string;
  provider: string;
  remainingBasisPoints: number;
  confidenceBasisPoints: number;
  exhausted: boolean;
  source: string;
  observedAt: Date;
  resetAt: Date | null;
};

const median = (values: readonly number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
};

export async function getAmuxWorkerTelemetry(
  workers: readonly WorkerIdentity[],
  now = new Date(),
  db: Prisma.TransactionClient | typeof prisma = prisma,
) {
  if (workers.length === 0) return new Map();
  const names = workers.map((worker) => worker.worker_name);
  const cutoff = new Date(now.getTime() - 90 * 86_400_000);
  const [attempts, quotaRows] = await Promise.all([
    db.$queryRaw<HistoricalAttemptRow[]>`
      SELECT
        ranked."worker",
        ranked."outcome",
        ranked."toStatus",
        ranked."startedAt",
        ranked."endedAt",
        ranked."settledCostMicrousd",
        ranked."costConfirmed"
      FROM (
        SELECT
          attempt."worker",
          attempt."outcome",
          attempt."toStatus",
          attempt."startedAt",
          attempt."endedAt",
          attempt."settledCostMicrousd",
          attempt."costConfirmed",
          ROW_NUMBER() OVER (
            PARTITION BY attempt."worker"
            ORDER BY attempt."endedAt" DESC, attempt."id" DESC
          ) AS "workerRowNumber"
        FROM "AmuxExecutionAttempt" AS attempt
        WHERE attempt."worker" IN (${Prisma.join(names)})
          AND attempt."endedAt" >= ${cutoff}
          AND attempt."endedAt" <= ${now}
      ) AS ranked
      WHERE ranked."workerRowNumber" <= 200
      ORDER BY ranked."worker" ASC, ranked."endedAt" DESC
    `,
    db.$queryRaw<QuotaObservationRow[]>`
      SELECT DISTINCT ON (observation."worker")
        observation."worker",
        observation."provider",
        observation."remainingBasisPoints",
        observation."confidenceBasisPoints",
        observation."exhausted",
        observation."source",
        observation."observedAt",
        observation."resetAt"
      FROM "AmuxQuotaObservation" AS observation
      WHERE observation."worker" IN (${Prisma.join(names)})
        AND observation."observedAt" <= ${now}
      ORDER BY
        observation."worker" ASC,
        observation."observedAt" DESC,
        observation."createdAt" DESC,
        observation."id" DESC
    `,
  ]);

  const workerOutcomeAttempts = attempts.filter(
    (attempt) => attempt.outcome !== "expired",
  );
  const cohortLatency = median(
    workerOutcomeAttempts.flatMap((attempt) =>
      attempt.endedAt
        ? [Math.max(1, attempt.endedAt.getTime() - attempt.startedAt.getTime())]
        : [],
    ),
  );
  const latestQuota = new Map<string, (typeof quotaRows)[number]>();
  for (const row of quotaRows) {
    if (!latestQuota.has(row.worker)) latestQuota.set(row.worker, row);
  }
  const costMeans = new Map<
    string,
    { mean: number; count: number; observedAt: Date }
  >();
  for (const worker of names) {
    const samples = workerOutcomeAttempts.filter(
      (attempt) =>
        attempt.worker === worker &&
        attempt.costConfirmed &&
        attempt.settledCostMicrousd !== null,
    );
    if (samples.length === 0) continue;
    costMeans.set(worker, {
      mean:
        samples.reduce(
          (sum, sample) => sum + Number(sample.settledCostMicrousd),
          0,
        ) / samples.length,
      count: samples.length,
      observedAt: samples[0]?.endedAt ?? now,
    });
  }
  const cohortCost = median([...costMeans.values()].map((item) => item.mean));

  return new Map(
    workers.map((worker) => {
      const history = calibrateAmuxHistory(
        workerOutcomeAttempts.filter(
          (attempt) => attempt.worker === worker.worker_name,
        ),
        now,
        cohortLatency ?? 1,
      );
      const quota = latestQuota.get(worker.worker_name);
      const quotaEvaluation = evaluateAmuxQuotaTelemetry(
        quota
          ? {
              remaining_fraction: quota.remainingBasisPoints / 10_000,
              confidence: quota.confidenceBasisPoints / 10_000,
              exhausted: quota.exhausted,
              source: quota.source as "provider_api" | "wrapper",
              observed_at: quota.observedAt.toISOString(),
              reset_at: quota.resetAt?.toISOString() ?? null,
            }
          : null,
        now,
      );
      const cost = costMeans.get(worker.worker_name);
      const costMetric: AmuxObservedMetric | null =
        cost && cohortCost !== null
          ? {
              value: Math.max(
                0,
                Math.min(1, cohortCost / Math.max(1, cost.mean)),
              ),
              confidence: Math.max(0, Math.min(1, cost.count / 20)),
              source: "historical_cost",
              sample_size: cost.count,
              observed_at: cost.observedAt.toISOString(),
            }
          : null;
      return [
        worker.worker_name,
        {
          scoring: {
            predicted_success: confidenceAdjustedMetric(
              history.predicted_success,
            ),
            quota_remaining: confidenceAdjustedMetric(quotaEvaluation.metric),
            expected_speed: confidenceAdjustedMetric(history.expected_speed),
            low_rework: confidenceAdjustedMetric(history.low_rework),
            low_human_attention: confidenceAdjustedMetric(
              history.low_human_attention,
            ),
            cost_efficiency: confidenceAdjustedMetric(costMetric),
            provider_exhausted: quotaEvaluation.provider_exhausted,
          },
          evidence: {
            history: {
              sample_size: history.sample_size,
              predicted_success: confidenceAdjustedMetric(
                history.predicted_success,
              ),
              expected_speed: confidenceAdjustedMetric(history.expected_speed),
              low_rework: confidenceAdjustedMetric(history.low_rework),
              low_human_attention: confidenceAdjustedMetric(
                history.low_human_attention,
              ),
              cost_efficiency: confidenceAdjustedMetric(costMetric),
            },
            quota: {
              ...confidenceAdjustedMetric(quotaEvaluation.metric),
              state: quotaEvaluation.state,
              provider_exhausted: quotaEvaluation.provider_exhausted,
              reset_at: quotaEvaluation.reset_at,
            },
          },
        },
      ] as const;
    }),
  );
}

/**
 * Quota observations stop contributing after fifteen minutes and historical
 * calibration reads a ninety-day window. Keep that full evidence window, then
 * remove rows no AMUX decision can consume. The database trigger enforces the
 * same lower bound, so a clock or caller error cannot shorten retention.
 */
export const AMUX_QUOTA_SWEEP_BATCH_SIZE = 200;

export async function sweepExpiredAmuxQuotaObservations() {
  return withAmuxDbBoundary(
    AMUX_DB_BOUNDARIES.quotaObservationSweep,
    async (tx) =>
      tx.$executeRaw`
        WITH expired AS MATERIALIZED (
          SELECT "id"
          FROM "AmuxQuotaObservation"
          WHERE "createdAt" <= clock_timestamp() - INTERVAL '90 days'
          ORDER BY "createdAt" ASC, "id" ASC
          LIMIT ${AMUX_QUOTA_SWEEP_BATCH_SIZE}
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM "AmuxQuotaObservation" AS observation
        USING expired
        WHERE observation."id" = expired."id"
      `,
  );
}
