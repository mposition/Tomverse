import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import type Stripe from "stripe";
import {
  acquireChatAccess,
  extendChatReservationExpiry,
  getChatCostGuardrails,
  preflightChatComparisonAccess,
  publicChatErrorDetails,
  reconcileExpiredChatCreditReservations,
  releaseChatAccess,
  settleChatUsage,
  type ChatAccess,
  type ChatBudget,
} from "@/lib/chatSecurity";
import { findChatLimitDecisionsByTraceId } from "@/lib/chatLimitDecisions";
import {
  handleCreditPackDispute,
  handleCreditPackDisputeClosed,
  grantCreditPackFromCheckout,
} from "@/lib/creditPurchase";
import { lockCreditAccount } from "@/lib/creditDebt";
import { reserveAddOnCredits, settleAddOnCredits } from "@/lib/creditLedger";
import {
  releasePromotionCheckout,
  reservePromotionCheckout,
} from "@/lib/billingPromotionSecurity";
import { getCreditPack } from "@/lib/creditPacks";
import { prisma } from "@/lib/prisma";
import { usageBucketCount } from "@/lib/chatUsageBucketCount";
import {
  getPlanGuardrailStorage,
  POSTGRES_INT4_MAX,
} from "@/lib/usageBucketRange";

const resetFinanceTestData = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ProductAnalyticsEvent",
      "ProviderDailyUsage",
      "ChatCreditReservation",
      "ChatRequestLease",
      "ChatUsageBucket",
      "CreditDebtEntry",
      "CreditLedgerEntry",
      "CreditLot",
      "CreditPurchase",
      "BillingTransaction",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(resetFinanceTestData);
after(async () => {
  await resetFinanceTestData();
  await prisma.$disconnect();
});

const createUser = (plan: "Free" | "Pro" | "Max" = "Free") =>
  prisma.user.create({
    data: {
      email: `credit-integration-${randomUUID()}@example.test`,
      plan,
    },
  });

const chatAccess = (
  user: { id: string; plan: string },
  monthlyMessageLimit: number,
  dailyMessageLimit = 10_000
): ChatAccess => ({
  kind: "user",
  userId: user.id,
  plan:
    user.plan === "Max" ? "Max" : user.plan === "Pro" ? "Pro" : "Free",
  subjectKey: `integration:user:${user.id}`,
  ipKey: `integration:ip:${user.id}`,
  planLimits: {
    dailyMessageLimit,
    monthlyMessageLimit,
  },
});

const chatBudget = ({
  credits,
  inputTokens = 100,
  outputTokens = 900,
  reservedOutputTokens = outputTokens,
  inputRate = 0,
  outputRate = 0,
  cachedInputPriceMultiplier = 1,
  provider = "openai",
}: {
  credits: number;
  inputTokens?: number;
  outputTokens?: number;
  reservedOutputTokens?: number;
  inputRate?: number;
  outputRate?: number;
  cachedInputPriceMultiplier?: number;
  provider?: ChatBudget["provider"];
}): ChatBudget => ({
  modelId: "credit-integration-model",
  minimumPlan: "Guest",
  modelUsageClass: "standard",
  usageCredits: credits,
  inputTokens,
  maxOutputTokens: outputTokens,
  providerMaxOutputTokens: null,
  reservedOutputTokens,
  inputUsdPerMillionTokens: inputRate,
  outputUsdPerMillionTokens: outputRate,
  cachedInputPriceMultiplier,
  cacheWriteUsdPerMillionTokens: null,
  promptCacheWriteReservedPremiumMicroUsd: 0,
  nativeSearchReservedCostMicroUsd: 0,
  nativeSearchCostPerQueryMicroUsd: 0,
  nativeSearchMaxQueries: 0,
  searchBackend: null,
  provider,
  pricingVersion: "test-fixture-pricing",
  costSource: "registry",
  longContextThresholdTokens: null,
});

const createAddOnLot = (
  userId: string,
  credits: number,
  fundedCostMicroUsd = 0
) =>
  prisma.creditLot.create({
    data: {
      userId,
      source: "integration_test_add_on",
      originalCredits: credits,
      remainingCredits: credits,
      originalFundedCostMicroUsd: BigInt(fundedCostMicroUsd),
      remainingFundedCostMicroUsd: BigInt(fundedCostMicroUsd),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });

type CreditPackCheckout = {
  session: Stripe.Checkout.Session;
  paymentIntentId: string;
  pack: NonNullable<ReturnType<typeof getCreditPack>>;
};

const creditPackCheckout = (
  userId: string,
  packId: "project_1500" = "project_1500"
): CreditPackCheckout => {
  const pack = getCreditPack(packId);
  assert.ok(pack);
  const suffix = randomUUID().replaceAll("-", "");
  const paymentIntentId = `pi_test_${suffix}`;
  return {
    pack,
    paymentIntentId,
    session: {
      id: `cs_test_${suffix}`,
      client_reference_id: userId,
      payment_status: "paid",
      amount_total: pack.priceCents,
      currency: pack.currency.toLowerCase(),
      created: Math.floor(Date.now() / 1_000),
      payment_intent: paymentIntentId,
      metadata: {
        purchaseType: "credit_pack",
        packId: pack.id,
        userId,
      },
    } as unknown as Stripe.Checkout.Session,
  };
};

const disputeFor = (
  checkout: CreditPackCheckout,
  status: Stripe.Dispute.Status = "needs_response"
) =>
  ({
    id: `dp_test_${checkout.paymentIntentId.slice(8)}`,
    amount: checkout.pack.priceCents,
    currency: checkout.pack.currency.toLowerCase(),
    status,
    payment_intent: checkout.paymentIntentId,
    charge: null,
  }) as unknown as Stripe.Dispute;

const consumePurchasedCredits = async ({
  userId,
  credits,
  fundedCostMicroUsd,
}: {
  userId: string;
  credits: number;
  fundedCostMicroUsd: number;
}) => {
  const reservationId = `purchase-consumption-${randomUUID()}`;
  await prisma.$transaction(async (tx) => {
    await lockCreditAccount(tx, userId);
    const entries = await reserveAddOnCredits(tx, {
      userId,
      reservationId,
      credits,
      fundedCostMicroUsd,
    });
    await settleAddOnCredits(tx, {
      userId,
      reservationId,
      entries,
      settledCredits: credits,
      settledFundedCostMicroUsd: fundedCostMicroUsd,
      outcome: "completed",
    });
  });
};

const createPartiallyConsumedDispute = async () => {
  const user = await createUser("Pro");
  const checkout = creditPackCheckout(user.id);
  assert.equal(await grantCreditPackFromCheckout(checkout.session), true);
  const billingTransaction = await prisma.billingTransaction.findUniqueOrThrow({
    where: { stripeCheckoutSessionId: checkout.session.id },
  });
  assert.equal(billingTransaction.currency, "USD");
  assert.equal(billingTransaction.amountPaidMinor, checkout.pack.priceCents);
  assert.equal(
    billingTransaction.amountPaidUsdMicroUsd,
    BigInt(checkout.pack.priceCents) * BigInt(10_000)
  );
  await consumePurchasedCredits({
    userId: user.id,
    credits: 1_200,
    fundedCostMicroUsd: 2_000_000,
  });
  const dispute = disputeFor(checkout);
  assert.equal(await handleCreditPackDispute(dispute), true);
  return { user, checkout, dispute };
};

test("creates a durable reservation and prevents duplicate settlement", async () => {
  const user = await createUser();
  const acquired = await acquireChatAccess(
    chatAccess(user, 100),
    chatBudget({
      credits: 5,
      inputRate: 1,
      outputRate: 1,
    }),
    { traceId: `trace-${randomUUID()}` }
  );

  const durable = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: acquired.usageReservation.reservationId },
  });
  assert.equal(durable.status, "reserved");
  assert.equal(durable.reservedCredits, 5);
  assert.match(durable.idempotencyKey, /^chat-credit-reservation:.+:v1$/);

  const settlements = await Promise.all([
    settleChatUsage(acquired.usageReservation, {
      inputTokens: 100,
      outputTokens: 900,
      outcome: "completed",
    }),
    settleChatUsage(acquired.usageReservation, {
      inputTokens: 100,
      outputTokens: 900,
      outcome: "completed",
    }),
  ]);
  assert.equal(settlements.filter((result) => result.applied).length, 1);
  assert.equal(settlements.filter((result) => !result.applied).length, 1);

  const finalized = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: durable.id },
  });
  assert.equal(finalized.status, "settled");
  assert.equal(finalized.settledCredits, 5);
  const providerUsage = await prisma.providerDailyUsage.findFirstOrThrow({
    where: { provider: "openai", source: "internal" },
  });
  assert.equal(providerUsage.requestCount, 1);
  await releaseChatAccess(acquired.leaseId);
});

