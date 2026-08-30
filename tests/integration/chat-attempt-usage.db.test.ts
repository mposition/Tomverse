import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, beforeEach, test } from "node:test";

import {
  acquireChatAccess,
  reconcileExpiredChatCreditReservations,
  settleChatUsage,
  releaseAttemptProviderBudget,
  reserveAttemptProviderBudget,
  type ChatAccess,
  type ChatBudget,
} from "@/lib/chatSecurity";
import {
  closeAttemptWithCost,
  rollupDayOf,
} from "@/lib/chatAttemptCostLedger";
import { closeAttempt } from "@/lib/routingAttemptStore";
import { getModel } from "@/lib/models";
import { getNativeSearchCostMicroUsdPerQuery } from "@/lib/modelPricing";
import {
  observeOperationalIncidents,
  type ObservedOperationalIncident,
} from "@/lib/operationalMonitoring";
import { getProviderCostGuardrailLimits } from "@/lib/providerCostBudget";
import { getWebSearchCapability } from "@/lib/webSearchCapability";
import {
  NATIVE_SEARCH_AUTHORIZATION_CUTOVER_ENV,
  reserveNativeSearchCost,
  resetSearchQueryCeilingBreaches,
  searchQueryCeilingBreached,
} from "@/lib/webSearchNativeCostReservation";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { usageBucketCount } from "@/lib/chatUsageBucketCount";
import type { AttemptUsage } from "@/lib/chatMultiAttemptSettlement";

/**
 * Routing policy §7's two ledgers, against a real database.
 *
 * The pure arithmetic is pinned in `tests/chatMultiAttemptSettlement.test.mjs`.
 * What is only checkable here is that the two ledgers land in two places: the
 * user's credits settle once, every attempt's cost reaches its own provider's
 * spend bucket, and the audit rows for the primary and the fallback both
 * survive -- which they did not before, because the reservation has one
 * `providerRequestId` column and `linkChatReservationProviderRequest` only
 * ever writes into a null one.
 */

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ContextManifest",
      "RoutingAttempt",
      "RoutingRun",
      "ProviderDailyUsage",
      "TokenEstimateShadowSample",
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
/**
 * Process state, put back whatever a test did with it.
 *
 * The search-ceiling latch and the authorization cutover both live outside the
 * database, so `reset()` above does not touch them -- and a latch left set by
 * one test would refuse every dispatch the next one makes, from a module the
 * next test never mentions. Each test that touches them also restores them in
 * its own `finally`; this is the net under a test that throws somewhere else.
 */
afterEach(() => {
  resetSearchQueryCeilingBreaches();
  delete process.env[NATIVE_SEARCH_AUTHORIZATION_CUTOVER_ENV];
});
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const createUser = () =>
  prisma.user.create({
    data: { email: `attempt-usage-${randomUUID()}@example.test`, plan: "Pro" },
  });

const chatAccess = (user: { id: string }): ChatAccess => ({
  kind: "user",
  userId: user.id,
  plan: "Pro",
  subjectKey: `integration:user:${user.id}`,
  ipKey: `integration:ip:${user.id}`,
  planLimits: { dailyMessageLimit: 10_000, monthlyMessageLimit: 10_000 },
});

const chatBudget = (overrides: Partial<ChatBudget> = {}): ChatBudget => ({
  modelId: "attempt-usage-model",
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
  cacheWriteUsdPerMillionTokens: null,
  promptCacheWriteReservedPremiumMicroUsd: 0,
  nativeSearchReservedCostMicroUsd: 0,
  nativeSearchCostPerQueryMicroUsd: 0,
  nativeSearchMaxQueries: 0,
  searchBackend: null,
  provider: "openai",
  pricingVersion: "attempt-usage-test",
  costSource: "attempt-usage-test",
  longContextThresholdTokens: null,
  ...overrides,
});

const price = (
  provider: ChatBudget["provider"],
  modelId: string,
  inputRate: number,
  outputRate: number
) => ({
  provider,
  modelId,
  inputUsdPerMillionTokens: inputRate,
  outputUsdPerMillionTokens: outputRate,
  cachedInputPriceMultiplier: 1,
  pricingVersion: "attempt-usage-test",
});

const attempt = (overrides: Partial<AttemptUsage> = {}): AttemptUsage => ({
  attemptIndex: 0,
  price: price("openai", "primary-model", 100, 100),
  inputTokens: 10_000,
  cachedInputTokens: 0,
  outputTokens: 0,
  usageFromProvider: true,
  outcome: "failed",
  ...overrides,
});

/** The rates and estimate a fallback attempt would run at. */
const fallbackIntent = {
  modelId: "fallback-model",
  provider: "google",
  estimatedInputTokens: 10_000,
  reservedOutputTokens: 10_000,
  inputUsdPerMillionTokens: 200,
  outputUsdPerMillionTokens: 200,
  cachedInputPriceMultiplier: 1,
  pricingVersion: "attempt-usage-test",
};

const bucket = (key: string, period: string) =>
  prisma.chatUsageBucket
    .findFirst({ where: { key, period } })
    .then((row) => usageBucketCount(row?.count));

/**
 * A dispatched attempt, as the routing boundary would have left it.
 *
 * Dispatched rather than merely open, because `closeAttemptWithCost` is about
 * an attempt that reached a provider -- and ROUTE-06's constraint refuses a
 * dispatch that has no finalized manifest, which is the whole point of it.
 */
const routingAttempt = async () => {
  const run = await prisma.routingRun.create({
    data: {
      traceId: `trace-${randomUUID()}`,
      subjectKey: `attempt-cost:${randomUUID()}`,
      mode: "auto",
      plan: "Pro",
      initialModelId: "primary-model",
      taskProfileVersion: "attempt-usage-test",
      candidateFilterVersion: "attempt-usage-test",
      selectionVersion: "attempt-usage-test",
      estimatorVersion: "attempt-usage-test",
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
      userSelectedModelId: "primary-model",
      decisionMicros: 1_000,
    },
    select: { id: true },
  });
  const attemptRow = await prisma.routingAttempt.create({
    data: {
      runId: run.id,
      attemptIndex: 0,
      modelId: "primary-model",
      provider: "openai",
      outcome: "pending",
      failureLayer: "none",
    },
    select: { id: true },
  });
  const finalizedAt = new Date();
  await prisma.contextManifest.create({
    data: {
      attemptId: attemptRow.id,
      state: "finalized",
      sourceRefs: [],
      tokenizerVersion: "attempt-usage-test",
      tokenCount: 100,
      contextWindowTokens: 1_000,
      plannerVersion: "none",
      adapterVersion: "attempt-usage-test",
      effectiveRequestHash: "attempt-usage-hash",
      contentHashVersion: "attempt-usage-test",
      hashAlgorithm: "hmac-sha256",
      hashKeyId: "test-key",
      finalizedAt,
    },
  });
  await prisma.routingAttempt.update({
    where: { id: attemptRow.id },
    data: { manifestFinalizedAt: finalizedAt, dispatchedAt: finalizedAt },
  });
  return attemptRow.id;
};

const twoAttemptRun = async () => {
  const user = await createUser();
  const acquired = await acquireChatAccess(chatAccess(user), chatBudget(), {
    traceId: `trace-${randomUUID()}`,
  });
  return { user, acquired };
};

test("both attempts leave an audit row, and neither overwrites the other", async () => {
  const { acquired } = await twoAttemptRun();

  await settleChatUsage(
    acquired.usageReservation,
    { inputTokens: 10_000, outputTokens: 10_000, outcome: "completed" },
    {
      attempts: [
        attempt({
          attemptIndex: 0,
          outcome: "failed",
          providerRequestId: "req-primary",
        }),
        attempt({
          attemptIndex: 1,
          price: price("google", "fallback-model", 200, 200),
          outputTokens: 10_000,
          outcome: "completed",
          providerRequestId: "req-fallback",
        }),
      ],
    }
  );

  const rows = await prisma.chatAttemptUsage.findMany({
    where: { reservationId: acquired.usageReservation.reservationId },
    orderBy: { attemptIndex: "asc" },
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => [row.attemptIndex, row.modelId, row.provider, row.providerRequestId]),
    [
      [0, "primary-model", "openai", "req-primary"],
      [1, "fallback-model", "google", "req-fallback"],
    ]
  );
  // Each priced at its own rates: 10K input at $100/M, then 10K in + 10K out
  // at $200/M. At the primary's rates the fallback would have been 2,000,000.
  assert.equal(rows[0].costMicroUsd, BigInt(1_000_000));
  assert.equal(rows[1].costMicroUsd, BigInt(4_000_000));
});

test("exactly one attempt is the one the user was charged for", async () => {
  const { acquired } = await twoAttemptRun();
  await settleChatUsage(
    acquired.usageReservation,
    { inputTokens: 10_000, outputTokens: 10_000, outcome: "completed" },
    {
      attempts: [
        attempt({ attemptIndex: 0, outcome: "failed" }),
        attempt({
          attemptIndex: 1,
          price: price("google", "fallback-model", 200, 200),
          outputTokens: 10_000,
          outcome: "completed",
        }),
      ],
    }
  );

  // The pointer is on the reservation, so "at most one" is one column
  // holding one value rather than a partial index over many rows.
  const durable = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: acquired.usageReservation.reservationId },
  });
  assert.equal(durable.settlementAttemptIndex, 1);
  assert.equal(durable.status, "settled");
  assert.equal(durable.outcome, "completed");
  assert.equal(durable.settledOutputTokens, 10_000);
});

test("the settlement pointer must name a real attempt of this reservation", async () => {
  // A bare nullable Int would accept 7. The composite foreign key makes it an
  // attempt that exists, of this reservation.
  const { acquired } = await twoAttemptRun();
  await assert.rejects(
    prisma.chatCreditReservation.update({
      where: { id: acquired.usageReservation.reservationId },
      data: { settlementAttemptIndex: 1 },
    }),
    /foreign key|constraint/i
  );
});

test("the settlement pointer is write-once", async () => {
  // §7: a goodwill refund must not rewrite provider cost accounting. Moving
  // the pointer would re-attribute the user's charge to a different attempt,
  // which is that rewrite by another route.
  const { acquired } = await twoAttemptRun();
  await settleChatUsage(
    acquired.usageReservation,
    { inputTokens: 10_000, outputTokens: 10_000, outcome: "completed" },
    {
      attempts: [
        attempt({ attemptIndex: 0, outcome: "failed" }),
        attempt({
          attemptIndex: 1,
          price: price("google", "fallback-model", 200, 200),
          outputTokens: 10_000,
          outcome: "completed",
        }),
      ],
    }
  );
  await assert.rejects(
    prisma.chatCreditReservation.update({
      where: { id: acquired.usageReservation.reservationId },
      data: { settlementAttemptIndex: 0 },
    }),
    /write-once/
  );
});

