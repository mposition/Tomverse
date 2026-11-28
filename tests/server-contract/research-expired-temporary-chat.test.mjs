import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
process.env.RESEARCH_ENGINE_ENABLED = "true";

// The service compares against the real clock (new Date()).
const NOW = new Date();
const PAST = new Date(NOW.getTime() - 60_000);
const FUTURE = new Date(NOW.getTime() + 3_600_000);
let conversationExpiry = null;
let stepsAfterGuard;

const row = () => ({
  id: "run-1", userId: "owner", conversationId: "conv-1", engineVersion: 2, status: "paused", approvedCredits: 100, approvedPlanRevision: null,
  planRevision: 1, inputRevision: 0, currentReportRevision: 1, cancelRequestedAt: null, pauseRequestedAt: null, pausedAt: null,
  conversation: { password: null, passwordVersion: 0, temporaryExpiresAt: conversationExpiry },
});
const tx = {
  researchPreviewRun: { findFirst: async () => { stepsAfterGuard.push("load-run"); return row(); } },
  researchWorkItem: { count: async () => 0, updateMany: async () => ({ count: 0 }) },
  researchPlanRevision: { findUniqueOrThrow: async () => { throw Object.assign(new Error("past the guard"), { pastGuard: true }); } },
};
// The plan and switch checks import their modules dynamically; where a runner does not
// apply the module mocks below to that import (seen on CI's Node 22.23), the real readers
// run against this client. It answers them as a Pro account with nothing stored: any other
// table reads as empty, so the real readers fall back to their defaults.
const emptyTable = { findMany: async () => [], findFirst: async () => null, findUnique: async () => null };
const prismaClient = new Proxy({
  $transaction: async (run) => run(tx),
  researchPreviewRun: tx.researchPreviewRun,
  user: {
    findUnique: async () => ({
      plan: "Pro", subscriptionStatus: "active", subscriptionCurrentPeriodEnd: FUTURE,
      webSubscriptionPlan: null, storeSubscriptionPlan: null, storeSubscriptionExpiresAt: null, storeSubscriptionSnapshot: null,
    }),
  },
}, { get: (target, key) => (key in target ? target[key] : typeof key === "string" && !key.startsWith("$") ? emptyTable : undefined) });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: prismaClient } });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: { assertConversationCapacity: async () => {}, assertMessageCapacity: async () => {}, ApiSecurityError: class extends Error {} } });
mock.module(mod("lib/researchEngineStore.ts"), { namedExports: {
  lockResearchRun: async () => {},
  bumpRunSequence: async () => { throw Object.assign(new Error("past the guard"), { pastGuard: true }); },
  enqueueResearchWorkItems: async () => { throw Object.assign(new Error("past the guard"), { pastGuard: true }); },
  readResearchRunMoney: async () => ({}),
} });
mock.module(mod("lib/researchEngineWorker.ts"), { namedExports: {
  advanceResearchRun: async () => {}, createPublicRedaction: async () => {}, providerFor: () => "provider",
  researchRunDeadline: () => NOW, startResearchFromPlan: async () => { throw Object.assign(new Error("past the guard"), { pastGuard: true }); },
} });
mock.module(mod("lib/researchEngineRuntime.ts"), { namedExports: { researchNow: () => NOW } });
mock.module(mod("lib/billingEntitlements.ts"), { namedExports: { getUserBillingPlan: async () => ({ tier: "Pro" }) } });
mock.module(mod("lib/appSettings.ts"), { namedExports: { getOperationalFeatureFlags: async () => ({ aiChatEnabled: true }) } });

const service = await import("../../lib/researchEngineService.ts");
const request = new Request("https://tomverse.app/api/chat/research/runs/run-1");
const base = { request, userId: "owner", runId: "run-1" };

// Every path that puts a research run (back) into execution, so provider calls follow.
const startsWork = {
  requestResearchPlan: () => service.requestResearchPlan({ ...base, expectedPlanRevision: 1 }),
  approveResearchPlan: () => service.approveResearchPlan({ ...base, planRevision: 1 }),
  resumeResearchRun: () => service.resumeResearchRun(base),
  extendResearchBudget: () => service.extendResearchBudget({ ...base, expectedApprovedCredits: 100, approvedCredits: 200 }),
  finishResearchNow: () => service.finishResearchNow(base),
  amendResearchScope: () => service.amendResearchScope({ ...base, amendment: { expectedInputRevision: 0, addQuestions: ["q"], excludeSourceKeys: [], excludeDomains: [] } }),
  requestResearchRevision: () => service.requestResearchRevision({ ...base, revision: { kind: "format", expectedReportRevision: 1, sectionKeys: [], instruction: "shorter" } }),
};
const expired = (error) => error?.code === "TEMPORARY_CHAT_EXPIRED" && error?.status === 410;

for (const [name, call] of Object.entries(startsWork)) {
  test(`${name} refuses an expired temporary Chat before any work starts`, async () => {
    stepsAfterGuard = [];
    conversationExpiry = PAST;
    await assert.rejects(call(), expired);
  });
  test(`${name} still works in an ordinary or unexpired temporary conversation`, async () => {
    for (const expiry of [null, FUTURE]) {
      stepsAfterGuard = [];
      conversationExpiry = expiry;
      // It gets past the guard: whatever it does next, it is not this refusal.
      await call().then(() => {}, (error) => assert.ok(!expired(error), `${name} ${expiry}`));
    }
  });
}

test("pause, cancel and delete never start work, so an expired temporary Chat does not stop them", async () => {
  conversationExpiry = PAST;
  for (const call of [() => service.pauseResearchRun(base), () => service.cancelResearchRun(base), () => service.deleteResearchRun(base)]) {
    stepsAfterGuard = [];
    await call().then(() => {}, (error) => assert.ok(!expired(error)));
    assert.ok(stepsAfterGuard.includes("load-run"));
  }
});