test("extendChatReservationExpiry heartbeats a reserved row but leaves a settled one alone", async () => {
  const user = await createUser();
  const acquired = await acquireChatAccess(
    chatAccess(user, 100),
    chatBudget({ credits: 5, inputRate: 1, outputRate: 1 })
  );
  const reservationId = acquired.usageReservation.reservationId;

  const before = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: reservationId },
  });
  await extendChatReservationExpiry(reservationId, 900);
  const afterHeartbeat = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: reservationId },
  });
  assert.ok(
    afterHeartbeat.expiresAt.getTime() > before.expiresAt.getTime(),
    "heartbeat should push expiresAt forward for a still-reserved job"
  );

  await settleChatUsage(acquired.usageReservation, {
    inputTokens: 100,
    outputTokens: 900,
    outcome: "completed",
  });
  const settled = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: reservationId },
  });
  assert.equal(settled.status, "settled");

  // Deep research can keep polling after Perplexity already reported a
  // terminal state (e.g. a slow client); the heartbeat must be a no-op once
  // the reservation is no longer "reserved" rather than reopening it.
  await extendChatReservationExpiry(reservationId, 900);
  const afterSettled = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: reservationId },
  });
  assert.equal(afterSettled.expiresAt.getTime(), settled.expiresAt.getTime());

  await releaseChatAccess(acquired.leaseId);
});

test("stores Mistral cached-token usage and the request-time pricing snapshot", async () => {
  const user = await createUser();
  const acquired = await acquireChatAccess(
    chatAccess(user, 100),
    chatBudget({
      credits: 5,
      inputTokens: 1_013,
      outputTokens: 30,
      inputRate: 2,
      outputRate: 6,
      cachedInputPriceMultiplier: 0.1,
      provider: "mistral",
    })
  );

  await settleChatUsage(acquired.usageReservation, {
    inputTokens: 1_013,
    cachedInputTokens: 1_008,
    outputTokens: 30,
    outcome: "completed",
  });

  const finalized = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: acquired.usageReservation.reservationId },
  });
  assert.equal(finalized.settledInputTokens, 1_013);
  assert.equal(finalized.settledCachedInputTokens, 1_008);
  assert.equal(finalized.settledOutputTokens, 30);
  assert.equal(finalized.settledCostMicroUsd, BigInt(392));
  assert.deepEqual(finalized.pricingSnapshot, {
    costSource: "token_estimate",
    inputTokens: 1_013,
    uncachedInputTokens: 5,
    cachedInputTokens: 1_008,
    outputTokens: 30,
    inputUsdPerMillionTokens: 2,
    outputUsdPerMillionTokens: 6,
    cachedInputPriceMultiplier: 0.1,
    uncachedInputCostMicroUsd: 10,
    cachedInputCostMicroUsd: 202,
    // Cache writes are their own line in the snapshot, and zero on a turn that
    // sent no cache marker. Zero here is a measurement -- this request created
    // no cache entry -- while the null rate says this model has no verified
    // cache-write price at all. See docs/policy/anthropic-prompt-caching.md §6.
    cacheWriteInputTokens: 0,
    cacheWriteUsdPerMillionTokens: null,
    cacheWriteInputCostMicroUsd: 0,
    unpricedCacheWriteTokens: 0,
    promptCacheTtl: null,
    outputCostMicroUsd: 180,
    totalCostMicroUsd: 392,
    // The settlement snapshot is the audit record for a charge, so it also
    // pins which price list produced it, which cost source the *reservation*
    // used, and whether the token counts came from the provider or from the
    // fallback estimator. See settleChatUsage in lib/chatSecurity.ts.
    pricingVersion: "test-fixture-pricing",
    reservationCostSource: "registry",
    longContextThresholdTokens: null,
    usageSource: "provider_usage_metadata",
    reasoningTokens: null,
  });

  const providerUsage = await prisma.providerDailyUsage.findFirstOrThrow({
    where: { provider: "mistral", source: "internal" },
  });
  assert.equal(providerUsage.cachedInputTokens, 1_008);
  assert.equal(providerUsage.uncachedInputCostMicroUsd, 10);
  assert.equal(providerUsage.cachedInputCostMicroUsd, 202);
  assert.equal(providerUsage.outputCostMicroUsd, 180);
  await releaseChatAccess(acquired.leaseId);
});

