import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

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
import { getProviderCostGuardrailLimits } from "@/lib/providerCostBudget";
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
    periodStarts: await periodStarts(),
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
    periodStarts: await periodStarts(),
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
  const starts = await periodStarts();
  const first = await reserveAttemptProviderBudget({
    reservationId: acquired.usageReservation.reservationId,
    userId: acquired.usageReservation.userId ?? null,
    attemptIndex: 1,
    provider: "google",
    costIntent: fallbackIntent,
    reservedMicroUsd: 500_000,
    periodStarts: starts,
  });
  assert.equal(first.reserved, true);
  const second = await reserveAttemptProviderBudget({
    reservationId: acquired.usageReservation.reservationId,
    userId: acquired.usageReservation.userId ?? null,
    attemptIndex: 1,
    provider: "google",
    costIntent: fallbackIntent,
    reservedMicroUsd: 500_000,
    periodStarts: starts,
  });
  assert.equal(second.reserved, false);
  assert.equal(second.reserved === false && second.reason, "already_held");
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
    periodStarts: await periodStarts(),
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
    periodStarts: await periodStarts(),
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
    periodStarts: starts,
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
    periodStarts: await periodStarts(),
  });
  assert.equal(result.reserved, false);
  assert.equal(result.reserved === false && result.reason, "reservation_not_open");
  assert.equal(await bucket("provider:google", "provider-cost-day"), 0);
});

test("a hold whose dispatch never happened is given back, payload included", async () => {
  const { acquired } = await twoAttemptRun();
  const starts = await periodStarts();
  await reserveAttemptProviderBudget({
    reservationId: acquired.usageReservation.reservationId,
    userId: acquired.usageReservation.userId ?? null,
    attemptIndex: 1,
    provider: "google",
    costIntent: fallbackIntent,
    reservedMicroUsd: 500_000,
    periodStarts: starts,
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
  const starts = await periodStarts();
  await reserveAttemptProviderBudget({
    reservationId: acquired.usageReservation.reservationId,
    userId: acquired.usageReservation.userId ?? null,
    attemptIndex: 1,
    provider: "google",
    costIntent: fallbackIntent,
    reservedMicroUsd: 500_000,
    periodStarts: starts,
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
    periodStarts: await periodStarts(),
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
  const starts = await periodStarts();
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
      periodStarts: starts,
    }),
    reserveAttemptProviderBudget({
      reservationId: second.acquired.usageReservation.reservationId,
      userId: second.acquired.usageReservation.userId ?? null,
      attemptIndex: 1,
      provider: "google",
      costIntent: fallbackIntent,
    reservedMicroUsd: amount,
      periodStarts: starts,
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
    periodStarts: await periodStarts(),
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
    periodStarts: starts,
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
    periodStarts: await periodStarts(),
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
