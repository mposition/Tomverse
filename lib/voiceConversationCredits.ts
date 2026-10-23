import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiSecurityError } from "@/lib/apiSecurity";
import { getUserBillingPlan } from "@/lib/billingEntitlements";
import { getChatCreditAllocation } from "@/lib/chatCreditAllocation";
import { getUserChatUsageKey, incrementUsageBucket, readUsageBucketCount, usagePeriodStart } from "@/lib/chatSecurity";
import { reserveAddOnCredits, settleAddOnCredits, type AddOnCreditReservationEntry } from "@/lib/creditLedger";
import { getUserDayWindow } from "@/lib/userDailyUsage";
import { lockCreditAccount, offsetCreditDebt } from "@/lib/creditDebt";
import { recordInternalProviderUsage } from "@/lib/providerUsageAccounting";
import { getProviderCostGuardrailLimits } from "@/lib/providerCostBudget";
import { providerBucketKey } from "@/lib/chatProviderHolds";
import { reserveVoiceBudgets, settleVoiceBudgets } from "@/lib/voiceBudgetReservation";
import { snapshotVoiceBudgets, restoreVoiceBudgets, type VoiceBudgetSnapshot } from "@/lib/voiceConversationBudget";
import { VOICE_CONVERSATION_INITIAL_SECONDS, VOICE_CONVERSATION_MODEL, VOICE_CONVERSATION_PRICING_VERSION, VOICE_CONVERSATION_SOURCE, voiceDurationCharge } from "@tomverse/chat-core";

export type VoiceCreditPayload = {
  kind: "voice_conversation";
  conversationId: string | null;
  creditsPerMinute: number;
  maxSeconds: number;
  dayStart: string;
  dayReserved: boolean;
  monthStart: string;
  addOnEntries: AddOnCreditReservationEntry[];
  budgets?: VoiceBudgetSnapshot;
  dispatchStartedAt?: string;
  closeAt?: string;
  webLeaseUntil?: string;
  providerCostHold?: { dayStart: string; monthStart: string; amount: number };
};

export function readVoiceCreditPayload(value: unknown): VoiceCreditPayload {
  const p = value as VoiceCreditPayload;
  if (!p || p.kind !== VOICE_CONVERSATION_SOURCE || p.creditsPerMinute !== 36 ||
      !Number.isSafeInteger(p.maxSeconds) || p.maxSeconds < 1 ||
      !Array.isArray(p.addOnEntries) || !Number.isFinite(Date.parse(p.dayStart)) ||
      !Number.isFinite(Date.parse(p.monthStart))) throw new Error("Invalid voice reservation.");
  if (p.providerCostHold && (!Number.isSafeInteger(p.providerCostHold.amount) || p.providerCostHold.amount < 0 || !Number.isFinite(Date.parse(p.providerCostHold.dayStart)) || !Number.isFinite(Date.parse(p.providerCostHold.monthStart)))) throw new Error("Invalid voice provider cost hold.");
  return p;
}