test("settling twice records the provider cost once", async () => {
  // ProviderDailyUsage is a daily rollup with no per-request key, so the
  // attempt rows are what dedupes it -- and the increment only follows an
  // insert that actually happened.
  const { acquired } = await twoAttemptRun();
  const attempts = [
    attempt({ attemptIndex: 0, outcome: "failed" }),
    attempt({
      attemptIndex: 1,
      price: price("google", "fallback-model", 200, 200),
      outputTokens: 10_000,
      outcome: "completed",
    }),
  ];
  const usage = { inputTokens: 10_000, outputTokens: 10_000, outcome: "completed" as const };
  await settleChatUsage(acquired.usageReservation, usage, { attempts });
  await settleChatUsage(acquired.usageReservation, usage, { attempts });

  const rollups = await prisma.providerDailyUsage.findMany({
    orderBy: { provider: "asc" },
  });
  assert.deepEqual(
    rollups.map((row) => [row.provider, row.requestCount]),
    [
      ["google", 1],
      ["openai", 1],
    ],
    "a repeated settlement must not double the day's rollup"
  );
  assert.equal(
    await prisma.chatAttemptUsage.count({
      where: { reservationId: acquired.usageReservation.reservationId },
    }),
    2
  );
});

test("an attempt's recorded cost cannot be edited afterwards", async () => {
  // §7: a goodwill refund "must not rewrite provider cost accounting". The
  // row admits no update at all, so a correction has to be a new record
  // somewhere else rather than a quiet edit to the evidence.
  const { acquired } = await twoAttemptRun();
  const row = await prisma.chatAttemptUsage.create({
    data: {
      reservationId: acquired.usageReservation.reservationId,
      attemptIndex: 0,
      modelId: "primary-model",
      provider: "openai",
      outcome: "failed",
      rollupDate: rollupDayOf(),
      inputTokens: 0,
      outputTokens: 0,
      costMicroUsd: BigInt(1_000_000),
    },
  });
  await assert.rejects(
    prisma.chatAttemptUsage.update({
      where: { id: row.id },
      data: { costMicroUsd: BigInt(0) },
    }),
    /cannot be modified/
  );
});

test("a third attempt cannot be recorded at all", async () => {
  // §6's two-build budget, at the layer that sees the money.
  const { acquired } = await twoAttemptRun();
  await assert.rejects(
    prisma.chatAttemptUsage.create({
      data: {
        reservationId: acquired.usageReservation.reservationId,
        attemptIndex: 2,
        modelId: "third-model",
        provider: "google",
        outcome: "completed",
        rollupDate: rollupDayOf(),
        inputTokens: 0,
        outputTokens: 0,
      },
    }),
    /constraint/i
  );
});

test("each provider's spend bucket sees its own attempt and only its own", async () => {
  const { acquired } = await twoAttemptRun();
  const heldBefore = await bucket("provider:openai", "provider-cost-day");
  assert.ok(heldBefore > 0, "the reservation should have held the primary's provider");

  await settleChatUsage(
    acquired.usageReservation,
    { inputTokens: 10_000, outputTokens: 10_000, outcome: "completed" },
    {
      attempts: [
        attempt({ attemptIndex: 0, outcome: "failed" }),
        attempt({
          attemptIndex: 1,
          price: price("google", "fallback-model", 200, 200),
          outputTokens: 10_000,
          outcome: "completed",
        }),
      ],
    }
  );

  // The primary's bucket settles down to what the primary actually cost, not
  // to the whole turn: the hold is released and the real figure applied.
  assert.equal(await bucket("provider:openai", "provider-cost-day"), 1_000_000);
  assert.equal(await bucket("provider:openai", "provider-cost-month"), 1_000_000);
  // The fallback's provider held nothing and is charged what it was paid.
  assert.equal(await bucket("provider:google", "provider-cost-day"), 4_000_000);
  assert.equal(await bucket("provider:google", "provider-cost-month"), 4_000_000);
});

test("a fallback on the same provider is not charged to it twice", async () => {
  const { acquired } = await twoAttemptRun();
  await settleChatUsage(
    acquired.usageReservation,
    { inputTokens: 10_000, outputTokens: 10_000, outcome: "completed" },
    {
      attempts: [
        attempt({ attemptIndex: 0, outcome: "failed" }),
        attempt({
          attemptIndex: 1,
          price: price("openai", "sibling-model", 100, 100),
          outputTokens: 10_000,
          outcome: "completed",
        }),
      ],
    }
  );
  // 1M in, then 1M in + 1M out, all at $1/M: one bucket, three million.
  assert.equal(await bucket("provider:openai", "provider-cost-day"), 3_000_000);
  assert.equal(await bucket("provider:google", "provider-cost-day"), 0);
});

test("the provider usage ledger records each attempt under its own model", async () => {
  const { acquired } = await twoAttemptRun();
  await settleChatUsage(
    acquired.usageReservation,
    { inputTokens: 10_000, outputTokens: 10_000, outcome: "completed" },
    {
      attempts: [
        attempt({ attemptIndex: 0, outcome: "failed" }),
        attempt({
          attemptIndex: 1,
          price: price("google", "fallback-model", 200, 200),
          outputTokens: 10_000,
          outcome: "completed",
        }),
      ],
    }
  );

  const usage = await prisma.providerDailyUsage.findMany({
    orderBy: { provider: "asc" },
  });
  assert.deepEqual(
    usage.map((row) => [row.provider, row.modelId]),
    [
      ["google", "fallback-model"],
      ["openai", "primary-model"],
    ]
  );
});

test("a settlement with no attempts settles the user's half exactly as it always has", async () => {
  // The whole of today's traffic. The user's ledger -- credits, cost, the
  // provider bucket -- must be untouched by the attempt ledger existing.
  //
  // What did change, deliberately, is that the turn now leaves a cost row of
  // its own. It used to accrue after the transaction committed, which left a
  // window where a crash lost the rollup with no way to rebuild it: the
  // reservation was already terminal, so a rerun could not restore it.
  const { acquired } = await twoAttemptRun();
  await settleChatUsage(acquired.usageReservation, {
    inputTokens: 10_000,
    outputTokens: 10_000,
    outcome: "completed",
  });

  const durable = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: acquired.usageReservation.reservationId },
  });
  assert.equal(durable.status, "settled");
  assert.equal(durable.settledCostMicroUsd, BigInt(2_000_000));
  assert.equal(await bucket("provider:openai", "provider-cost-day"), 2_000_000);

  const rows = await prisma.chatAttemptUsage.findMany({
    where: { reservationId: durable.id },
  });
  assert.equal(rows.length, 1, "one dispatch, one cost row");
  assert.equal(rows[0].attemptIndex, 0);
  assert.equal(rows[0].costMicroUsd, BigInt(2_000_000));
});

test("a malformed attempt set is refused rather than settled anyway", async () => {
  const { acquired } = await twoAttemptRun();
  await assert.rejects(
    settleChatUsage(
      acquired.usageReservation,
      { inputTokens: 1, outputTokens: 1, outcome: "completed" },
      {
        attempts: [
          attempt({ attemptIndex: 0 }),
          attempt({ attemptIndex: 0 }),
        ],
      }
    ),
    /cannot be settled/
  );
  const durable = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: acquired.usageReservation.reservationId },
  });
  assert.equal(durable.status, "reserved", "the money must not have moved");
});

const periodStarts = async () => ({
  day: (
    await prisma.chatUsageBucket.findFirstOrThrow({
      where: { key: "provider:openai", period: "provider-cost-day" },
    })
  ).periodStart,
  month: (
    await prisma.chatUsageBucket.findFirstOrThrow({
      where: { key: "provider:openai", period: "provider-cost-month" },
    })
  ).periodStart,
});

const payloadIntents = async (reservationId: string) => {
  const row = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: reservationId },
  });
  return (
    (row.reservationPayload as {
      attemptCostIntents?: { attemptIndex: number; reservedCostMicroUsd: number }[];
    }).attemptCostIntents ?? []
  );
};

const payloadHolds = async (reservationId: string) => {
  const row = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: reservationId },
  });
  return (
    (row.reservationPayload as { attemptHolds?: { attemptIndex: number }[] })
      .attemptHolds ?? []
  );
};

const payloadEntries = async (reservationId: string) => {
  const row = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: reservationId },
  });
  return (row.reservationPayload as { entries: { key: string; period: string; amount: number }[] })
    .entries;
};

test("a fallback on another provider takes its own hold, in the durable payload", async () => {
  // The bug this replaced: the hold was taken and handed back to a caller who
  // never kept it, so settleChatUsage re-read a payload that still described a
  // hold on the primary alone.
  const { acquired } = await twoAttemptRun();
  const heldBefore = await bucket("provider:openai", "provider-cost-day");

  const reserved = await reserveAttemptProviderBudget({
    reservationId: acquired.usageReservation.reservationId,
    userId: acquired.usageReservation.userId ?? null,
    attemptIndex: 1,
    provider: "google",
    costIntent: fallbackIntent,
    reservedMicroUsd: 500_000,
  });

  assert.equal(reserved.reserved, true);
  assert.equal(await bucket("provider:google", "provider-cost-day"), 500_000);
  // The primary's hold is kept until settlement releases it down to what the
  // primary actually cost. Briefly counting the turn against two providers is
  // the safe direction for a guard whose job is to prevent overspend.
  assert.equal(await bucket("provider:openai", "provider-cost-day"), heldBefore);

  const entries = await payloadEntries(acquired.usageReservation.reservationId);
  assert.equal(
    entries.filter((entry) => entry.key === "provider:google").length,
    2,
    "the payload must record both periods, or settlement cannot release them"
  );
});

test("a fallback on the same provider takes its own hold too", async () => {
  // The bug this replaced returned early here on the grounds that "the hold
  // already covers it". A hold is sized for one attempt, and a second call on
  // the same provider costs more whether or not it shares a bucket.
  const { acquired } = await twoAttemptRun();
  const before = await bucket("provider:openai", "provider-cost-day");
  const result = await reserveAttemptProviderBudget({
    reservationId: acquired.usageReservation.reservationId,
    userId: acquired.usageReservation.userId ?? null,
    attemptIndex: 1,
    provider: "openai",
    costIntent: fallbackIntent,
    reservedMicroUsd: 500_000,
  });
  assert.equal(result.reserved, true);
  assert.equal(
    await bucket("provider:openai", "provider-cost-day"),
    before + 500_000
  );
  // One entry, its amount the sum. Two rows under one key would be settled
  // twice, because settlement moves every provider entry to that provider's
  // whole actual cost.
  const entries = await payloadEntries(acquired.usageReservation.reservationId);
  const day = entries.filter(
    (entry) => entry.key === "provider:openai" && entry.period === "provider-cost-day"
  );
  assert.equal(day.length, 1);
  assert.equal(day[0].amount, before + 500_000);
});

test("one attempt cannot hold the same budget twice", async () => {
  const { acquired } = await twoAttemptRun();
  const first = await reserveAttemptProviderBudget({
    reservationId: acquired.usageReservation.reservationId,
    userId: acquired.usageReservation.userId ?? null,
    attemptIndex: 1,
    provider: "google",
    costIntent: fallbackIntent,
    reservedMicroUsd: 500_000,
  });
  assert.equal(first.reserved, true);
  const second = await reserveAttemptProviderBudget({
    reservationId: acquired.usageReservation.reservationId,
    userId: acquired.usageReservation.userId ?? null,
    attemptIndex: 1,
    provider: "google",
    costIntent: fallbackIntent,
    reservedMicroUsd: 500_000,
  });
  assert.equal(second.reserved, false);
  assert.equal(second.reserved === false && second.reason, "already_authorized");
  assert.equal(await bucket("provider:google", "provider-cost-day"), 500_000);
});

