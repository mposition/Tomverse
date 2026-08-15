import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import {
  acquireChatAccess,
  reserveAttemptProviderBudget,
  settleChatUsage,
  type ChatAccess,
  type ChatBudget,
  type ChatUsageReservation,
} from "@/lib/chatSecurity";
import {
  applyPendingAttemptCostAdjustments,
  resolvedAttemptCosts,
  rollupDayOf,
} from "@/lib/chatAttemptCostLedger";
import { prisma } from "@/lib/prisma";
import { closeAttempt } from "@/lib/routingAttemptStore";
import {
  STALE_ATTEMPT_AFTER_MS,
  SWEEP_VERSION,
  staleAttemptBacklog,
  sweepStaleRoutingAttempts,
} from "@/lib/routingAttemptSweep";

/**
 * A dispatch is recorded before the provider's stream is read and the outcome
 * after it. Between those two the process can die, and the attempt stays
 * `pending` for ever — polluting the reliability numbers and ROUTE-06's
 * evidence long after the incident.
 *
 * These are about what the sweep may conclude (very little), what it must not
 * touch, and the compare-and-set that stops it racing the live request.
 */

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ContextManifest",
      "RoutingAttempt",
      "RoutingRun",
      "ProviderDailyUsage",
      "ChatAttemptUsageAdjustment",
      "ChatAttemptUsage",
      "ChatCreditReservation",
      "ChatRequestLease",
      "ChatUsageBucket",
      "CreditLedgerEntry",
      "CreditLot",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const ancient = () => new Date(Date.now() - STALE_ATTEMPT_AFTER_MS - 60_000);

const makeRun = async (
  overrides: { subjectKey?: string; reservationId?: string } = {}
) => {
  const subjectKey = overrides.subjectKey ?? `sweep:${randomUUID()}`;
  const run = await prisma.routingRun.create({
    data: {
      traceId: `trace-${randomUUID()}`,
      subjectKey,
      reservationId: overrides.reservationId ?? null,
      mode: "auto",
      plan: "Pro",
      initialModelId: "gpt-5-6-luna",
      taskProfileVersion: "sweep-test",
      candidateFilterVersion: "sweep-test",
      selectionVersion: "sweep-test",
      estimatorVersion: "sweep-test",
      profileKind: "general",
      profileConfidence: "high",
      needsCurrentInformation: false,
      hasImageInput: false,
      hasDocumentInput: false,
      expectedOutputLength: "short",
      estimatedInputTokens: 100,
      reservedInputTokens: 100,
      requestOutputCapTokens: 100,
      eligibleCount: 1,
      rejectedByReason: {},
      selectionReason: "task_preference",
      selectionMargin: 0,
      userSelectedModelId: "gpt-5-6-luna",
      decisionMicros: 1_000,
    },
    select: { id: true },
  });
  return { runId: run.id, subjectKey };
};

/**
 * A reservation as a real turn would have left it: money committed, an attempt
 * cost intent recorded at dispatch, and the request gone.
 *
 * Built through `acquireChatAccess` rather than by hand because the payload is
 * signed -- a hand-written one would not deserialize, and the intent it has to
 * carry is written there and nowhere else. The lease is deleted and the
 * expiry moved into the past because that is the state a crashed request
 * leaves behind: no process renewing anything, and money nobody settled.
 */
const makeCrashedReservation = async (): Promise<ChatUsageReservation> => {
  const user = await prisma.user.create({
    data: { email: `sweep-${randomUUID()}@example.test`, plan: "Pro" },
  });
  const access: ChatAccess = {
    kind: "user",
    userId: user.id,
    plan: "Pro",
    subjectKey: `integration:user:${user.id}`,
    ipKey: `integration:ip:${user.id}`,
    planLimits: { dailyMessageLimit: 10_000, monthlyMessageLimit: 10_000 },
  };
  const budget: ChatBudget = {
    modelId: "gpt-5-6-luna",
    minimumPlan: "Guest",
    modelUsageClass: "standard",
    usageCredits: 5,
    inputTokens: 10_000,
    maxOutputTokens: 10_000,
    providerMaxOutputTokens: null,
    reservedOutputTokens: 10_000,
    inputUsdPerMillionTokens: 100,
    outputUsdPerMillionTokens: 100,
    cachedInputPriceMultiplier: 1,
    provider: "openai",
    pricingVersion: "sweep-test",
    costSource: "sweep-test",
    longContextThresholdTokens: null,
  };
  const acquired = await acquireChatAccess(access, budget, {
    traceId: `trace-${randomUUID()}`,
  });
  await prisma.chatRequestLease.deleteMany({});
  await prisma.chatCreditReservation.update({
    where: { id: acquired.usageReservation.reservationId },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });
  return acquired.usageReservation;
};

const attemptCostRow = (reservationId: string, attemptIndex = 0) =>
  prisma.chatAttemptUsage.findUnique({
    where: { reservationId_attemptIndex: { reservationId, attemptIndex } },
  });