// The snapshot above is the token_estimate case: Tomverse priced the turn from
// token counts. Perplexity instead reports what the call actually cost, and
// that number must win while the token estimate survives alongside it for
// audit -- billing on an estimate we know to be superseded is the failure this
// guards.
test("settles Perplexity from the provider-reported cost and keeps the token estimate", async () => {
  const user = await createUser();
  const acquired = await acquireChatAccess(
    chatAccess(user, 100),
    chatBudget({
      credits: 5,
      inputTokens: 1_000,
      outputTokens: 100,
      inputRate: 3,
      outputRate: 15,
      provider: "perplexity",
    })
  );

  await settleChatUsage(
    acquired.usageReservation,
    { inputTokens: 1_000, outputTokens: 100, outcome: "completed" },
    {
      providerUsageSnapshot: {
        source: "perplexity_response_usage",
        currency: "USD",
        totalCostMicroUsd: 7_777,
        inputTokensCostMicroUsd: 2_222,
        outputTokensCostMicroUsd: 3_333,
        reasoningTokensCostMicroUsd: null,
        requestCostMicroUsd: null,
        citationTokensCostMicroUsd: null,
        searchQueriesCostMicroUsd: null,
        promptTokens: 1_000,
        completionTokens: 100,
        totalTokens: 1_100,
        reasoningTokens: null,
        citationTokens: null,
        searchQueries: null,
        searchContextSize: null,
      },
    }
  );

  const finalized = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: acquired.usageReservation.reservationId },
  });
  // Billed on the provider's number (7_777), not the 4_500 token estimate.
  assert.equal(finalized.settledCostMicroUsd, BigInt(7_777));
  assert.deepEqual(finalized.pricingSnapshot, {
    costSource: "provider_response",
    inputTokens: 1_000,
    uncachedInputTokens: 1_000,
    cachedInputTokens: 0,
    outputTokens: 100,
    inputUsdPerMillionTokens: 3,
    outputUsdPerMillionTokens: 15,
    cachedInputPriceMultiplier: 1,
    uncachedInputCostMicroUsd: 2_222,
    cachedInputCostMicroUsd: 0,
    // Cache writes are their own line in the snapshot, and zero on a turn that
    // sent no cache marker. Zero here is a measurement -- this request created
    // no cache entry -- while the null rate says this model has no verified
    // cache-write price at all. See docs/policy/anthropic-prompt-caching.md §6.
    cacheWriteInputTokens: 0,
    cacheWriteUsdPerMillionTokens: null,
    cacheWriteInputCostMicroUsd: 0,
    unpricedCacheWriteTokens: 0,
    promptCacheTtl: null,
    outputCostMicroUsd: 3_333,
    tokenEstimatedTotalCostMicroUsd: 4_500,
    totalCostMicroUsd: 7_777,
    pricingVersion: "test-fixture-pricing",
    reservationCostSource: "registry",
    longContextThresholdTokens: null,
    usageSource: "provider_usage_metadata",
    reasoningTokens: null,
  });

  await releaseChatAccess(acquired.leaseId);
});

// Native web search bills a per-call provider fee on top of the token cost.
// The snapshot has to keep the two separable, and the total has to be their
// sum -- a search fee folded into tokenCostMicroUsd would be invisible to
// per-feature cost analysis.
test("adds native web search cost on top of the token cost and keeps both separable", async () => {
  const user = await createUser();
  const acquired = await acquireChatAccess(
    chatAccess(user, 100),
    chatBudget({
      credits: 5,
      inputTokens: 800,
      outputTokens: 200,
      inputRate: 5,
      outputRate: 20,
      provider: "openai",
    })
  );

  await settleChatUsage(acquired.usageReservation, {
    inputTokens: 800,
    outputTokens: 200,
    outcome: "completed",
    searchExecuted: true,
    searchCostMicroUsd: 25_000,
    searchQueryCount: 3,
  });

  const finalized = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: acquired.usageReservation.reservationId },
  });
  // tokens 800*5 + 200*20 = 8_000; search 25_000; total 33_000.
  assert.equal(finalized.settledCostMicroUsd, BigInt(33_000));
  assert.deepEqual(finalized.pricingSnapshot, {
    costSource: "token_estimate",
    inputTokens: 800,
    uncachedInputTokens: 800,
    cachedInputTokens: 0,
    outputTokens: 200,
    inputUsdPerMillionTokens: 5,
    outputUsdPerMillionTokens: 20,
    cachedInputPriceMultiplier: 1,
    uncachedInputCostMicroUsd: 4_000,
    cachedInputCostMicroUsd: 0,
    // Cache writes are their own line in the snapshot, and zero on a turn that
    // sent no cache marker. Zero here is a measurement -- this request created
    // no cache entry -- while the null rate says this model has no verified
    // cache-write price at all. See docs/policy/anthropic-prompt-caching.md §6.
    cacheWriteInputTokens: 0,
    cacheWriteUsdPerMillionTokens: null,
    cacheWriteInputCostMicroUsd: 0,
    unpricedCacheWriteTokens: 0,
    promptCacheTtl: null,
    outputCostMicroUsd: 4_000,
    tokenCostMicroUsd: 8_000,
    searchCostMicroUsd: 25_000,
    searchQueryCount: 3,
    totalCostMicroUsd: 33_000,
    pricingVersion: "test-fixture-pricing",
    reservationCostSource: "registry",
    longContextThresholdTokens: null,
    usageSource: "provider_usage_metadata",
    reasoningTokens: null,
  });

  await releaseChatAccess(acquired.leaseId);
});

