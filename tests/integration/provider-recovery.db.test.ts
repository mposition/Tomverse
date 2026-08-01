import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma";
import {
  applyVerifiedRecovery,
  claimVerificationSlot,
  getProviderVerificationSummaries,
  recordVerificationResult,
} from "../../lib/providerRecovery";
import { LIVE_VERIFICATION_KIND } from "../../lib/providerRecoveryCore";
import type { ProviderVerificationResult } from "../../lib/providerVerification";

// STG-R002: the durable half of verified provider recovery. These scenarios
// exist because the failure they guard against is silent: a reset that
// happens without evidence, twice, or that fabricates a traffic success looks
// exactly like a correct recovery from the outside.

const PROVIDER = "perplexity" as const;

const resetProviderRecoveryData = async () => {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "ProviderHealthCheck", "ProviderHealthState" RESTART IDENTITY CASCADE
  `);
};

beforeEach(resetProviderRecoveryData);
after(async () => {
  await resetProviderRecoveryData();
  await prisma.$disconnect();
});

const seedBlockedProvider = async ({
  consecutiveFailures = 5,
  lastFailureAt = new Date(Date.now() - 38 * 3_600_000),
  lastSuccessAt = null as Date | null,
} = {}) =>
  prisma.providerHealthState.create({
    data: {
      provider: PROVIDER,
      consecutiveFailures,
      lastFailureAt,
      lastSuccessAt,
    },
  });

const successResult = (): ProviderVerificationResult => ({
  provider: PROVIDER,
  status: "success",
  modelId: "perplexity/sonar",
  latencyMs: 412,
  diagnosticCode: null,
  errorClassification: null,
  message: null,
  usage: { inputTokens: 7, outputTokens: 2 },
});

const failureResult = (): ProviderVerificationResult => ({
  provider: PROVIDER,
  status: "failed",
  modelId: "perplexity/sonar",
  latencyMs: 388,
  diagnosticCode: "PROVIDER_VERIFICATION_FAILED.AI_APICallError.HTTP_503",
  errorClassification: "SERVER_ERROR",
  message: "Perplexity returned an error.",
  usage: null,
});

const runVerification = async (result: ProviderVerificationResult) => {
  const claim = await claimVerificationSlot({
    provider: PROVIDER,
    modelId: result.modelId,
    traceId: randomUUID(),
    actorId: null,
    actorEmail: "ops@tomverse.test",
    // Each scenario runs its own verification, and the cooldown is time-based
    // on the previous attempt -- so attempts are dated apart rather than
    // waiting a real minute per test.
    now: new Date(Date.now() + 24 * 3_600_000),
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) throw new Error("unreachable");
  await recordVerificationResult({ checkId: claim.checkId, result });
  return claim.checkId;
};

test("a successful verification clears the block without touching lastSuccessAt", async () => {
  await seedBlockedProvider();
  const checkId = await runVerification(successResult());

  const beforeRecovery = await prisma.providerHealthState.findUniqueOrThrow({
    where: { provider: PROVIDER },
  });
  // Verification on its own is evidence, not a state change: the block is
  // still in place until recovery is explicitly requested.
  assert.equal(beforeRecovery.consecutiveFailures, 5);
  assert.ok(beforeRecovery.lastVerificationSuccessAt);
  assert.equal(beforeRecovery.lastSuccessAt, null);

  const outcome = await applyVerifiedRecovery({ provider: PROVIDER, checkId });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) throw new Error("unreachable");
  assert.equal(outcome.previousConsecutiveFailures, 5);
  assert.equal(outcome.resultingConsecutiveFailures, 0);

  const afterRecovery = await prisma.providerHealthState.findUniqueOrThrow({
    where: { provider: PROVIDER },
  });
  assert.equal(afterRecovery.consecutiveFailures, 0);
  assert.equal(afterRecovery.lastRecoveryCheckId, checkId);
  assert.ok(afterRecovery.lastRecoveryAt);
  // The load-bearing assertion: recovery stops expired failures from counting
  // as current. It does not invent a request that succeeded.
  assert.equal(afterRecovery.lastSuccessAt, null);
});

test("a successful verification never writes lastSuccessAt on its own", async () => {
  await seedBlockedProvider();
  await runVerification(successResult());
  const state = await prisma.providerHealthState.findUniqueOrThrow({
    where: { provider: PROVIDER },
  });
  assert.equal(state.lastSuccessAt, null);
  assert.ok(state.lastVerificationSuccessAt);
});

test("a failed verification neither clears the block nor authorises a recovery", async () => {
  await seedBlockedProvider();
  const checkId = await runVerification(failureResult());

  const outcome = await applyVerifiedRecovery({ provider: PROVIDER, checkId });
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error("unreachable");
  assert.equal(outcome.reason, "VERIFICATION_FAILED");

  const state = await prisma.providerHealthState.findUniqueOrThrow({
    where: { provider: PROVIDER },
  });
  assert.equal(state.consecutiveFailures, 5);
  assert.equal(state.lastVerificationSuccessAt, null);
  assert.ok(state.lastVerificationFailureAt);
});

test("a duplicate recovery request is a no-op, not a second reset", async () => {
  await seedBlockedProvider();
  const checkId = await runVerification(successResult());

  const first = await applyVerifiedRecovery({ provider: PROVIDER, checkId });
  assert.equal(first.ok, true);

  // Re-blocked by fresh real traffic. Replaying the original request must not
  // clear the new block on the strength of the old evidence.
  await prisma.providerHealthState.update({
    where: { provider: PROVIDER },
    data: { consecutiveFailures: 4, lastFailureAt: new Date() },
  });

  const second = await applyVerifiedRecovery({ provider: PROVIDER, checkId });
  assert.equal(second.ok, false);
  if (second.ok) throw new Error("unreachable");
  assert.equal(second.reason, "VERIFICATION_ALREADY_CONSUMED");

  const state = await prisma.providerHealthState.findUniqueOrThrow({
    where: { provider: PROVIDER },
  });
  assert.equal(state.consecutiveFailures, 4);
});

test("concurrent recoveries against one verification apply exactly once", async () => {
  await seedBlockedProvider({ consecutiveFailures: 7 });
  const checkId = await runVerification(successResult());

  const outcomes = await Promise.all([
    applyVerifiedRecovery({ provider: PROVIDER, checkId }),
    applyVerifiedRecovery({ provider: PROVIDER, checkId }),
    applyVerifiedRecovery({ provider: PROVIDER, checkId }),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1);

  const check = await prisma.providerHealthCheck.findUniqueOrThrow({
    where: { id: checkId },
  });
  assert.equal(check.recoveryApplied, true);
  assert.equal(check.previousConsecutiveFailures, 7);

  const state = await prisma.providerHealthState.findUniqueOrThrow({
    where: { provider: PROVIDER },
  });
  assert.equal(state.consecutiveFailures, 0);
});

test("a stale verification cannot authorise a recovery", async () => {
  await seedBlockedProvider();
  const checkId = await runVerification(successResult());
  await prisma.providerHealthCheck.update({
    where: { id: checkId },
    data: { createdAt: new Date(Date.now() - 6 * 3_600_000) },
  });

  const outcome = await applyVerifiedRecovery({ provider: PROVIDER, checkId });
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error("unreachable");
  assert.equal(outcome.reason, "VERIFICATION_STALE");

  const state = await prisma.providerHealthState.findUniqueOrThrow({
    where: { provider: PROVIDER },
  });
  assert.equal(state.consecutiveFailures, 5);
});

test("an unblocked provider has nothing to recover and the evidence stays unconsumed", async () => {
  await seedBlockedProvider({ consecutiveFailures: 0 });
  const checkId = await runVerification(successResult());

  const outcome = await applyVerifiedRecovery({ provider: PROVIDER, checkId });
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error("unreachable");
  assert.equal(outcome.reason, "NOT_BLOCKED");

  const check = await prisma.providerHealthCheck.findUniqueOrThrow({
    where: { id: checkId },
  });
  assert.equal(check.recoveryApplied, false);
});

test("a second verification inside the cooldown is refused", async () => {
  await seedBlockedProvider();
  const first = await claimVerificationSlot({
    provider: PROVIDER,
    modelId: "perplexity/sonar",
    traceId: randomUUID(),
    actorId: null,
    actorEmail: "ops@tomverse.test",
  });
  assert.equal(first.ok, true);

  const second = await claimVerificationSlot({
    provider: PROVIDER,
    modelId: "perplexity/sonar",
    traceId: randomUUID(),
    actorId: null,
    actorEmail: "ops@tomverse.test",
  });
  assert.equal(second.ok, false);
  if (second.ok) throw new Error("unreachable");
  assert.equal(second.reason, "cooldown");
  assert.ok(second.retryAfterSeconds > 0);

  const checks = await prisma.providerHealthCheck.count({
    where: { provider: PROVIDER, kind: LIVE_VERIFICATION_KIND },
  });
  assert.equal(checks, 1);
});

test("the verification summary reports the latest check and the recovery history", async () => {
  await seedBlockedProvider();
  const checkId = await runVerification(successResult());
  await applyVerifiedRecovery({ provider: PROVIDER, checkId });

  const summaries = await getProviderVerificationSummaries([PROVIDER]);
  const summary = summaries.get(PROVIDER);
  assert.ok(summary);
  assert.equal(summary.lastCheck?.id, checkId);
  assert.equal(summary.lastCheck?.status, "success");
  assert.equal(summary.lastCheck?.recoveryApplied, true);
  assert.equal(summary.recentRecoveries.length, 1);
  assert.equal(summary.recentRecoveries[0]?.previousConsecutiveFailures, 5);
});