const makeAttempt = async (
  runId: string,
  overrides: {
    outcome?: string;
    dispatchedAt?: Date | null;
    createdAt?: Date;
  } = {}
) => {
  const dispatchedAt =
    overrides.dispatchedAt === undefined ? ancient() : overrides.dispatchedAt;
  // Created undispatched, then marked dispatched once its manifest is
  // finalized: ROUTE-06's constraint refuses a dispatch that has no finalized
  // manifest, which is the boundary the whole feature rests on.
  const attempt = await prisma.routingAttempt.create({
    data: {
      runId,
      attemptIndex: 0,
      modelId: "gpt-5-6-luna",
      provider: "openai",
      outcome: overrides.outcome ?? "pending",
      failureLayer: "none",
    },
    select: { id: true },
  });
  if (dispatchedAt) {
    await prisma.contextManifest.create({
      data: {
        attemptId: attempt.id,
        state: "finalized",
        sourceRefs: [],
        tokenizerVersion: "sweep-test",
        tokenCount: 100,
        contextWindowTokens: 1_000,
        // A finalized manifest must be able to say what it committed to; the
        // constraint refuses one that only claims to be finalized.
        plannerVersion: "none",
        adapterVersion: "sweep-test",
        effectiveRequestHash: "sweep-test-hash",
        contentHashVersion: "sweep-test",
        hashAlgorithm: "hmac-sha256",
        hashKeyId: "test-key",
        finalizedAt: dispatchedAt,
      },
    });
    await prisma.routingAttempt.update({
      where: { id: attempt.id },
      // The attempt carries its own copy of the finalization time, and the
      // constraint requires it to be at or before the dispatch: a manifest
      // finalized afterwards would describe a request that had already gone.
      data: { manifestFinalizedAt: dispatchedAt, dispatchedAt },
    });
  }
  if (overrides.createdAt !== undefined) {
    await prisma.$executeRaw`
      UPDATE "RoutingAttempt" SET "createdAt" = ${overrides.createdAt} WHERE "id" = ${attempt.id}
    `;
  }
  return attempt.id;
};

const outcomeOf = async (id: string) =>
  (await prisma.routingAttempt.findUniqueOrThrow({ where: { id } })).outcome;

test("a dispatched attempt whose process stopped is closed, honestly", async () => {
  const { runId } = await makeRun();
  const id = await makeAttempt(runId, { createdAt: ancient() });

  // No reservation on this run, so there is no cost to state -- the close is
  // still the point, and it is counted where it belongs.
  const result = await sweepStaleRoutingAttempts();
  assert.equal(result.closedWithoutCostIntent, 1);
  assert.equal(result.closedCostInserted, 0);

  const row = await prisma.routingAttempt.findUniqueOrThrow({ where: { id } });
  // Not `failed_pre_token`: nobody observed the provider call, so a failure
  // would be a claim about an outcome nothing saw.
  assert.equal(row.outcome, "unknown_after_dispatch");
  // Not `provider`: §8's recovery reads provider health to decide what to
  // route to next, and a host restart is not evidence about a model.
  assert.equal(row.failureLayer, "process");
  // The record of what reached a provider is still true and is left alone.
  assert.ok(row.dispatchedAt);
});

test("an attempt that never dispatched is left alone", async () => {
  // There is no uncertainty to record: it did not reach a provider, and
  // `not_dispatched` is what says so.
  const { runId } = await makeRun();
  const id = await makeAttempt(runId, {
    dispatchedAt: null,
    createdAt: ancient(),
  });
  const result = await sweepStaleRoutingAttempts();
  assert.equal(result.examined, 0);
  assert.equal(await outcomeOf(id), "pending");
});

test("a young attempt is left alone", async () => {
  // A turn can legitimately stream for minutes, and closing a live attempt is
  // worse than closing a dead one late.
  const { runId } = await makeRun();
  const id = await makeAttempt(runId, { createdAt: new Date() });
  assert.equal((await sweepStaleRoutingAttempts()).examined, 0);
  assert.equal(await outcomeOf(id), "pending");
});

