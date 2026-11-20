import "server-only";
import { prisma } from "@/lib/prisma";

type PresearchWindow = {
  hours: number;
  serverAttempts: number;
  paired: number;
  missingClient: number;
  failed: number;
  cancelled: number;
  completed: number;
  completedWithFirstContent: number;
  withinTenSeconds: number;
  firstP50Ms: number | null;
  firstP95Ms: number | null;
  completionP50Ms: number | null;
  completionP95Ms: number | null;
  timedSlowCompleted: number;
  slowBeforeProviderEstimateP50Ms: number | null;
  slowProviderToContentP50Ms: number | null;
  slowContentToEndP50Ms: number | null;
};

/** Daily maintenance reads both windows before the seven-day retention sweep. */
export async function readChatPresearchLatency(now = new Date()) {
  const asOf = now.toISOString();
  const windows = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL statement_timeout = '4s'`;
    return tx.$queryRaw<PresearchWindow[]>`
      WITH bounds AS (
        SELECT ${asOf}::timestamp AS cutoff
      ), attempts AS (
        SELECT s."createdAt", c.id IS NOT NULL AS paired,
               (c.timings->>'firstContentMs')::int AS first_ms,
               (c.timings->>'completionMs')::int AS total_ms,
               (s.timings->>'providerToContentMs')::int AS provider_ms,
               CASE WHEN s.outcome IN ('failed', 'failed_before_stream', 'empty') OR c.outcome = 'failed' THEN 'failed'
                    WHEN s.outcome = 'cancelled' OR c.outcome = 'cancelled' THEN 'cancelled'
                    WHEN s.outcome = 'completed' AND c.outcome = 'completed' THEN 'completed' END AS outcome
        FROM bounds
        JOIN "ResponseLatencySample" s ON s."createdAt" >= cutoff - INTERVAL '7 days' AND s."createdAt" < cutoff
        LEFT JOIN "ResponseLatencySample" c ON c.id = left(s.id, -7) || ':client'
          AND c.source = 'client' AND c.product = 'chat' AND c.mode = 'auto' AND c."createdAt" < cutoff
        WHERE s.source = 'server' AND s.product = 'chat' AND s.mode = 'auto'
          AND right(s.id, 7) = ':server' AND s.timings ? 'presearchMs'
      ), measured AS (
        SELECT *, outcome = 'completed' AND total_ms > 10000 AND provider_ms >= 0
          AND provider_ms <= first_ms AND first_ms <= total_ms AS timed_slow
        FROM attempts
      )
      SELECT hours, count(a."createdAt")::int AS "serverAttempts",
             count(*) FILTER (WHERE paired)::int AS paired,
             count(*) FILTER (WHERE a."createdAt" IS NOT NULL AND NOT paired)::int AS "missingClient",
             count(*) FILTER (WHERE outcome = 'failed')::int AS failed,
             count(*) FILTER (WHERE outcome = 'cancelled')::int AS cancelled,
             count(total_ms) FILTER (WHERE outcome = 'completed')::int AS completed,
             count(first_ms) FILTER (WHERE outcome = 'completed' AND total_ms IS NOT NULL)::int AS "completedWithFirstContent",
             count(*) FILTER (WHERE outcome = 'completed' AND first_ms IS NOT NULL AND total_ms <= 10000)::int AS "withinTenSeconds",
             percentile_disc(0.5) WITHIN GROUP (ORDER BY first_ms) FILTER (WHERE outcome = 'completed' AND total_ms IS NOT NULL) AS "firstP50Ms",
             percentile_disc(0.95) WITHIN GROUP (ORDER BY first_ms) FILTER (WHERE outcome = 'completed' AND total_ms IS NOT NULL) AS "firstP95Ms",
             percentile_disc(0.5) WITHIN GROUP (ORDER BY total_ms) FILTER (WHERE outcome = 'completed') AS "completionP50Ms",
             percentile_disc(0.95) WITHIN GROUP (ORDER BY total_ms) FILTER (WHERE outcome = 'completed') AS "completionP95Ms",
             count(*) FILTER (WHERE timed_slow)::int AS "timedSlowCompleted",
             percentile_disc(0.5) WITHIN GROUP (ORDER BY first_ms - provider_ms) FILTER (WHERE timed_slow) AS "slowBeforeProviderEstimateP50Ms",
             percentile_disc(0.5) WITHIN GROUP (ORDER BY provider_ms) FILTER (WHERE timed_slow) AS "slowProviderToContentP50Ms",
             percentile_disc(0.5) WITHIN GROUP (ORDER BY total_ms - first_ms) FILTER (WHERE timed_slow) AS "slowContentToEndP50Ms"
      FROM (VALUES (24), (168)) AS spans(hours) CROSS JOIN bounds
      LEFT JOIN measured a ON a."createdAt" >= cutoff - hours * INTERVAL '1 hour'
      GROUP BY hours ORDER BY hours
    `;
  });
  return { status: "available" as const, scope: "smart_adaptive_presearch_attempts" as const, asOf, windows: windows.map(row => ({
    ...row, withinTenSecondsRate: row.serverAttempts === 0 ? null : row.withinTenSeconds / row.serverAttempts,
  })) };
}