test("releasing one attempt leaves the other's hold on a shared provider", async () => {
  // The reason release takes an attempt index and not a provider: by provider
  // it would take the primary's hold away with the fallback's, and the turn
  // would hold nothing for a call that is still running.
  const { acquired } = await twoAttemptRun();
  const primaryHold = await bucket("provider:openai", "provider-cost-day");
  await reserveAttemptProviderBudget({
    reservationId: acquired.usageReservation.reservationId,
    userId: acquired.usageReservation.userId ?? null,
    attemptIndex: 1,
    provider: "openai",
    costIntent: fallbackIntent,
    reservedMicroUsd: 500_000,
  });
  const released = await releaseAttemptProviderBudget({
    reservationId: acquired.usageReservation.reservationId,
    userId: acquired.usageReservation.userId ?? null,
    attemptIndex: 1,
  });
  assert.equal(released, true);
  assert.equal(
    await bucket("provider:openai", "provider-cost-day"),
    primaryHold,
    "only the fallback's delta may come back"
  );
});

test("a refused day budget leaves the primary's hold untouched", async () => {
  const { acquired } = await twoAttemptRun();
  const heldBefore = await bucket("provider:openai", "provider-cost-day");
  const result = await reserveAttemptProviderBudget({
    reservationId: acquired.usageReservation.reservationId,
    userId: acquired.usageReservation.userId ?? null,
    attemptIndex: 1,
    provider: "google",
    // Larger than any configured guardrail, so incrementUsage refuses.
    costIntent: fallbackIntent,
    reservedMicroUsd: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(result.reserved, false);
  assert.equal(await bucket("provider:openai", "provider-cost-day"), heldBefore);
  assert.equal(await bucket("provider:google", "provider-cost-day"), 0);
  const entries = await payloadEntries(acquired.usageReservation.reservationId);
  assert.equal(entries.some((entry) => entry.key === "provider:google"), false);
});

test("a month refusal rolls back the day hold taken moments before", async () => {
  // The two checks run in one transaction precisely so this cannot leave a
  // day hold behind for a call that was never authorized.
  const { acquired } = await twoAttemptRun();
  const guardrails = getProviderCostGuardrailLimits("google");
  // Fill the month bucket to just under its limit, leaving the day bucket
  // empty: the day check then passes and the month check refuses.
  const starts = await periodStarts();
  await prisma.chatUsageBucket.create({
    data: {
      key: "provider:google",
      period: "provider-cost-month",
      periodStart: starts.month,
      count: guardrails.month - 1,
    },
  });
  const result = await reserveAttemptProviderBudget({
    reservationId: acquired.usageReservation.reservationId,
    userId: acquired.usageReservation.userId ?? null,
    attemptIndex: 1,
    provider: "google",
    costIntent: fallbackIntent,
    reservedMicroUsd: 1_000,
  });
  assert.equal(result.reserved, false);
  assert.equal(
    result.reserved === false && result.reason,
    "budget_exhausted"
  );
  assert.equal(
    await bucket("provider:google", "provider-cost-day"),
    0,
    "the day hold must roll back with the month refusal"
  );
  assert.equal(
    await bucket("provider:google", "provider-cost-month"),
    guardrails.month - 1
  );
});

test("a reservation that already settled cannot be held against", async () => {
  const { acquired } = await twoAttemptRun();
  await settleChatUsage(acquired.usageReservation, {
    inputTokens: 10_000,
    outputTokens: 10_000,
    outcome: "completed",
  });
  const result = await reserveAttemptProviderBudget({
    reservationId: acquired.usageReservation.reservationId,
    userId: acquired.usageReservation.userId ?? null,
    attemptIndex: 1,
    provider: "google",
    costIntent: fallbackIntent,
    reservedMicroUsd: 500_000,
  });
  assert.equal(result.reserved, false);
  assert.equal(result.reserved === false && result.reason, "reservation_not_open");
  assert.equal(await bucket("provider:google", "provider-cost-day"), 0);
});

test("a hold whose dispatch never happened is given back, payload included", async () => {
  const { acquired } = await twoAttemptRun();
  await reserveAttemptProviderBudget({
    reservationId: acquired.usageReservation.reservationId,
    userId: acquired.usageReservation.userId ?? null,
    attemptIndex: 1,
    provider: "google",
    costIntent: fallbackIntent,
    reservedMicroUsd: 500_000,
  });
  const released = await releaseAttemptProviderBudget({
    reservationId: acquired.usageReservation.reservationId,
    userId: acquired.usageReservation.userId ?? null,
    attemptIndex: 1,
    });
  assert.equal(released, true);
  assert.equal(await bucket("provider:google", "provider-cost-day"), 0);
  assert.equal(await bucket("provider:google", "provider-cost-month"), 0);
  const entries = await payloadEntries(acquired.usageReservation.reservationId);
  assert.equal(
    entries.some((entry) => entry.key === "provider:google"),
    false,
    "the payload must not keep claiming a hold that has been released"
  );
});

test("a released hold leaves the turn settling as the single attempt it was", async () => {
  // The path the route takes when the fallback's dispatch fails: one attempt,
  // one settlement, and no trace of a provider that was never called.
  const { acquired } = await twoAttemptRun();
  await reserveAttemptProviderBudget({
    reservationId: acquired.usageReservation.reservationId,
    userId: acquired.usageReservation.userId ?? null,
    attemptIndex: 1,
    provider: "google",
    costIntent: fallbackIntent,
    reservedMicroUsd: 500_000,
  });
  await releaseAttemptProviderBudget({
    reservationId: acquired.usageReservation.reservationId,
    userId: acquired.usageReservation.userId ?? null,
    attemptIndex: 1,
    });
  await settleChatUsage(acquired.usageReservation, {
    inputTokens: 10_000,
    outputTokens: 0,
    outcome: "failed",
  });
  assert.equal(await bucket("provider:google", "provider-cost-day"), 0);
  assert.equal(await bucket("provider:openai", "provider-cost-day"), 1_000_000);
});

test("reserve then settle lands each provider on its own actual cost", async () => {
  // The end-to-end the previous version got wrong: the hold has to be in the
  // durable payload, because settleChatUsage re-reads it from the row.
  const { acquired } = await twoAttemptRun();
  await reserveAttemptProviderBudget({
    reservationId: acquired.usageReservation.reservationId,
    userId: acquired.usageReservation.userId ?? null,
    attemptIndex: 1,
    provider: "google",
    costIntent: fallbackIntent,
    reservedMicroUsd: 5_000_000,
  });
  assert.equal(await bucket("provider:google", "provider-cost-day"), 5_000_000);

  await settleChatUsage(
    acquired.usageReservation,
    { inputTokens: 10_000, outputTokens: 10_000, outcome: "completed" },
    {
      attempts: [
        attempt({ attemptIndex: 0, outcome: "failed" }),
        attempt({
          attemptIndex: 1,
          price: price("google", "fallback-model", 200, 200),
          outputTokens: 10_000,
          outcome: "completed",
        }),
      ],
    }
  );

  // Each settles down to what it actually cost, from its own hold. The
  // fallback's 5,000,000 hold is released to its real 4,000,000, and the
  // primary's 2,000,000 hold to its real 1,000,000.
  assert.equal(await bucket("provider:openai", "provider-cost-day"), 1_000_000);
  assert.equal(await bucket("provider:openai", "provider-cost-month"), 1_000_000);
  assert.equal(await bucket("provider:google", "provider-cost-day"), 4_000_000);
  assert.equal(await bucket("provider:google", "provider-cost-month"), 4_000_000);
});

test("two concurrent fallbacks cannot both take the last of a budget", async () => {
  const guardrails = getProviderCostGuardrailLimits("google");
  const first = await twoAttemptRun();
  const second = await twoAttemptRun();
  // Room for exactly one of the two.
  const amount = Math.floor(guardrails.day / 2) + 1;

  const results = await Promise.all([
    reserveAttemptProviderBudget({
      reservationId: first.acquired.usageReservation.reservationId,
      userId: first.acquired.usageReservation.userId ?? null,
      attemptIndex: 1,
      provider: "google",
      costIntent: fallbackIntent,
    reservedMicroUsd: amount,
    }),
    reserveAttemptProviderBudget({
      reservationId: second.acquired.usageReservation.reservationId,
      userId: second.acquired.usageReservation.userId ?? null,
      attemptIndex: 1,
      provider: "google",
      costIntent: fallbackIntent,
    reservedMicroUsd: amount,
    }),
  ]);

  const taken = results.filter((result) => result.reserved);
  assert.equal(taken.length, 1, "the budget admitted both requests");
  assert.equal(await bucket("provider:google", "provider-cost-day"), amount);
});

// Reservations written before `attemptHolds` existed. Rare in production —
// the fallback flag is off — but a reservation created before a deploy is
// still open after it, and reconciliation will read it.

/** Strips `attemptHolds`, leaving the payload as the old code wrote it. */
const makeLegacy = async (reservationId: string) => {
  const row = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: reservationId },
  });
  const payload = row.reservationPayload as Record<string, unknown>;
  delete payload.attemptHolds;
  await prisma.chatCreditReservation.update({
    where: { id: reservationId },
    data: { reservationPayload: payload as Prisma.InputJsonValue },
  });
};

test("a legacy reservation settles exactly as it always did", async () => {
  const { acquired } = await twoAttemptRun();
  await makeLegacy(acquired.usageReservation.reservationId);

  await settleChatUsage(acquired.usageReservation, {
    inputTokens: 10_000,
    outputTokens: 10_000,
    outcome: "completed",
  });

  const durable = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: acquired.usageReservation.reservationId },
  });
  assert.equal(durable.status, "settled");
  // A charged turn names the attempt it charged for, legacy payload or not:
  // the pointer is about what was billed, and this one billed attempt 0.
  assert.equal(durable.settlementAttemptIndex, 0);
  // 10K in and 10K out at $100/M: the whole turn on one provider.
  assert.equal(await bucket("provider:openai", "provider-cost-day"), 2_000_000);
});

test("a legacy reservation reconciles when it expires", async () => {
  const { acquired } = await twoAttemptRun();
  await makeLegacy(acquired.usageReservation.reservationId);
  await prisma.chatCreditReservation.update({
    where: { id: acquired.usageReservation.reservationId },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });

  const result = await reconcileExpiredChatCreditReservations();
  assert.equal(result.failed, 0);
  assert.equal(result.refunded, 1);
  // The hold is given back in full: nothing was spent.
  assert.equal(await bucket("provider:openai", "provider-cost-day"), 0);
});

