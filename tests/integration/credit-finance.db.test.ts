import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import type Stripe from "stripe";
import {
  acquireChatAccess,
  extendChatReservationExpiry,
  preflightChatComparisonAccess,
  reconcileExpiredChatCreditReservations,
  releaseChatAccess,
  settleChatUsage,
  type ChatAccess,
  type ChatBudget,
} from "@/lib/chatSecurity";
import {
  handleCreditPackDispute,
  handleCreditPackDisputeClosed,
  grantCreditPackFromCheckout,
} from "@/lib/creditPurchase";
import { lockCreditAccount } from "@/lib/creditDebt";
import { reserveAddOnCredits, settleAddOnCredits } from "@/lib/creditLedger";
import { getCreditPack } from "@/lib/creditPacks";
import { prisma } from "@/lib/prisma";

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
  reservedOutputTokens,
  inputUsdPerMillionTokens: inputRate,
  outputUsdPerMillionTokens: outputRate,
  cachedInputPriceMultiplier,
  provider,
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
    inputTokens: 1_013,
    uncachedInputTokens: 5,
    cachedInputTokens: 1_008,
    outputTokens: 30,
    inputUsdPerMillionTokens: 2,
    outputUsdPerMillionTokens: 6,
    cachedInputPriceMultiplier: 0.1,
    uncachedInputCostMicroUsd: 10,
    cachedInputCostMicroUsd: 202,
    outputCostMicroUsd: 180,
    totalCostMicroUsd: 392,
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
  assert.deepEqual(result, { applied: true, status: "settled" });
  const reservation = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: acquired.usageReservation.reservationId },
  });
  assert.equal(reservation.settledCredits, 3);
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
  assert.ok(
    failed.every(
      (result) =>
        result.reason instanceof Error &&
        "code" in result.reason &&
        result.reason.code === "CREDIT_BALANCE_INSUFFICIENT"
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
  assert.equal(monthUsage.count, 2);

  await Promise.all(
    succeeded.map(({ value }) => releaseChatAccess(value.leaseId))
  );
});

test("preflights and reserves three premium models without full-output quota collisions", async () => {
  const user = await createUser("Max");
  const access = chatAccess(user, 10_000);
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
    assert.equal(await prisma.chatUsageBucket.count(), 0);

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
  assert.equal(dailyUsage.count, 300);
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
