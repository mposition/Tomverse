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
import { VOICE_CONVERSATION_INITIAL_SECONDS, VOICE_CONVERSATION_CLOSING_SECONDS, VOICE_CONVERSATION_RESERVATION_SECONDS, VOICE_CONVERSATION_MODEL, VOICE_CONVERSATION_PRICING_VERSION, VOICE_CONVERSATION_SOURCE, voiceDurationCharge } from "@tomverse/chat-core";

type VoiceFunding = {
  startSeconds: number; endSeconds: number; planCredits: number; createdAt: string;
  dayStart: string; dayReserved: boolean; monthStart: string;
  addOnEntries: AddOnCreditReservationEntry[]; budgets: VoiceBudgetSnapshot;
  providerCostHold: { dayStart: string; monthStart: string; amount: number };
};

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
  recoveryLease?: { token: string; until: string };
  providerCostHold?: { dayStart: string; monthStart: string; amount: number };
  funding?: VoiceFunding[];
};

export function readVoiceCreditPayload(value: unknown): VoiceCreditPayload {
  const p = value as VoiceCreditPayload;
  if (!p || p.kind !== VOICE_CONVERSATION_SOURCE || p.creditsPerMinute !== 36 ||
      !Number.isSafeInteger(p.maxSeconds) || p.maxSeconds < 1 ||
      !Array.isArray(p.addOnEntries) || !Number.isFinite(Date.parse(p.dayStart)) ||
      !Number.isFinite(Date.parse(p.monthStart))) throw new Error("Invalid voice reservation.");
  if (p.providerCostHold && (!Number.isSafeInteger(p.providerCostHold.amount) || p.providerCostHold.amount < 0 || !Number.isFinite(Date.parse(p.providerCostHold.dayStart)) || !Number.isFinite(Date.parse(p.providerCostHold.monthStart)))) throw new Error("Invalid voice provider cost hold.");
  if (p.funding) {
    let previous = 0;
    if (!Array.isArray(p.funding) || !p.funding.length) throw new Error("Invalid voice funding.");
    for (const part of p.funding) {
      if (part.startSeconds !== previous || !Number.isSafeInteger(part.endSeconds) || part.endSeconds <= previous ||
          !Number.isSafeInteger(part.planCredits) || part.planCredits < 0 || !Array.isArray(part.addOnEntries) ||
          part.addOnEntries.some(entry => !entry.lotId || (entry.purchaseId !== null && (typeof entry.purchaseId !== "string" || !entry.purchaseId)) || !Number.isSafeInteger(entry.credits) || entry.credits < 0 || !Number.isSafeInteger(entry.fundedCostMicroUsd) || entry.fundedCostMicroUsd < 0) ||
          ![part.dayStart, part.monthStart, part.createdAt, part.providerCostHold?.dayStart, part.providerCostHold?.monthStart].every(value => typeof value === "string" && Number.isFinite(Date.parse(value)))) throw new Error("Invalid voice funding.");
      const expected = fundingPrice(part.startSeconds, part.endSeconds, p.creditsPerMinute);
      if (part.planCredits + part.addOnEntries.reduce((sum, entry) => sum + entry.credits, 0) !== expected.credits || part.providerCostHold.amount !== expected.costMicroUsd || restoreVoiceBudgets(part.budgets).subject.reservedSeconds !== part.endSeconds - part.startSeconds) throw new Error("Invalid voice funding.");
      previous = part.endSeconds;
    }
    if (previous !== p.maxSeconds) throw new Error("Invalid voice funding duration.");
  }
  return p;
}

const fundingPrice = (from: number, to: number, rate: number) => {
  const start = voiceDurationCharge(from, rate); const end = voiceDurationCharge(to, rate);
  return { credits: end.credits - start.credits, costMicroUsd: end.costMicroUsd - start.costMicroUsd };
};