test("a legacy reservation's primary hold survives its first fallback", async () => {
  // The bug this pins: with no `attemptHolds` to start from, writing the
  // fallback's hold rebuilt the provider entries from that hold alone and the
  // primary's vanished — leaving money in the bucket that nothing would ever
  // release.
  const { acquired } = await twoAttemptRun();
  await makeLegacy(acquired.usageReservation.reservationId);
  const primaryHold = await bucket("provider:openai", "provider-cost-day");
  assert.ok(primaryHold > 0);

  const reserved = await reserveAttemptProviderBudget({
    reservationId: acquired.usageReservation.reservationId,
    userId: acquired.usageReservation.userId ?? null,
    attemptIndex: 1,
    provider: "google",
    costIntent: fallbackIntent,
    reservedMicroUsd: 500_000,
  });
  assert.equal(reserved.reserved, true);

  const entries = await payloadEntries(acquired.usageReservation.reservationId);
  const primaryDay = entries.find(
    (entry) =>
      entry.key === "provider:openai" && entry.period === "provider-cost-day"
  );
  assert.ok(primaryDay, "the primary's entry must survive the adoption");
  assert.equal(primaryDay.amount, primaryHold);

  // And it settles back down rather than being stranded.
  await settleChatUsage(
    acquired.usageReservation,
    { inputTokens: 10_000, outputTokens: 10_000, outcome: "completed" },
    {
      attempts: [
        attempt({ attemptIndex: 0, outcome: "failed" }),
        attempt({
          attemptIndex: 1,
          price: price("google", "fallback-model", 200, 200),
          outputTokens: 10_000,
          outcome: "completed",
        }),
      ],
    }
  );
  assert.equal(await bucket("provider:openai", "provider-cost-day"), 1_000_000);
  assert.equal(await bucket("provider:google", "provider-cost-day"), 4_000_000);
});

// The deferred constraint trigger. What makes it worth having is that it is
// evaluated at COMMIT against the row's final state — not at the statement
// that queued it.

test("a temporary violation inside the transaction survives to COMMIT", async () => {
  const { acquired } = await twoAttemptRun();
  const id = acquired.usageReservation.reservationId;

  await prisma.$transaction(async (tx) => {
    // Settled with attempt rows and no pointer: a violation, right now.
    await tx.chatAttemptUsage.create({
      data: {
        reservationId: id,
        attemptIndex: 0,
        modelId: "primary-model",
        provider: "openai",
        outcome: "failed",
        rollupDate: rollupDayOf(),
        inputTokens: 0,
        outputTokens: 0,
      },
    });
    await tx.chatCreditReservation.update({
      where: { id },
      // Charged credits, because a full refund is allowed to name no attempt
      // and would not put the trigger in play at all.
      data: { status: "settled", settledCredits: 5, settledAt: new Date() },
    });
    // Repaired before the transaction ends, in a separate statement — which
    // is the case a trigger reading its queued NEW would have failed.
    await tx.chatCreditReservation.update({
      where: { id },
      data: { settlementAttemptIndex: 0 },
    });
  });

  const durable = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id },
  });
  assert.equal(durable.settlementAttemptIndex, 0);
});

test("a violation left standing fails the whole transaction", async () => {
  const { acquired } = await twoAttemptRun();
  const id = acquired.usageReservation.reservationId;

  await assert.rejects(
    prisma.$transaction(async (tx) => {
      await tx.chatAttemptUsage.create({
        data: {
          reservationId: id,
          attemptIndex: 0,
          modelId: "primary-model",
          provider: "openai",
          outcome: "failed",
          rollupDate: rollupDayOf(),
          inputTokens: 0,
          outputTokens: 0,
        },
      });
      await tx.chatCreditReservation.update({
        where: { id },
        data: { status: "settled", settledCredits: 5, settledAt: new Date() },
      });
    }),
    /charged 5 credits across 1 attempt\(s\) and names none/
  );

  const durable = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id },
  });
  assert.equal(durable.status, "reserved", "the transaction must have rolled back");
});

test("a full refund may name no attempt, even with cost rows against it", async () => {
  // The relaxation crash reconciliation needed. The user is refunded in full
  // and the provider's cost is kept, so no attempt was the basis of a charge
  // -- and demanding a pointer would force a claim that one was.
  const { acquired } = await twoAttemptRun();
  const id = acquired.usageReservation.reservationId;

  await prisma.$transaction(async (tx) => {
    await tx.chatAttemptUsage.create({
      data: {
        reservationId: id,
        attemptIndex: 0,
        modelId: "primary-model",
        provider: "openai",
        outcome: "unknown_after_dispatch",
        rollupDate: rollupDayOf(),
        usageSource: "crash_reconciliation",
        costSource: "reserved_upper_bound",
        costMicroUsd: BigInt(2_000_000),
      },
    });
    await tx.chatCreditReservation.update({
      where: { id },
      data: { status: "refunded", settledCredits: 0, settledAt: new Date() },
    });
  });

  const durable = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id },
  });
  assert.equal(durable.settlementAttemptIndex, null);
  assert.equal(
    await prisma.chatAttemptUsage.count({ where: { reservationId: id } }),
    1
  );
});

test("the pointer may be set before the attempt row it names exists", async () => {
  // The deferred foreign key: at COMMIT both are there, and the order they
  // arrived in is not the constraint's business.
  const { acquired } = await twoAttemptRun();
  const id = acquired.usageReservation.reservationId;

  await prisma.$transaction(async (tx) => {
    await tx.chatCreditReservation.update({
      where: { id },
      data: {
        settlementAttemptIndex: 1,
        status: "settled",
        settledCredits: 5,
        settledAt: new Date(),
      },
    });
    await tx.chatAttemptUsage.create({
      data: {
        reservationId: id,
        attemptIndex: 1,
        modelId: "fallback-model",
        provider: "google",
        outcome: "completed",
        rollupDate: rollupDayOf(),
        inputTokens: 0,
        outputTokens: 0,
      },
    });
  });

  const durable = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id },
  });
  assert.equal(durable.settlementAttemptIndex, 1);
});

// An attempt's cost, recorded when that attempt ends rather than when the turn
// does. The primary of a fallback is terminal long before settlement, so the
// stale-attempt sweep never looks at it again -- and until this existed, a
// process dying during the fallback lost the primary's provider spend
// outright.

test("an attempt that ends mid-turn records its cost with its close", async () => {
  const { acquired } = await twoAttemptRun();
  const reservationId = acquired.usageReservation.reservationId;
  const attemptId = await routingAttempt();

  const result = await closeAttemptWithCost({
    attemptId,
    outcome: "failed_pre_token",
    failureLayer: "provider",
    cost: {
      reservationId,
      attempt: {
        ...attempt({ attemptIndex: 0, outcome: "failed" }),
        costMicroUsd: 1_000_000,
        costSource: "token_estimate",
        userBilled: false,
      },
    },
  });
  assert.deepEqual(result, { closed: true, cost: "inserted" });

  const row = await prisma.chatAttemptUsage.findUniqueOrThrow({
    where: { reservationId_attemptIndex: { reservationId, attemptIndex: 0 } },
  });
  assert.equal(row.costMicroUsd, BigInt(1_000_000));
  // The provenance says the numbers were observed, not reserved: this attempt
  // ended in a place where somebody was watching.
  assert.equal(row.usageSource, "provider_usage_metadata");
  assert.equal(row.costSource, "token_estimate");
  // And the rollup moved with it, in the same transaction.
  const rollup = await prisma.providerDailyUsage.findFirstOrThrow({
    where: { provider: "openai", modelId: "primary-model" },
  });
  assert.equal(rollup.estimatedCostMicroUsd, 1_000_000);
});

test("a close that loses the compare-and-set records no cost either", async () => {
  // The cost row belongs to whoever established the attempt was over. A loser
  // that wrote one anyway would be recording spend against an outcome it did
  // not set -- and the winner's row would be the one skipped as a duplicate.
  const { acquired } = await twoAttemptRun();
  const reservationId = acquired.usageReservation.reservationId;
  const attemptId = await routingAttempt();
  assert.equal(await closeAttempt({ attemptId, outcome: "succeeded" }), true);

  const result = await closeAttemptWithCost({
    attemptId,
    outcome: "failed_pre_token",
    cost: {
      reservationId,
      attempt: {
        ...attempt({ attemptIndex: 0, outcome: "failed" }),
        costMicroUsd: 1_000_000,
        costSource: "token_estimate",
        userBilled: false,
      },
    },
  });
  assert.deepEqual(result, { closed: false, cost: "skipped" });
  assert.equal(
    await prisma.chatAttemptUsage.count({ where: { reservationId } }),
    0
  );
  assert.equal(await prisma.providerDailyUsage.count(), 0);
});

test("settlement does not charge again for an attempt that already recorded itself", async () => {
  const { acquired } = await twoAttemptRun();
  const reservationId = acquired.usageReservation.reservationId;
  const attemptId = await routingAttempt();
  const primary = attempt({ attemptIndex: 0, outcome: "failed" });

  await closeAttemptWithCost({
    attemptId,
    outcome: "failed_pre_token",
    cost: {
      reservationId,
      attempt: { ...primary, costMicroUsd: 1_000_000, costSource: "token_estimate", userBilled: false },
    },
  });

  await settleChatUsage(
    acquired.usageReservation,
    { inputTokens: 10_000, outputTokens: 10_000, outcome: "completed" },
    {
      attempts: [
        primary,
        attempt({
          attemptIndex: 1,
          price: price("google", "fallback-model", 200, 200),
          outputTokens: 10_000,
          outcome: "completed",
        }),
      ],
    }
  );

  // Two rows, one each, and no adjustment: the second writer of an observed
  // row is a replay, not a correction.
  assert.equal(
    await prisma.chatAttemptUsage.count({ where: { reservationId } }),
    2
  );
  assert.equal(
    await prisma.chatAttemptUsageAdjustment.count({ where: { reservationId } }),
    0
  );
  const primaryRollup = await prisma.providerDailyUsage.findFirstOrThrow({
    where: { provider: "openai", modelId: "primary-model" },
  });
  assert.equal(
    primaryRollup.estimatedCostMicroUsd,
    1_000_000,
    "the primary's spend must be counted once, not once per writer"
  );
  assert.equal(primaryRollup.requestCount, 1);
});

// A fallback that stays on the provider it started on. Sharing a bucket is
// what makes these worth pinning: the hold, the limit and the settlement all
// have to keep two attempts apart inside one key.

test("a same-provider fallback is refused when the two holds exceed the limit", async () => {
  const { acquired } = await twoAttemptRun();
  const guardrails = getProviderCostGuardrailLimits("openai");
  const starts = await periodStarts();
  // Fill the shared bucket to one under the day limit. The primary's own hold
  // is part of that total, which is the point: a same-provider fallback is
  // measured against everything already in the bucket, its own turn included.
  await prisma.chatUsageBucket.updateMany({
    where: { key: "provider:openai", period: "provider-cost-day", periodStart: starts.day },
    data: { count: guardrails.day - 1 },
  });

  const result = await reserveAttemptProviderBudget({
    reservationId: acquired.usageReservation.reservationId,
    userId: acquired.usageReservation.userId ?? null,
    attemptIndex: 1,
    provider: "openai",
    costIntent: { ...fallbackIntent, provider: "openai", modelId: "sibling-model" },
    reservedMicroUsd: 1_000,
  });
  assert.equal(result.reserved, false);
  assert.equal(result.reserved === false && result.reason, "budget_exhausted");
  // The primary's hold is still exactly where it was: a refused fallback must
  // not take, or give back, budget that belongs to the attempt that ran.
  assert.equal(
    await bucket("provider:openai", "provider-cost-day"),
    guardrails.day - 1
  );
  const entries = await payloadEntries(acquired.usageReservation.reservationId);
  assert.equal(
    entries.filter((entry) => entry.key === "provider:openai" && entry.period === "provider-cost-day")
      .length,
    1
  );
});