// The mirror image: when the provider ran no search, no search fee may appear
// in the snapshot at all -- not a zeroed field, and nothing added to the total.
test("charges no search cost when the provider ran no native web search", async () => {
  const user = await createUser();
  const acquired = await acquireChatAccess(
    chatAccess(user, 100),
    chatBudget({
      credits: 5,
      inputTokens: 800,
      outputTokens: 200,
      inputRate: 5,
      outputRate: 20,
      provider: "openai",
    })
  );

  await settleChatUsage(acquired.usageReservation, {
    inputTokens: 800,
    outputTokens: 200,
    outcome: "completed",
    searchExecuted: false,
    searchQueryCount: 0,
  });

  const finalized = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: acquired.usageReservation.reservationId },
  });
  assert.equal(finalized.settledCostMicroUsd, BigInt(8_000));
  assert.deepEqual(finalized.pricingSnapshot, {
    costSource: "token_estimate",
    inputTokens: 800,
    uncachedInputTokens: 800,
    cachedInputTokens: 0,
    outputTokens: 200,
    inputUsdPerMillionTokens: 5,
    outputUsdPerMillionTokens: 20,
    cachedInputPriceMultiplier: 1,
    uncachedInputCostMicroUsd: 4_000,
    cachedInputCostMicroUsd: 0,
    // Cache writes are their own line in the snapshot, and zero on a turn that
    // sent no cache marker. Zero here is a measurement -- this request created
    // no cache entry -- while the null rate says this model has no verified
    // cache-write price at all. See docs/policy/anthropic-prompt-caching.md §6.
    cacheWriteInputTokens: 0,
    cacheWriteUsdPerMillionTokens: null,
    cacheWriteInputCostMicroUsd: 0,
    unpricedCacheWriteTokens: 0,
    promptCacheTtl: null,
    outputCostMicroUsd: 4_000,
    totalCostMicroUsd: 8_000,
    pricingVersion: "test-fixture-pricing",
    reservationCostSource: "registry",
    longContextThresholdTokens: null,
    usageSource: "provider_usage_metadata",
    reasoningTokens: null,
  });

  await releaseChatAccess(acquired.leaseId);
});

test("refunds an expired durable reservation and restores add-on credits", async () => {
  const user = await createUser();
  const lot = await createAddOnLot(user.id, 20);
  const acquired = await acquireChatAccess(
    chatAccess(user, 1),
    chatBudget({ credits: 5 })
  );
  assert.equal(
    (await prisma.creditLot.findUniqueOrThrow({ where: { id: lot.id } }))
      .remainingCredits,
    16
  );
  await prisma.chatCreditReservation.update({
    where: { id: acquired.usageReservation.reservationId },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });

  const result = await reconcileExpiredChatCreditReservations(new Date(), 10);
  assert.deepEqual(result, {
    examined: 1,
    refunded: 1,
    alreadyFinalized: 0,
    failed: 0,
  });
  const reservation = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: acquired.usageReservation.reservationId },
  });
  assert.equal(reservation.status, "refunded");
  assert.ok(reservation.reconciledAt);
  assert.match(reservation.lastError || "", /reservation_expired/);
  assert.equal(
    (await prisma.creditLot.findUniqueOrThrow({ where: { id: lot.id } }))
      .remainingCredits,
    20
  );
  await releaseChatAccess(acquired.leaseId);
});

test("settles partial cancelled usage and refunds only the unused reservation", async () => {
  const user = await createUser();
  const lot = await createAddOnLot(user.id, 20);
  const acquired = await acquireChatAccess(
    chatAccess(user, 2),
    chatBudget({ credits: 5 })
  );
  assert.equal(
    (await prisma.creditLot.findUniqueOrThrow({ where: { id: lot.id } }))
      .remainingCredits,
    17
  );

  const result = await settleChatUsage(acquired.usageReservation, {
    inputTokens: 100,
    outputTokens: 500,
    outcome: "cancelled",
  });
  // The returned figures are the same two the stored row carries, which is the
  // point of returning them: a caller reconciling what it held against what it
  // was charged should not have to re-read the reservation to find out.
  // `status` alone cannot answer it -- "settled" says credits were taken and
  // not how many.
  assert.deepEqual(result, {
    applied: true,
    status: "settled",
    reservedCredits: 5,
    settledCredits: 3,
  });
  const reservation = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: acquired.usageReservation.reservationId },
  });
  assert.equal(reservation.settledCredits, 3);
  assert.equal(reservation.reservedCredits, 5);
  assert.equal(
    (await prisma.creditLot.findUniqueOrThrow({ where: { id: lot.id } }))
      .remainingCredits,
    19
  );
  const ledgerTypes = await prisma.creditLedgerEntry.findMany({
    where: { reservationId: acquired.usageReservation.reservationId },
    orderBy: { type: "asc" },
    select: { type: true, creditsDelta: true },
  });
  assert.deepEqual(ledgerTypes, [
    { type: "refund", creditsDelta: 2 },
    { type: "reserve", creditsDelta: -3 },
    { type: "settle", creditsDelta: 0 },
  ]);
  await releaseChatAccess(acquired.leaseId);
});

test("creates recoverable debt when a chargeback follows partial consumption", async () => {
  const { user } = await createPartiallyConsumedDispute();
  const account = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
  });
  assert.equal(account.creditDebtCredits, 1_200);
  assert.equal(account.creditDebtCostMicroUsd, BigInt(2_000_000));
  assert.equal(account.billingRiskStatus, "disputed_hold");

  const purchase = await prisma.creditPurchase.findFirstOrThrow({
    where: { userId: user.id },
  });
  assert.equal(purchase.status, "disputed");
  assert.equal(purchase.revokedCredits, 300);
  assert.equal(purchase.unrecoveredCredits, 1_200);
  assert.equal(purchase.disputeDebtCredits, 1_200);
  const debtEntry = await prisma.creditDebtEntry.findFirstOrThrow({
    where: { userId: user.id, type: "dispute_unrecovered" },
  });
  assert.equal(debtEntry.creditsDelta, 1_200);
});