test("an attempt whose subject still holds a lease is left alone", async () => {
  const { runId, subjectKey } = await makeRun();
  const id = await makeAttempt(runId, { createdAt: ancient() });
  await prisma.chatRequestLease.create({
    data: {
      id: `lease-${randomUUID()}`,
      subjectKey,
      ipKey: `ip-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  assert.equal((await sweepStaleRoutingAttempts()).examined, 0);
  assert.equal(await outcomeOf(id), "pending");
});

test("a terminal outcome cannot be changed, by the sweep or anyone", async () => {
  // The field §5's outcomes, §8's recovery and the drill's scenarios are all
  // told apart by.
  const { runId } = await makeRun();
  const id = await makeAttempt(runId, {
    outcome: "succeeded",
    createdAt: ancient(),
  });
  await assert.rejects(
    prisma.routingAttempt.update({
      where: { id },
      data: { outcome: "failed_pre_token" },
    }),
    /terminal outcome cannot be changed/
  );
  assert.equal(await outcomeOf(id), "succeeded");
});

test("closing an already-closed attempt reports that it lost, and changes nothing", async () => {
  const { runId } = await makeRun();
  const id = await makeAttempt(runId, { createdAt: ancient() });

  assert.equal(await closeAttempt({ attemptId: id, outcome: "succeeded" }), true);
  assert.equal(
    await closeAttempt({ attemptId: id, outcome: "failed_pre_token" }),
    false,
    "the second close must report that it did not write"
  );
  assert.equal(await outcomeOf(id), "succeeded");
});

test("the live request and the sweep cannot both close one attempt", async () => {
  const { runId } = await makeRun();
  const id = await makeAttempt(runId, { createdAt: ancient() });

  const [live, swept] = await Promise.all([
    closeAttempt({ attemptId: id, outcome: "succeeded" }),
    sweepStaleRoutingAttempts(),
  ]);
  const wonBySweep =
    swept.closedCostInserted +
      swept.closedWithExistingCost +
      swept.closedWithoutCostIntent ===
    1;
  assert.equal(
    [live, wonBySweep].filter(Boolean).length,
    1,
    "exactly one of the live close and the sweep may win"
  );
  assert.ok(["succeeded", "unknown_after_dispatch"].includes(await outcomeOf(id)));
});

test("the backlog reports how far behind the sweep is, not only that it is", async () => {
  // A backlog of zero on a sweep that never runs looks identical to a backlog
  // of zero on one that keeps up; the age is what tells them apart.
  const { runId } = await makeRun();
  await makeAttempt(runId, { createdAt: ancient() });

  const before = await staleAttemptBacklog();
  assert.equal(before.eligiblePending, 1);
  assert.equal(before.agedPending, 1);
  assert.ok((before.oldestEligibleMs ?? 0) >= STALE_ATTEMPT_AFTER_MS);

  await sweepStaleRoutingAttempts();
  const after = await staleAttemptBacklog();
  assert.deepEqual(after, {
    agedPending: 0,
    eligiblePending: 0,
    oldestEligibleMs: null,
  });
});

test("an old attempt the sweep may not touch is aged but not eligible", async () => {
  // A deep-research turn legitimately streaming past the window holds a lease.
  // Counting it as work the sweep has not got to would put healthy traffic
  // into the number an alarm reads -- which is why the backlog now shares the
  // sweep's own predicate instead of checking age alone.
  const { runId, subjectKey } = await makeRun();
  await makeAttempt(runId, { createdAt: ancient() });
  await prisma.chatRequestLease.create({
    data: {
      id: `lease-${randomUUID()}`,
      subjectKey,
      ipKey: `ip-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });

  const backlog = await staleAttemptBacklog();
  assert.equal(backlog.agedPending, 1, "it is old, and that is true");
  assert.equal(backlog.eligiblePending, 0, "and nothing is waiting on the sweep");
  assert.equal(backlog.oldestEligibleMs, null);
});

test("a reservation still reserved and unexpired keeps its attempt out of the backlog", async () => {
  const reservation = await makeCrashedReservation();
  await prisma.chatCreditReservation.update({
    where: { id: reservation.reservationId },
    data: { expiresAt: new Date(Date.now() + 10 * 60_000) },
  });
  const { runId } = await makeRun({ reservationId: reservation.reservationId });
  await makeAttempt(runId, { createdAt: ancient() });

  const backlog = await staleAttemptBacklog();
  assert.equal(backlog.agedPending, 1);
  assert.equal(
    backlog.eligiblePending,
    0,
    "the money may yet settle, so the sweep is not behind on this one"
  );
});

test("an unknown_after_dispatch outcome requires a dispatch", async () => {
  // Enforced by the database, so no future writer can record the uncertainty
  // about a call that never happened.
  const { runId } = await makeRun();
  const id = await makeAttempt(runId, { dispatchedAt: null });
  await assert.rejects(
    prisma.routingAttempt.update({
      where: { id },
      data: { outcome: "unknown_after_dispatch", failureLayer: "process" },
    }),
    /constraint/i
  );
});

// What a crashed attempt cost.
//
// The sweep closing the attempt was only half of it: a dispatch was recorded,
// so the provider was called and was paid, and until these rows existed the
// money left no trace anywhere. Not a wrong number -- no number.

test("a crashed attempt's provider cost is recorded, at what it was allowed to spend", async () => {
  const reservation = await makeCrashedReservation();
  const { runId } = await makeRun({ reservationId: reservation.reservationId });
  await makeAttempt(runId, { createdAt: ancient() });

  const result = await sweepStaleRoutingAttempts();
  assert.equal(result.closedCostInserted, 1);
  assert.equal(result.closedWithoutCostIntent, 0);

  const row = await attemptCostRow(reservation.reservationId);
  assert.ok(row, "the sweep must leave a cost row");
  // The upper bound the attempt was authorized to spend. Not 0, which would
  // claim a call that demonstrably happened used nothing.
  assert.ok(row.costMicroUsd > BigInt(0));
  assert.equal(row.costSource, "reserved_upper_bound");
  assert.equal(row.usageSource, "crash_reconciliation");
  assert.equal(row.outcome, "unknown_after_dispatch");
  // Tokens stay unknown rather than invented: the cost is defensible because
  // the money was really committed, and a token count nobody measured is not.
  assert.equal(row.inputTokens, null);
  assert.equal(row.outputTokens, null);
  assert.equal(
    (row.pricingSnapshot as { sweptBy?: string } | null)?.sweptBy,
    SWEEP_VERSION,
    "a later fix has to be able to find the rows this version wrote"
  );
});

test("the crash estimate reaches the provider rollup, and its correction nets out", async () => {
  // The whole reason the sweep moves the rollup itself. A correction is a
  // *delta* against what the row already claimed, so a rollup that never
  // received the estimate would be short by it for ever once the delta landed.
  const reservation = await makeCrashedReservation();
  const { runId } = await makeRun({ reservationId: reservation.reservationId });
  await makeAttempt(runId, { createdAt: ancient() });
  await sweepStaleRoutingAttempts();

  const estimate = (await attemptCostRow(reservation.reservationId))!;
  const afterSweep = await prisma.providerDailyUsage.findFirstOrThrow({
    where: { provider: "openai", modelId: "gpt-5-6-luna", source: "internal" },
  });
  assert.equal(
    BigInt(afterSweep.estimatedCostMicroUsd),
    estimate.costMicroUsd,
    "the reserved upper bound has to reach the ledger budgets read"
  );
  // Tokens stay zero and the component split stays zero: the money is known
  // and how it divides is not.
  assert.equal(afterSweep.inputTokens, 0);
  assert.equal(afterSweep.outputTokens, 0);
  assert.equal(afterSweep.requestCount, 1);

  await settleChatUsage(
    reservation,
    { inputTokens: 10_000, outputTokens: 0, outcome: "failed" },
    {
      attempts: [
        {
          attemptIndex: 0,
          price: {
            provider: "openai",
            modelId: "gpt-5-6-luna",
            inputUsdPerMillionTokens: 100,
            outputUsdPerMillionTokens: 100,
            cachedInputPriceMultiplier: 1,
            pricingVersion: "sweep-test",
          },
          inputTokens: 10_000,
          cachedInputTokens: 0,
          outputTokens: 0,
          usageFromProvider: true,
          outcome: "failed",
        },
      ],
    }
  );

  const afterCorrection = await prisma.providerDailyUsage.findFirstOrThrow({
    where: { provider: "openai", modelId: "gpt-5-6-luna", source: "internal" },
  });
  // Rollup and per-attempt ledger agree on the observed figure. They would
  // not if either the estimate or the delta were missing from the rollup.
  assert.equal(BigInt(afterCorrection.estimatedCostMicroUsd), BigInt(1_000_000));
  const [resolved] = await resolvedAttemptCosts(reservation.reservationId);
  assert.equal(resolved.costMicroUsd, BigInt(1_000_000));
});

test("only a crash-reconciled row may leave its tokens unknown", async () => {
  // Enforced by the database, so no future writer can file an unmeasured
  // estimate as if somebody had observed it.
  const reservation = await makeCrashedReservation();
  await assert.rejects(
    prisma.chatAttemptUsage.create({
      data: {
        reservationId: reservation.reservationId,
        attemptIndex: 0,
        modelId: "gpt-5-6-luna",
        provider: "openai",
        outcome: "completed",
        rollupDate: rollupDayOf(),
        usageSource: "provider_usage_metadata",
      },
    }),
    /unknown_tokens_check/
  );
});

test("sweeping twice records the cost once", async () => {
  const reservation = await makeCrashedReservation();
  const { runId } = await makeRun({ reservationId: reservation.reservationId });
  await makeAttempt(runId, { createdAt: ancient() });

  await sweepStaleRoutingAttempts();
  const first = await attemptCostRow(reservation.reservationId);
  // Nothing is pending any more, so the second pass finds nothing at all --
  // and even if it did, the unique key would refuse a second row.
  const again = await sweepStaleRoutingAttempts();
  assert.equal(again.examined, 0);
  assert.equal(again.closedCostInserted, 0);

  const rows = await prisma.chatAttemptUsage.findMany({
    where: { reservationId: reservation.reservationId },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].costMicroUsd, first!.costMicroUsd);
});

test("a crash refunds the user in full and keeps the provider's cost", async () => {
  // The two ledgers §7 separates, at their furthest apart. Nobody saw an
  // answer, so there is nothing to charge for; the provider was still called,
  // so there is something to account for.
  const reservation = await makeCrashedReservation();
  const { runId } = await makeRun({ reservationId: reservation.reservationId });
  await makeAttempt(runId, { createdAt: ancient() });
  await sweepStaleRoutingAttempts();

  await settleChatUsage(reservation, {
    inputTokens: 0,
    outputTokens: 0,
    outcome: "failed",
  });

  const durable = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: reservation.reservationId },
  });
  assert.equal(durable.settledCredits, 0, "the user pays for no answer");
  assert.equal(durable.status, "refunded");
  // A full refund charged for no attempt, so naming one would be a claim that
  // some attempt was billed when none was.
  assert.equal(durable.settlementAttemptIndex, null);

  const row = await attemptCostRow(reservation.reservationId);
  assert.ok(row, "the provider's cost survives the user's refund");
  assert.equal(row.usageSource, "crash_reconciliation");
});