test("a same-provider fallback settles the shared bucket to the sum of both actual costs", async () => {
  const { acquired } = await twoAttemptRun();
  await reserveAttemptProviderBudget({
    reservationId: acquired.usageReservation.reservationId,
    userId: acquired.usageReservation.userId ?? null,
    attemptIndex: 1,
    provider: "openai",
    costIntent: { ...fallbackIntent, provider: "openai", modelId: "sibling-model" },
    reservedMicroUsd: 5_000_000,
  });

  await settleChatUsage(
    acquired.usageReservation,
    { inputTokens: 10_000, outputTokens: 10_000, outcome: "completed" },
    {
      attempts: [
        attempt({ attemptIndex: 0, outcome: "failed" }),
        attempt({
          attemptIndex: 1,
          price: price("openai", "sibling-model", 100, 100),
          outputTokens: 10_000,
          outcome: "completed",
        }),
      ],
    }
  );

  // 1,000,000 for the primary and 2,000,000 for the fallback, in one bucket.
  // Not one of them, which is what a release keyed by provider would leave,
  // and not the 7,000,000 of holds either.
  assert.equal(await bucket("provider:openai", "provider-cost-day"), 3_000_000);
  assert.equal(await bucket("provider:openai", "provider-cost-month"), 3_000_000);
  // The user pays for the one attempt that answered.
  const durable = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: acquired.usageReservation.reservationId },
  });
  assert.equal(durable.settlementAttemptIndex, 1);
});

// The turn that dispatched once, which is most of them.
//
// Its accrual used to happen after the settlement transaction committed, which
// left the window this ledger exists to close: commit, die, and the rollup
// never happens -- with the reservation already terminal, so a rerun cannot
// restore it.

test("a single-attempt settlement writes its row, its rollup and its pointer atomically", async () => {
  const { acquired } = await twoAttemptRun();
  const reservationId = acquired.usageReservation.reservationId;

  await settleChatUsage(acquired.usageReservation, {
    inputTokens: 10_000,
    outputTokens: 10_000,
    outcome: "completed",
  });

  const row = await prisma.chatAttemptUsage.findUniqueOrThrow({
    where: { reservationId_attemptIndex: { reservationId, attemptIndex: 0 } },
  });
  assert.equal(row.provider, "openai");
  assert.equal(row.modelId, "attempt-usage-model");
  assert.equal(row.usageSource, "provider_usage_metadata");
  assert.equal(row.costSource, "token_estimate");
  // 10K in and 10K out at $100/M each.
  assert.equal(row.costMicroUsd, BigInt(2_000_000));

  const rollup = await prisma.providerDailyUsage.findFirstOrThrow({
    where: { provider: "openai", modelId: "attempt-usage-model", source: "internal" },
  });
  assert.equal(rollup.estimatedCostMicroUsd, 2_000_000);
  assert.equal(rollup.requestCount, 1);
  // Same day for both, by the value the row carries rather than by inference.
  assert.equal(rollup.date.getTime(), row.rollupDate.getTime());

  const durable = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: reservationId },
  });
  assert.equal(durable.status, "settled");
  assert.equal(
    durable.settlementAttemptIndex,
    0,
    "a charged single-attempt turn names the attempt it charged for"
  );
});

test("settling a single-attempt turn twice moves the ledger once", async () => {
  const { acquired } = await twoAttemptRun();
  const reservationId = acquired.usageReservation.reservationId;
  const usage = {
    inputTokens: 10_000,
    outputTokens: 10_000,
    outcome: "completed" as const,
  };

  await settleChatUsage(acquired.usageReservation, usage);
  const second = await settleChatUsage(acquired.usageReservation, usage);
  assert.equal(second.applied, false, "the reservation is already terminal");

  assert.equal(
    await prisma.chatAttemptUsage.count({ where: { reservationId } }),
    1
  );
  const rollup = await prisma.providerDailyUsage.findFirstOrThrow({
    where: { provider: "openai", modelId: "attempt-usage-model", source: "internal" },
  });
  assert.equal(rollup.estimatedCostMicroUsd, 2_000_000);
  assert.equal(rollup.requestCount, 1);
  assert.equal(
    await prisma.chatAttemptUsageAdjustment.count({ where: { reservationId } }),
    0
  );
});

test("a full refund names no attempt and records no spend", async () => {
  const { acquired } = await twoAttemptRun();
  const reservationId = acquired.usageReservation.reservationId;

  await settleChatUsage(acquired.usageReservation, {
    inputTokens: 0,
    outputTokens: 0,
    outcome: "failed",
  });

  const durable = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: reservationId },
  });
  assert.equal(durable.status, "refunded");
  assert.equal(durable.settledCredits, 0);
  assert.equal(
    durable.settlementAttemptIndex,
    null,
    "charged for no attempt, so it names none"
  );
  // Nothing was used and nothing cost, so there is no call to put in the
  // ledger of calls that happened.
  assert.equal(
    await prisma.chatAttemptUsage.count({ where: { reservationId } }),
    0
  );
  assert.equal(await prisma.providerDailyUsage.count(), 0);
});

test("a cancelled single-attempt turn still records what it cost", async () => {
  // The user is charged for a partial answer, and the provider was paid for
  // the whole call either way.
  const { acquired } = await twoAttemptRun();
  const reservationId = acquired.usageReservation.reservationId;

  await settleChatUsage(acquired.usageReservation, {
    inputTokens: 10_000,
    outputTokens: 2_000,
    outcome: "cancelled",
  });

  const row = await prisma.chatAttemptUsage.findUniqueOrThrow({
    where: { reservationId_attemptIndex: { reservationId, attemptIndex: 0 } },
  });
  assert.equal(row.outcome, "cancelled");
  assert.equal(row.costMicroUsd, BigInt(1_200_000));
  const rollup = await prisma.providerDailyUsage.findFirstOrThrow({
    where: { provider: "openai", modelId: "attempt-usage-model", source: "internal" },
  });
  assert.equal(rollup.estimatedCostMicroUsd, 1_200_000);
});

// The rollup is the last thing the settlement transaction does, and it is
// still inside it. Both halves of that need pinning: that moving it late did
// not move it out, and that it is late enough to matter.

test("a rollup that fails rolls back the credits, the reservation and the cost row", async () => {
  // The reason this stayed inside the transaction when it moved to the end.
  // A settlement that charged the user and lost the provider accrual is two
  // ledgers disagreeing about the same turn, with no record of which is wrong.
  const user = await createUser();
  const acquired = await acquireChatAccess(chatAccess(user), chatBudget(), {
    traceId: `trace-${randomUUID()}`,
  });
  const reservationId = acquired.usageReservation.reservationId;

  await prisma.$executeRaw`
    ALTER TABLE "ProviderDailyUsage"
    ADD CONSTRAINT "settlement_test_refuses_rollup" CHECK (false) NOT VALID
  `;
  try {
    await assert.rejects(
      settleChatUsage(acquired.usageReservation, {
        inputTokens: 10_000,
        outputTokens: 10_000,
        outcome: "completed",
      })
    );
  } finally {
    await prisma.$executeRaw`
      ALTER TABLE "ProviderDailyUsage" DROP CONSTRAINT "settlement_test_refuses_rollup"
    `;
  }

  const durable = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: reservationId },
  });
  assert.equal(
    durable.status,
    "reserved",
    "the whole settlement must have rolled back, not just the rollup"
  );
  assert.equal(durable.settlementAttemptIndex, null);
  assert.equal(
    await prisma.chatAttemptUsage.count({ where: { reservationId } }),
    0
  );
  assert.equal(await prisma.providerDailyUsage.count(), 0);

  // And it settles cleanly once the fault is gone: nothing was half-written.
  await settleChatUsage(acquired.usageReservation, {
    inputTokens: 10_000,
    outputTokens: 10_000,
    outcome: "completed",
  });
  const settled = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: reservationId },
  });
  assert.equal(settled.status, "settled");
  assert.equal(settled.settlementAttemptIndex, 0);
  assert.equal(
    (
      await prisma.providerDailyUsage.findFirstOrThrow({
        where: { provider: "openai", modelId: "attempt-usage-model" },
      })
    ).estimatedCostMicroUsd,
    2_000_000
  );
});

test("concurrent single-attempt settlements each accrue once on the shared rollup row", async () => {
  // Every turn on one model settles against one ProviderDailyUsage row, which
  // is why the accrual is the transaction's last statement. Correctness under
  // that contention is the part worth pinning: four turns, four accruals, no
  // lost update and no deadlock.
  const reservations = await Promise.all(
    Array.from({ length: 4 }, async () => {
      const user = await createUser();
      const acquired = await acquireChatAccess(chatAccess(user), chatBudget(), {
        traceId: `trace-${randomUUID()}`,
      });
      return acquired.usageReservation;
    })
  );

  await Promise.all(
    reservations.map((reservation) =>
      settleChatUsage(reservation, {
        inputTokens: 10_000,
        outputTokens: 10_000,
        outcome: "completed",
      })
    )
  );

  const rollup = await prisma.providerDailyUsage.findFirstOrThrow({
    where: { provider: "openai", modelId: "attempt-usage-model", source: "internal" },
  });
  assert.equal(rollup.requestCount, 4);
  assert.equal(rollup.estimatedCostMicroUsd, 4 * 2_000_000);
  assert.equal(rollup.inputTokens, 4 * 10_000);
  assert.equal(rollup.outputTokens, 4 * 10_000);

  for (const reservation of reservations) {
    const durable = await prisma.chatCreditReservation.findUniqueOrThrow({
      where: { id: reservation.reservationId },
    });
    assert.equal(durable.status, "settled");
    assert.equal(durable.settlementAttemptIndex, 0);
  }
  assert.equal(await prisma.chatAttemptUsage.count(), 4);
});

// Shadow telemetry sits outside the settlement transaction, and both halves of
// that need pinning: it cannot fail a paid settlement, and it cannot record
// one that did not happen.

test("a shadow telemetry failure does not stop the settlement committing", async () => {
  // The module's contract is that shadow telemetry never fails a paid request.
  // Run on the transaction's own connection, a failing statement would abort
  // that transaction whatever the caller does with the exception -- so the
  // contract only holds because the call is outside.
  const { acquired } = await twoAttemptRun();
  const reservationId = acquired.usageReservation.reservationId;

  await prisma.$executeRaw`
    ALTER TABLE "TokenEstimateShadowSample"
    ADD CONSTRAINT "shadow_test_refuses_everything" CHECK (false) NOT VALID
  `;
  try {
    const result = await settleChatUsage(acquired.usageReservation, {
      inputTokens: 10_000,
      outputTokens: 10_000,
      outcome: "completed",
    });
    assert.equal(result.applied, true);
  } finally {
    await prisma.$executeRaw`
      ALTER TABLE "TokenEstimateShadowSample"
      DROP CONSTRAINT "shadow_test_refuses_everything"
    `;
  }

  const durable = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: reservationId },
  });
  assert.equal(durable.status, "settled");
  assert.equal(durable.settlementAttemptIndex, 0);
  assert.equal(
    await prisma.chatAttemptUsage.count({ where: { reservationId } }),
    1
  );
  assert.equal(
    (
      await prisma.providerDailyUsage.findFirstOrThrow({
        where: { provider: "openai", modelId: "attempt-usage-model" },
      })
    ).estimatedCostMicroUsd,
    2_000_000
  );
});