test("offsets debt from a new purchase and restores value after the dispute is won", async () => {
  const { user, checkout, dispute } = await createPartiallyConsumedDispute();
  const replacementCheckout = creditPackCheckout(user.id);
  assert.equal(
    await grantCreditPackFromCheckout(replacementCheckout.session),
    true
  );

  const afterOffset = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
  });
  assert.equal(afterOffset.creditDebtCredits, 0);
  assert.equal(afterOffset.creditDebtCostMicroUsd, BigInt(0));
  const replacementLot = await prisma.creditLot.findFirstOrThrow({
    where: { userId: user.id, source: "add_on", purchase: { stripeCheckoutSessionId: replacementCheckout.session.id } },
  });
  assert.equal(replacementLot.remainingCredits, 300);
  const disputedPurchase = await prisma.creditPurchase.findFirstOrThrow({
    where: { stripeCheckoutSessionId: checkout.session.id },
  });
  assert.equal(disputedPurchase.unrecoveredCredits, 0);
  assert.equal(disputedPurchase.disputeOffsetCredits, 1_200);

  const wonDispute = {
    ...dispute,
    status: "won",
  } as Stripe.Dispute;
  assert.equal(await handleCreditPackDisputeClosed(wonDispute), true);

  const recoveredAccount = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
  });
  assert.equal(recoveredAccount.billingRiskStatus, "normal");
  const recoveredPurchase = await prisma.creditPurchase.findUniqueOrThrow({
    where: { id: disputedPurchase.id },
  });
  assert.equal(recoveredPurchase.status, "paid");
  assert.equal(recoveredPurchase.disputeStatus, "won");
  assert.equal(recoveredPurchase.disputeDebtCredits, 0);
  assert.equal(recoveredPurchase.disputeOffsetCredits, 0);
  const restoredLot = await prisma.creditLot.findFirstOrThrow({
    where: { purchaseId: disputedPurchase.id, source: "dispute_reinstatement" },
  });
  assert.equal(restoredLot.remainingCredits, 1_500);
  const activeCredits = await prisma.creditLot.aggregate({
    where: { userId: user.id, status: "active" },
    _sum: { remainingCredits: true },
  });
  assert.equal(activeCredits._sum.remainingCredits, 1_800);
});

test("serializes concurrent reservations without overspending plan or add-on balances", async () => {
  const user = await createUser();
  const lot = await createAddOnLot(user.id, 3);
  const attempts = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      acquireChatAccess(
        chatAccess(user, 2),
        chatBudget({ credits: 1, inputTokens: 1, outputTokens: 0 })
      )
    )
  );
  const succeeded = attempts.filter(
    (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireChatAccess>>> =>
      result.status === "fulfilled"
  );
  const failed = attempts.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  assert.equal(succeeded.length, 5);
  assert.equal(failed.length, 3);
  // Both outcomes are entitlement decisions, told apart by whether the account
  // still holds purchased credits: an account with none is told its plan is
  // exhausted, one with some but not enough is told its balance is short.
  assert.ok(
    failed.every(
      (result) =>
        result.reason instanceof Error &&
        "code" in result.reason &&
        (result.reason.code === "CREDIT_BALANCE_INSUFFICIENT" ||
          result.reason.code === "PLAN_ENTITLEMENT_EXHAUSTED")
    )
  );
  assert.equal(await prisma.chatCreditReservation.count(), 5);
  const remainingLot = await prisma.creditLot.findUniqueOrThrow({
    where: { id: lot.id },
  });
  assert.equal(remainingLot.remainingCredits, 0);
  assert.ok(remainingLot.remainingCredits >= 0);
  const monthUsage = await prisma.chatUsageBucket.findFirstOrThrow({
    where: { key: chatAccess(user, 2).subjectKey, period: "month" },
  });
  assert.equal(usageBucketCount(monthUsage.count), 2);

  await Promise.all(
    succeeded.map(({ value }) => releaseChatAccess(value.leaseId))
  );
});

test("preflights and reserves three premium models without full-output quota collisions", async () => {
  const user = await createUser("Max");
  const access = chatAccess(user, 10_000);
  // The retired per-user USD ceiling. Setting it must have no effect at all:
  // this is the exact value and variable that blocked a paying Pro account
  // with thousands of plan credits still available.
  const previousDailyLimit = process.env.CHAT_MAX_COST_MICROUSD_PER_DAY;
  process.env.CHAT_MAX_COST_MICROUSD_PER_DAY = "1500000";

  try {
    const budgets = ["premium-a", "premium-b", "premium-c"].map((modelId) => ({
      ...chatBudget({
        credits: 8,
        inputTokens: 100,
        outputTokens: 8_192,
        reservedOutputTokens: 2_048,
        inputRate: 15,
        outputRate: 60,
      }),
      modelId,
    }));

    const preflight = await preflightChatComparisonAccess(access, budgets);
    assert.equal(preflight.modelCount, 3);
    assert.equal(preflight.requiredCredits, 24);
    assert.equal(preflight.reservedCostMicroUsd, 373_140);
    // The reserved cost is well past the retired US$1.50/day ceiling and is
    // still allowed, because the guardrail is derived from the plan's credits.
    assert.ok(preflight.reservedCostMicroUsd < 1_500_000);
    // A preflight spends no credits, no tokens and no cost allowance. What it
    // does reserve is admission: the comparison's concurrency slots and its
    // per-minute request capacity, both taken for the whole run so it cannot
    // be admitted in part. That is two `minute` rows -- the caller's own scope
    // and the IP ceiling -- and nothing else.
    const preflightBuckets = await prisma.chatUsageBucket.findMany({
      select: { key: true, period: true },
    });
    assert.deepEqual(
      preflightBuckets.map((bucket) => bucket.period).sort(),
      ["minute", "minute"]
    );
    assert.deepEqual(
      preflightBuckets.map((bucket) => bucket.key).sort(),
      [access.ipKey, access.subjectKey].sort()
    );
    assert.equal(await prisma.chatCreditReservation.count(), 0);
    assert.equal(await prisma.chatRequestLease.count(), 3);
    // Reset instants handed to the client are always ahead of now.
    assert.ok(preflight.dailyResetAt);
    assert.ok(new Date(preflight.dailyResetAt!).getTime() > Date.now());

    const acquired = await Promise.all(
      budgets.map((budget) => acquireChatAccess(access, budget))
    );
    assert.equal(acquired.length, 3);
    assert.equal(await prisma.chatCreditReservation.count(), 3);

    await Promise.all(acquired.map((grant) => releaseChatAccess(grant.leaseId)));
  } finally {
    if (previousDailyLimit === undefined) {
      delete process.env.CHAT_MAX_COST_MICROUSD_PER_DAY;
    } else {
      process.env.CHAT_MAX_COST_MICROUSD_PER_DAY = previousDailyLimit;
    }
  }
});

