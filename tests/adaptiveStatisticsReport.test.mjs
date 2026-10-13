import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;
const calls = [];
const prisma = {
  promptRefinerProductExecutionReceipt: {
    findMany: async (options) => { calls.push(["refiner", options]); return []; },
  },
  routingRun: {
    findMany: async (options) => { calls.push(["router", options]); return []; },
    count: async (options) => { calls.push(["unattributed", options]); return 0; },
  },
  chatAttemptUsage: {
    findMany: async () => { throw new Error("empty Router result must not scan usage"); },
  },
};
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma } });

test("the report reads only content-free columns and distinguishes missing denominators", async () => {
  const { getAdaptiveStatisticsReport } = await import(mod("lib/adaptiveStatisticsReport.ts"));
  const report = await getAdaptiveStatisticsReport(7, new Date("2026-10-13T00:00:00.000Z"));
  assert.equal(report.coverage.allChatTurns, null);
  assert.equal(report.coverage.allAutoRequests, null);
  assert.equal(report.coverage.providerUsageTruncated, false);
  const refiner = calls.find(([name]) => name === "refiner")[1];
  const router = calls.find(([name]) => name === "router")[1];
  assert.equal(refiner.where.completedAt.gte.toISOString(), "2026-10-06T00:00:00.000Z");
  assert.equal(refiner.take, 10_001);
  assert.equal(router.where.mode, "auto");
  assert.equal(router.take, 10_001);
  const selected = JSON.stringify([refiner.select, router.select]);
  for (const forbidden of ["content", "prompt", "message", "subjectKey", "traceId", "userId", "conversationId", "requestId"]) {
    assert.equal(selected.includes(`"${forbidden}"`), false, `selected ${forbidden}`);
  }
});