test("real usage arriving late is appended, and the estimate it corrects is left standing", async () => {
  const reservation = await makeCrashedReservation();
  const { runId } = await makeRun({ reservationId: reservation.reservationId });
  await makeAttempt(runId, { createdAt: ancient() });
  await sweepStaleRoutingAttempts();
  const estimate = (await attemptCostRow(reservation.reservationId))!;

  // The turn's own settlement finally runs, carrying what the attempt really
  // used. 10K in at $100/M is 1,000,000 micro-USD, well under the bound.
  await settleChatUsage(
    reservation,
    { inputTokens: 10_000, outputTokens: 0, outcome: "failed" },
    {
      attempts: [
        {
          attemptIndex: 0,
          price: {
            provider: "openai",
            modelId: "gpt-5-6-luna",
            inputUsdPerMillionTokens: 100,
            outputUsdPerMillionTokens: 100,
            cachedInputPriceMultiplier: 1,
            pricingVersion: "sweep-test",
          },
          inputTokens: 10_000,
          cachedInputTokens: 0,
          outputTokens: 0,
          usageFromProvider: true,
          outcome: "failed",
        },
      ],
    }
  );

  const base = (await attemptCostRow(reservation.reservationId))!;
  assert.equal(
    base.costMicroUsd,
    estimate.costMicroUsd,
    "the base row is immutable; a correction may not rewrite it"
  );
  assert.equal(base.usageSource, "crash_reconciliation");

  const adjustments = await prisma.chatAttemptUsageAdjustment.findMany({
    where: { reservationId: reservation.reservationId },
  });
  assert.equal(adjustments.length, 1);
  assert.equal(adjustments[0].kind, "late_provider_actual");
  assert.equal(adjustments[0].observedCostMicroUsd, BigInt(1_000_000));
  // Signed: what the truth is, minus what the estimate claimed.
  assert.equal(
    adjustments[0].costDeltaMicroUsd,
    BigInt(1_000_000) - estimate.costMicroUsd
  );
  // Resolved cost is base plus adjustments, and it is the observed figure.
  assert.equal(
    base.costMicroUsd + adjustments[0].costDeltaMicroUsd,
    BigInt(1_000_000)
  );
  // Which is what the reader reports, so nothing downstream has to know that
  // a correction happened in order to get the right number.
  const [resolved] = await resolvedAttemptCosts(reservation.reservationId);
  assert.equal(resolved.costMicroUsd, BigInt(1_000_000));
  assert.equal(resolved.recordedCostMicroUsd, estimate.costMicroUsd);
  assert.equal(resolved.estimated, false);
});

test("an uncorrected crash estimate reports as the estimate it is", async () => {
  // A figure nobody measured has to be legible as one. Reporting it beside
  // measured spend without saying which is which is how an upper bound turns
  // into a number somebody plans against.
  const reservation = await makeCrashedReservation();
  const { runId } = await makeRun({ reservationId: reservation.reservationId });
  await makeAttempt(runId, { createdAt: ancient() });
  await sweepStaleRoutingAttempts();

  const [resolved] = await resolvedAttemptCosts(reservation.reservationId);
  assert.equal(resolved.estimated, true);
  assert.equal(resolved.correctionMicroUsd, BigInt(0));
  assert.equal(resolved.costMicroUsd, resolved.recordedCostMicroUsd);
});

