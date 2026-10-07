import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/amux/auditContract";
import { rollupAmuxCliUsageFacts, type AmuxCliUsageFact } from
  "@/lib/amux/cliUsageAggregateCore";
import { prisma } from "@/lib/prisma";

type Group = Omit<AmuxCliUsageFact, "calls" | "reportedCalls" | "projectedCalls"> & {
  calls: bigint;
  reportedCalls: bigint;
  projectedCalls: bigint;
};

const safeCount = (count: bigint): number => {
  if (count < BigInt(0) || count > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("cli_usage_count_overflow");
  return Number(count);
};

/** Finalize a complete calendar-year cohort before removing its first raw row.
 * The advisory lock serializes concurrent retention workers without locking
 * unrelated years. The batch marker prevents recomputing a partial year. */
async function finalizeCohort(tx: Prisma.TransactionClient, year: number):
  Promise<number> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(69114, ${year})::TEXT`;
  const existing = await tx.amuxCliUsageAggregateCohort.findUnique({
    where: { cohortYear: year }, select: { cohortYear: true },
  });
  if (existing) return 0;
  const nextYear = year + 1;
  const groups = await tx.$queryRaw<Group[]>`
    SELECT to_char(e."createdAt", 'YYYY-MM') AS month,
      e."provider" AS provider,
      COALESCE(e."actualModelId", 'unknown') AS model,
      COALESCE(CASE WHEN e."bindingKind" = 'idea_analysis'
        THEN 'analysis' ELSE w."taskRole" END, 'unknown') AS role,
      COUNT(*)::BIGINT AS calls,
      COUNT(e."inputTokens")::BIGINT AS "reportedCalls",
      COALESCE(SUM(e."inputTokens"), 0)::BIGINT AS "inputTokens",
      COALESCE(SUM(e."outputTokens"), 0)::BIGINT AS "outputTokens",
      COALESCE(SUM(e."cacheReadInputTokens"), 0)::BIGINT AS "cacheReadInputTokens",
      COALESCE(SUM(e."cacheCreationInputTokens"), 0)::BIGINT AS "cacheCreationInputTokens",
      COALESCE(SUM(e."projectedApiCostMicrousd"), 0)::BIGINT AS "projectedApiCostMicrousd",
      COUNT(e."projectedApiCostMicrousd")::BIGINT AS "projectedCalls"
    FROM "AmuxCliUsageEvent" e
    LEFT JOIN "AmuxWorkItem" w ON w."id" = e."taskId"
    WHERE e."createdAt" >= make_date(${year}, 1, 1)
      AND e."createdAt" < make_date(${nextYear}, 1, 1)
    GROUP BY month, e."provider", model, role
  `;
  const facts = groups.map((group) => ({ ...group,
    calls: safeCount(group.calls),
    reportedCalls: safeCount(group.reportedCalls),
    projectedCalls: safeCount(group.projectedCalls),
  }));
  const total = facts.reduce((sum, fact) => sum + fact.calls, 0);
  if (!Number.isSafeInteger(total) || total === 0) throw new Error("empty_cli_usage_cohort");
  const cells = rollupAmuxCliUsageFacts(facts);
  // One creation timestamp keeps the 36-month expiry exact in the DB guard.
  const cohort = await tx.$queryRaw<Array<{ createdAt: Date;
    retentionUntil: Date }>>`
    INSERT INTO "AmuxCliUsageAggregateCohort"
      ("cohortYear", "publishedCells", "createdAt", "retentionUntil")
    VALUES (${year}, ${cells.length},
      CURRENT_TIMESTAMP::timestamp(3),
      CURRENT_TIMESTAMP::timestamp(3) + interval '36 months')
    RETURNING "createdAt", "retentionUntil"`;
  if (cohort.length !== 1) throw new Error("cohort_not_created");
  const { createdAt, retentionUntil } = cohort[0];
  for (const cell of cells) {
    await tx.amuxCliUsageAggregate.create({ data: {
      id: randomUUID(), cohortYear: year, provider: cell.provider,
      grain: cell.grain, periodStart: new Date(`${cell.periodStart}-01T00:00:00.000Z`),
      model: cell.model, role: cell.role, calls: cell.calls,
      reportedCalls: cell.reportedCalls,
      inputTokens: cell.inputTokens, outputTokens: cell.outputTokens,
      cacheReadInputTokens: cell.cacheReadInputTokens,
      cacheCreationInputTokens: cell.cacheCreationInputTokens,
      projectedApiCostMicrousd: cell.projectedApiCostMicrousd,
      projectedCalls: cell.projectedCalls, createdAt, retentionUntil,
    } });
  }
  await writeSystemAuditLog({ tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
    action: "amux.cli_usage.aggregate_finalized",
    targetType: "AmuxCliUsageAggregateCohort", targetId: String(year),
    summary: "Finalized deidentified AMUX CLI usage cells before raw-row expiry.",
    metadata: { cohortYear: year, publishedCells: cells.length,
      minimumCallsPerCell: 5 },
  });
  return cells.length;
}

/** Bounded purge, independent of model dispatch. Never deletes a raw call
 * before its entire closed-year aggregate has been finalized or suppressed. */
export async function purgeExpiredAmuxCliUsageInTransaction(
  tx: Prisma.TransactionClient,
) {
    await tx.$executeRaw`SET LOCAL statement_timeout = '15s'`;
    const due = await tx.$queryRaw<Array<{ year: number }>>`
      SELECT EXTRACT(YEAR FROM MIN("createdAt"))::INTEGER AS year
      FROM "AmuxCliUsageEvent"
      WHERE "retentionUntil" <= clock_timestamp()`;
    const year = due[0]?.year;
    let aggregated = 0;
    let deleted = 0;
    if (year !== null && year !== undefined) {
      aggregated = await finalizeCohort(tx, year);
      const removed = await tx.$queryRaw<Array<{ id: string }>>`
        DELETE FROM "AmuxCliUsageEvent"
        WHERE "id" IN (
          SELECT "id" FROM "AmuxCliUsageEvent"
          WHERE "retentionUntil" <= clock_timestamp()
            AND "createdAt" >= make_date(${year}, 1, 1)
            AND "createdAt" < make_date(${year + 1}, 1, 1)
          ORDER BY "retentionUntil", "id"
          LIMIT 100 FOR UPDATE SKIP LOCKED
        ) RETURNING "id"`;
      deleted = removed.length;
    }
    // These cells already outlived the separate 36-month long-term period.
    const oldCells = await tx.$queryRaw<Array<{ id: string }>>`
      DELETE FROM "AmuxCliUsageAggregate"
      WHERE "id" IN (SELECT "id" FROM "AmuxCliUsageAggregate"
        WHERE "retentionUntil" <= clock_timestamp()
        ORDER BY "retentionUntil", "id"
        LIMIT 100 FOR UPDATE SKIP LOCKED) RETURNING "id"`;
    const oldCohorts = await tx.$queryRaw<Array<{ cohortYear: number }>>`
      DELETE FROM "AmuxCliUsageAggregateCohort"
      WHERE "cohortYear" IN (SELECT c."cohortYear"
        FROM "AmuxCliUsageAggregateCohort" c
        WHERE c."retentionUntil" <= clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM "AmuxCliUsageAggregate" a
            WHERE a."cohortYear" = c."cohortYear")
        ORDER BY c."retentionUntil", c."cohortYear"
        LIMIT 100 FOR UPDATE SKIP LOCKED)
      RETURNING "cohortYear"`;
    if (deleted || oldCells.length || oldCohorts.length) {
      await writeSystemAuditLog({ tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
        action: "amux.cli_usage.retention_purged",
        targetType: "AmuxCliUsageRetentionBatch", targetId: randomUUID(),
        summary: "Purged expired content-free AMUX CLI usage data.",
        metadata: { rawMonths: 13, aggregateMonths: 36 },
      });
    }
    return { deleted, aggregated,
      deletedAggregates: oldCells.length, deletedCohorts: oldCohorts.length };
}

export async function purgeExpiredAmuxCliUsage() {
  return prisma.$transaction(purgeExpiredAmuxCliUsageInTransaction,
    { maxWait: 5_000, timeout: 20_000 });
}