/** Each funding window uses the same wallet, time-zone and provider guards as Start. */
async function reserveFunding(tx: Prisma.TransactionClient, input: { userId: string; reservationId: string; creditsPerMinute: number }, from: number, to: number, now: Date): Promise<VoiceFunding> {
  const plan = await getUserBillingPlan(input.userId);
  const subjectKey = getUserChatUsageKey(input.userId);
  const price = fundingPrice(from, to, input.creditsPerMinute);
  const day = await getUserDayWindow(tx, input.userId, now);
  const monthStart = usagePeriodStart("month", now);
  let monthlyUsed = await readUsageBucketCount(tx, subjectKey, "month", monthStart);
  const debt = await offsetCreditDebt(tx, {
    userId: input.userId, availableCredits: Math.max(0, plan.monthlyMessageLimit - monthlyUsed), availableFundedCostMicroUsd: BigInt(0), type: "plan_offset",
    metadata: { source: "monthly_plan_credits", periodStart: monthStart.toISOString() },
  });
  if (debt.offsetCredits > 0) {
    if (!(await incrementUsageBucket(tx, subjectKey, "month", monthStart, plan.monthlyMessageLimit, debt.offsetCredits))) throw new ApiSecurityError(409, "CONCURRENT_RESERVATION_CONFLICT", "Credit debt balance changed. Try again.");
    monthlyUsed += debt.offsetCredits;
  }
  const dailyUsed = await readUsageBucketCount(tx, subjectKey, "day", day.start);
  const purchased = await tx.creditLot.aggregate({ where: { userId: input.userId, status: "active", expiresAt: { gt: now }, remainingCredits: { gt: 0 } }, _sum: { remainingCredits: true } });
  const allocation = getChatCreditAllocation({ requiredCredits: price.credits, monthlyPlanCreditsRemaining: Math.max(0, plan.monthlyMessageLimit - monthlyUsed), dailyPlanCreditsRemaining: plan.dailyMessageLimit > 0 ? Math.max(0, plan.dailyMessageLimit - dailyUsed) : null, purchasedCreditsRemaining: purchased._sum.remainingCredits ?? 0 });
  if (allocation.balanceInsufficient) throw new ApiSecurityError(402, "CREDIT_BALANCE_INSUFFICIENT", "Not enough credits for voice.");
  if (allocation.dailyPlanGuardrailBlocked) throw new ApiSecurityError(429, "PLAN_DAILY_CREDIT_LIMIT_REACHED", "Daily plan credits are exhausted.");
  for (const bucket of [{ period: "day", start: day.start, limit: plan.dailyMessageLimit }, { period: "month", start: monthStart, limit: plan.monthlyMessageLimit }]) {
    if (allocation.planReservedCredits && bucket.limit > 0 && !(await incrementUsageBucket(tx, subjectKey, bucket.period, bucket.start, bucket.limit, allocation.planReservedCredits))) throw new ApiSecurityError(409, "CONCURRENT_RESERVATION_CONFLICT", "Another request is reserving credits. Try again.");
  }
  const addOnEntries = allocation.addOnCreditsRequired ? await reserveAddOnCredits(tx, {
    userId: input.userId, reservationId: input.reservationId, credits: allocation.addOnCreditsRequired,
    fundedCostMicroUsd: Math.ceil(price.costMicroUsd * allocation.addOnCreditsRequired / price.credits), now,
  }) : [];
  const budgets = await reserveVoiceBudgets({ subjectKey, seconds: to - from, client: tx });
  const providerLimits = getProviderCostGuardrailLimits("openai"); const providerDay = usagePeriodStart("day", now);
  for (const window of [{ period: "provider-cost-day", start: providerDay, limit: providerLimits.day }, { period: "provider-cost-month", start: monthStart, limit: providerLimits.month }]) {
    if (!await incrementUsageBucket(tx, providerBucketKey("openai"), window.period, window.start, window.limit, price.costMicroUsd)) throw new ApiSecurityError(503, "PROVIDER_BUDGET_EXHAUSTED", "Voice is temporarily unavailable.");
  }
  return { startSeconds: from, endSeconds: to, planCredits: allocation.planReservedCredits, createdAt: now.toISOString(), dayStart: day.start.toISOString(), dayReserved: plan.dailyMessageLimit > 0, monthStart: monthStart.toISOString(), addOnEntries, budgets: snapshotVoiceBudgets(budgets), providerCostHold: { dayStart: providerDay.toISOString(), monthStart: monthStart.toISOString(), amount: price.costMicroUsd } };
}