test("an adjustment is append-only, like the row it corrects", async () => {
  const reservation = await makeCrashedReservation();
  const { runId } = await makeRun({ reservationId: reservation.reservationId });
  await makeAttempt(runId, { createdAt: ancient() });
  await sweepStaleRoutingAttempts();

  const adjustment = await prisma.chatAttemptUsageAdjustment.create({
    data: {
      reservationId: reservation.reservationId,
      attemptIndex: 0,
      kind: "late_provider_actual",
      observedCostMicroUsd: BigInt(7),
      costDeltaMicroUsd: BigInt(7),
      observationId: `obs-${randomUUID()}`,
    },
  });
  await assert.rejects(
    prisma.chatAttemptUsageAdjustment.update({
      where: { id: adjustment.id },
      data: { costDeltaMicroUsd: BigInt(999) },
    }),
    /append-only/
  );
  // The one door: unapplied to applied, once.
  await prisma.chatAttemptUsageAdjustment.update({
    where: { id: adjustment.id },
    data: { appliedAt: new Date() },
  });
  await assert.rejects(
    prisma.chatAttemptUsageAdjustment.update({
      where: { id: adjustment.id },
      data: { appliedAt: new Date() },
    }),
    /append-only/
  );
});

test("the same observation twice is one adjustment", async () => {
  // A provider reconciliation file replayed must move the ledger once.
  const reservation = await makeCrashedReservation();
  const { runId } = await makeRun({ reservationId: reservation.reservationId });
  await makeAttempt(runId, { createdAt: ancient() });
  await sweepStaleRoutingAttempts();

  const observationId = `obs-${randomUUID()}`;
  const write = () =>
    prisma.chatAttemptUsageAdjustment.createMany({
      skipDuplicates: true,
      data: [
        {
          reservationId: reservation.reservationId,
          attemptIndex: 0,
          kind: "late_provider_actual",
          observedCostMicroUsd: BigInt(1_000_000),
          costDeltaMicroUsd: BigInt(-500_000),
          observationId,
        },
      ],
    });
  assert.equal((await write()).count, 1);
  assert.equal((await write()).count, 0, "the replay must write nothing");
  assert.equal(
    await prisma.chatAttemptUsageAdjustment.count({
      where: { reservationId: reservation.reservationId },
    }),
    1
  );
});

test("a payload whose cost intent is missing is swept without one", async () => {
  // Two things at once, and both matter. The payload is refused on read --
  // holds and intents are one authorization and a hold without its intent is
  // a payload somebody tampered with or a writer left half-finished. And the
  // sweep still closes the attempt: classifying a dead attempt does not
  // depend on knowing its price, and leaving it `pending` for ever because
  // the money is unreadable would trade one lost fact for two.
  const reservation = await makeCrashedReservation();
  const durable = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: reservation.reservationId },
  });
  const payload = durable.reservationPayload as Record<string, unknown>;
  delete payload.attemptCostIntents;
  await prisma.$executeRaw`
    UPDATE "ChatCreditReservation"
    SET "reservationPayload" = ${payload}::jsonb
    WHERE "id" = ${reservation.reservationId}
  `;

  const { runId } = await makeRun({ reservationId: reservation.reservationId });
  const id = await makeAttempt(runId, { createdAt: ancient() });

  const result = await sweepStaleRoutingAttempts();
  // Counted apart from a clean sweep: nobody can now state what this attempt
  // cost, and reporting that as an ordinary success hides a hole in the ledger.
  assert.equal(result.closedCostInserted, 0);
  assert.equal(result.closedWithoutCostIntent, 1);
  assert.equal(await outcomeOf(id), "unknown_after_dispatch");
  assert.equal(await attemptCostRow(reservation.reservationId), null);
});

// Failure has to cost a delay, not a record.

test("a cost write that fails takes the close with it, and the next sweep recovers", async () => {
  // The reason the close and the cost row share a transaction. If they did
  // not, a failure here would leave a terminal attempt with no cost row --
  // and the sweep only looks at `pending`, so nothing would ever come back
  // for it. Bound together, a failure leaves the attempt exactly where the
  // next sweep can find it.
  const reservation = await makeCrashedReservation();
  const { runId } = await makeRun({ reservationId: reservation.reservationId });
  const id = await makeAttempt(runId, { createdAt: ancient() });

  // A row already under this key that the sweep's insert cannot become: the
  // insert is skipped, and the outcome is `duplicate` rather than a write.
  // Then the ledger's own guard fires on a close that won the CAS.
  await prisma.$executeRaw`
    ALTER TABLE "ChatAttemptUsage"
    ADD CONSTRAINT "sweep_test_refuses_everything" CHECK (false) NOT VALID
  `;
  try {
    const result = await sweepStaleRoutingAttempts();
    assert.equal(result.failed, 1);
    assert.equal(result.closedCostInserted, 0);
    // Still open, because the transaction that would have closed it rolled
    // back with the cost row it could not write.
    assert.equal(await outcomeOf(id), "pending");
    assert.equal(await attemptCostRow(reservation.reservationId), null);
  } finally {
    await prisma.$executeRaw`
      ALTER TABLE "ChatAttemptUsage" DROP CONSTRAINT "sweep_test_refuses_everything"
    `;
  }

  // The next sweep finds it and completes both.
  const recovered = await sweepStaleRoutingAttempts();
  assert.equal(recovered.closedCostInserted, 1);
  assert.equal(await outcomeOf(id), "unknown_after_dispatch");
  assert.ok(await attemptCostRow(reservation.reservationId));
});

