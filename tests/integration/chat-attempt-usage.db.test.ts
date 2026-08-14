import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import {
  acquireChatAccess,
  settleChatUsage,
  transferProviderBudgetForFallback,
  type ChatAccess,
  type ChatBudget,
} from "@/lib/chatSecurity";
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

  const billed = await prisma.chatAttemptUsage.findMany({
    where: {
      reservationId: acquired.usageReservation.reservationId,
      userBilled: true,
    },
  });
  assert.equal(billed.length, 1);
  assert.equal(billed[0].attemptIndex, 1);

  // And the reservation itself settled once, on the accepted attempt.
  const durable = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: acquired.usageReservation.reservationId },
  });
  assert.equal(durable.status, "settled");
  assert.equal(durable.outcome, "completed");
  assert.equal(durable.settledOutputTokens, 10_000);
});

test("a second billed row for one reservation is refused by the database", async () => {
  const { acquired } = await twoAttemptRun();
  await prisma.chatAttemptUsage.create({
    data: {
      reservationId: acquired.usageReservation.reservationId,
      attemptIndex: 0,
      modelId: "primary-model",
      provider: "openai",
      outcome: "completed",
      userBilled: true,
    },
  });
  await assert.rejects(
    prisma.chatAttemptUsage.create({
      data: {
        reservationId: acquired.usageReservation.reservationId,
        attemptIndex: 1,
        modelId: "fallback-model",
        provider: "google",
        outcome: "completed",
        userBilled: true,
      },
    }),
    /unique|constraint/i
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

test("a fallback on another provider takes its own budget hold", async () => {
  // The hold this creates is the primary's; the transfer has to move it.
  await twoAttemptRun();
  const heldDay = await bucket("provider:openai", "provider-cost-day");

  const moved = await transferProviderBudgetForFallback({
    heldProvider: "openai",
    fallbackProvider: "google",
    heldMicroUsd: heldDay,
    fallbackReservedMicroUsd: 500_000,
    periodStarts: {
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
    },
  });

  assert.equal(moved.moved, true);
  assert.equal(await bucket("provider:google", "provider-cost-day"), 500_000);
  assert.equal(await bucket("provider:openai", "provider-cost-day"), 0);
  assert.equal(
    moved.moved && moved.entries.length,
    2,
    "the caller needs both periods to settle what it held"
  );
});

test("a fallback on the same provider is not a transfer", async () => {
  await twoAttemptRun();
  const before = await bucket("provider:openai", "provider-cost-day");
  const result = await transferProviderBudgetForFallback({
    heldProvider: "openai",
    fallbackProvider: "openai",
    heldMicroUsd: before,
    fallbackReservedMicroUsd: 500_000,
    periodStarts: { day: new Date(), month: new Date() },
  });
  assert.equal(result.moved, false);
  assert.equal(result.moved === false && result.reason, "same_provider");
  // The hold already covers it, and re-reserving would count this turn
  // against its own budget twice.
  assert.equal(await bucket("provider:openai", "provider-cost-day"), before);
});