/** Holds the whole bounded session before a paid call, using the ordinary account balance. */
export async function reserveVoiceConversationCredits(input: {
  userId: string; requestId: string; conversationId: string | null;
  creditsPerMinute: number; maxSeconds: number;
  sessionSeconds?: number;
}) {
  const now = new Date();
  const plan = await getUserBillingPlan(input.userId);
  const subjectKey = getUserChatUsageKey(input.userId);
  const price = voiceDurationCharge(input.maxSeconds, input.creditsPerMinute);
  return prisma.$transaction(async tx => {
    // Same wallet lock used by ordinary Chat, including purchased-credit lots.
    await lockCreditAccount(tx, input.userId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${subjectKey}))`;
    const idempotencyKey = `voice-conversation:${input.userId}:${input.requestId}`;
    if (await tx.chatCreditReservation.findUnique({ where: { idempotencyKey }, select: { id: true } })) {
      throw new ApiSecurityError(409, "VOICE_START_ALREADY_ATTEMPTED", "This voice start was already attempted. Check its outcome before starting again.");
    }
    const day = await getUserDayWindow(tx, input.userId, now);
    const monthStart = usagePeriodStart("month", now);
    let monthlyUsed = await readUsageBucketCount(tx, subjectKey, "month", monthStart);
    const debt = await offsetCreditDebt(tx, {
      userId: input.userId, availableCredits: Math.max(0, plan.monthlyMessageLimit - monthlyUsed),
      availableFundedCostMicroUsd: BigInt(0), type: "plan_offset",
      metadata: { source: "monthly_plan_credits", periodStart: monthStart.toISOString() },
    });
    if (debt.offsetCredits > 0) {
      if (!(await incrementUsageBucket(tx, subjectKey, "month", monthStart, plan.monthlyMessageLimit, debt.offsetCredits))) {
        throw new ApiSecurityError(409, "CONCURRENT_RESERVATION_CONFLICT", "Credit debt balance changed. Try again.");
      }
      monthlyUsed += debt.offsetCredits;
    }
    const dailyUsed = await readUsageBucketCount(tx, subjectKey, "day", day.start);
    const purchased = await tx.creditLot.aggregate({
      where: { userId: input.userId, status: "active", expiresAt: { gt: now }, remainingCredits: { gt: 0 } },
      _sum: { remainingCredits: true },
    });
    const allocation = getChatCreditAllocation({
      requiredCredits: price.credits,
      monthlyPlanCreditsRemaining: Math.max(0, plan.monthlyMessageLimit - monthlyUsed),
      dailyPlanCreditsRemaining: plan.dailyMessageLimit > 0 ? Math.max(0, plan.dailyMessageLimit - dailyUsed) : null,
      purchasedCreditsRemaining: purchased._sum.remainingCredits ?? 0,
    });
    if (allocation.balanceInsufficient) throw new ApiSecurityError(402, "CREDIT_BALANCE_INSUFFICIENT", "Not enough credits for a voice session.");
    if (allocation.dailyPlanGuardrailBlocked) throw new ApiSecurityError(429, "PLAN_DAILY_CREDIT_LIMIT_REACHED", "Daily plan credits are exhausted.");
    for (const bucket of [
      { period: "day", start: day.start, limit: plan.dailyMessageLimit },
      { period: "month", start: monthStart, limit: plan.monthlyMessageLimit },
    ]) {
      if (allocation.planReservedCredits && bucket.limit > 0 &&
          !(await incrementUsageBucket(tx, subjectKey, bucket.period, bucket.start, bucket.limit, allocation.planReservedCredits))) {
        throw new ApiSecurityError(409, "CONCURRENT_RESERVATION_CONFLICT", "Another request is reserving credits. Try again.");
      }
    }
    const reservationId = `voice:${input.requestId}:${subjectKey}`;
    const addOnEntries = allocation.addOnCreditsRequired ? await reserveAddOnCredits(tx, {
      userId: input.userId, reservationId, credits: allocation.addOnCreditsRequired,
      fundedCostMicroUsd: Math.ceil(price.costMicroUsd * allocation.addOnCreditsRequired / price.credits), now,
    }) : [];
    const budgets = await reserveVoiceBudgets({ subjectKey, seconds: input.maxSeconds, client: tx });
    const providerLimits = getProviderCostGuardrailLimits("openai");
    const providerDay = usagePeriodStart("day", now);
    for (const window of [{ period: "provider-cost-day", start: providerDay, limit: providerLimits.day }, { period: "provider-cost-month", start: monthStart, limit: providerLimits.month }]) {
      if (!await incrementUsageBucket(tx, providerBucketKey("openai"), window.period, window.start, window.limit, price.costMicroUsd)) throw new ApiSecurityError(503, "PROVIDER_BUDGET_EXHAUSTED", "Voice is temporarily unavailable.");
    }
    const payload: VoiceCreditPayload = {
      kind: VOICE_CONVERSATION_SOURCE, conversationId: input.conversationId,
      creditsPerMinute: input.creditsPerMinute, maxSeconds: input.maxSeconds,
      dayStart: day.start.toISOString(), dayReserved: plan.dailyMessageLimit > 0,
      monthStart: monthStart.toISOString(), addOnEntries,
      budgets: snapshotVoiceBudgets(budgets),
      providerCostHold: { dayStart: providerDay.toISOString(), monthStart: monthStart.toISOString(), amount: price.costMicroUsd },
      closeAt: new Date(now.getTime() + (input.sessionSeconds ?? input.maxSeconds) * 1_000).toISOString(),
    };
    return tx.chatCreditReservation.create({ data: {
      id: reservationId, userId: input.userId, subjectKey, traceId: input.requestId,
      source: VOICE_CONVERSATION_SOURCE, provider: "openai", modelId: VOICE_CONVERSATION_MODEL,
      idempotencyKey, status: "reserved", reservationPayload: payload as unknown as Prisma.InputJsonValue,
      reservedCredits: price.credits, reservedCostMicroUsd: BigInt(price.costMicroUsd),
      planReservedCredits: allocation.planReservedCredits, addOnReservedCredits: allocation.addOnCreditsRequired,
      pricingSnapshot: { creditsPerMinute: input.creditsPerMinute, microUsdPerMinute: 50_000, version: VOICE_CONVERSATION_PRICING_VERSION },
      expiresAt: new Date(now.getTime() + input.maxSeconds * 1_000 + 60_000),
    } });
  });
}

/** Missing finalization can only charge the provider-observed lower bound. */
export async function settleVoiceConversationCredits(id: string, seconds: number, initialized = false, evidence: "final" | "observed_minimum" = "final", providerStopped = true) {
  return prisma.$transaction(async tx => {
    const owner = await tx.chatCreditReservation.findUnique({ where: { id }, select: { userId: true } });
    if (owner?.userId) await lockCreditAccount(tx, owner.userId);
    const claim = await tx.chatCreditReservation.updateMany({
      where: { id, source: VOICE_CONVERSATION_SOURCE, status: "reserved" }, data: { status: "settling" },
    });
    if (!claim.count) return null;
    const row = await tx.chatCreditReservation.findUniqueOrThrow({ where: { id } });
    const payload = readVoiceCreditPayload(row.reservationPayload);
    if (evidence === "observed_minimum") {
      // This read follows the atomic claim, so evidence arriving while a sweep
      // awaited provider closure wins over its earlier duration snapshot.
      const saved = row.providerUsageSnapshot as { seconds?: number; confirmed?: boolean } | null;
      const valid = typeof saved?.seconds === "number" && Number.isFinite(saved.seconds) && saved.seconds >= 0 && saved.seconds <= payload.maxSeconds;
      seconds = valid ? saved.seconds! : 0;
      if (valid && saved?.confirmed) { evidence = "final"; providerStopped = true; }
    }
    const price = voiceDurationCharge(seconds, payload.creditsPerMinute);
    // Provider initialization has a 15-second minimum. Keep the provider cost
    // distinct from the user's reported active seconds; never add it twice.
    price.costMicroUsd = voiceDurationCharge(initialized ? Math.max(VOICE_CONVERSATION_INITIAL_SECONDS, seconds) : seconds, payload.creditsPerMinute).costMicroUsd;
    // Incomplete provider accounting retains the full operational exposure.
    // The user only pays for seconds the trusted sideband actually observed.
    if (evidence === "observed_minimum") price.costMicroUsd = Number(row.reservedCostMicroUsd);
    // Do not fabricate usage or silently debit beyond the authorized reservation.
    if (price.credits > row.reservedCredits || price.costMicroUsd > Number(row.reservedCostMicroUsd)) {
      throw new Error("Voice usage exceeded its reservation.");
    }
    const providerRefund = (payload.providerCostHold?.amount ?? price.costMicroUsd) - price.costMicroUsd;
    if (providerRefund > 0 && payload.providerCostHold) for (const window of [{ period: "provider-cost-day", start: payload.providerCostHold.dayStart }, { period: "provider-cost-month", start: payload.providerCostHold.monthStart }]) {
      await tx.$executeRaw`UPDATE "ChatUsageBucket" SET "count" = GREATEST(0, "count" - ${providerRefund}), "updatedAt" = NOW() WHERE "key" = ${providerBucketKey("openai")} AND "period" = ${window.period} AND "periodStart" = ${new Date(window.start)}`;
    }
    const planCharged = Math.min(row.planReservedCredits, price.credits);
    const refund = row.planReservedCredits - planCharged;
    if (refund) for (const bucket of [
      ...(payload.dayReserved ? [{ period: "day", start: payload.dayStart }] : []),
      { period: "month", start: payload.monthStart },
    ]) {
      await tx.$executeRaw`UPDATE "ChatUsageBucket" SET "count" = GREATEST(0, "count" - ${refund}), "updatedAt" = NOW()
        WHERE "key" = ${row.subjectKey} AND "period" = ${bucket.period} AND "periodStart" = ${new Date(bucket.start)}`;
    }
    if (row.userId && payload.addOnEntries.length) {
      const addOnCharged = price.credits - planCharged;
      await settleAddOnCredits(tx, {
        userId: row.userId, reservationId: row.id, entries: payload.addOnEntries,
        settledCredits: addOnCharged,
        settledFundedCostMicroUsd: row.addOnReservedCredits ? Math.ceil(
          payload.addOnEntries.reduce((sum, e) => sum + e.fundedCostMicroUsd, 0) * addOnCharged / row.addOnReservedCredits,
        ) : 0,
        outcome: seconds > 0 ? "completed" : "empty",
      });
    }
    if (price.costMicroUsd > 0) await recordInternalProviderUsage({
      client: tx, provider: "openai", modelId: VOICE_CONVERSATION_MODEL,
      inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
      estimatedCostMicroUsd: price.costMicroUsd, uncachedInputCostMicroUsd: 0,
      cachedInputCostMicroUsd: 0, outputCostMicroUsd: price.costMicroUsd, date: row.createdAt,
    });
    if (payload.budgets) await settleVoiceBudgets({
      reservation: restoreVoiceBudgets(payload.budgets), client: tx,
      basis: evidence === "observed_minimum" ? { kind: "reservation" } : initialized ? { kind: "provider_seconds", seconds: Math.max(VOICE_CONVERSATION_INITIAL_SECONDS, seconds) } : { kind: "not_billed" },
    });
    await tx.chatCreditReservation.update({ where: { id }, data: {
      status: "settled", outcome: seconds > 0 ? "completed" : "empty", settledAt: new Date(),
      settledCredits: price.credits, settledCostMicroUsd: BigInt(price.costMicroUsd),
      providerUsageSnapshot: { seconds, source: "provider", confirmed: evidence === "final", settlementBasis: evidence,
        providerCostEstimated: evidence !== "final", providerStopped },
      lastError: !providerStopped ? "VOICE_PROVIDER_STOP_PENDING" : evidence === "final" ? null : "VOICE_USAGE_ADJUSTED_AFTER_DISCONNECT",
    } });
    return price;
  });
}