test("the base row and its rollup agree on which day they landed on", async () => {
  // Stored rather than inferred from `createdAt`: the rollup's day comes from
  // the application clock and `createdAt` from the database's, and across UTC
  // midnight those are different days. A correction that guessed would update
  // a row that is not there.
  const reservation = await makeCrashedReservation();
  const { runId } = await makeRun({ reservationId: reservation.reservationId });
  await makeAttempt(runId, { createdAt: ancient() });
  await sweepStaleRoutingAttempts();

  const row = (await attemptCostRow(reservation.reservationId))!;
  const rollup = await prisma.providerDailyUsage.findFirstOrThrow({
    where: { provider: "openai", modelId: "gpt-5-6-luna", source: "internal" },
  });
  assert.equal(row.rollupDate.getTime(), rollup.date.getTime());
  // Midnight UTC, which the database also enforces.
  assert.equal(row.rollupDate.getTime(), rollupDayOf(row.createdAt).getTime());
});

test("a correction whose rollup row is gone stays pending, and the replay applies it once", async () => {
  const reservation = await makeCrashedReservation();
  const { runId } = await makeRun({ reservationId: reservation.reservationId });
  await makeAttempt(runId, { createdAt: ancient() });
  await sweepStaleRoutingAttempts();
  const estimate = (await attemptCostRow(reservation.reservationId))!;

  // The rollup row disappears -- a retention job, a bad restore, anything.
  // The delta has nowhere to land, and that must be visible rather than lost.
  await prisma.providerDailyUsage.deleteMany({});

  await settleChatUsage(
    reservation,
    { inputTokens: 10_000, outputTokens: 0, outcome: "failed" },
    {
      attempts: [
        {
          attemptIndex: 0,
          price: {
            provider: "openai",
            modelId: "gpt-5-6-luna",
            inputUsdPerMillionTokens: 100,
            outputUsdPerMillionTokens: 100,
            cachedInputPriceMultiplier: 1,
            pricingVersion: "sweep-test",
          },
          inputTokens: 10_000,
          cachedInputTokens: 0,
          outputTokens: 0,
          usageFromProvider: true,
          outcome: "failed",
        },
      ],
    }
  );

  const pending = await prisma.chatAttemptUsageAdjustment.findFirstOrThrow({
    where: { reservationId: reservation.reservationId },
  });
  assert.equal(
    pending.appliedAt,
    null,
    "an unapplied delta must say so; the partial index exists to find it"
  );

  // The replay is the consumer that index was built for.
  const first = await applyPendingAttemptCostAdjustments();
  assert.deepEqual(first, { examined: 1, applied: 1, failed: 0 });
  const rollup = await prisma.providerDailyUsage.findFirstOrThrow({
    where: { provider: "openai", modelId: "gpt-5-6-luna", source: "internal" },
  });
  // The row is recreated on the base row's own day, carrying the delta.
  assert.equal(rollup.date.getTime(), estimate.rollupDate.getTime());
  const afterFirst = rollup.estimatedCostMicroUsd;

  // And exactly once: a second replay finds nothing to do.
  const second = await applyPendingAttemptCostAdjustments();
  assert.deepEqual(second, { examined: 0, applied: 0, failed: 0 });
  const again = await prisma.providerDailyUsage.findFirstOrThrow({
    where: { provider: "openai", modelId: "gpt-5-6-luna", source: "internal" },
  });
  assert.equal(again.estimatedCostMicroUsd, afterFirst);
});

// Which kind of "no cost" it was, because the four are not the same thing and
// only one of them is ordinary.

test("a reservation the run points at but that is gone is reported as dangling", async () => {
  const reservation = await makeCrashedReservation();
  const { runId } = await makeRun({ reservationId: reservation.reservationId });
  const id = await makeAttempt(runId, { createdAt: ancient() });
  // The run keeps its reservationId; the row behind it does not survive.
  await prisma.$executeRaw`
    UPDATE "RoutingRun" SET "reservationId" = NULL WHERE "id" = ${runId}
  `;
  await prisma.chatCreditReservation.delete({
    where: { id: reservation.reservationId },
  });
  await prisma.$executeRaw`
    UPDATE "RoutingRun" SET "reservationId" = ${reservation.reservationId}
    WHERE "id" = ${runId}
  `;

  const result = await sweepStaleRoutingAttempts();
  // Closed, and counted as a hole rather than a success -- but not as the
  // legacy case either, which is a closed set that ages out.
  assert.equal(result.closedWithoutCostIntent, 1);
  assert.equal(result.closedCostInserted, 0);
  assert.equal(await outcomeOf(id), "unknown_after_dispatch");
});

test("a cost row settlement wrote first is a race, not a missing cost", async () => {
  // Both are "this sweep wrote no cost row", and only one of them means the
  // spend is unaccounted for.
  const reservation = await makeCrashedReservation();
  const { runId } = await makeRun({ reservationId: reservation.reservationId });
  await makeAttempt(runId, { createdAt: ancient() });

  await prisma.chatAttemptUsage.create({
    data: {
      reservationId: reservation.reservationId,
      attemptIndex: 0,
      modelId: "gpt-5-6-luna",
      provider: "openai",
      outcome: "failed",
      rollupDate: rollupDayOf(),
      inputTokens: 10_000,
      outputTokens: 0,
      costMicroUsd: BigInt(1_000_000),
    },
  });

  const result = await sweepStaleRoutingAttempts();
  assert.equal(result.closedWithExistingCost, 1);
  assert.equal(result.closedCostInserted, 0);
  assert.equal(result.closedWithoutCostIntent, 0);
  // The observed row stands; the sweep's upper bound does not replace it.
  const row = (await attemptCostRow(reservation.reservationId))!;
  assert.equal(row.costMicroUsd, BigInt(1_000_000));
  assert.equal(row.usageSource, "provider_usage_metadata");
  // And no adjustment: a guess may not correct an observation.
  assert.equal(
    await prisma.chatAttemptUsageAdjustment.count({
      where: { reservationId: reservation.reservationId },
    }),
    0
  );
});