test("uses add-on credits beyond the plan daily guardrail", async () => {
  const user = await createUser("Pro");
  const access = chatAccess(user, 3_000, 300);
  const now = new Date();
  const dayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  await prisma.chatUsageBucket.create({
    data: {
      key: access.subjectKey,
      period: "day",
      periodStart: dayStart,
      count: 300,
    },
  });
  const lot = await createAddOnLot(user.id, 10);

  const acquired = await acquireChatAccess(
    access,
    chatBudget({ credits: 5, inputTokens: 1, outputTokens: 0 })
  );

  assert.equal(acquired.usageReservation.planReservedCredits, 0);
  assert.equal(acquired.usageReservation.addOnReservedCredits, 5);
  const dailyUsage = await prisma.chatUsageBucket.findUniqueOrThrow({
    where: {
      key_period_periodStart: {
        key: access.subjectKey,
        period: "day",
        periodStart: dayStart,
      },
    },
  });
  assert.equal(usageBucketCount(dailyUsage.count), 300);
  const reservedLot = await prisma.creditLot.findUniqueOrThrow({
    where: { id: lot.id },
  });
  assert.equal(reservedLot.remainingCredits, 5);

  await settleChatUsage(acquired.usageReservation, {
    inputTokens: 1,
    outputTokens: 0,
    outcome: "completed",
  });
  await releaseChatAccess(acquired.leaseId);
});

test("an answer longer than the reservation is settled up, not silently capped", async () => {
  const user = await createUser("Pro");
  const access = chatAccess(user, 3_000, 300);
  const acquired = await acquireChatAccess(
    access,
    chatBudget({
      credits: 8,
      inputTokens: 3_469,
      outputTokens: 8_192,
      reservedOutputTokens: 2_048,
      inputRate: 5,
      outputRate: 30,
    })
  );
  const reservedCost = 3_469 * 5 + 2_048 * 30;
  const durable = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: acquired.usageReservation.reservationId },
  });
  assert.equal(Number(durable.reservedCostMicroUsd), reservedCost);

  // The model answered with 6,000 output tokens -- nearly three times the
  // reservation, which is exactly the case a 2,048-token reservation missed.
  await settleChatUsage(acquired.usageReservation, {
    inputTokens: 3_469,
    outputTokens: 6_000,
    outcome: "completed",
    usageFromProvider: true,
  });

  const settled = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: durable.id },
  });
  const actualCost = 3_469 * 5 + 6_000 * 30;
  assert.equal(Number(settled.settledCostMicroUsd), actualCost);
  assert.ok(actualCost > reservedCost);
  assert.equal(settled.settledOutputTokens, 6_000);

  const planCostBucket = await prisma.chatUsageBucket.findFirstOrThrow({
    where: { key: access.subjectKey, period: "cost-day" },
  });
  assert.equal(usageBucketCount(planCostBucket.count), actualCost);
  const totalCostBucket = await prisma.chatUsageBucket.findFirstOrThrow({
    where: { key: access.subjectKey, period: "op-cost-day" },
  });
  assert.equal(usageBucketCount(totalCostBucket.count), actualCost);

  const snapshot = settled.pricingSnapshot as Record<string, unknown>;
  assert.equal(snapshot.pricingVersion, "test-fixture-pricing");
  assert.equal(snapshot.usageSource, "provider_usage_metadata");

  await releaseChatAccess(acquired.leaseId);
});

test("a failed model refunds while a completed sibling settles", async () => {
  const user = await createUser("Pro");
  const access = chatAccess(user, 3_000, 300);
  const budget = () =>
    chatBudget({
      credits: 8,
      inputTokens: 1_000,
      outputTokens: 8_192,
      reservedOutputTokens: 4_096,
      inputRate: 5,
      outputRate: 25,
    });

  const completed = await acquireChatAccess(access, budget());
  const failed = await acquireChatAccess(access, budget());

  await settleChatUsage(completed.usageReservation, {
    inputTokens: 1_000,
    outputTokens: 2_000,
    outcome: "completed",
    usageFromProvider: true,
  });
  await settleChatUsage(failed.usageReservation, {
    inputTokens: 0,
    outputTokens: 0,
    outcome: "failed",
    usageFromProvider: true,
  });

  const completedCost = 1_000 * 5 + 2_000 * 25;
  for (const period of ["cost-day", "cost-month", "op-cost-day", "op-cost-month"]) {
    const bucket = await prisma.chatUsageBucket.findFirstOrThrow({
      where: { key: access.subjectKey, period },
    });
    assert.equal(
      usageBucketCount(bucket.count),
      completedCost,
      `${period} still carries the failed model's reservation`
    );
  }
  // The failed model consumed no credits either.
  const monthCredits = await prisma.chatUsageBucket.findFirstOrThrow({
    where: { key: access.subjectKey, period: "month" },
  });
  assert.equal(usageBucketCount(monthCredits.count), 8);

  await Promise.all([
    releaseChatAccess(completed.leaseId),
    releaseChatAccess(failed.leaseId),
  ]);
});

test("plan exhaustion and the operational guardrail return different codes", async () => {
  const planExhaustedUser = await createUser("Pro");
  const planExhaustedAccess = chatAccess(planExhaustedUser, 8, 300);
  await acquireChatAccess(
    planExhaustedAccess,
    chatBudget({ credits: 8, inputTokens: 1, outputTokens: 0 })
  );
  const planError = await acquireChatAccess(
    planExhaustedAccess,
    chatBudget({ credits: 8, inputTokens: 1, outputTokens: 0 })
  ).catch((error) => error);
  assert.equal(planError.code, "PLAN_ENTITLEMENT_EXHAUSTED");
  assert.equal(planError.status, 402);

  // Same plan, credits still available, but the internal cost guardrail is
  // already spent -- a different layer and a different code.
  const guardrailUser = await createUser("Pro");
  const guardrailAccess = chatAccess(guardrailUser, 3_000, 300);
  const now = new Date();
  const dayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const guardrails = getChatCostGuardrails("Pro", {
    dailyMessageLimit: 300,
    monthlyMessageLimit: 3_000,
  });
  await prisma.chatUsageBucket.create({
    data: {
      key: guardrailAccess.subjectKey,
      period: "cost-day",
      periodStart: dayStart,
      count: guardrails.planDay,
    },
  });
  const guardrailError = await acquireChatAccess(
    guardrailAccess,
    chatBudget({
      credits: 8,
      inputTokens: 1_000,
      outputTokens: 4_096,
      inputRate: 5,
      outputRate: 25,
    })
  ).catch((error) => error);
  assert.equal(guardrailError.code, "OPERATIONAL_COST_GUARDRAIL_TRIGGERED");
  assert.equal(guardrailError.status, 429);
  assert.equal(guardrailError.details.limitLayer, "operational_guardrail");
  // Internal micro-USD is carried for logging but stripped from the response.
  assert.equal(typeof guardrailError.details.internalLimitCostMicroUsd, "number");
  const publicDetails = publicChatErrorDetails(guardrailError.details)!;
  assert.equal("internalLimitCostMicroUsd" in publicDetails, false);
  assert.equal("internalUsedCostMicroUsd" in publicDetails, false);
  assert.ok(new Date(String(publicDetails.resetAt)).getTime() > Date.now());

  // A refused request consumes nothing.
  const guardrailCredits = await prisma.chatUsageBucket.findFirst({
    where: { key: guardrailAccess.subjectKey, period: "month" },
  });
  assert.equal(guardrailCredits, null);
});

