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
      "ProviderDailyUsage",
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

const bucket = (key: string, period: string) =>
  prisma.chatUsageBucket
    .findFirst({ where: { key, period } })
    .then((row) => usageBucketCount(row?.count));

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

test("a settlement with no attempts behaves exactly as it always has", async () => {
  // The whole of today's traffic. Nothing about the single-attempt path may
  // move because the multi-attempt one now exists.
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
  assert.equal(
    await prisma.chatAttemptUsage.count({
      where: { reservationId: durable.id },
    }),
    0,
    "a single-attempt turn writes no attempt rows; the reservation is its own record"
  );
  assert.equal(await bucket("provider:openai", "provider-cost-day"), 2_000_000);
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
    reservedMicroUsd: 500_000,
    periodStarts: starts,
  });
  assert.equal(first.reserved, true);
  const second = await reserveAttemptProviderBudget({
    reservationId: acquired.usageReservation.reservationId,
    userId: acquired.usageReservation.userId ?? null,
    attemptIndex: 1,
    provider: "google",
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
      reservedMicroUsd: amount,
      periodStarts: starts,
    }),
    reserveAttemptProviderBudget({
      reservationId: second.acquired.usageReservation.reservationId,
      userId: second.acquired.usageReservation.userId ?? null,
      attemptIndex: 1,
      provider: "google",
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
  assert.equal(durable.settlementAttemptIndex, null);
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
      },
    });
    await tx.chatCreditReservation.update({
      where: { id },
      data: { status: "settled", settledAt: new Date() },
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
        },
      });
      await tx.chatCreditReservation.update({
        where: { id },
        data: { status: "settled", settledAt: new Date() },
      });
    }),
    /no settlementAttemptIndex/
  );

  const durable = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id },
  });
  assert.equal(durable.status, "reserved", "the transaction must have rolled back");
});

test("the pointer may be set before the attempt row it names exists", async () => {
  // The deferred foreign key: at COMMIT both are there, and the order they
  // arrived in is not the constraint's business.
  const { acquired } = await twoAttemptRun();
  const id = acquired.usageReservation.reservationId;

  await prisma.$transaction(async (tx) => {
    await tx.chatCreditReservation.update({
      where: { id },
      data: { settlementAttemptIndex: 1, status: "settled", settledAt: new Date() },
    });
    await tx.chatAttemptUsage.create({
      data: {
        reservationId: id,
        attemptIndex: 1,
        modelId: "fallback-model",
        provider: "google",
        outcome: "completed",
      },
    });
  });

  const durable = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id },
  });
  assert.equal(durable.settlementAttemptIndex, 1);
});
