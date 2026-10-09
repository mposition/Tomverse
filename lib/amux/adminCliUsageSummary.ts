import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type AmuxCliUsageSummaryRow = {
  worker: string;
  model: string;
  round: number | null;
  recorded: number;
  usageUnknown: number;
  noReceiptAttempts: number;
  /** Lower-bound fraction; unseen invocations cannot be counted. */
  unmeasuredRateLowerBound: number;
  reportedInputTokens: string;
  reportedOutputTokens: string;
  reportedCacheReadTokens: string;
  reportedCacheWriteTokens: string;
  cacheWriteReports: number;
  knownProjectedApiCostMicrousd: string;
  pricedCalls: number;
};

export function amuxCliUnmeasuredRateLowerBound(
  recorded: number, unknown: number, noReceiptAttempts: number,
): number {
  const denominator = recorded + noReceiptAttempts;
  return denominator === 0 ? 0 :
    (unknown + noReceiptAttempts) / denominator;
}

export async function readAmuxCliUsageSummaryForAdmin(
  db: Pick<Prisma.TransactionClient, "$queryRaw"> = prisma,
): Promise<{
  windowDays: number;
  rows: AmuxCliUsageSummaryRow[];
  /** Lower bound: attempts with no row + rows whose usage is unknown. A single
   * attempt may make multiple unreported CLI calls, so never call this exact. */
  unmeasuredLowerBound: number;
  recorded: number;
}> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const facts = await db.$queryRaw<Array<Omit<AmuxCliUsageSummaryRow,
    "unmeasuredRateLowerBound">>>`
    WITH facts AS (
      SELECT e."worker", COALESCE(e."actualModelId", 'unknown') AS model,
        a."attemptNumber" AS round, 1 AS recorded,
        CASE WHEN e."completeness" <> 'reported_complete' THEN 1 ELSE 0 END AS unknown,
        0 AS missing, e."inputTokens" AS input_tokens,
        e."outputTokens" AS output_tokens,
        e."cacheReadInputTokens" AS cache_read_tokens,
        e."cacheCreationInputTokens" AS cache_write_tokens,
        e."projectedApiCostMicrousd" AS projected_cost
      FROM "AmuxCliUsageEvent" e
      LEFT JOIN "AmuxExecutionAttempt" a ON a."id" = e."attemptId"
      WHERE e."createdAt" >= ${since}
      UNION ALL
      SELECT a."worker", 'unknown' AS model, a."attemptNumber" AS round,
        0 AS recorded, 0 AS unknown, 1 AS missing,
        NULL::BIGINT AS input_tokens, NULL::BIGINT AS output_tokens,
        NULL::BIGINT AS cache_read_tokens,
        NULL::BIGINT AS cache_write_tokens,
        NULL::BIGINT AS projected_cost
      FROM "AmuxExecutionAttempt" a
      WHERE a."startedAt" >= ${since}
        AND a."endedAt" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "AmuxCliUsageEvent" e
          WHERE e."attemptId" = a."id")
      UNION ALL
      SELECT 'amux-intake' AS worker, h."modelId" AS model,
        NULL::INTEGER AS round, 0 AS recorded, 0 AS unknown, 1 AS missing,
        NULL::BIGINT AS input_tokens, NULL::BIGINT AS output_tokens,
        NULL::BIGINT AS cache_read_tokens,
        NULL::BIGINT AS cache_write_tokens,
        NULL::BIGINT AS projected_cost
      FROM "AmuxIdeaAnalysisBudgetHold" h
      WHERE h."dispatchedAt" >= ${since}
        AND h."closedAt" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "AmuxCliUsageEvent" e
          WHERE e."analysisHoldId" = h."id")
    )
    SELECT worker, model, round, SUM(recorded)::INTEGER AS recorded,
      SUM(unknown)::INTEGER AS "usageUnknown",
      SUM(missing)::INTEGER AS "noReceiptAttempts",
      COALESCE(SUM(input_tokens), 0)::TEXT AS "reportedInputTokens",
      COALESCE(SUM(output_tokens), 0)::TEXT AS "reportedOutputTokens",
      COALESCE(SUM(cache_read_tokens), 0)::TEXT AS "reportedCacheReadTokens",
      COALESCE(SUM(cache_write_tokens), 0)::TEXT AS "reportedCacheWriteTokens",
      COUNT(cache_write_tokens)::INTEGER AS "cacheWriteReports",
      COALESCE(SUM(projected_cost), 0)::TEXT AS "knownProjectedApiCostMicrousd",
      COUNT(projected_cost)::INTEGER AS "pricedCalls"
    FROM facts GROUP BY worker, model, round
    ORDER BY SUM(unknown + missing) DESC, worker, model, round
  `;
  const rows = facts.map((row) => ({ ...row,
    unmeasuredRateLowerBound: amuxCliUnmeasuredRateLowerBound(
      row.recorded, row.usageUnknown, row.noReceiptAttempts),
  }));
  return { windowDays: 30, rows,
    unmeasuredLowerBound: rows.reduce((sum, row) => sum +
      row.usageUnknown + row.noReceiptAttempts, 0),
    recorded: rows.reduce((sum, row) => sum + row.recorded, 0) };
}