test("an observation naming a different model is refused, not applied", async () => {
  // A delta is the difference between two prices for one call. Moving one
  // model's difference onto another model's rollup is two wrong numbers.
  const reservation = await makeCrashedReservation();
  const { runId } = await makeRun({ reservationId: reservation.reservationId });
  await makeAttempt(runId, { createdAt: ancient() });
  await sweepStaleRoutingAttempts();
  const estimate = (await attemptCostRow(reservation.reservationId))!;

  await settleChatUsage(
    reservation,
    { inputTokens: 10_000, outputTokens: 0, outcome: "failed" },
    {
      attempts: [
        {
          attemptIndex: 0,
          price: {
            provider: "google",
            modelId: "some-other-model",
            inputUsdPerMillionTokens: 100,
            outputUsdPerMillionTokens: 100,
            cachedInputPriceMultiplier: 1,
            pricingVersion: "sweep-test",
          },
          inputTokens: 10_000,
          cachedInputTokens: 0,
          outputTokens: 0,
          usageFromProvider: true,
          outcome: "failed",
        },
      ],
    }
  );

  assert.equal(
    await prisma.chatAttemptUsageAdjustment.count({
      where: { reservationId: reservation.reservationId },
    }),
    0,
    "no adjustment may be appended for a call this row does not describe"
  );
  const base = (await attemptCostRow(reservation.reservationId))!;
  assert.equal(base.costMicroUsd, estimate.costMicroUsd);
  assert.equal(base.provider, "openai");
});

test("a correction reaches the rollup the base row names, not the one the observation does", async () => {
  const reservation = await makeCrashedReservation();
  const { runId } = await makeRun({ reservationId: reservation.reservationId });
  await makeAttempt(runId, { createdAt: ancient() });
  await sweepStaleRoutingAttempts();
  const estimate = (await attemptCostRow(reservation.reservationId))!;

  await settleChatUsage(
    reservation,
    { inputTokens: 10_000, outputTokens: 0, outcome: "failed" },
    {
      attempts: [
        {
          attemptIndex: 0,
          price: {
            provider: "openai",
            modelId: "gpt-5-6-luna",
            inputUsdPerMillionTokens: 100,
            outputUsdPerMillionTokens: 100,
            cachedInputPriceMultiplier: 1,
            pricingVersion: "sweep-test",
          },
          inputTokens: 10_000,
          cachedInputTokens: 0,
          outputTokens: 0,
          usageFromProvider: true,
          outcome: "failed",
        },
      ],
    }
  );

  const rollups = await prisma.providerDailyUsage.findMany({
    where: { source: "internal" },
  });
  assert.equal(rollups.length, 1, "one call, one rollup row");
  assert.equal(rollups[0].provider, estimate.provider);
  assert.equal(rollups[0].modelId, estimate.modelId);
  assert.equal(rollups[0].date.getTime(), estimate.rollupDate.getTime());
  assert.equal(rollups[0].estimatedCostMicroUsd, 1_000_000);
  // The tokens the observation brought, which the estimate had none of.
  assert.equal(rollups[0].inputTokens, 10_000);
});

// A turn that reserved nothing, and the two ways a payload can say so.
//
// `microdollarsFor` rounds each component up, so any positive rate on a
// positive token count reserves at least one micro-dollar. Zero reserved
// means every applicable rate is zero -- a free model, or an administrator
// override that flattened a real price. The sweep cannot tell those apart and
// must not raise an incident for either; the catalogue check is what does.

const makeFreeReservation = async (): Promise<ChatUsageReservation> => {
  const user = await prisma.user.create({
    data: { email: `sweep-free-${randomUUID()}@example.test`, plan: "Pro" },
  });
  const acquired = await acquireChatAccess(
    {
      kind: "user",
      userId: user.id,
      plan: "Pro",
      subjectKey: `integration:user:${user.id}`,
      ipKey: `integration:ip:${user.id}`,
      planLimits: { dailyMessageLimit: 10_000, monthlyMessageLimit: 10_000 },
    },
    {
      modelId: "gpt-5-6-luna",
      minimumPlan: "Guest",
      modelUsageClass: "standard",
      usageCredits: 5,
      inputTokens: 10_000,
      maxOutputTokens: 10_000,
      providerMaxOutputTokens: null,
      reservedOutputTokens: 10_000,
      // Every rate zero: the only way `reservedCost` reaches zero.
      inputUsdPerMillionTokens: 0,
      outputUsdPerMillionTokens: 0,
      cachedInputPriceMultiplier: 1,
      provider: "openai",
      pricingVersion: "sweep-test",
      costSource: "sweep-test",
      longContextThresholdTokens: null,
    },
    { traceId: `trace-${randomUUID()}` }
  );
  await prisma.chatRequestLease.deleteMany({});
  await prisma.chatCreditReservation.update({
    where: { id: acquired.usageReservation.reservationId },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });
  return acquired.usageReservation;
};

test("a turn that authorized nothing still leaves an audit row", async () => {
  // Under the old contract this attempt had no intent at all, so the sweep
  // could only say "nothing to price" and guess whether that was a free model
  // or a lost authorization. The intent is written for every dispatch now, so
  // the ceiling of zero is a recorded fact rather than an absence.
  const reservation = await makeFreeReservation();
  const { runId } = await makeRun({ reservationId: reservation.reservationId });
  const id = await makeAttempt(runId, { createdAt: ancient() });

  const result = await sweepStaleRoutingAttempts();
  assert.equal(result.closedCostInserted, 1);
  assert.equal(result.closedWithoutCostIntent, 0);
  // Named from the attempt row, which is what actually ran.
  assert.deepEqual(result.zeroReservedCostModels, { "openai/gpt-5-6-luna": 1 });
  assert.equal(await outcomeOf(id), "unknown_after_dispatch");

  const row = (await attemptCostRow(reservation.reservationId))!;
  assert.equal(row.costMicroUsd, BigInt(0));
  // Not "the provider charged nothing" -- the ceiling it was allowed was
  // nothing. A native search's own per-call charge sits outside the
  // reservation entirely.
  assert.equal(row.costSource, "reserved_upper_bound");
  assert.equal(row.usageSource, "crash_reconciliation");
  assert.equal(row.inputTokens, null);
});

