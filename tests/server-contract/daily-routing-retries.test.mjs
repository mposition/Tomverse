import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {} } });
mock.module(mod("lib/adminAudit.ts"), { namedExports: { takeAuditChainLock: async () => {} } });
mock.module(mod("lib/autoRouterOptimizer.ts"), { namedExports: { OPTIMIZER_LOCK: "test" } });
const audits = [];
mock.module(mod("lib/autoRouterRecAgentSystemAudit.ts"), { namedExports: { writeAutoRouterRecAgentSystemAudit: async (_tx, entry) => audits.push(entry) } });
const { claimRecommendationInTransaction } = await import(mod("lib/autoRouterRecAgent.ts"));
const now = new Date("2026-11-15T00:00:00Z");
const failed = { status: "failed", reason: "tests", at: "2026-11-13T00:00:00Z", by: "auto-router-rec-agent", claimId: "11111111-2222-4333-8444-555555555555" };
let summary;
const tx = {
  appSetting: { findUnique: async () => ({ value: JSON.stringify({ enabled: true }) }) },
  autoRouterOptimizerCycle: {
    findMany: async () => [{ id: "cycle", createdAt: new Date("2026-11-10"), summary }],
    update: async ({ data }) => { summary = data.summary; },
  },
};
test.beforeEach(() => {
  summary = { report: { recommendations: [{ kind: "code", text: "Fix it" }], findings: [] }, recommendationStatus: { 0: { ...failed } } };
  audits.length = 0;
});

test("routing retries are opt-in on the daily path and retain attempts and claim fencing", async () => {
  assert.equal(await claimRecommendationInTransaction(tx, "https://test.invalid", now), null);
  const result = await claimRecommendationInTransaction(tx, "https://test.invalid", now, { automaticRetries: true });
  assert.notEqual(result.claimId, failed.claimId);
  assert.equal(summary.recommendationStatus[0].attempts, 2);
  assert.equal(audits[0].metadata.priorClaimId, failed.claimId);
  assert.match(result.instruction, /Retry attempt 2\/3/);
  assert.equal(await claimRecommendationInTransaction(tx, "https://test.invalid", now, { automaticRetries: true }), null);
});

test("routing new work takes precedence and human dispositions cannot be retried", async () => {
  summary.report.recommendations.push({ kind: "code", text: "New work" });
  const result = await claimRecommendationInTransaction(tx, "https://test.invalid", now, { automaticRetries: true });
  assert.equal(result.index, 1);
  for (const patch of [{ status: "done" }, { status: "dismissed" }, { status: "sent_to_amux" }, { attempts: 3 }, { attempts: "bad" }, { reason: "review_unknown" }, { reason: "pr_failed" }, { amuxIdeaId: "reserved" }]) {
    summary.recommendationStatus[0] = { ...failed, ...patch };
    assert.equal(await claimRecommendationInTransaction(tx, "https://test.invalid", now, { automaticRetries: true }), null, JSON.stringify(patch));
  }
});

test("a malformed stored routing claim is not treated as new open work", async () => {
  for (const value of [{ ...failed, by: null }, { status: "broken" }, "corrupt"]) {
    summary.recommendationStatus[0] = value;
    assert.equal(await claimRecommendationInTransaction(tx, "https://test.invalid", now, { automaticRetries: true }), null);
  }
});

test("an exact linked recovery PR suppresses both open work and next-day retries without a new claim", async () => {
  const options = { automaticRetries: true, coveredTaskIds: new Set(["cycle:0"]) };
  assert.equal(await claimRecommendationInTransaction(tx, "https://test.invalid", now, options), null);
  assert.equal(summary.recommendationStatus[0].claimId, failed.claimId);
  assert.equal(audits.length, 0);
  delete summary.recommendationStatus[0];
  assert.equal(await claimRecommendationInTransaction(tx, "https://test.invalid", now, options), null);
  summary.report.recommendations.push({ kind: "code", text: "Next task" });
  const next = await claimRecommendationInTransaction(tx, "https://test.invalid", now, options);
  assert.equal(next.id, "cycle:1");
});
