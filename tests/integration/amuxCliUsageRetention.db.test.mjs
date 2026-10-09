import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const raw = process.env.TEST_DATABASE_URL;
const allowed = (() => {
  if (!raw || process.env.DATABASE_URL !== raw) return false;
  const value = new URL(raw);
  return ["localhost", "127.0.0.1"].includes(value.hostname) &&
    /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(value.pathname);
})();

test("expired raw calls finalize a k>=5 closed-year cohort before deletion", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const [{ prisma }, { purgeExpiredAmuxCliUsageInTransaction }] = await Promise.all([
    import("../../lib/prisma.ts"),
    import("../../lib/amux/cliUsageRetention.ts"),
  ]);
  const rollback = new Error("synthetic retention rollback");
  try {
    await assert.rejects(prisma.$transaction(async (tx) => {
      const taskId = `amux-usage-task-${randomUUID()}`;
      const attemptId = randomUUID();
      await tx.amuxWorkItem.create({ data: {
        id: taskId, title: "retention fixture", status: "doing",
        kind: "code", priority: "p3",
      } });
      await tx.amuxExecutionAttempt.create({ data: {
        id: attemptId, taskId, worker: "worker-retention",
        workerInstanceId: "fixture", workerGeneration: 1,
        taskRevision: 1, startedAt: new Date(), heartbeatAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
      } });
      for (let index = 0; index < 5; index += 1) {
        await tx.$executeRaw`
          INSERT INTO "AmuxCliUsageEvent" (
            "id", "invocationId", "receiptDigest", "bindingKind", "attemptId",
            "taskId", "worker", "cli", "provider", "selectedModelId",
            "actualModelId", "authentication", "startedAt", "endedAt", "status",
            "completeness", "source", "inputTokens", "outputTokens",
            "cacheReadInputTokens", "inputTokensIncludeCacheRead",
            "inputTokensIncludeCacheWrite", "completedTurns",
            "createdAt", "retentionUntil") VALUES (
            ${randomUUID()}, ${randomUUID()}, ${"a".repeat(64)},
            'task_attempt', ${attemptId}, ${taskId}, 'worker-retention',
            'claude', 'anthropic', 'claude-opus-5', 'claude-opus-5',
            'subscription', TIMESTAMP '2020-01-01', TIMESTAMP '2020-01-01',
            'succeeded', 'reported_complete', 'claude_result', 100, 20,
            10, false, false, 1, TIMESTAMP '2020-01-01',
            TIMESTAMP '2020-01-01' + interval '13 months')`;
      }
      const result = await purgeExpiredAmuxCliUsageInTransaction(tx);
      assert.equal(result.deleted, 5);
      assert.equal(result.aggregated, 1);
      const cells = await tx.amuxCliUsageAggregate.findMany({
        where: { cohortYear: 2020 },
      });
      assert.equal(cells.length, 1);
      assert.equal(cells[0].calls, 5);
      assert.equal(cells[0].inputTokens, 500n);
      assert.equal(cells[0].grain, "month_role_model");
      const cohort = await tx.amuxCliUsageAggregateCohort.findUnique({
        where: { cohortYear: 2020 },
      });
      assert.equal(cohort?.publishedCells, 1);
      // A different year with one call must be purged without a token cell.
      await tx.$executeRaw`
        INSERT INTO "AmuxCliUsageEvent" (
          "id", "invocationId", "receiptDigest", "bindingKind", "attemptId",
          "taskId", "worker", "cli", "provider", "selectedModelId",
          "actualModelId", "authentication", "startedAt", "endedAt", "status",
          "completeness", "source", "inputTokens", "outputTokens",
          "cacheReadInputTokens", "inputTokensIncludeCacheRead",
          "inputTokensIncludeCacheWrite", "completedTurns",
          "createdAt", "retentionUntil") VALUES (
          ${randomUUID()}, ${randomUUID()}, ${"b".repeat(64)},
          'task_attempt', ${attemptId}, ${taskId}, 'worker-retention',
          'claude', 'anthropic', 'claude-opus-5', 'claude-opus-5',
          'subscription', TIMESTAMP '2021-01-01', TIMESTAMP '2021-01-01',
          'succeeded', 'reported_complete', 'claude_result', 300, 40,
          10, false, false, 1, TIMESTAMP '2021-01-01',
          TIMESTAMP '2021-01-01' + interval '13 months')`;
      const suppressed = await purgeExpiredAmuxCliUsageInTransaction(tx);
      assert.equal(suppressed.deleted, 1);
      assert.equal(suppressed.aggregated, 0);
      assert.equal((await tx.amuxCliUsageAggregateCohort.findUnique({
        where: { cohortYear: 2021 },
      }))?.publishedCells, 0);
      assert.equal(await tx.amuxCliUsageAggregate.count({
        where: { cohortYear: 2021 },
      }), 0);
      // A past 36-month cell and its witness are purged in the same pass.
      await tx.$executeRaw`
        INSERT INTO "AmuxCliUsageAggregateCohort"
          ("cohortYear", "publishedCells", "createdAt", "retentionUntil")
        VALUES (2022, 1, TIMESTAMP '2022-01-01',
          TIMESTAMP '2022-01-01' + interval '36 months')`;
      await tx.$executeRaw`
        INSERT INTO "AmuxCliUsageAggregate" (
          "id", "cohortYear", "provider", "grain", "periodStart",
          "model", "role", "calls", "reportedCalls", "inputTokens",
          "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens",
          "projectedApiCostMicrousd", "projectedCalls", "createdAt",
          "retentionUntil") VALUES (${randomUUID()}, 2022, 'anthropic',
          'month_role_model', DATE '2022-01-01', 'claude-opus-5', 'develop',
          5, 5, 500, 100, 0, 0, 0, 0, TIMESTAMP '2022-01-01',
          TIMESTAMP '2022-01-01' + interval '36 months')`;
      const longTermPurge = await purgeExpiredAmuxCliUsageInTransaction(tx);
      assert.equal(longTermPurge.deletedAggregates, 1);
      assert.equal(longTermPurge.deletedCohorts, 1);
      assert.equal(await tx.amuxCliUsageAggregateCohort.findUnique({
        where: { cohortYear: 2022 },
      }), null);
      throw rollback;
    }, { timeout: 20_000 }), (error) => error === rollback);
  } finally { await prisma.$disconnect(); }
});