test("a late actual corrects a zero ceiling like any other estimate", async () => {
  const reservation = await makeFreeReservation();
  const { runId } = await makeRun({ reservationId: reservation.reservationId });
  await makeAttempt(runId, { createdAt: ancient() });
  await sweepStaleRoutingAttempts();

  await settleChatUsage(
    reservation,
    { inputTokens: 10_000, outputTokens: 0, outcome: "failed" },
    {
      attempts: [
        {
          attemptIndex: 0,
          price: {
            provider: "openai",
            modelId: "gpt-5-6-luna",
            inputUsdPerMillionTokens: 100,
            outputUsdPerMillionTokens: 100,
            cachedInputPriceMultiplier: 1,
            pricingVersion: "sweep-test",
          },
          inputTokens: 10_000,
          cachedInputTokens: 0,
          outputTokens: 0,
          usageFromProvider: true,
          outcome: "failed",
        },
      ],
    }
  );

  const [resolved] = await resolvedAttemptCosts(reservation.reservationId);
  // Base zero plus the whole observed cost: the ordinary adjustment path, with
  // nothing special about the ceiling having been zero.
  assert.equal(resolved.recordedCostMicroUsd, BigInt(0));
  assert.equal(resolved.correctionMicroUsd, BigInt(1_000_000));
  assert.equal(resolved.costMicroUsd, BigInt(1_000_000));
});

test("an intent naming a different model than the attempt that ran is refused", async () => {
  // A fallback's payload `modelId` is the primary's for ever, so the attempt
  // row is the only record of what actually ran. Pricing one model's call at
  // another's rates is what this stops.
  const reservation = await makeCrashedReservation();
  const { runId } = await makeRun({ reservationId: reservation.reservationId });
  const attemptId = await makeAttempt(runId, { createdAt: ancient() });
  await prisma.$executeRaw`
    UPDATE "RoutingAttempt" SET "modelId" = 'a-different-model' WHERE "id" = ${attemptId}
  `;

  const result = await sweepStaleRoutingAttempts();
  assert.equal(result.noCostReasons.cost_intent_identity_mismatch, 1);
  assert.equal(result.closedCostInserted, 0);
  assert.equal(await attemptCostRow(reservation.reservationId), null);
});

test("a positive authorization holding no bucket is refused on read", async () => {
  // The validator's job now: an intent that says money was authorized, with
  // nothing in the bucket to show for it, is a hold that was lost.
  const reservation = await makeCrashedReservation();
  const durable = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: reservation.reservationId },
  });
  const payload = durable.reservationPayload as {
    entries?: { key: string }[];
    attemptHolds?: unknown[];
  };
  payload.entries = (payload.entries ?? []).filter(
    (entry) => !entry.key.startsWith("provider:")
  );
  payload.attemptHolds = [];
  await prisma.$executeRaw`
    UPDATE "ChatCreditReservation"
    SET "reservationPayload" = ${payload}::jsonb
    WHERE "id" = ${reservation.reservationId}
  `;

  const { runId } = await makeRun({ reservationId: reservation.reservationId });
  await makeAttempt(runId, { createdAt: ancient() });

  const result = await sweepStaleRoutingAttempts();
  assert.equal(result.noCostReasons.invalid_cost_intent_payload, 1);
});

test("a fallback that reserves nothing leaves the same shape the primary does", async () => {
  // The two paths used to disagree: acquisition skipped the hold and the
  // intent together, and the fallback wrote a zero hold with an intent beside
  // it -- so a crashed free primary and a crashed free fallback produced
  // payloads the sweep classified differently.
  const reservation = await makeFreeReservation();
  const day = await prisma.chatUsageBucket.findFirst({
    where: { period: "provider-cost-day" },
  });
  const month = await prisma.chatUsageBucket.findFirst({
    where: { period: "provider-cost-month" },
  });
  const starts = {
    day: day?.periodStart ?? new Date(),
    month: month?.periodStart ?? new Date(),
  };

  const result = await reserveAttemptProviderBudget({
    reservationId: reservation.reservationId,
    userId: reservation.userId ?? null,
    attemptIndex: 1,
    provider: "google",
    costIntent: {
      modelId: "fallback-model",
      provider: "google",
      estimatedInputTokens: 10_000,
      reservedOutputTokens: 10_000,
      inputUsdPerMillionTokens: 0,
      outputUsdPerMillionTokens: 0,
      cachedInputPriceMultiplier: 1,
      pricingVersion: "sweep-test",
    },
    reservedMicroUsd: 0,
    periodStarts: starts,
  });
  assert.equal(result.reserved, true);
  assert.deepEqual(result.reserved === true && result.entries, []);

  const durable = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: reservation.reservationId },
  });
  const payload = durable.reservationPayload as {
    attemptHolds?: { attemptIndex: number }[];
    attemptCostIntents?: { attemptIndex: number; reservedCostMicroUsd: number }[];
  };
  // The authorization is written and the hold is not, exactly as acquisition
  // leaves a free primary: an intent is what was allowed, a hold is money in a
  // bucket, and zero allowed puts none there.
  const fallbackIntent = (payload.attemptCostIntents ?? []).find(
    (intent) => intent.attemptIndex === 1
  );
  assert.ok(fallbackIntent, "a dispatched attempt is always authorized");
  assert.equal(fallbackIntent.reservedCostMicroUsd, 0);
  assert.equal(
    (payload.attemptHolds ?? []).some((hold) => hold.attemptIndex === 1),
    false
  );
  // And the primary's own hold, if it had one, is untouched by all of this.
  assert.equal(
    (payload.attemptHolds ?? []).filter((hold) => hold.attemptIndex === 0).length,
    (payload.attemptCostIntents ?? []).find((i) => i.attemptIndex === 0)
      ?.reservedCostMicroUsd
      ? 2
      : 0
  );
});
