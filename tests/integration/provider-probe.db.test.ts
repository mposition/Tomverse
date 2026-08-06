import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import {
  recordProviderFailure,
  recordProviderProbeFailure,
  recordProviderProbeSuccess,
  recordProviderSuccess,
} from "@/lib/providerMonitoring";
import {
  getProbeUsageCostTodayMicroUsd,
  recordInternalProviderUsage,
} from "@/lib/providerUsageAccounting";
import { prisma } from "@/lib/prisma";

const resetProviderProbeTestData = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ProviderProbeResult",
      "ProviderHealthState",
      "ScheduledJobRun",
      "ProviderDailyUsage",
      "ChatUsageBucket"
    RESTART IDENTITY CASCADE
  `);

beforeEach(resetProviderProbeTestData);
after(async () => {
  await resetProviderProbeTestData();
  await prisma.$disconnect();
});

test("recordProviderProbeSuccess only touches the probe-specific ProviderHealthState fields", async () => {
  await recordProviderProbeSuccess("openai");

  const state = await prisma.providerHealthState.findUniqueOrThrow({
    where: { provider: "openai" },
  });
  assert.ok(state.lastProbeSuccessAt);
  assert.equal(state.consecutiveProbeFailures, 0);
  // Real-traffic fields must remain completely untouched by probe evidence.
  assert.equal(state.lastSuccessAt, null);
  assert.equal(state.lastFailureAt, null);
  assert.equal(state.consecutiveFailures, 0);
});

test("recordProviderProbeFailure increments consecutiveProbeFailures without touching real-traffic fields", async () => {
  await recordProviderProbeFailure("anthropic");
  await recordProviderProbeFailure("anthropic");

  const state = await prisma.providerHealthState.findUniqueOrThrow({
    where: { provider: "anthropic" },
  });
  assert.equal(state.consecutiveProbeFailures, 2);
  assert.ok(state.lastProbeFailureAt);
  assert.equal(state.lastSuccessAt, null);
  assert.equal(state.lastFailureAt, null);
  assert.equal(state.consecutiveFailures, 0);
});

test("a probe success resets consecutiveProbeFailures back to zero", async () => {
  await recordProviderProbeFailure("google");
  await recordProviderProbeFailure("google");
  await recordProviderProbeSuccess("google");

  const state = await prisma.providerHealthState.findUniqueOrThrow({
    where: { provider: "google" },
  });
  assert.equal(state.consecutiveProbeFailures, 0);
  assert.ok(state.lastProbeSuccessAt);
});

test("real-traffic recording never touches the probe-specific fields (reverse direction)", async () => {
  await recordProviderProbeSuccess("groq");
  const afterProbe = await prisma.providerHealthState.findUniqueOrThrow({
    where: { provider: "groq" },
  });

  await recordProviderSuccess("groq");
  // A code from PROVIDER_CALL_DIAGNOSTIC_ROOTS, not an invented one. STG-R002
  // made `recordProviderFailure` classify before it writes: a code that does
  // not describe a completed provider round trip is a local rejection, is
  // scoped `none`, and deliberately writes no health state at all. This test
  // is about probe fields surviving *real traffic*, so it has to send real
  // traffic -- with a made-up code it asserted nothing and failed.
  await recordProviderFailure("groq", "AI_REQUEST_FAILED.503");

  const afterRealTraffic = await prisma.providerHealthState.findUniqueOrThrow({
    where: { provider: "groq" },
  });
  assert.equal(
    afterRealTraffic.lastProbeSuccessAt?.getTime(),
    afterProbe.lastProbeSuccessAt?.getTime()
  );
  assert.equal(afterRealTraffic.consecutiveProbeFailures, 0);
  assert.ok(afterRealTraffic.lastSuccessAt);
  assert.ok(afterRealTraffic.lastFailureAt);
});

test("ProviderProbeResult rows persist the expected shape for a successful attempt", async () => {
  const runId = randomUUID();
  await prisma.providerProbeResult.create({
    data: {
      runId,
      provider: "openai",
      modelId: "gpt-5-4-mini",
      environment: "test",
      startedAt: new Date(),
      completedAt: new Date(),
      success: true,
      timedOut: false,
      latencyMs: 250,
    },
  });

  const rows = await prisma.providerProbeResult.findMany({ where: { runId } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].success, true);
  assert.equal(rows[0].errorClassification, null);
  assert.equal(rows[0].diagnosticCode, null);
});

test("ProviderProbeResult rows persist a public-safe classification for a failed attempt", async () => {
  const runId = randomUUID();
  await prisma.providerProbeResult.create({
    data: {
      runId,
      provider: "mistral",
      modelId: "mistral-small-4",
      environment: "test",
      startedAt: new Date(),
      completedAt: new Date(),
      success: false,
      timedOut: false,
      latencyMs: 9_800,
      errorClassification: "SERVER_ERROR",
      diagnosticCode: "PROVIDER_PROBE_FAILED.Error.HTTP_503",
    },
  });

  const stored = await prisma.providerProbeResult.findFirstOrThrow({ where: { runId } });
  assert.equal(stored.errorClassification, "SERVER_ERROR");
  assert.ok(!stored.diagnosticCode?.toLowerCase().includes("apikey"));
});

test("two near-simultaneous provider_probe scheduled-job starts within the overlap window are both visible to a findFirst guard query", async () => {
  const now = new Date();
  const first = await prisma.scheduledJobRun.create({
    data: { jobKey: "provider_probe", status: "running", startedAt: now },
  });

  // Simulates the route's overlap guard: a second near-simultaneous
  // invocation queries for any run started within the last 5 minutes
  // before starting its own -- it must find the first run and skip.
  const guardQuery = await prisma.scheduledJobRun.findFirst({
    where: {
      jobKey: "provider_probe",
      startedAt: { gte: new Date(now.getTime() - 5 * 60 * 1_000) },
    },
    select: { id: true },
  });
  assert.equal(guardQuery?.id, first.id);
});

test("getProbeUsageCostTodayMicroUsd only sums source=probe usage, ignoring internal and provider_api rows", async () => {
  const today = new Date();

  await recordInternalProviderUsage({
    provider: "openai",
    modelId: "gpt-5-4-mini",
    inputTokens: 1_000_000,
    cachedInputTokens: 0,
    outputTokens: 1_000_000,
    estimatedCostMicroUsd: 500_000,
    uncachedInputCostMicroUsd: 250_000,
    cachedInputCostMicroUsd: 0,
    outputCostMicroUsd: 250_000,
    date: today,
    source: "internal",
  });
  await recordInternalProviderUsage({
    provider: "openai",
    modelId: "gpt-5-4-mini",
    inputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 5,
    estimatedCostMicroUsd: 42,
    uncachedInputCostMicroUsd: 20,
    cachedInputCostMicroUsd: 0,
    outputCostMicroUsd: 22,
    date: today,
    source: "probe",
  });
  await recordInternalProviderUsage({
    provider: "anthropic",
    modelId: "claude-haiku-4-5",
    inputTokens: 8,
    cachedInputTokens: 0,
    outputTokens: 4,
    estimatedCostMicroUsd: 18,
    uncachedInputCostMicroUsd: 10,
    cachedInputCostMicroUsd: 0,
    outputCostMicroUsd: 8,
    date: today,
    source: "probe",
  });

  const totalProbeCost = await getProbeUsageCostTodayMicroUsd(today);
  assert.equal(totalProbeCost, 42 + 18);
});