/** Holds only the next funded window before a paid call. Legacy rows remain readable. */
export async function reserveVoiceConversationCredits(input: {
  userId: string; requestId: string; conversationId: string | null;
  creditsPerMinute: number; maxSeconds: number;
  sessionSeconds?: number;
  continuous?: boolean;
}) {
  if (input.creditsPerMinute !== 36 || !Number.isSafeInteger(input.maxSeconds) || input.maxSeconds < 1) throw new Error("Invalid voice reservation.");
  const subjectKey = getUserChatUsageKey(input.userId);
  const price = voiceDurationCharge(input.maxSeconds, input.creditsPerMinute);
  return prisma.$transaction(async tx => {
    // Same wallet lock used by ordinary Chat, including purchased-credit lots.
    await lockCreditAccount(tx, input.userId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${subjectKey}))`;
    const now = new Date();
    const idempotencyKey = `voice-conversation:${input.userId}:${input.requestId}`;
    if (await tx.chatCreditReservation.findUnique({ where: { idempotencyKey }, select: { id: true } })) {
      throw new ApiSecurityError(409, "VOICE_START_ALREADY_ATTEMPTED", "This voice start was already attempted. Check its outcome before starting again.");
    }
    const reservationId = `voice:${input.requestId}:${subjectKey}`;
    const funding = await reserveFunding(tx, { ...input, reservationId }, 0, input.maxSeconds, now);
    // Wallet-lock and funding latency must not consume the paid session window.
    // This same durable anchor is used by subsequent rolling renewals.
    const fundedAt = new Date();
    const payload: VoiceCreditPayload = {
      kind: VOICE_CONVERSATION_SOURCE, conversationId: input.conversationId,
      creditsPerMinute: input.creditsPerMinute, maxSeconds: input.maxSeconds,
      dayStart: funding.dayStart, dayReserved: funding.dayReserved, monthStart: funding.monthStart, addOnEntries: funding.addOnEntries,
      budgets: funding.budgets, providerCostHold: funding.providerCostHold,
      ...(input.continuous ? { funding: [funding] } : {}),
      closeAt: new Date(fundedAt.getTime() + (input.sessionSeconds ?? input.maxSeconds) * 1_000).toISOString(),
    };
    return tx.chatCreditReservation.create({ data: {
      id: reservationId, userId: input.userId, subjectKey, traceId: input.requestId,
      source: VOICE_CONVERSATION_SOURCE, provider: "openai", modelId: VOICE_CONVERSATION_MODEL,
      idempotencyKey, status: "reserved", reservationPayload: payload as unknown as Prisma.InputJsonValue,
      createdAt: fundedAt,
      reservedCredits: price.credits, reservedCostMicroUsd: BigInt(price.costMicroUsd),
      planReservedCredits: funding.planCredits, addOnReservedCredits: price.credits - funding.planCredits,
      pricingSnapshot: { creditsPerMinute: input.creditsPerMinute, microUsdPerMinute: 50_000, version: VOICE_CONVERSATION_PRICING_VERSION },
      expiresAt: new Date(fundedAt.getTime() + input.maxSeconds * 1_000 + 60_000),
    } });
  });
}

export const isVoiceCapacityRefusal = (error: unknown): error is { code: string } => ["CREDIT_BALANCE_INSUFFICIENT", "PLAN_DAILY_CREDIT_LIMIT_REACHED", "PROVIDER_BUDGET_EXHAUSTED", "VOICE_OPERATIONAL_LIMIT_REACHED", "ADDON_CREDITS_INSUFFICIENT", "ADDON_COST_ALLOWANCE_INSUFFICIENT"].includes((error as { code?: string })?.code ?? "");

export async function reserveContinuousVoiceCredits(input: { userId: string; requestId: string; conversationId: string | null; creditsPerMinute: number }) {
  // Leave at least five seconds for provider creation in addition to a usable
  // initial window and the existing shutdown exposure. This adds no spend cap.
  const minimum = VOICE_CONVERSATION_INITIAL_SECONDS + VOICE_CONVERSATION_CLOSING_SECONDS + 5;
  const windows = [VOICE_CONVERSATION_RESERVATION_SECONDS, minimum + 5, minimum];
  for (let index = 0; ; index++) {
    const seconds = windows[index];
    try { return await reserveVoiceConversationCredits({ ...input, maxSeconds: seconds, sessionSeconds: seconds - VOICE_CONVERSATION_CLOSING_SECONDS, continuous: true }); }
    catch (error) { if (!isVoiceCapacityRefusal(error) || index === windows.length - 1) throw error; }
  }
}

function appendFunding(parts: VoiceFunding[], next: VoiceFunding): VoiceFunding[] {
  const last = parts.at(-1)!;
  const samePeriod = last.dayStart === next.dayStart && last.monthStart === next.monthStart && last.dayReserved === next.dayReserved && last.providerCostHold.dayStart === next.providerCostHold.dayStart && last.providerCostHold.monthStart === next.providerCostHold.monthStart && last.budgets.subject.periodStart === next.budgets.subject.periodStart && last.budgets.provider.bookings.every((booking, i) => booking.period === next.budgets.provider.bookings[i].period && booking.periodStart === next.budgets.provider.bookings[i].periodStart);
  if (!samePeriod) return [...parts, next];
  const entries = new Map<string, AddOnCreditReservationEntry>();
  for (const item of [...last.addOnEntries, ...next.addOnEntries]) {
    const previous = entries.get(item.lotId);
    entries.set(item.lotId, previous ? { ...previous, credits: previous.credits + item.credits, fundedCostMicroUsd: previous.fundedCostMicroUsd + item.fundedCostMicroUsd } : { ...item });
  }
  const seconds = next.endSeconds - next.startSeconds;
  return [...parts.slice(0, -1), { ...last, endSeconds: next.endSeconds, planCredits: last.planCredits + next.planCredits, addOnEntries: [...entries.values()],
    providerCostHold: { ...last.providerCostHold, amount: last.providerCostHold.amount + next.providerCostHold.amount },
    budgets: { subject: { ...last.budgets.subject, reservedSeconds: last.budgets.subject.reservedSeconds + seconds }, provider: { reservedSeconds: last.budgets.provider.reservedSeconds + seconds, bookings: last.budgets.provider.bookings.map(booking => ({ ...booking, seconds: booking.seconds + seconds })) } },
  }];
}

/** Account lock + row lock serialize funding with settlement and preserve concurrent task JSON writes. */
export async function extendVoiceConversationCredits(id: string, userId: string) {
  // Five-second quanta are exactly three credits at the approved rate. Even a
  // small renewal therefore funds purchased-credit cost allowance atomically;
  // no zero-credit delta can leave new provider exposure without its lot hold.
  const windows = [VOICE_CONVERSATION_RESERVATION_SECONDS - VOICE_CONVERSATION_CLOSING_SECONDS, 15, 5];
  for (let index = 0; ; index++) {
    const seconds = windows[index];
    try {
      return await prisma.$transaction(async tx => {
        await lockCreditAccount(tx, userId);
        await tx.$executeRaw`SELECT "id" FROM "ChatCreditReservation" WHERE "id" = ${id} AND "userId" = ${userId} FOR UPDATE`;
        const row = await tx.chatCreditReservation.findUniqueOrThrow({ where: { id } });
        const payload = readVoiceCreditPayload(row.reservationPayload); const now = new Date();
        if (row.userId !== userId || row.source !== VOICE_CONVERSATION_SOURCE || row.status !== "reserved" || row.lastError || !payload.funding || !(Date.parse(payload.closeAt ?? "") > now.getTime()) || !(Date.parse(payload.webLeaseUntil ?? "") > now.getTime()) || Date.parse(payload.recoveryLease?.until ?? "") > now.getTime()) throw new ApiSecurityError(409, "VOICE_SESSION_ENDED", "This voice session ended.");
        if (Date.parse(payload.closeAt!) - now.getTime() > 15_000) return { maxSeconds: payload.maxSeconds, closeAt: payload.closeAt! };
        const maxSeconds = payload.maxSeconds + seconds;
        if (!Number.isSafeInteger(maxSeconds)) throw new ApiSecurityError(409, "VOICE_SESSION_ENDED", "Voice duration is outside the supported accounting range.");
        const funding = await reserveFunding(tx, { userId, reservationId: id, creditsPerMinute: payload.creditsPerMinute }, payload.maxSeconds, maxSeconds, now);
        if (Date.parse(payload.closeAt!) <= Date.now()) throw new ApiSecurityError(409, "VOICE_SESSION_ENDED", "This voice session ended.");
        const closeAt = new Date(row.createdAt.getTime() + (maxSeconds - VOICE_CONVERSATION_CLOSING_SECONDS) * 1_000).toISOString();
        const changed = await tx.chatCreditReservation.updateMany({ where: { id, status: "reserved", lastError: null }, data: {
          reservationPayload: { ...payload, maxSeconds, closeAt, funding: appendFunding(payload.funding, funding) } as unknown as Prisma.InputJsonValue,
          reservedCredits: { increment: fundingPrice(payload.maxSeconds, maxSeconds, payload.creditsPerMinute).credits },
          reservedCostMicroUsd: { increment: BigInt(funding.providerCostHold.amount) }, planReservedCredits: { increment: funding.planCredits }, addOnReservedCredits: { increment: funding.addOnEntries.reduce((sum, entry) => sum + entry.credits, 0) },
          expiresAt: new Date(row.createdAt.getTime() + maxSeconds * 1_000 + 60_000),
        } });
        if (changed.count !== 1) throw new ApiSecurityError(409, "VOICE_SESSION_ENDED", "This voice session ended.");
        return { maxSeconds, closeAt };
      });
    } catch (error) { if (!isVoiceCapacityRefusal(error) || index === windows.length - 1) throw error; }
  }
}

async function settleFunding(tx: Prisma.TransactionClient, row: { id: string; userId: string | null; subjectKey: string }, payload: VoiceCreditPayload, seconds: number, initialized: boolean, evidence: "final" | "observed_minimum") {
  const billedSeconds = initialized ? Math.max(VOICE_CONVERSATION_INITIAL_SECONDS, seconds) : seconds;
  for (const part of payload.funding!) {
    const usedEnd = Math.max(part.startSeconds, Math.min(part.endSeconds, seconds));
    const providerEnd = Math.max(part.startSeconds, Math.min(part.endSeconds, billedSeconds));
    const price = fundingPrice(part.startSeconds, usedEnd, payload.creditsPerMinute);
    const actualCost = evidence === "observed_minimum" ? part.providerCostHold.amount : fundingPrice(part.startSeconds, providerEnd, payload.creditsPerMinute).costMicroUsd;
    const planCharged = Math.min(part.planCredits, price.credits); const refund = part.planCredits - planCharged;
    if (refund) for (const bucket of [...(part.dayReserved ? [{ period: "day", start: part.dayStart }] : []), { period: "month", start: part.monthStart }]) {
      await tx.$executeRaw`UPDATE "ChatUsageBucket" SET "count" = GREATEST(0, "count" - ${refund}), "updatedAt" = NOW() WHERE "key" = ${row.subjectKey} AND "period" = ${bucket.period} AND "periodStart" = ${new Date(bucket.start)}`;
    }
    const providerRefund = part.providerCostHold.amount - actualCost;
    if (providerRefund > 0) for (const window of [{ period: "provider-cost-day", start: part.providerCostHold.dayStart }, { period: "provider-cost-month", start: part.providerCostHold.monthStart }]) {
      await tx.$executeRaw`UPDATE "ChatUsageBucket" SET "count" = GREATEST(0, "count" - ${providerRefund}), "updatedAt" = NOW() WHERE "key" = ${providerBucketKey("openai")} AND "period" = ${window.period} AND "periodStart" = ${new Date(window.start)}`;
    }
    const addOnReserved = part.addOnEntries.reduce((sum, entry) => sum + entry.credits, 0);
    if (row.userId && part.addOnEntries.length) await settleAddOnCredits(tx, {
      userId: row.userId, reservationId: row.id, entries: part.addOnEntries, settledCredits: price.credits - planCharged,
      settledFundedCostMicroUsd: addOnReserved ? Math.ceil(part.addOnEntries.reduce((sum, entry) => sum + entry.fundedCostMicroUsd, 0) * (price.credits - planCharged) / addOnReserved) : 0, outcome: seconds > 0 ? "completed" : "empty",
    });
    if (actualCost > 0) await recordInternalProviderUsage({ client: tx, provider: "openai", modelId: VOICE_CONVERSATION_MODEL, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, estimatedCostMicroUsd: actualCost, uncachedInputCostMicroUsd: 0, cachedInputCostMicroUsd: 0, outputCostMicroUsd: actualCost, date: new Date(part.createdAt) });
    await settleVoiceBudgets({ reservation: restoreVoiceBudgets(part.budgets), client: tx, basis: evidence === "observed_minimum" ? { kind: "reservation" } : initialized ? { kind: "provider_seconds", seconds: providerEnd - part.startSeconds } : { kind: "not_billed" } });
  }
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
    if (payload.funding) await settleFunding(tx, row, payload, seconds, initialized, evidence);
    else {
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
    }
    // Transient delivery content must not outlive the voice session in a ledger row.
    const settledPayload = { ...payload } as Record<string, unknown>;
    if (Array.isArray(settledPayload.tasks)) settledPayload.tasks = settledPayload.tasks.map(task => {
      const saved = { ...task }; delete saved.answer; return saved;
    });
    await tx.chatCreditReservation.update({ where: { id }, data: {
      status: "settled", outcome: seconds > 0 ? "completed" : "empty", settledAt: new Date(),
      reservationPayload: settledPayload as Prisma.InputJsonValue,
      settledCredits: price.credits, settledCostMicroUsd: BigInt(price.costMicroUsd),
      providerUsageSnapshot: { seconds, source: "provider", confirmed: evidence === "final", settlementBasis: evidence,
        providerCostEstimated: evidence !== "final", providerStopped },
      lastError: !providerStopped ? "VOICE_PROVIDER_STOP_PENDING" : evidence === "final" ? null : "VOICE_USAGE_ADJUSTED_AFTER_DISCONNECT",
    } });
    return price;
  });
}