test("a preflight rejection is retrievable by its Trace ID", async () => {
  const user = await createUser("Pro");
  const access = chatAccess(user, 8, 300);
  const traceId = randomUUID();
  const budgets = ["premium-a", "premium-b"].map((modelId) => ({
    ...chatBudget({
      credits: 8,
      inputTokens: 3_469,
      outputTokens: 8_192,
      reservedOutputTokens: 4_096,
      inputRate: 5,
      outputRate: 30,
    }),
    modelId,
  }));

  const error = await preflightChatComparisonAccess(access, budgets, {
    traceId,
    enabledTools: ["web_search"],
  }).catch((thrown) => thrown);
  assert.ok(error instanceof Error);

  const decisions = await findChatLimitDecisionsByTraceId(traceId);
  assert.equal(decisions.length, 1);
  const decision = decisions[0];
  assert.equal(decision.decision, "rejected");
  assert.equal(decision.phase, "comparison_preflight");
  assert.equal(decision.plan, "Pro");
  assert.deepEqual(decision.modelIds, ["premium-a", "premium-b"]);
  assert.deepEqual(decision.enabledTools, ["web_search"]);
  assert.equal(decision.estimatedInputTokens, 3_469 * 2);
  assert.equal(decision.estimatedOutputTokens, 4_096 * 2);
  assert.equal(decision.requiredCredits, 16);
  assert.deepEqual(decision.pricingVersions, ["test-fixture-pricing"]);
  assert.ok(decision.timeZone);
  // Nothing that could contain prompt text is stored.
  assert.equal(JSON.stringify(decision).includes("prompt"), false);
});

test("purchased credits are not blocked a second time by the plan cost guardrail", async () => {
  const user = await createUser("Pro");
  const access = chatAccess(user, 3_000, 300);
  const now = new Date();
  const dayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const guardrails = getChatCostGuardrails("Pro", {
    dailyMessageLimit: 300,
    monthlyMessageLimit: 3_000,
  });
  // Plan-funded cost for the day is already at its guardrail, and the daily
  // plan credits are spent, so this request can only be add-on funded.
  await prisma.chatUsageBucket.createMany({
    data: [
      {
        key: access.subjectKey,
        period: "cost-day",
        periodStart: dayStart,
        count: guardrails.planDay,
      },
      {
        key: access.subjectKey,
        period: "day",
        periodStart: dayStart,
        count: 300,
      },
    ],
  });
  const lot = await createAddOnLot(user.id, 20, 5_000_000);

  const acquired = await acquireChatAccess(
    access,
    chatBudget({
      credits: 8,
      inputTokens: 1_000,
      outputTokens: 4_096,
      inputRate: 5,
      outputRate: 25,
    })
  );
  assert.equal(acquired.usageReservation.planReservedCredits, 0);
  assert.equal(acquired.usageReservation.addOnReservedCredits, 8);

  // The plan-funded bucket is untouched; only the total-cost guardrail moved.
  const planCost = await prisma.chatUsageBucket.findUniqueOrThrow({
    where: {
      key_period_periodStart: {
        key: access.subjectKey,
        period: "cost-day",
        periodStart: dayStart,
      },
    },
  });
  assert.equal(usageBucketCount(planCost.count), guardrails.planDay);
  const totalCost = await prisma.chatUsageBucket.findFirstOrThrow({
    where: { key: access.subjectKey, period: "op-cost-day" },
  });
  assert.equal(usageBucketCount(totalCost.count), 1_000 * 5 + 4_096 * 25);

  await settleChatUsage(acquired.usageReservation, {
    inputTokens: 1_000,
    outputTokens: 1_000,
    outcome: "completed",
    usageFromProvider: true,
  });
  const settledLot = await prisma.creditLot.findUniqueOrThrow({
    where: { id: lot.id },
  });
  assert.ok(settledLot.remainingCredits < 20);
  await releaseChatAccess(acquired.leaseId);
});

// The int4 fix has two halves. The limit half -- binding a guardrail above
// 2,147,483,647 µUSD into the guard query -- is covered by
// tests/chatCostGuardrails.test.mjs and by the Max reservation scenarios above.
// This covers the other half: the running total itself.
//
// `count = count + amount` overflowed on int4 just as the bound limit did, so
// a bucket that had been quietly filling up would start failing once it
// approached the ceiling -- later, and further from the cause, than the
// original report. Widening the column fixed both, and this pins the second
// one so a future narrowing (or an int cast in the guard query) cannot pass
// the limit-side tests while breaking accumulation.
test("a cost bucket accumulates past the old int4 ceiling", async () => {
  const user = await createUser("Max");
  const access = chatAccess(user, 10_000);
  const now = new Date();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );

  // The operational total-cost bucket: its limit (totalMonth, 2,500,000,000
  // µUSD for this plan) is the one that sits above the ceiling, so it is the
  // only bucket whose running total can legitimately reach it. Seeded close
  // enough that one reservation's cost carries the total across.
  await prisma.chatUsageBucket.create({
    data: {
      key: access.subjectKey,
      period: "op-cost-month",
      periodStart: monthStart,
      count: BigInt(2_147_450_000),
    },
  });

  const acquired = await acquireChatAccess(
    access,
    chatBudget({
      credits: 8,
      inputTokens: 1_000,
      outputTokens: 4_096,
      inputRate: 5,
      outputRate: 25,
    })
  );
  assert.ok(acquired.usageReservation);

  const bucket = await prisma.chatUsageBucket.findFirstOrThrow({
    where: { key: access.subjectKey, period: "op-cost-month" },
  });
  assert.ok(
    usageBucketCount(bucket.count) > 2_147_483_647,
    `expected the running total to pass int4's ceiling, got ${bucket.count}`
  );

  await releaseChatAccess(acquired.leaseId);
});

