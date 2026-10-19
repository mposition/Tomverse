import "server-only";

import { Prisma } from "@prisma/client";

import { resolveDeploymentEnvironment } from "@/lib/deploymentEnvironment";
import { prisma } from "@/lib/prisma";

/**
 * The four numbers at the top of the Marketing console: what waits for a
 * person, what the generator has spent against its cap this month, what its
 * latest run did, and which accounts can receive drafts.
 *
 * Each is read on its own and fails on its own: a number that cannot be read
 * is null and the screen says so, never zero (docs/ui-contracts/admin-console-ia.md,
 * rule 8). Counts only -- no draft text, fact value, URL or prompt.
 */
export type MarketingConsoleOverview = {
  /**
   * When this was read, by the server's clock. The screen measures "2 hours
   * ago" from here rather than from the browser's clock, so the page the
   * server renders and the page the browser hydrates say the same thing.
   */
  readAt: string;
  /** The deployment this console belongs to (production, staging, dev...). */
  environment: string;
  pending: { count: number; oldestAt: string | null } | null;
  /**
   * This UTC month's ledger. `countedMicroUsd` is what the monthly cap counts
   * (every reservation not released); `tokenMicroUsd` is the settled calls'
   * reported tokens at their pinned rates -- web search fees are not reported
   * per call and are not in it.
   */
  llm: { calls: number; countedMicroUsd: number; tokenMicroUsd: number } | null;
  /** The newest generator run, or `{ at: null }` when none has run. */
  lastRun:
    | {
        at: string | null;
        calls: number;
        reportAt: string | null;
        factsKept: number | null;
        factsDropped: number | null;
      }
    | null;
  accounts: { total: number; byStatus: Record<string, number> } | null;
  /** Approved competitors: the ones A3 searches. */
  competitors: { approved: number } | null;
};

const settle = async <T>(read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch {
    return null;
  }
};

export async function readMarketingConsoleOverview(): Promise<MarketingConsoleOverview> {
  const readAt = new Date().toISOString();
  const [pending, llm, lastRun, accounts, competitors] = await Promise.all([
    settle(async () => {
      const rows = await prisma.$queryRaw<Array<{ count: number; oldest: Date | null }>>(Prisma.sql`
        SELECT count(*)::int AS "count", min("createdAt") AS "oldest"
        FROM "MarketingPost" WHERE "status" = 'pending_approval'
      `);
      return { count: rows[0]?.count ?? 0, oldestAt: rows[0]?.oldest ? rows[0].oldest.toISOString() : null };
    }),
    settle(async () => {
      const rows = await prisma.$queryRaw<Array<{ calls: number; counted: bigint; tokens: bigint }>>(Prisma.sql`
        SELECT count(*)::int AS "calls",
               COALESCE(sum("reservedMicroUsd") FILTER (WHERE "state" <> 'released'), 0)::bigint AS "counted",
               COALESCE(sum(ceil(
                 (COALESCE("reportedInputTokens", 0) * ("configSnapshot"->'pin'->>'worstInputMicroUsdPerMillion')::numeric
                  + COALESCE("reportedOutputTokens", 0) * ("configSnapshot"->'pin'->>'worstOutputMicroUsdPerMillion')::numeric)
                 / 1000000)) FILTER (WHERE "state" = 'settled'), 0)::bigint AS "tokens"
        FROM "MarketingLlmCall"
        WHERE "monthStart" = date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')
      `);
      return {
        calls: rows[0]?.calls ?? 0,
        countedMicroUsd: Number(rows[0]?.counted ?? 0),
        tokenMicroUsd: Number(rows[0]?.tokens ?? 0),
      };
    }),
    settle(async () => {
      const runs = await prisma.$queryRaw<Array<{ at: Date; calls: number }>>(Prisma.sql`
        SELECT max("createdAt") AS "at", count(*)::int AS "calls"
        FROM "MarketingLlmCall"
        GROUP BY "generatorRunId"
        ORDER BY max("createdAt") DESC
        LIMIT 1
      `);
      const reports = await prisma.$queryRaw<Array<{ at: Date; kept: number | null; dropped: number | null }>>(Prisma.sql`
        SELECT "createdAt" AS "at",
               CASE WHEN jsonb_typeof("payload"->'facts') = 'array' THEN jsonb_array_length("payload"->'facts') END AS "kept",
               CASE WHEN jsonb_typeof("payload"->'unrepresentableFactCount') = 'number'
                    THEN ("payload"->>'unrepresentableFactCount')::int END AS "dropped"
        FROM "MarketingReport" WHERE "kind" = 'market_intel'
        ORDER BY "createdAt" DESC LIMIT 1
      `);
      const run = runs[0];
      const report = reports[0];
      return {
        at: run ? run.at.toISOString() : null,
        calls: run?.calls ?? 0,
        reportAt: report ? report.at.toISOString() : null,
        factsKept: report?.kept ?? null,
        factsDropped: report?.dropped ?? null,
      };
    }),
    settle(async () => {
      const rows = await prisma.$queryRaw<Array<{ status: string; count: number }>>(Prisma.sql`
        SELECT "status", count(*)::int AS "count" FROM "MarketingChannel" GROUP BY "status"
      `);
      const byStatus = Object.fromEntries(rows.map((row) => [row.status, row.count]));
      return { total: rows.reduce((sum, row) => sum + row.count, 0), byStatus };
    }),
    settle(async () => {
      const rows = await prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT count(*)::int AS "count" FROM "MarketingCompetitor" WHERE "status" = 'approved'
      `);
      return { approved: rows[0]?.count ?? 0 };
    }),
  ]);
  return { readAt, environment: resolveDeploymentEnvironment(), pending, llm, lastRun, accounts, competitors };
}