test("a settlement that rolls back leaves no shadow sample claiming it settled", async () => {
  const { acquired } = await twoAttemptRun();
  const reservationId = acquired.usageReservation.reservationId;

  await prisma.tokenEstimateShadowSample.create({
    data: {
      attemptId: reservationId,
      modelId: "attempt-usage-model",
      providerId: "openai",
      controlEstimatorVersion: "attempt-usage-test",
      controlRawEstimatedInputTokens: 10_000,
      candidateEstimatorVersion: "attempt-usage-test",
      candidateRawEstimatedInputTokens: 10_000,
      reservedInputTokens: 10_000,
      tokenizerFamily: "test",
      contentCohort: "test",
      hangulCharacters: 0,
      hanKanaCharacters: 0,
      nonCjkBytes: 0,
    },
  });

  await prisma.$executeRaw`
    ALTER TABLE "ProviderDailyUsage"
    ADD CONSTRAINT "settlement_test_refuses_rollup_2" CHECK (false) NOT VALID
  `;
  try {
    await assert.rejects(
      settleChatUsage(acquired.usageReservation, {
        inputTokens: 10_000,
        outputTokens: 10_000,
        outcome: "completed",
      })
    );
  } finally {
    await prisma.$executeRaw`
      ALTER TABLE "ProviderDailyUsage"
      DROP CONSTRAINT "settlement_test_refuses_rollup_2"
    `;
  }

  const sample = await prisma.tokenEstimateShadowSample.findFirstOrThrow({
    where: { attemptId: reservationId },
  });
  assert.equal(
    sample.settledAt,
    null,
    "a turn that did not settle must not appear in calibration as one that did"
  );
});

// One authorization per attempt, whichever shape it left behind.
//
// Checking the holds alone was enough while a hold was the only thing an
// authorization produced. A zero authorization writes an intent and no hold,
// so a second call would find no hold, pass, and append a duplicate intent --
// which the payload validator refuses on the next read, leaving the
// reservation unreadable and its money stuck.

const zeroIntent = { ...fallbackIntent, inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 };

const reserveFallback = async (
  reservationId: string,
  userId: string | null,
  reservedMicroUsd: number
) =>
  reserveAttemptProviderBudget({
    reservationId,
    userId,
    attemptIndex: 1,
    provider: "google",
    costIntent: reservedMicroUsd === 0 ? zeroIntent : fallbackIntent,
    reservedMicroUsd,
  });

test("a positive authorization refuses a zero one for the same attempt", async () => {
  const { acquired } = await twoAttemptRun();
  const id = acquired.usageReservation.reservationId;
  const userId = acquired.usageReservation.userId ?? null;

  assert.equal((await reserveFallback(id, userId, 500_000)).reserved, true);
  const second = await reserveFallback(id, userId, 0);
  assert.equal(second.reserved, false);
  assert.equal(second.reserved === false && second.reason, "already_authorized");
  // And the payload still reads, which is the thing a duplicate would break.
  await settleChatUsage(acquired.usageReservation, {
    inputTokens: 10_000,
    outputTokens: 10_000,
    outcome: "completed",
  });
});

test("a zero authorization refuses a second zero one for the same attempt", async () => {
  const { acquired } = await twoAttemptRun();
  const id = acquired.usageReservation.reservationId;
  const userId = acquired.usageReservation.userId ?? null;

  assert.equal((await reserveFallback(id, userId, 0)).reserved, true);
  const second = await reserveFallback(id, userId, 0);
  assert.equal(second.reserved === false && second.reason, "already_authorized");
  const intents = await payloadIntents(id);
  assert.equal(intents.filter((intent) => intent.attemptIndex === 1).length, 1);
});

test("a zero authorization refuses a positive one for the same attempt", async () => {
  const { acquired } = await twoAttemptRun();
  const id = acquired.usageReservation.reservationId;
  const userId = acquired.usageReservation.userId ?? null;

  assert.equal((await reserveFallback(id, userId, 0)).reserved, true);
  const before = await bucket("provider:google", "provider-cost-day");
  const second = await reserveFallback(id, userId, 500_000);
  assert.equal(second.reserved === false && second.reason, "already_authorized");
  assert.equal(
    await bucket("provider:google", "provider-cost-day"),
    before,
    "a refused authorization takes no budget"
  );
});

test("two concurrent zero authorizations, and only one wins", async () => {
  const { acquired } = await twoAttemptRun();
  const id = acquired.usageReservation.reservationId;
  const userId = acquired.usageReservation.userId ?? null;

  const [first, second] = await Promise.all([
    reserveFallback(id, userId, 0),
    reserveFallback(id, userId, 0),
  ]);
  assert.equal(
    [first, second].filter((result) => result.reserved).length,
    1,
    "the advisory lock serialises them; the loser sees the winner's intent"
  );
  const intents = await payloadIntents(id);
  assert.equal(intents.filter((intent) => intent.attemptIndex === 1).length, 1);
});

test("releasing a zero authorization removes the intent and moves no bucket", async () => {
  const { acquired } = await twoAttemptRun();
  const id = acquired.usageReservation.reservationId;
  const userId = acquired.usageReservation.userId ?? null;
  await reserveFallback(id, userId, 0);

  const primaryDay = await bucket("provider:openai", "provider-cost-day");
  assert.equal(
    await releaseAttemptProviderBudget({ reservationId: id, userId, attemptIndex: 1 }),
    true,
    "something really changed, so the release says so"
  );
  assert.deepEqual(
    (await payloadIntents(id)).map((intent) => intent.attemptIndex),
    [0],
    "the abandoned attempt's authorization is undone completely"
  );
  // The primary is untouched: its hold, its intent, its bucket.
  assert.equal(await bucket("provider:openai", "provider-cost-day"), primaryDay);
  const holds = await payloadHolds(id);
  assert.equal(holds.filter((hold) => hold.attemptIndex === 0).length, 2);
  assert.equal(await bucket("provider:google", "provider-cost-day"), 0);

  // A second release changed nothing, and says so.
  assert.equal(
    await releaseAttemptProviderBudget({ reservationId: id, userId, attemptIndex: 1 }),
    false
  );

  // And the reservation still settles, which a half-undone payload would not.
  await settleChatUsage(acquired.usageReservation, {
    inputTokens: 10_000,
    outputTokens: 10_000,
    outcome: "completed",
  });
  const durable = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id },
  });
  assert.equal(durable.status, "settled");
});

// The provider budget period, anchored once when the turn is authorized.
//
// It used to be borrowed from whichever held entry happened to share the
// period, which worked only while something was held. A turn whose primary
// reserved nothing had no entry to borrow from, so a fallback's real spend was
// dropped -- the exact "a provider budget that cannot see its own spend keeps
// saying yes" the settlement block exists to prevent.

const anchorOf = async (reservationId: string) => {
  const row = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: reservationId },
  });
  const payload = row.reservationPayload as {
    providerBudgetPeriodStarts?: { day: string; month: string };
  };
  return payload.providerBudgetPeriodStarts;
};

