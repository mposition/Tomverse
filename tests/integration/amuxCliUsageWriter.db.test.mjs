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

test("CLI usage writer binds the attempt, deduplicates and audits atomically", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const [{ prisma }, { recordAmuxCliUsage },
    { readAmuxCliUsageSummaryForAdmin }] = await Promise.all([
    import("../../lib/prisma.ts"),
    import("../../lib/amux/cliUsageLedgerStore.ts"),
    import("../../lib/amux/adminCliUsageSummary.ts"),
  ]);
  const rollback = new Error("synthetic rollback");
  try {
    await assert.rejects(prisma.$transaction(async (tx) => {
      const taskId = `amux-usage-task-${randomUUID()}`;
      const attemptId = randomUUID();
      await tx.amuxWorkItem.create({ data: {
        id: taskId, title: "usage writer fixture", status: "doing",
        kind: "code", priority: "p3",
      } });
      await tx.amuxExecutionAttempt.create({ data: {
        id: attemptId, taskId, worker: "worker-a",
        workerInstanceId: "fixture", workerGeneration: 1,
        taskRevision: 1, startedAt: new Date(), heartbeatAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
      } });
      const receipt = {
        version: 1, invocationId: randomUUID(),
        binding: { kind: "task_attempt", attemptId }, worker: "worker-a",
        cli: "claude", provider: "anthropic", selectedModelId: "claude-opus-5",
        actualModelId: "claude-opus-5", cliVersion: "2.1.288",
        authentication: "subscription", startedAt: "2026-10-06T00:00:00.000Z",
        endedAt: "2026-10-06T00:00:01.000Z", status: "failed",
        completeness: "reported_partial", source: "claude_result",
        observed: { inputTokens: 100, outputTokens: 25,
          cacheReadInputTokens: 10, cacheCreationInputTokens: 3,
          reasoningOutputTokens: null },
        inputTokensIncludeCacheRead: false,
        inputTokensIncludeCacheWrite: false,
        reasoningOutputIncludedInOutput: null, completedTurns: 1,
      };
      const first = await recordAmuxCliUsage(tx, receipt);
      assert.equal(first.duplicate, false);
      assert.ok(first.auditId);
      assert.equal((await recordAmuxCliUsage(tx, receipt)).duplicate, true);
      await assert.rejects(recordAmuxCliUsage(tx, { ...receipt,
        observed: { ...receipt.observed, inputTokens: 101 } }),
      /receipt_conflict/);
      const row = await tx.amuxCliUsageEvent.findUnique({
        where: { invocationId: receipt.invocationId },
      });
      assert.equal(row?.taskId, taskId);
      assert.equal(row?.inputTokens, BigInt(100));
      assert.equal(row?.projectedApiCostMicrousd, null);
      const summary = await readAmuxCliUsageSummaryForAdmin(tx);
      const current = summary.rows.find((entry) => entry.worker === "worker-a" &&
        entry.model === "claude-opus-5");
      assert.equal(current?.recorded, 1);
      assert.equal(current?.reportedInputTokens, "100");
      assert.equal(current?.reportedOutputTokens, "25");
      assert.equal(current?.reportedCacheReadTokens, "10");
      assert.equal(current?.reportedCacheWriteTokens, "3");
      assert.equal(current?.knownProjectedApiCostMicrousd, "0");
      assert.equal(current?.pricedCalls, 0);
      assert.equal(await tx.amuxCliUsageEvent.count({
        where: { invocationId: receipt.invocationId },
      }), 1);
      throw rollback;
    }, { timeout: 15_000 }), (error) => error === rollback);
  } finally { await prisma.$disconnect(); }
});