// The storage contract itself, asserted against a real column rather than
// inferred from the schema file: the largest value the guardrail arithmetic
// can derive has to survive a write and come back byte-identical.
//
// The accumulation test above proves the counter can *cross* int4. This proves
// the exact figure the policy document names -- Max's 2,500,000,000 µUSD
// total-cost guardrail -- round-trips, so a bucket is allowed to sit at its
// own limit rather than failing just short of it.
test("the largest derived guardrail survives a database round trip", async () => {
  const user = await createUser("Max");
  const access = chatAccess(user, 10_000);
  const monthStart = new Date(Date.UTC(2026, 7, 1));

  const max = getPlanGuardrailStorage().find((plan) => plan.plan === "Max");
  assert.ok(max);
  assert.equal(max.largestStoredValue, 2_500_000_000);
  assert.ok(max.largestStoredValue > POSTGRES_INT4_MAX);

  await prisma.chatUsageBucket.create({
    data: {
      key: access.subjectKey,
      period: "op-cost-month",
      periodStart: monthStart,
      count: BigInt(max.largestStoredValue),
    },
  });

  const stored = await prisma.chatUsageBucket.findUniqueOrThrow({
    where: {
      key_period_periodStart: {
        key: access.subjectKey,
        period: "op-cost-month",
        periodStart: monthStart,
      },
    },
  });
  // Identical value, not merely "large enough" -- a narrowing cast would
  // truncate or throw, and a lossy read would round.
  assert.equal(stored.count, BigInt(2_500_000_000));
  assert.equal(usageBucketCount(stored.count), 2_500_000_000);

  // And every plan's own ceiling, so a future constant change is caught here
  // as well as in the static check.
  for (const plan of getPlanGuardrailStorage()) {
    const period = `round-trip-${plan.plan}`;
    await prisma.chatUsageBucket.create({
      data: {
        key: access.subjectKey,
        period,
        periodStart: monthStart,
        count: BigInt(plan.largestStoredValue),
      },
    });
    const row = await prisma.chatUsageBucket.findUniqueOrThrow({
      where: {
        key_period_periodStart: {
          key: access.subjectKey,
          period,
          periodStart: monthStart,
        },
      },
    });
    assert.equal(
      usageBucketCount(row.count),
      plan.largestStoredValue,
      `${plan.plan} plan's ${plan.largestLimit} did not round trip`
    );
  }
});

test("the database refuses a lot balance below zero (§9)", async () => {
  // The net under the account lock, not a replacement for it.
  //
  // reserveAddOnCredits() decides sufficiency from a read and then decrements.
  // The lock is what serialises that decision; this is what happens when a
  // caller does not hold it. Without the constraint the transaction commits a
  // negative balance and the account silently holds credits it never bought,
  // which surfaces months later in a ledger reconciliation. With it the
  // transaction fails, which is a bug someone finds the same day.
  //
  // Both columns, because reserveAddOnCredits() decrements them in the same
  // loop: guarding only the credits would leave the money side of an
  // over-reservation invisible.
  const user = await createUser();
  const lot = await createAddOnLot(user.id, 3);

  await assert.rejects(
    prisma.creditLot.update({
      where: { id: lot.id },
      data: { remainingCredits: { decrement: 4 } },
    }),
    /CreditLot_remainingCredits_non_negative_check/
  );
  await assert.rejects(
    prisma.creditLot.update({
      where: { id: lot.id },
      // More micro-USD than any lot holds. Written through BigInt() rather
      // than as a literal: the project targets ES2017, where `1n` does not
      // parse.
      data: {
        remainingFundedCostMicroUsd: { decrement: BigInt(1_000_000_000_000) },
      },
    }),
    /CreditLot_remainingFundedCost_non_negative_check/
  );

  // Exactly zero is a spent lot, not a violation -- the ordinary end state of
  // every lot the account fully uses.
  const spent = await prisma.creditLot.update({
    where: { id: lot.id },
    data: { remainingCredits: { decrement: 3 } },
  });
  assert.equal(spent.remainingCredits, 0);
});

/* -------------------------------------------------------------------------- */
/* Promotion checkout lease                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The lease that stops one customer holding two live Checkout Sessions for the
 * same promotion. It is keyed on `(promotionId, userId)` and records nothing
 * about which attempt took it, so the `checkout.session.expired` handler has to
 * bound its release by the Session's own creation time. Stripe redelivers a
 * failed webhook for days; an unbounded release would free a lease a later
 * attempt is relying on, which is the one outcome the lease exists to prevent.
 *
 * Asserted against the real table because the guard is a `where` clause: a
 * mocked release proves only that the bound was passed, not that it is obeyed.
 */

test("an expired checkout releases only the lease its own attempt took", async () => {
  const promotionId = `promo_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;

  const abandoned = await reservePromotionCheckout(promotionId, userId);
  const abandonedRow = await prisma.chatRequestLease.findUniqueOrThrow({
    where: { id: abandoned.id },
  });

  // A redelivery naming an instant before this lease was taken: the attempt it
  // describes is older than the lease that is currently held.
  await releasePromotionCheckout(promotionId, userId, {
    takenAtOrBefore: new Date(abandonedRow.createdAt.getTime() - 1000),
  });
  assert.equal(
    await prisma.chatRequestLease.count({ where: { id: abandoned.id } }),
    1,
    "a lease taken after the Session being reported must survive"
  );

  // The Session that actually took it. Stripe stamps `created` before the lease
  // row exists, so the bound is at or after the row's own timestamp.
  await releasePromotionCheckout(promotionId, userId, {
    takenAtOrBefore: new Date(abandonedRow.createdAt.getTime() + 1000),
  });
  assert.equal(
    await prisma.chatRequestLease.count({ where: { id: abandoned.id } }),
    0
  );

  // And with the lease gone the customer can start the other plan's checkout,
  // which is the whole point of handling the event.
  const next = await reservePromotionCheckout(promotionId, userId);
  assert.equal(next.id, abandoned.id);
  await releasePromotionCheckout(promotionId, userId);
  assert.equal(
    await prisma.chatRequestLease.count({ where: { id: abandoned.id } }),
    0
  );
});