test("a reservation anchors its provider budget period even when it holds nothing", async () => {
  const user = await createUser();
  const acquired = await acquireChatAccess(
    chatAccess(user),
    chatBudget({ inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 }),
    { traceId: `trace-${randomUUID()}` }
  );
  const anchor = await anchorOf(acquired.usageReservation.reservationId);
  assert.ok(anchor, "the period is part of the authorization, not of the hold");
  const day = new Date(anchor.day);
  assert.equal(day.getTime(), Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const month = new Date(anchor.month);
  assert.equal(month.getUTCDate(), 1);
  // Nothing was held, which is exactly the case that used to leave settlement
  // with no period to write against.
  assert.equal(await bucket("provider:openai", "provider-cost-day"), 0);
});

test("a free primary's fallback spend still reaches the provider buckets", async () => {
  const user = await createUser();
  const acquired = await acquireChatAccess(
    chatAccess(user),
    chatBudget({ inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 }),
    { traceId: `trace-${randomUUID()}` }
  );
  const anchor = (await anchorOf(acquired.usageReservation.reservationId))!;

  await settleChatUsage(
    acquired.usageReservation,
    { inputTokens: 10_000, outputTokens: 10_000, outcome: "completed" },
    {
      attempts: [
        attempt({
          attemptIndex: 0,
          price: price("openai", "free-model", 0, 0),
          outcome: "failed",
          // A free model can still run a paid native search.
          searchCostMicroUsd: 30_000,
        }),
        attempt({
          attemptIndex: 1,
          price: price("google", "fallback-model", 200, 200),
          outputTokens: 10_000,
          outcome: "completed",
        }),
      ],
    }
  );

  // Both providers' real spend lands, and on the anchored period.
  assert.equal(await bucket("provider:openai", "provider-cost-day"), 30_000);
  assert.equal(await bucket("provider:google", "provider-cost-day"), 4_000_000);
  const dayRow = await prisma.chatUsageBucket.findFirstOrThrow({
    where: { key: "provider:google", period: "provider-cost-day" },
  });
  assert.equal(dayRow.periodStart.toISOString(), new Date(anchor.day).toISOString());
  const monthRow = await prisma.chatUsageBucket.findFirstOrThrow({
    where: { key: "provider:google", period: "provider-cost-month" },
  });
  assert.equal(monthRow.periodStart.toISOString(), new Date(anchor.month).toISOString());
});

test("a fallback holds against the anchored period, not the one it runs in", async () => {
  const { acquired } = await twoAttemptRun();
  const id = acquired.usageReservation.reservationId;
  const anchor = (await anchorOf(id))!;

  // The reservation is re-anchored a day into the past, standing in for a turn
  // authorized at 23:59:59 whose fallback runs after midnight.
  const yesterday = new Date(new Date(anchor.day).getTime() - 86_400_000);
  const lastMonth = new Date(
    Date.UTC(new Date(anchor.month).getUTCFullYear(), new Date(anchor.month).getUTCMonth() - 1, 1)
  );
  const row = await prisma.chatCreditReservation.findUniqueOrThrow({ where: { id } });
  const payload = row.reservationPayload as Record<string, unknown>;
  payload.providerBudgetPeriodStarts = {
    day: yesterday.toISOString(),
    month: lastMonth.toISOString(),
  };
  payload.attemptHolds = [];
  payload.entries = (payload.entries as { key: string }[]).filter(
    (entry) => !entry.key.startsWith("provider:")
  );
  payload.attemptCostIntents = [
    {
      ...(payload.attemptCostIntents as { attemptIndex: number }[])[0],
      reservedCostMicroUsd: 0,
    },
  ];
  await prisma.$executeRaw`
    UPDATE "ChatCreditReservation" SET "reservationPayload" = ${payload}::jsonb WHERE "id" = ${id}
  `;

  const reserved = await reserveAttemptProviderBudget({
    reservationId: id,
    userId: acquired.usageReservation.userId ?? null,
    attemptIndex: 1,
    provider: "google",
    costIntent: fallbackIntent,
    reservedMicroUsd: 500_000,
  });
  assert.equal(reserved.reserved, true);

  const held = await prisma.chatUsageBucket.findFirstOrThrow({
    where: { key: "provider:google", period: "provider-cost-day" },
  });
  assert.equal(
    held.periodStart.toISOString(),
    yesterday.toISOString(),
    "one logical response belongs to the period it was authorized in"
  );
});

test("a legacy payload recovers its anchor from the holds it already carries", async () => {
  const { acquired } = await twoAttemptRun();
  const id = acquired.usageReservation.reservationId;
  const anchor = (await anchorOf(id))!;
  await makeLegacy(id);
  // And the anchor itself goes, leaving only the provider entries a
  // pre-anchor payload would have had.
  const row = await prisma.chatCreditReservation.findUniqueOrThrow({ where: { id } });
  const payload = row.reservationPayload as Record<string, unknown>;
  delete payload.providerBudgetPeriodStarts;
  await prisma.$executeRaw`
    UPDATE "ChatCreditReservation" SET "reservationPayload" = ${payload}::jsonb WHERE "id" = ${id}
  `;

  const reserved = await reserveAttemptProviderBudget({
    reservationId: id,
    userId: acquired.usageReservation.userId ?? null,
    attemptIndex: 1,
    provider: "google",
    costIntent: fallbackIntent,
    reservedMicroUsd: 500_000,
  });
  assert.equal(reserved.reserved, true);
  // Those holds were taken at the moment the reservation was authorized, so
  // their own periodStart *is* the anchor rather than a reconstruction of it.
  assert.deepEqual(await anchorOf(id), {
    day: new Date(anchor.day).toISOString(),
    month: new Date(anchor.month).toISOString(),
  });
});

test("a legacy payload with no holds and no anchor refuses the fallback", async () => {
  // Nothing in the payload knows the period, and every way of guessing is
  // wrong: a user's `day` bucket is anchored to their account's reckoning, and
  // `createdAt` is the database's clock rather than the one the reservation
  // was computed against. Real money in a period nobody chose is worse than a
  // fallback that does not happen.
  const user = await createUser();
  const acquired = await acquireChatAccess(
    chatAccess(user),
    chatBudget({ inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 }),
    { traceId: `trace-${randomUUID()}` }
  );
  const id = acquired.usageReservation.reservationId;
  const row = await prisma.chatCreditReservation.findUniqueOrThrow({ where: { id } });
  const payload = row.reservationPayload as Record<string, unknown>;
  delete payload.providerBudgetPeriodStarts;
  delete payload.attemptHolds;
  delete payload.attemptCostIntents;
  await prisma.$executeRaw`
    UPDATE "ChatCreditReservation" SET "reservationPayload" = ${payload}::jsonb WHERE "id" = ${id}
  `;

  const reserved = await reserveAttemptProviderBudget({
    reservationId: id,
    userId: acquired.usageReservation.userId ?? null,
    attemptIndex: 1,
    provider: "google",
    costIntent: fallbackIntent,
    reservedMicroUsd: 500_000,
  });
  assert.equal(reserved.reserved, false);
  assert.equal(
    reserved.reserved === false && reserved.reason,
    "no_provider_budget_period"
  );
  assert.equal(await bucket("provider:google", "provider-cost-day"), 0);
});

test("a hold on a period the reservation did not anchor is refused on read", async () => {
  const { acquired } = await twoAttemptRun();
  const id = acquired.usageReservation.reservationId;
  const row = await prisma.chatCreditReservation.findUniqueOrThrow({ where: { id } });
  const payload = row.reservationPayload as {
    attemptHolds?: { period: string; periodStart: string }[];
  };
  const holds = payload.attemptHolds ?? [];
  const dayHold = holds.find((hold) => hold.period === "provider-cost-day")!;
  dayHold.periodStart = new Date(
    new Date(dayHold.periodStart).getTime() - 86_400_000
  ).toISOString();
  await prisma.$executeRaw`
    UPDATE "ChatCreditReservation" SET "reservationPayload" = ${payload}::jsonb WHERE "id" = ${id}
  `;

  // Settlement releases what the payload says was held, and a hold on another
  // period names a bucket row it never touched.
  await assert.rejects(
    settleChatUsage(acquired.usageReservation, {
      inputTokens: 10_000,
      outputTokens: 10_000,
      outcome: "completed",
    }),
    /not the reservation's/
  );
});

/**
 * A native search's authorization, from the reservation that froze it to the
 * settlement that prices against it.
 *
 * `tests/webSearchNativeCostReservation.test.mjs` pins the arithmetic. What
 * only a database can show is that the authorization written at
 * `acquireChatAccess` is still there -- serialized, stored, read back --  when
 * `settleChatUsage` needs it, and that a provider over its declared ceiling
 * lands in all three of the reservation, the attempt row and the provider's
 * daily rollup rather than being quietly clamped to what was authorized.
 */

const SEARCH_MAX_QUERIES = 5;

/** A turn allowed `max` searches at `rate` each, on Anthropic's tool. */
const searchBudget = (
  rate: number,
  max: number,
  overrides: Partial<ChatBudget> = {}
) =>
  chatBudget({
    provider: "anthropic",
    nativeSearchCostPerQueryMicroUsd: rate,
    nativeSearchMaxQueries: max,
    searchBackend: null,
    nativeSearchReservedCostMicroUsd: Math.ceil(rate * max),
    ...overrides,
  });

/** 10K input and 10K output at $100/M each, which every case below settles. */
const SETTLED_TOKEN_COST = 2_000_000;

const storedIntents = async (reservationId: string) => {
  const row = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: reservationId },
  });
  return (
    row.reservationPayload as {
      attemptCostIntents?: {
        attemptIndex: number;
        nativeSearchAuthorization?: {
          reservedCostMicroUsd: number;
          costPerQueryMicroUsd: number;
          maxQueries: number;
        };
      }[];
    }
  ).attemptCostIntents;
};

const settledCostOf = (reservationId: string) =>
  prisma.chatCreditReservation
    .findUniqueOrThrow({ where: { id: reservationId } })
    .then((row) => row.settledCostMicroUsd);

const searchTurn = async (
  rate: number,
  max: number,
  overrides: Partial<ChatBudget> = {}
) => {
  const user = await createUser();
  const acquired = await acquireChatAccess(
    chatAccess(user),
    searchBudget(rate, max, overrides),
    { traceId: `trace-${randomUUID()}` }
  );
  return { user, acquired, id: acquired.usageReservation.reservationId };
};

test("a search authorization survives serialization, storage and read-back into settlement", async () => {
  const { acquired, id } = await searchTurn(10_000, SEARCH_MAX_QUERIES);

  // In the row, not only in the object the caller still holds.
  assert.deepEqual((await storedIntents(id))?.[0]?.nativeSearchAuthorization, {
    reservedCostMicroUsd: 50_000,
    costPerQueryMicroUsd: 10_000,
    maxQueries: SEARCH_MAX_QUERIES,
  });

  // The caller's own figure is deliberately absurd. Settlement reads the
  // stored authorization and prices two queries against it instead.
  await settleChatUsage(acquired.usageReservation, {
    inputTokens: 10_000,
    outputTokens: 10_000,
    outcome: "completed",
    searchQueryCount: 2,
    searchCostMicroUsd: 999_999,
  });

  assert.equal(await settledCostOf(id), BigInt(SETTLED_TOKEN_COST + 20_000));
  const row = await prisma.chatAttemptUsage.findFirstOrThrow({
    where: { reservationId: id },
  });
  assert.equal(row.costMicroUsd, BigInt(SETTLED_TOKEN_COST + 20_000));
});

test("the rate the turn was authorized at governs settlement, not today's registry", async () => {
  // The point of freezing the rate is the case where the two disagree, so the
  // authorization is taken at a rate the catalogue does not sell.
  assert.equal(getNativeSearchCostMicroUsdPerQuery("anthropic"), 10_000);
  const { acquired, id } = await searchTurn(7_777, SEARCH_MAX_QUERIES);

  await settleChatUsage(acquired.usageReservation, {
    inputTokens: 10_000,
    outputTokens: 10_000,
    outcome: "completed",
    searchQueryCount: 3,
    // What a normalizer pricing at today's rate would have handed over.
    searchCostMicroUsd: 30_000,
  });

  // Three at the stored 7,777, not three at the registry's 10,000.
  assert.equal(await settledCostOf(id), BigInt(SETTLED_TOKEN_COST + 23_331));
});

test("a provider over its authorized ceiling is billed in full, reported, and stops dispatching", async () => {
  const incidents: ObservedOperationalIncident[] = [];
  const stopObserving = observeOperationalIncidents((incident) =>
    incidents.push(incident)
  );
  try {
    const { acquired, id } = await searchTurn(10_000, SEARCH_MAX_QUERIES);

    await settleChatUsage(acquired.usageReservation, {
      inputTokens: 10_000,
      outputTokens: 10_000,
      outcome: "completed",
      // One more than the request authorized.
      searchQueryCount: SEARCH_MAX_QUERIES + 1,
      searchCostMicroUsd: 60_000,
    });

    // Six queries' worth, in all three places. Clamping to the authorized five
    // would have been accurate about the authorization and wrong about the
    // money, which is the direction that hides the problem.
    const overCeiling = BigInt(SETTLED_TOKEN_COST + 60_000);
    assert.equal(await settledCostOf(id), overCeiling);
    const row = await prisma.chatAttemptUsage.findFirstOrThrow({
      where: { reservationId: id },
    });
    assert.equal(row.costMicroUsd, overCeiling);
    const rollup = await prisma.providerDailyUsage.findFirstOrThrow({
      where: {
        provider: "anthropic",
        modelId: "attempt-usage-model",
        source: "internal",
        date: rollupDayOf(),
      },
    });
    assert.equal(rollup.estimatedCostMicroUsd, SETTLED_TOKEN_COST + 60_000);

    const breach = incidents.find(
      (incident) => incident.code === "NATIVE_SEARCH_QUERY_CEILING_BREACHED"
    );
    assert.ok(breach, "the ceiling breach was not reported");
    assert.equal(breach.severity, "error");
    assert.deepEqual(
      {
        provider: breach.context.provider,
        observedQueries: breach.context.observedQueries,
        authorizedQueries: breach.context.authorizedQueries,
        costMicroUsd: breach.context.costMicroUsd,
      },
      {
        provider: "anthropic",
        observedQueries: 6,
        authorizedQueries: SEARCH_MAX_QUERIES,
        costMicroUsd: 60_000,
      }
    );

    // And the next real pre-authorization for that provider is refused: a
    // ceiling that did not hold cannot size the next reservation.
    assert.equal(searchQueryCeilingBreached("anthropic"), true);
    const next = reserveNativeSearchCost({
      model: getModel("claude-sonnet-5")!,
      capability: getWebSearchCapability("claude-sonnet-5"),
      nativeSearchEnabled: true,
    });
    assert.equal(next.ok, false);
    assert.equal(
      next.ok === false && next.reason,
      "search_query_ceiling_breached"
    );
  } finally {
    stopObserving();
    resetSearchQueryCeilingBreaches();
  }
});

test("a breach reaches an operator even when the settlement that found it fails", async () => {
  const incidents: ObservedOperationalIncident[] = [];
  const stopObserving = observeOperationalIncidents((incident) =>
    incidents.push(incident)
  );
  // The failure is injected at the database, at the tail of the settlement
  // transaction: the breach has been detected and the latch set, and the
  // commit that would have recorded it never happens.
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION attempt_cost_write_fails() RETURNS trigger AS $fn$
    BEGIN RAISE EXCEPTION 'injected attempt cost write failure'; END;
    $fn$ LANGUAGE plpgsql
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER attempt_cost_write_fails
    BEFORE INSERT ON "ChatAttemptUsage"
    FOR EACH ROW EXECUTE FUNCTION attempt_cost_write_fails()
  `);
  try {
    const { acquired, id } = await searchTurn(10_000, SEARCH_MAX_QUERIES);

    await assert.rejects(
      settleChatUsage(acquired.usageReservation, {
        inputTokens: 10_000,
        outputTokens: 10_000,
        outcome: "completed",
        searchQueryCount: SEARCH_MAX_QUERIES + 1,
        searchCostMicroUsd: 60_000,
      }),
      /injected attempt cost write failure/
    );

    // Nothing committed.
    const reservation = await prisma.chatCreditReservation.findUniqueOrThrow({
      where: { id },
    });
    assert.equal(reservation.status, "reserved");
    assert.equal(await prisma.chatAttemptUsage.count(), 0);

    // The provider still ran six searches. That is money already spent at
    // somebody else's API, and it does not become untrue because this
    // transaction rolled back -- so the latch holds and the incident is sent.
    assert.equal(searchQueryCeilingBreached("anthropic"), true);
    assert.ok(
      incidents.some(
        (incident) => incident.code === "NATIVE_SEARCH_QUERY_CEILING_BREACHED"
      ),
      "a rolled-back settlement swallowed the breach it had already detected"
    );
  } finally {
    stopObserving();
    resetSearchQueryCeilingBreaches();
    await prisma.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS attempt_cost_write_fails ON "ChatAttemptUsage"`
    );
    await prisma.$executeRawUnsafe(
      `DROP FUNCTION IF EXISTS attempt_cost_write_fails()`
    );
  }
});

test("a payload with no authorization settles on the caller's search cost and raises nothing", async () => {
  const incidents: ObservedOperationalIncident[] = [];
  const stopObserving = observeOperationalIncidents((incident) =>
    incidents.push(incident)
  );
  try {
    // A rate the caller's own figure cannot be confused with. At 7,777 the
    // three queries below are worth 23,331 if the authorization is honoured
    // and 30,000 if it is gone -- an earlier version of this test used the
    // catalogue rate, where both roads led to the same number and the test
    // passed whether or not the payload had actually been stripped.
    const { acquired, id } = await searchTurn(7_777, SEARCH_MAX_QUERIES);
    // A reservation as it looked before authorizations were frozen into it:
    // an intent, and nothing in it about search.
    const payload = (
      await prisma.chatCreditReservation.findUniqueOrThrow({ where: { id } })
    ).reservationPayload as {
      attemptCostIntents?: { nativeSearchAuthorization?: unknown }[];
    };
    delete payload.attemptCostIntents?.[0]?.nativeSearchAuthorization;
    await prisma.$executeRaw`
      UPDATE "ChatCreditReservation" SET "reservationPayload" = ${payload}::jsonb WHERE "id" = ${id}
    `;
    // Read back rather than assumed: the delete above walks an optional chain,
    // so a payload shaped differently than expected would leave it a silent
    // no-op and every assertion below would be about the wrong reservation.
    assert.equal(
      (await storedIntents(id))?.[0]?.nativeSearchAuthorization,
      undefined,
      "the authorization was still in the payload"
    );

    await settleChatUsage(acquired.usageReservation, {
      inputTokens: 10_000,
      outputTokens: 10_000,
      outcome: "completed",
      searchQueryCount: 3,
      searchCostMicroUsd: 30_000,
    });

    // Its cost is kept, at the caller's figure. Dropping it would under-record
    // real provider spend to punish a turn that was dispatched correctly under
    // the older contract; pricing it at 23,331 would mean the stripped
    // authorization was still being read.
    assert.equal(await settledCostOf(id), BigInt(SETTLED_TOKEN_COST + 30_000));
    assert.deepEqual(
      incidents.map((incident) => incident.code),
      []
    );
  } finally {
    stopObserving();
  }
});

test("past the cutover, a paid search with no authorization is a defect and is reported", async () => {
  const incidents: ObservedOperationalIncident[] = [];
  const stopObserving = observeOperationalIncidents((incident) =>
    incidents.push(incident)
  );
  try {
    const { acquired, id } = await searchTurn(7_777, SEARCH_MAX_QUERIES);
    const payload = (
      await prisma.chatCreditReservation.findUniqueOrThrow({ where: { id } })
    ).reservationPayload as {
      attemptCostIntents?: { nativeSearchAuthorization?: unknown }[];
    };
    delete payload.attemptCostIntents?.[0]?.nativeSearchAuthorization;
    await prisma.$executeRaw`
      UPDATE "ChatCreditReservation" SET "reservationPayload" = ${payload}::jsonb WHERE "id" = ${id}
    `;
    assert.equal(
      (await storedIntents(id))?.[0]?.nativeSearchAuthorization,
      undefined,
      "the authorization was still in the payload"
    );
    // Written after the cutover, so it is a writer that stopped filling the
    // authorization in rather than a turn that predates it.
    process.env[NATIVE_SEARCH_AUTHORIZATION_CUTOVER_ENV] = new Date(
      Date.now() - 86_400_000
    ).toISOString();

    await settleChatUsage(acquired.usageReservation, {
      inputTokens: 10_000,
      outputTokens: 10_000,
      outcome: "completed",
      searchQueryCount: 3,
      searchCostMicroUsd: 30_000,
    });

    assert.equal(await settledCostOf(id), BigInt(SETTLED_TOKEN_COST + 30_000));
    const missing = incidents.find(
      (incident) => incident.code === "MISSING_NATIVE_SEARCH_AUTHORIZATION"
    );
    assert.ok(missing, "an unauthorized paid search was not reported");
    assert.equal(missing.context.provider, "anthropic");
    assert.equal(missing.context.queries, 3);
  } finally {
    stopObserving();
    delete process.env[NATIVE_SEARCH_AUTHORIZATION_CUTOVER_ENV];
  }
});

test("a turn abandoned mid-answer records the search ceiling, not zero", async () => {
  const incidents: ObservedOperationalIncident[] = [];
  const stopObserving = observeOperationalIncidents((incident) =>
    incidents.push(incident)
  );
  try {
    // 5 base credits plus a 2-credit search surcharge, as a searching turn
    // reserves them in production.
    const { acquired, id } = await searchTurn(10_000, SEARCH_MAX_QUERIES, {
      usageCredits: 7,
    });

    // What the route's `earlyCancelSearchFields` sends: the user's surcharge
    // is unearned, and nobody counted the searches the provider already ran.
    await settleChatUsage(acquired.usageReservation, {
      inputTokens: 10_000,
      outputTokens: 10_000,
      outcome: "cancelled",
      searchSurchargeCredits: 2,
      searchExecuted: false,
      searchQueriesObserved: false,
    });

    // The provider's ledger keeps the frozen ceiling. Settling this at zero
    // would hand back a reservation covering money already spent at Anthropic.
    assert.equal(await settledCostOf(id), BigInt(SETTLED_TOKEN_COST + 50_000));
    const row = await prisma.chatAttemptUsage.findFirstOrThrow({
      where: { reservationId: id },
    });
    assert.equal(row.costMicroUsd, BigInt(SETTLED_TOKEN_COST + 50_000));

    // Provenance: an upper bound, and said so where a report can filter on it.
    assert.equal(row.costSource, "reserved_upper_bound");
    // Not crash-reconciled. Nobody counted the searches; the tokens were
    // counted the usual way, and claiming otherwise would also widen the
    // constraint that lets only a crash row leave its token counts NULL.
    assert.notEqual(row.usageSource, "crash_reconciliation");
    assert.equal(row.inputTokens, 10_000);

    // And it does not pretend to know how many queries ran. `maxQueries` is
    // recorded as the authorization it is, beside an explicitly null count.
    assert.deepEqual(
      {
        searchCostSource: (row.pricingSnapshot as Record<string, unknown>)
          .searchCostSource,
        searchQueryCount: (row.pricingSnapshot as Record<string, unknown>)
          .searchQueryCount,
        searchAuthorizedMaxQueries: (
          row.pricingSnapshot as Record<string, unknown>
        ).searchAuthorizedMaxQueries,
      },
      {
        searchCostSource: "reserved_upper_bound",
        searchQueryCount: null,
        searchAuthorizedMaxQueries: SEARCH_MAX_QUERIES,
      }
    );

    // The user's ledger goes the other way: a search whose results they never
    // saw earns no surcharge, so the 2 credits reserved for it come back and
    // the 5 base credits stand. Two ledgers, two answers, same turn.
    const settled = await prisma.chatCreditReservation.findUniqueOrThrow({
      where: { id },
    });
    assert.equal(settled.settledCredits, 5);

    // Nothing was observed, so nothing was breached.
    assert.deepEqual(
      incidents.map((incident) => incident.code),
      []
    );

    // The provider's spend bucket carries the ceiling rather than releasing it.
    const daily = await bucket("provider:anthropic", "provider-cost-day");
    assert.equal(daily, SETTLED_TOKEN_COST + 50_000);
    const rollup = await prisma.providerDailyUsage.findFirstOrThrow({
      where: {
        provider: "anthropic",
        modelId: "attempt-usage-model",
        source: "internal",
        date: rollupDayOf(),
      },
    });
    assert.equal(rollup.estimatedCostMicroUsd, SETTLED_TOKEN_COST + 50_000);

    // Settling again counts none of it twice.
    await settleChatUsage(acquired.usageReservation, {
      inputTokens: 10_000,
      outputTokens: 10_000,
      outcome: "cancelled",
      searchSurchargeCredits: 2,
      searchExecuted: false,
      searchQueriesObserved: false,
    });
    assert.equal(
      await bucket("provider:anthropic", "provider-cost-day"),
      SETTLED_TOKEN_COST + 50_000
    );
    const afterReplay = await prisma.providerDailyUsage.findFirstOrThrow({
      where: {
        provider: "anthropic",
        modelId: "attempt-usage-model",
        source: "internal",
        date: rollupDayOf(),
      },
    });
    assert.equal(afterReplay.estimatedCostMicroUsd, SETTLED_TOKEN_COST + 50_000);
    assert.equal(await prisma.chatAttemptUsage.count(), 1);
  } finally {
    stopObserving();
  }
});

test("a turn that ran no search is unaffected by the unobserved-search rule", async () => {
  // The rule is scoped to a frozen authorization. A turn with none settles on
  // exactly the path it always did, cancelled or not -- otherwise every
  // abandoned turn in the product would start carrying an invented cost.
  const user = await createUser();
  const acquired = await acquireChatAccess(chatAccess(user), chatBudget(), {
    traceId: `trace-${randomUUID()}`,
  });
  const id = acquired.usageReservation.reservationId;

  await settleChatUsage(acquired.usageReservation, {
    inputTokens: 10_000,
    outputTokens: 10_000,
    outcome: "cancelled",
    searchExecuted: false,
    searchQueriesObserved: false,
  });

  assert.equal(await settledCostOf(id), BigInt(SETTLED_TOKEN_COST));
  const row = await prisma.chatAttemptUsage.findFirstOrThrow({
    where: { reservationId: id },
  });
  assert.notEqual(row.costSource, "reserved_upper_bound");
});
