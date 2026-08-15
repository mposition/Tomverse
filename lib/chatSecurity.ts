import "server-only";

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { usageBucketCount } from "@/lib/chatUsageBucketCount";
import { hashChatSubject, userChatUsageKey } from "@/lib/chatUsageKey";
import {
    AVAILABLE_MODELS,
    canUseModelWithPlan,
    getModelUsageProfile,
    getSettledUsageCredits,
    getWeightedUsageCredits,
    resolveModelRequestPricing,
    type AiModel,
    type ModelMinimumPlan,
    type ModelTier,
    type ModelUsageClass,
} from "@/lib/models";
import {
    getCostGuardrailLimits,
    getGuestCostGuardrailLimits,
    type CostGuardrailLimits,
} from "@/lib/chatCostGuardrails";
import {
    classifyProviderBudgetUtilisation,
    findAlternativeModelsForBlockedProvider,
    getProviderCostGuardrailLimits,
    type ProviderBudgetUtilisationLevel,
} from "@/lib/providerCostBudget";
import { PROVIDER_FALLBACKS } from "@/lib/providerFallbackCandidates";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import {
    CONCURRENT_RESERVATION_CONFLICT,
    CREDIT_BALANCE_INSUFFICIENT,
    OPERATIONAL_COST_GUARDRAIL_TRIGGERED,
    PLAN_ENTITLEMENT_EXHAUSTED,
    PROVIDER_BUDGET_EXHAUSTED,
} from "@/lib/chatCostSafetyCore";
import {
    estimateToolInputTokenOverhead,
    toReservedInputTokens,
    type TokenEstimateBreakdown,
} from "@/lib/chatTokenEstimate";
import {
    attemptSetProblems,
    combineAttemptUsage,
    type AttemptUsage,
} from "@/lib/chatMultiAttemptSettlement";
import {
    MAX_ATTEMPT_INDEX,
    PROVIDER_BUCKET_PREFIX,
    attemptCostIntentProblems,
    type AttemptCostIntent,
    PROVIDER_BUDGET_PERIODS,
    deriveProviderEntries,
    providerBucketKey,
    providerHoldProblems,
    withoutAttemptHolds,
    type AttemptHold,
} from "@/lib/chatProviderHolds";
import { resolveInputUsageSource } from "@/lib/tokenEstimateShadow";
import { recordShadowSettlement } from "@/lib/tokenEstimateShadowRecorder";
import {
    safeDailyResetAt,
    withFutureResetAt,
} from "@/lib/chatLimitDecisionCore";
import { recordChatLimitDecision } from "@/lib/chatLimitDecisions";
import { isWebSearchMode, type WebSearchMode } from "@/lib/appDefaults";
import { getAnonymousClientKey } from "@/lib/clientIp";
import {
    boundedProviderIdentifier,
    recordAttemptCost,
    rollupDayOf,
    type LedgerAttempt,
} from "@/lib/chatAttemptCostLedger";
import {
    AddOnCreditError,
    reserveAddOnCredits,
    settleAddOnCredits,
    type AddOnCreditReservationEntry,
} from "@/lib/creditLedger";
import { lockCreditAccount, offsetCreditDebt } from "@/lib/creditDebt";
import { calculateProviderUsageCost } from "@/lib/providerUsageCost";
import type { PerplexityUsageCostSnapshot } from "@/lib/perplexityUsageCore";
import { notifyProviderCreditIfNeeded } from "@/lib/providerMonitoring";
import { getUserDayWindow } from "@/lib/userDailyUsage";
import { getChatCreditAllocation } from "@/lib/chatCreditAllocation";
import {
    assertOperationalFeatureEnabled,
    OperationalFeatureDisabledError,
} from "@/lib/appSettings";
import {
    concurrencyRejectionDetails,
    concurrencyRejectionMessage,
    CONCURRENCY_RETRY_AFTER_SECONDS,
    IP_CONCURRENCY_EXCEEDED,
    SUBJECT_CONCURRENCY_EXCEEDED,
    resolveAdmissionTtlSeconds,
    resolveChatConcurrencyPlan,
    resolveLeaseTtlSeconds,
    type ChatConcurrencyPlan,
    type ChatConcurrencyScope,
} from "@/lib/chatConcurrencyCore";
import {
    admissionSlotFor,
    issueAdmissionToken,
    verifyAdmissionToken,
    type AdmissionSlot,
} from "@/lib/chatAdmissionCore";
import {
    CHAT_RATE_LIMITED,
    ipRateScope,
    rateLimitRejectionDetails,
    rateLimitRejectionMessage,
    resolveIpPerMinuteLimit,
    subjectRateScope,
    type ChatRateScope,
} from "@/lib/chatRateLimitCore";
import {
    claimAdmissionSlot,
    countActiveLeases,
    insertLeases,
    releaseChatRequestLease,
    releaseUnclaimedAdmission,
    sweepExpiredLeasesForScopes,
    touchChatRequestLease,
} from "@/lib/chatRequestLease";
import {
    enforceUserOperationalSecurity,
    UserOperationalRestrictionError,
} from "@/lib/userOperationalSecurity";

const GUEST_COOKIE_NAME = "tomverse_guest";
const GUEST_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const CHAT_REQUEST_LIMITS = {
    maxBodyBytes: 2 * 1024 * 1024,
    maxMessages: 100,
    maxMessageCharacters: 50_000,
    maxTotalCharacters: 300_000,
} as const;

export type AccessKind = "user" | "guest";
type Period = "minute" | "day" | "month";
type LimitRule = { period: Period; limit: number };
export type ChatAccess = {
    kind: AccessKind;
    subjectKey: string;
    ipKey: string;
    userId?: string;
    plan?: ModelTier;
    planLimits?: {
        dailyMessageLimit: number;
        monthlyMessageLimit: number;
    };
    setCookie?: string;
};

export type ChatBudget = {
    modelId: string;
    minimumPlan: ModelMinimumPlan;
    modelUsageClass: ModelUsageClass;
    usageCredits: number;
    inputTokens: number;
    /**
     * The output cap this application asks for, before it is fitted to the
     * room the context window has left (`lib/chatContextWindow.ts`). Not what
     * the request ends up sending.
     */
    maxOutputTokens: number;
    /** The provider's absolute settable ceiling, where verified. */
    providerMaxOutputTokens: number | null;
    reservedOutputTokens: number;
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
    cachedInputPriceMultiplier: number;
    provider: AiModel["provider"];
    /** Which entry of lib/modelPricing.ts produced the rates above. */
    pricingVersion: string;
    costSource: string;
    /** Prompt-size threshold that selected the applied price tier, if any. */
    longContextThresholdTokens: number | null;
};

type ReservationEntry = {
    key: string;
    period: string;
    periodStart: Date;
    amount: number;
    metric: "tokens" | "cost" | "credits" | "plan-credits" | "plan-cost" | "pro-response";
};

export type ChatUsageReservation = {
    reservationId: string;
    userId?: string;
    traceId: string;
    source: "chat" | "comparison_review";
    modelId: string;
    provider: AiModel["provider"];
    entries: ReservationEntry[];
    /**
     * Which attempt holds what against which provider budget.
     *
     * The source of truth for the `provider:` rows in `entries`, which are
     * derived from it -- see lib/chatProviderHolds.ts for why a provider hold
     * cannot be expressed by the entries alone once a turn can dispatch twice.
     * Absent on a reservation written before automatic fallback existed, and
     * on those the entries stand as they always did.
     */
    attemptHolds?: AttemptHold[];
    /**
     * What each attempt was authorized to spend, and at what rates.
     *
     * Written beside the hold, before the provider is called, because a sweep
     * that finds a crashed attempt half an hour later has no other way to know
     * what the call was allowed to cost -- and 0 would be a claim that a call
     * which happened used nothing.
     */
    attemptCostIntents?: AttemptCostIntent[];
    /**
     * The UTC day and month this turn's provider budget belongs to.
     *
     * Anchored once, when the reservation is created, and used by every later
     * write -- a fallback's hold, and the settlement of a provider the
     * reservation never held anything against. One logical response is charged
     * to one period even when it crosses UTC midnight.
     *
     * Stored even when nothing is held. The period is part of the
     * authorization, not something to reconstruct afterwards from whatever
     * happens to be at hand: a user's `day` bucket is anchored to their
     * account's own reckoning and can name a different day, and `createdAt` is
     * the database's clock rather than the one the reservation was computed
     * against.
     */
    providerBudgetPeriodStarts?: { day: Date; month: Date };
    usageCredits: number;
    inputTokens: number;
    maxOutputTokens: number;
    reservedOutputTokens: number;
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
    cachedInputPriceMultiplier: number;
    planReservedCredits: number;
    addOnReservedCredits: number;
    addOnReservations: AddOnCreditReservationEntry[];
    pricingVersion?: string;
    costSource?: string;
    longContextThresholdTokens?: number | null;
};

const durableReservationPayloadSchema = z
    .object({
        reservationId: z.string().min(1).max(100),
        userId: z.string().min(1).max(100).optional(),
        traceId: z.string().min(1).max(120),
        source: z.enum(["chat", "comparison_review"]),
        modelId: z.string().min(1).max(160),
        provider: z.string().min(1).max(80),
        entries: z.array(
            z
                .object({
                    key: z.string().min(1).max(240),
                    period: z.string().min(1).max(80),
                    periodStart: z.iso.datetime(),
                    amount: z.number().int().nonnegative(),
                    metric: z.enum([
                        "tokens",
                        "cost",
                        "credits",
                        "plan-credits",
                        "plan-cost",
                        "pro-response",
                    ]),
                })
                .strict()
        ).max(40),
        attemptHolds: z
            .array(
                z
                    .object({
                        attemptIndex: z.number().int().min(0).max(MAX_ATTEMPT_INDEX),
                        key: z.string().min(1).max(240),
                        period: z.string().min(1).max(80),
                        periodStart: z.iso.datetime(),
                        amount: z.number().int().nonnegative(),
                    })
                    .strict()
            )
            .max(8)
            .optional(),
        providerBudgetPeriodStarts: z
            .object({
                day: z.coerce.date(),
                month: z.coerce.date(),
            })
            .strict()
            .optional(),
        attemptCostIntents: z
            .array(
                z
                    .object({
                        attemptIndex: z.number().int().min(0).max(MAX_ATTEMPT_INDEX),
                        modelId: z.string().min(1).max(160),
                        provider: z.string().min(1).max(80),
                        estimatedInputTokens: z.number().int().nonnegative(),
                        reservedOutputTokens: z.number().int().nonnegative(),
                        inputUsdPerMillionTokens: z.number().nonnegative(),
                        outputUsdPerMillionTokens: z.number().nonnegative(),
                        cachedInputPriceMultiplier: z.number().min(0).max(1),
                        pricingVersion: z.string().min(1).max(120).nullable().optional(),
                        reservedCostMicroUsd: z.number().int().nonnegative(),
                    })
                    .strict()
            )
            .max(4)
            .optional(),
        usageCredits: z.number().int().positive(),
        inputTokens: z.number().int().nonnegative(),
        maxOutputTokens: z.number().int().nonnegative(),
        reservedOutputTokens: z.number().int().nonnegative().optional(),
        inputUsdPerMillionTokens: z.number().nonnegative(),
        outputUsdPerMillionTokens: z.number().nonnegative(),
        cachedInputPriceMultiplier: z.number().min(0).max(1).default(1),
        // Optional so a reservation written before the pricing registry landed
        // still deserializes and settles at the rates it was reserved with.
        pricingVersion: z.string().min(1).max(120).optional(),
        costSource: z.string().min(1).max(60).optional(),
        longContextThresholdTokens: z.number().int().nonnegative().nullable().optional(),
        planReservedCredits: z.number().int().nonnegative(),
        addOnReservedCredits: z.number().int().nonnegative(),
        addOnReservations: z.array(
            z
                .object({
                    lotId: z.string().min(1).max(100),
                    purchaseId: z.string().min(1).max(100).nullable(),
                    credits: z.number().int().nonnegative(),
                    fundedCostMicroUsd: z.number().int().nonnegative(),
                })
                .strict()
        ).max(40),
    })
    .strict();

/**
 * The payload as it is stored, with the provider entries rebuilt from the
 * holds.
 *
 * Rebuilt rather than trusted: `attemptHolds` is the source of truth, and a
 * caller that changed one without the other would otherwise persist the
 * disagreement. Deriving on the way out means the only way to change a
 * provider entry is to change the hold that produced it.
 *
 * A reservation with no holds -- everything written before automatic fallback
 * existed -- keeps its entries exactly as they are.
 */
const serializeReservation = (
    reservation: ChatUsageReservation
): Prisma.InputJsonValue => {
    const { userId, attemptHolds, ...rest } = reservation;
    const entries = attemptHolds
        ? [
              ...reservation.entries.filter(
                  (entry) => !entry.key.startsWith(PROVIDER_BUCKET_PREFIX)
              ),
              ...deriveProviderEntries(attemptHolds),
          ]
        : reservation.entries;
    return {
        ...rest,
        entries: entries.map((entry) => ({
            ...entry,
            periodStart: entry.periodStart.toISOString(),
        })),
        ...(attemptHolds
            ? {
                  attemptHolds: attemptHolds.map((hold) => ({
                      ...hold,
                      periodStart: hold.periodStart.toISOString(),
                  })),
              }
            : {}),
        ...(userId ? { userId } : {}),
    };
};

export const deserializeReservation = (payload: Prisma.JsonValue) => {
    const parsed = durableReservationPayloadSchema.parse(payload);
    const entries = parsed.entries.map((entry) => ({
        ...entry,
        periodStart: new Date(entry.periodStart),
    }));
    const attemptHolds = parsed.attemptHolds?.map((hold) => ({
        ...hold,
        periodStart: new Date(hold.periodStart),
    }));
    if (attemptHolds) {
        // Checked on every read, not only on write. Two fields of one object
        // commit together and can still be written disagreeing with each
        // other, and every disagreement here is money moving without
        // authorization: an entry above its holds releases budget nobody
        // reserved, one below leaves a provider holding money for a call that
        // finished long ago.
        const problems = [
            ...providerHoldProblems({ holds: attemptHolds, entries }),
            ...attemptCostIntentProblems({
                holds: attemptHolds,
                intents: parsed.attemptCostIntents ?? [],
                periodStarts: parsed.providerBudgetPeriodStarts,
            }),
        ];
        if (problems.length > 0) {
            throw new Error(
                `Chat reservation provider holds are inconsistent: ${problems.join(" ")}`
            );
        }
    }
    // `attemptHolds` is dropped from the spread and reattached with real
    // dates: leaving the parsed one in would union a string-dated shape into
    // the type and every caller would have to narrow it.
    const rest = { ...parsed, attemptHolds: undefined };
    delete (rest as { attemptHolds?: unknown }).attemptHolds;
    return {
        ...rest,
        reservedOutputTokens:
            parsed.reservedOutputTokens ?? parsed.maxOutputTokens,
        provider: parsed.provider as AiModel["provider"],
        entries,
        ...(attemptHolds ? { attemptHolds } : {}),
    } satisfies ChatUsageReservation;
};

export type ChatErrorDetails = Record<string, number | string | string[]>;

export class ChatAccessError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
        public readonly retryAfter?: number,
        // `string[]` carries a list of model IDs (the way out of a blocked
        // provider). Never a cost: everything numeric here is either already
        // public or prefixed `internal` and stripped before the client sees it.
        public readonly details?: ChatErrorDetails
    ) {
        super(message);
    }
}

/**
 * Whether a thrown value is one of this module's own refusals.
 *
 * Exported as a predicate rather than left to `instanceof` at the call site
 * because `instanceof` compares class identity, and class identity is a
 * property of the module *instance*: a bundler or a test harness that
 * evaluates this file twice produces two `ChatAccessError` classes, and a
 * refusal raised by one is not an instance of the other. Asking the module
 * that owns the class means the comparison always happens against the copy
 * that raised the error.
 *
 * That distinction is load-bearing wherever getting it wrong is silent.
 * `chatErrorResponse` below can use `instanceof` directly -- it lives in this
 * file -- but a caller in another module that mistakes a local refusal for a
 * provider failure writes bad data into provider health and says nothing.
 */
export const isChatAccessError = (error: unknown): error is ChatAccessError =>
    error instanceof ChatAccessError;

/**
 * Refuses an account an administrator has put out of bounds: suspended,
 * already scheduled for deletion, or restricted from AI usage specifically.
 *
 * The check itself lives in lib/userOperationalSecurity.ts, which cannot raise
 * a `ChatAccessError` without importing this module back. Every paid AI entry
 * point should call *this*, so that a suspended account is refused the same way
 * and with the same code wherever it asks -- chat, a model comparison, an image
 * generation, a memory extraction. Enforced in the service rather than the
 * route: a second caller of the service is exactly how a gate written once
 * stops covering everything.
 *
 * The expiry half matters as much as the refusal: a suspension or restriction
 * whose end date has passed is cleared here, so a fixed-term penalty ends on
 * its own rather than waiting for an administrator to remember.
 */
export const assertUserOperationalAccess = async (userId: string) => {
    try {
        await enforceUserOperationalSecurity(userId);
    } catch (error) {
        if (error instanceof UserOperationalRestrictionError) {
            throw new ChatAccessError(403, error.code, error.message);
        }
        throw error;
    }
};

const positiveInteger = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const planCreditEntitlement = (
    plan: ModelTier,
    planLimits?: ChatAccess["planLimits"]
) => ({
    dailyCreditLimit:
        planLimits?.dailyMessageLimit ??
        (plan === "Max"
            ? 0
            : plan === "Pro"
              ? positiveInteger(process.env.CHAT_PRO_PER_DAY, 300)
              : positiveInteger(process.env.CHAT_FREE_PER_DAY, 30)),
    monthlyCreditLimit:
        planLimits?.monthlyMessageLimit ??
        (plan === "Max"
            ? positiveInteger(process.env.CHAT_MAX_PER_MONTH, 10_000)
            : plan === "Pro"
              ? positiveInteger(
                    process.env.CHAT_PRO_PER_MONTH,
                    positiveInteger(process.env.CHAT_USER_PER_MONTH, 3_000)
                )
              : positiveInteger(process.env.CHAT_FREE_PER_MONTH, 300)),
});

/**
 * Operational cost guardrails for a plan.
 *
 * This is NOT the user's entitlement -- that is plan credits plus purchased
 * credits, enforced by the credit ledger. These limits exist only to stop
 * abnormal spend (a mispriced model, a provider incident, an abusive account)
 * and are derived from the plan's own credit grant so they cannot bind before
 * the credits themselves do. See lib/chatCostGuardrails.ts for the derivation.
 */
export const getChatCostGuardrails = (
    plan: ModelTier,
    planLimits?: ChatAccess["planLimits"]
): CostGuardrailLimits =>
    getCostGuardrailLimits(plan, planCreditEntitlement(plan, planLimits));

export const assertModelAccess = (access: Pick<ChatAccess, "kind" | "plan">, model: AiModel) => {
    const currentPlan = access.kind === "guest" ? "Guest" : access.plan || "Free";
    if (!canUseModelWithPlan(currentPlan, model)) {
        const usageClass = getModelUsageProfile(model).category;
        throw new ChatAccessError(
            403,
            "MODEL_ACCESS_FORBIDDEN",
            currentPlan === "Guest"
                ? `Sign in to use this ${usageClass} model.`
                : `This ${usageClass} model requires the ${model.minimumPlan} plan or higher.`,
            undefined,
            {
                currentPlan,
                minimumPlan: model.minimumPlan,
                usageClass,
            }
        );
    }
};

const microdollarsFor = (tokens: number, usdPerMillionTokens: number) =>
    Math.ceil(tokens * usdPerMillionTokens);

export const getChatBudgetReservedTokens = (budget: ChatBudget) =>
    budget.inputTokens + budget.reservedOutputTokens;

export const getChatBudgetReservedCostMicroUsd = (budget: ChatBudget) =>
    microdollarsFor(
        budget.inputTokens,
        budget.inputUsdPerMillionTokens
    ) +
    microdollarsFor(
        budget.reservedOutputTokens,
        budget.outputUsdPerMillionTokens
    );

export const createChatBudget = (
    kind: AccessKind,
    model: AiModel,
    /**
     * The turn's raw input estimate. Prefer a breakdown, built with
     * `createTokenEstimateAccumulator`: it carries the segment mix, and the
     * reservation margins are per segment, so a bare total leaves
     * `toReservedInputTokens` nothing to widen accurately and it has to fall
     * back to the largest margin any segment carries.
     */
    estimatedInput: number | TokenEstimateBreakdown,
    options?: {
        webSearchSurchargeCredits?: number;
        /**
         * Whether a provider-native search tool will be attached. A searching
         * turn feeds retrieved result text back into the prompt, so its real
         * input is materially larger than the conversation alone -- reserving
         * without it is what made searching requests settle above reservation.
         */
        nativeSearchEnabled?: boolean;
    }
): ChatBudget => {
    const maxInputTokens =
        kind === "guest"
            ? positiveInteger(process.env.CHAT_GUEST_MAX_INPUT_TOKENS, 16_000)
            : positiveInteger(process.env.CHAT_USER_MAX_INPUT_TOKENS, 128_000);

    // The limit is checked against the raw estimate, deliberately: it bounds
    // the conversation the user sent, not the margin and tool overhead the
    // reservation adds on top. Charging someone a rejection for overhead they
    // did not write would move the limit without anyone changing it.
    const estimatedInputTokens =
        typeof estimatedInput === "number"
            ? estimatedInput
            : estimatedInput.rawTotal;

    if (
        !Number.isSafeInteger(estimatedInputTokens) ||
        estimatedInputTokens <= 0 ||
        estimatedInputTokens > maxInputTokens
    ) {
        throw new ChatAccessError(
            413,
            "CHAT_INPUT_TOKEN_LIMIT",
            "Chat context exceeds the allowed token budget."
        );
    }

    // Credits are weighted by the conversation the user actually sent, so tool
    // overhead never inflates what they are charged -- it only widens the
    // internal cost reservation, which is refunded down at settlement.
    //
    // Computed by `toReservedInputTokens` rather than by adding the overhead
    // here, because that function is where the active estimator calibration's
    // safety multiplier and framing overhead live. Under
    // `generic_multilingual_v1` both are the identity and this is exactly what
    // the hand-written sum produced; under a calibration that is not, a
    // reservation that skipped them would be short by the margin the
    // calibration exists to provide, and the reason would be that this one
    // caller did its own arithmetic.
    const reservedInputTokens = Math.min(
        maxInputTokens,
        toReservedInputTokens(estimatedInput, {
            toolOverheadTokens: estimateToolInputTokenOverhead({
                nativeSearchEnabled: options?.nativeSearchEnabled === true,
            }),
        })
    );
    const pricing = resolveModelRequestPricing(model, {
        estimatedPromptTokens: reservedInputTokens,
    });

    return {
        modelId: model.id,
        minimumPlan: model.minimumPlan,
        modelUsageClass: model.usageClass,
        usageCredits:
            getWeightedUsageCredits(model, estimatedInputTokens) +
            (options?.webSearchSurchargeCredits || 0),
        inputTokens: reservedInputTokens,
        maxOutputTokens: pricing.maxOutputTokens,
        providerMaxOutputTokens: pricing.providerMaxOutputTokens,
        reservedOutputTokens: pricing.reservationOutputTokens,
        inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: pricing.outputUsdPerMillionTokens,
        cachedInputPriceMultiplier: pricing.cachedInputPriceMultiplier,
        provider: model.provider,
        pricingVersion: pricing.pricingVersion,
        costSource: pricing.costSource,
        longContextThresholdTokens: pricing.longContextThresholdTokens,
    };
};

const decisionModelsFromBudgets = (budgets: readonly ChatBudget[]) =>
    budgets.map((budget) => ({
        modelId: budget.modelId,
        provider: budget.provider,
        estimatedInputTokens: budget.inputTokens,
        estimatedOutputTokens: budget.reservedOutputTokens,
        estimatedCostMicroUsd: getChatBudgetReservedCostMicroUsd(budget),
        inputUsdPerMillionTokens: budget.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: budget.outputUsdPerMillionTokens,
        pricingVersion: budget.pricingVersion,
        costSource: budget.costSource,
        longContextThresholdTokens: budget.longContextThresholdTokens,
    }));

const numericDetail = (details: ChatErrorDetails | undefined, key: string) => {
    const value = details?.[key];
    return typeof value === "number" ? value : null;
};

const textDetail = (details: ChatErrorDetails | undefined, key: string) => {
    const value = details?.[key];
    return typeof value === "string" ? value : null;
};

/**
 * Allowed decisions are only persisted when explicitly enabled: every chat turn
 * would otherwise write a row. Rejections are always persisted, because a
 * blocked user with a Trace ID is exactly who support needs to answer.
 */
const shouldRecordAllowedDecisions = () =>
    process.env.CHAT_LIMIT_DECISION_LOG_ALLOWED === "1";

const limitsFor = (access: Pick<ChatAccess, "kind" | "plan" | "planLimits">): LimitRule[] => {
    if (access.kind !== "user") {
        return [
            { period: "minute", limit: positiveInteger(process.env.CHAT_GUEST_PER_MINUTE, 5) },
            { period: "day", limit: positiveInteger(process.env.CHAT_GUEST_PER_DAY, 20) },
            { period: "month", limit: positiveInteger(process.env.CHAT_GUEST_PER_MONTH, 100) },
        ];
    }

    const plan = access.plan || "Free";
    const minuteLimit = positiveInteger(process.env.CHAT_USER_PER_MINUTE, 20);
    const monthLimit =
        access.planLimits?.monthlyMessageLimit ??
        (plan === "Max"
            ? positiveInteger(process.env.CHAT_MAX_PER_MONTH, 10_000)
            : plan === "Pro"
              ? positiveInteger(
                    process.env.CHAT_PRO_PER_MONTH,
                    positiveInteger(process.env.CHAT_USER_PER_MONTH, 3_000)
                )
              : positiveInteger(process.env.CHAT_FREE_PER_MONTH, 300));
    const limits: LimitRule[] = [{ period: "minute", limit: minuteLimit }];
    if (monthLimit > 0) {
        limits.push({ period: "month", limit: monthLimit });
    }

    const dayLimit =
        access.planLimits?.dailyMessageLimit ??
        (plan === "Max"
            ? 0
            : plan === "Pro"
              ? positiveInteger(process.env.CHAT_PRO_PER_DAY, 300)
              : positiveInteger(process.env.CHAT_FREE_PER_DAY, 30));

    if (dayLimit > 0) {
        limits.push({
            period: "day",
            limit: dayLimit,
        });
    }

    return limits;
};

const getSecret = () => {
    const secret = process.env.NEXTAUTH_SECRET;
    if (!secret) {
        throw new ChatAccessError(
            503,
            "SECURITY_NOT_CONFIGURED",
            "Chat security is not configured."
        );
    }
    return secret;
};

const signGuestId = (guestId: string) =>
    createHmac("sha256", getSecret()).update(guestId).digest("base64url");

const parseCookies = (header: string | null) =>
    new Map(
        (header || "")
            .split(";")
            .map((part) => part.trim())
            .filter(Boolean)
            .map((part) => {
                const separator = part.indexOf("=");
                return separator === -1
                    ? [part, ""]
                    : [part.slice(0, separator), part.slice(separator + 1)];
            })
    );

const readGuestId = (request: Request) => {
    const token = parseCookies(request.headers.get("cookie")).get(GUEST_COOKIE_NAME);
    if (!token) return null;

    const separator = token.lastIndexOf(".");
    if (separator === -1) return null;

    const guestId = token.slice(0, separator);
    const signature = token.slice(separator + 1);
    if (!/^[0-9a-f-]{36}$/i.test(guestId)) return null;

    const expected = signGuestId(guestId);
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (
        actualBuffer.length !== expectedBuffer.length ||
        !timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
        return null;
    }
    return guestId;
};

const createGuestCookie = (guestId: string) => {
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    return `${GUEST_COOKIE_NAME}=${guestId}.${signGuestId(guestId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${GUEST_COOKIE_MAX_AGE}${secure}`;
};

const hashKey = (scope: string, value: string) =>
    hashChatSubject(scope, value, getSecret());

export const getUserChatUsageKey = (userId: string) =>
    userChatUsageKey(userId, getSecret());

export const identifyChatCaller = (
    request: Request,
    userId?: string | null,
    plan?: ModelTier,
    planLimits?: ChatAccess["planLimits"]
): ChatAccess => {
    const ipKey = `ip:${hashKey("ip", getAnonymousClientKey(request))}`;
    if (userId) {
        return {
            kind: "user",
            subjectKey: `user:${hashKey("user", userId)}`,
            ipKey,
            userId,
            plan,
            planLimits,
        };
    }

    const existingGuestId = readGuestId(request);
    const guestId = existingGuestId || randomUUID();
    return {
        kind: "guest",
        subjectKey: `guest:${hashKey("guest", guestId)}`,
        ipKey,
        setCookie: existingGuestId ? undefined : createGuestCookie(guestId),
    };
};

// Server-authoritative guest usage snapshot: reads the exact same
// ChatUsageBucket day-period row that acquireChatAccess enforces, keyed by
// the same signed guest cookie, instead of a client-only counter that can
// drift arbitrarily from what the server actually allows.
export const getGuestUsageSnapshot = async (request: Request) => {
    const access = identifyChatCaller(request, null);
    const now = new Date();
    const dayStart = periodStart("day", now);
    const monthStart = periodStart("month", now);
    const rules = limitsFor(access);
    const dayLimit = rules.find((rule) => rule.period === "day")?.limit ?? 0;
    const monthLimit = rules.find((rule) => rule.period === "month")?.limit ?? 0;
    const [dayBucket, monthBucket] = await Promise.all([
        prisma.chatUsageBucket.findUnique({
            where: {
                key_period_periodStart: {
                    key: access.subjectKey,
                    period: "day",
                    periodStart: dayStart,
                },
            },
            select: { count: true },
        }),
        prisma.chatUsageBucket.findUnique({
            where: {
                key_period_periodStart: {
                    key: access.subjectKey,
                    period: "month",
                    periodStart: monthStart,
                },
            },
            select: { count: true },
        }),
    ]);
    const used = usageBucketCount(dayBucket?.count);
    const monthUsed = usageBucketCount(monthBucket?.count);
    const dayRemaining = Math.max(0, dayLimit - used);
    const monthRemaining = Math.max(0, monthLimit - monthUsed);
    return {
        // Server-side only: the caller's hashed usage subject, so a route can
        // read this guest's other feature buckets without re-deriving the
        // identity. Never included in an API response.
        subjectKey: access.subjectKey,
        used,
        limit: dayLimit,
        remaining: dayRemaining,
        monthUsed,
        monthLimit,
        monthRemaining,
        // These buckets are incremented by a request's *credit* weight, not by
        // one per message, so the smaller of the two remainders is exactly
        // what a guest can still afford to spend right now. Surfacing it lets
        // the comparison rail tell "you have run out of credits" apart from
        // "you have used your monthly AI Review trial" -- two different
        // blocks with two different ways out.
        creditsAvailable: Math.min(dayRemaining, monthRemaining),
        resetsAt: new Date(dayStart.getTime() + 86_400_000).toISOString(),
        setCookie: access.setCookie,
    };
};

const periodStart = (period: Period, now: Date) => {
    if (period === "minute") {
        return new Date(
            Date.UTC(
                now.getUTCFullYear(),
                now.getUTCMonth(),
                now.getUTCDate(),
                now.getUTCHours(),
                now.getUTCMinutes()
            )
        );
    }
    if (period === "day") {
        return new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
        );
    }
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
};

const retryAfterFor = (period: Period, now: Date, dailyEnd?: Date) => {
    let end: Date;
    if (period === "minute") {
        end = new Date(periodStart(period, now).getTime() + 60_000);
    } else if (period === "day") {
        end = dailyEnd || new Date(periodStart(period, now).getTime() + 86_400_000);
    } else {
        end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    }
    return Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 1000));
};

const monthlyResetAt = (now: Date) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

const incrementUsage = async (
    tx: Prisma.TransactionClient,
    key: string,
    period: string,
    start: Date,
    limit: number,
    amount = 1
) => {
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > limit) {
        return false;
    }
    const rows = await tx.$queryRaw<Array<{ count: number }>>`
        INSERT INTO "ChatUsageBucket" ("key", "period", "periodStart", "count", "updatedAt")
        VALUES (${key}, ${period}, ${start}, ${amount}, NOW())
        ON CONFLICT ("key", "period", "periodStart")
        DO UPDATE SET
            "count" = "ChatUsageBucket"."count" + ${amount},
            "updatedAt" = NOW()
        WHERE "ChatUsageBucket"."count" <= ${limit - amount}
        RETURNING "count"
    `;
    return rows.length > 0;
};

// A separate, feature-scoped guest cap (independent of the general
// day/month chat-message quota from limitsFor/acquireChatAccess): guests
// get exactly one Quick Difference Summary per day. Uses its own "period"
// string on the same ChatUsageBucket table/subjectKey so it can't collide
// with or be confused for the chat-message "day" bucket.
export async function assertGuestQuickSummaryDailyLimit(
    access: Pick<ChatAccess, "kind" | "subjectKey">
) {
    if (access.kind !== "guest") return;
    const allowed = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"guest-quick-summary:" + access.subjectKey}))`;
        return incrementUsage(
            tx,
            access.subjectKey,
            "guest-quick-summary-day",
            periodStart("day", new Date()),
            positiveInteger(process.env.CHAT_GUEST_QUICK_SUMMARY_PER_DAY, 1),
            1
        );
    });
    if (!allowed) {
        throw new ChatAccessError(
            429,
            "GUEST_QUICK_SUMMARY_LIMIT_REACHED",
            "Guests can use quick difference summary once per day."
        );
    }
}

/**
 * Models a user blocked by `provider`'s budget can still reach. Model IDs only:
 * this goes into a client response, so it names the way out without naming any
 * cost.
 */
const alternativeModelsForProvider = (provider: string) =>
    findAlternativeModelsForBlockedProvider({
        blockedProvider: provider,
        candidateModelIds:
            PROVIDER_FALLBACKS[provider as keyof typeof PROVIDER_FALLBACKS]
                ?.recommendedModelIds ?? [],
        models: AVAILABLE_MODELS,
    });

/**
 * Reports a provider budget approaching its limit, before it refuses anything.
 *
 * Deliberately not awaited: this runs inside the reservation transaction, and
 * an alert delivery must never hold a database transaction open or fail a
 * request that the budget itself allowed. `reportOperationalIncident` already
 * logs synchronously and rate-limits by code, so the un-awaited call is a
 * notification, not the record.
 *
 * `notice` (70%) is logged only. Paging on the first threshold of a limit
 * nobody is near yet teaches operators to ignore the ones that matter.
 */
const reportProviderBudgetUtilisation = ({
    provider,
    scope,
    level,
    ratio,
    usedMicroUsd,
    requiredMicroUsd,
    limitMicroUsd,
}: {
    provider: string;
    scope: string;
    level: ProviderBudgetUtilisationLevel;
    ratio: number;
    usedMicroUsd: number;
    requiredMicroUsd: number;
    limitMicroUsd: number;
}) => {
    const percent = Math.round(ratio * 100);
    console.warn(
        JSON.stringify({
            event: "provider_budget_utilisation",
            provider,
            scope,
            level,
            percent,
            usedMicroUsd,
            requiredMicroUsd,
            limitMicroUsd,
            timestamp: new Date().toISOString(),
        })
    );
    if (level === "notice") return;
    void reportOperationalIncident({
        code: `PROVIDER_BUDGET_${level.toUpperCase()}_${scope.toUpperCase()}_${provider.toUpperCase()}`,
        title: `${provider} spend budget at ${percent}% (${scope})`,
        error: `${provider} would reach ${percent}% of its ${scope} budget with the request in hand.`,
        severity: level === "exhausted" ? "error" : "warning",
        context: {
            component: "chat-security",
            provider,
            scope,
            percent,
            usedMicroUsd,
            requiredMicroUsd,
            limitMicroUsd,
        },
    }).catch(() => undefined);
};

const readUsageCount = async (
    tx: Prisma.TransactionClient,
    key: string,
    period: string,
    start: Date
) => {
    const bucket = await tx.chatUsageBucket.findUnique({
        where: {
            key_period_periodStart: {
                key,
                period,
                periodStart: start,
            },
        },
        select: { count: true },
    });
    return usageBucketCount(bucket?.count);
};

/* ------------------------------------------------------------------------- */
/* Concurrency admission                                                     */
/* ------------------------------------------------------------------------- */

const concurrencyError = (
    scope: ChatConcurrencyScope,
    activeRequests: number,
    requestedSlots: number
) =>
    new ChatAccessError(
        429,
        scope.errorCode,
        concurrencyRejectionMessage(scope.scope),
        CONCURRENCY_RETRY_AFTER_SECONDS,
        concurrencyRejectionDetails(scope, activeRequests, requestedSlots)
    );

/**
 * Checks every concurrency scope that applies to this caller.
 *
 * The subject scope is the caller's own allowance -- their account, or their
 * signed guest cookie. The IP scope, when present, is the far higher anonymous
 * abuse ceiling. They are separate limits with separate codes: a guest blocked
 * by their own running answer and a guest blocked by a hostile neighbour on the
 * same NAT are not the same event and must not read, log or resolve the same
 * way.
 */
const assertConcurrencyCapacity = async (
    tx: Prisma.TransactionClient,
    plan: ChatConcurrencyPlan,
    requestedSlots: number
) => {
    for (const scope of [plan.subject, plan.ip]) {
        if (!scope) continue;
        const active = await countActiveLeases(tx, scope);
        if (active + requestedSlots > scope.limit) {
            throw concurrencyError(scope, active, requestedSlots);
        }
    }
};

/**
 * Locks every scope this caller is counted in, in a stable order.
 *
 * Two locks, always subject-then-IP, so two guests behind one NAT can never
 * deadlock against each other by taking them in opposite orders.
 */
const lockConcurrencyScopes = async (
    tx: Prisma.TransactionClient,
    plan: ChatConcurrencyPlan
) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`chat-lease:${plan.subject.key}`}))`;
    if (plan.ip) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`chat-lease:${plan.ip.key}`}))`;
    }
};

type ReservedAdmission = {
    admissionId: string;
    slots: AdmissionSlot[];
    expiresAt: Date;
};

/**
 * Takes the whole comparison's per-minute request capacity in one go.
 *
 * A three-model comparison is three `POST /api/chat` requests, and each of
 * those spends one unit of the caller's per-minute allowance and one of the
 * IP's. Reading the counter here and letting the model requests increment it
 * later is what produced the report this exists to fix: with a guest limit of
 * five and three units already spent, the read passed, two panels incremented
 * successfully, and the third came back 429 -- a comparison admitted in part.
 *
 * So the capacity is *reserved*, not inspected. `incrementUsage` is a single
 * conditional UPDATE that adds the whole model count or adds nothing, which
 * makes another tab arriving between this line and the model requests unable
 * to take a unit this comparison is already holding. Both increments run
 * inside the caller's transaction, so a rejection anywhere below -- including
 * the IP scope refusing after the subject scope was charged -- unwinds them.
 *
 * Each model request then claims its slot and skips its own increment, so
 * nothing is counted twice.
 */
const reserveComparisonRateCapacity = async (
    tx: Prisma.TransactionClient,
    access: ChatAccess,
    requestedRequests: number,
    now: Date
) => {
    const minuteStart = periodStart("minute", now);
    const resetAt = new Date(minuteStart.getTime() + 60_000);
    const retryAfterSeconds = retryAfterFor("minute", now);
    const subjectLimit = limitsFor(access).find(
        (rule) => rule.period === "minute"
    )?.limit;

    const refuse = async (scope: ChatRateScope): Promise<never> => {
        const used = await readUsageCount(tx, scope.key, "minute", minuteStart);
        throw new ChatAccessError(
            429,
            CHAT_RATE_LIMITED,
            rateLimitRejectionMessage(scope.scope),
            retryAfterSeconds,
            rateLimitRejectionDetails(scope, {
                usedRequests: used,
                requestedRequests,
                retryAfterSeconds,
                resetAt,
            })
        );
    };

    const scopes: ChatRateScope[] = [];
    if (subjectLimit !== undefined) {
        scopes.push(
            subjectRateScope(access.kind, access.subjectKey, subjectLimit)
        );
    }
    // The aggregate ceiling applies to signed-in callers as well as guests:
    // it is the protection that a fresh cookie -- or a fresh account -- cannot
    // walk away from, and `acquireChatAccess` has always charged it per
    // request. Checking it only for guests here would let a comparison pass
    // preflight and then lose a panel to it.
    scopes.push(ipRateScope(access.ipKey, resolveIpPerMinuteLimit()));

    for (const scope of scopes) {
        const allowed = await incrementUsage(
            tx,
            scope.key,
            "minute",
            minuteStart,
            scope.limit,
            requestedRequests
        );
        if (!allowed) await refuse(scope);
    }

    return { minuteStart };
};

/**
 * Reserves one concurrency slot per model for a comparison, all or nothing.
 *
 * Runs inside the caller's transaction and under the scope locks, so either
 * every model in the comparison has a slot when this returns or none does and
 * the transaction unwinds. That is the whole point: a comparison that is
 * admitted for two of three models is a worse outcome than one that is refused
 * outright, because the user pays for the two that ran.
 */
const reserveComparisonAdmission = async (
    tx: Prisma.TransactionClient,
    access: ChatAccess,
    modelIds: string[],
    now: Date
): Promise<ReservedAdmission> => {
    const plan = resolveChatConcurrencyPlan(access);
    await lockConcurrencyScopes(tx, plan);
    await sweepExpiredLeasesForScopes(tx, {
        subjectKey: plan.subject.key,
        ipKey: plan.ip?.key ?? null,
    });
    await assertConcurrencyCapacity(tx, plan, modelIds.length);
    // Two different questions, asked in the order the caller can act on:
    // "is one of your own answers still running" comes before "are you sending
    // faster than your allowance", because the first has a visible cause on
    // screen. Both are all-or-nothing for the whole comparison.
    const { minuteStart } = await reserveComparisonRateCapacity(
        tx,
        access,
        modelIds.length,
        now
    );

    const admissionId = randomUUID();
    const expiresAt = new Date(
        now.getTime() + resolveAdmissionTtlSeconds() * 1000
    );
    const slots = modelIds.map((modelId) => ({
        leaseId: randomUUID(),
        modelId,
    }));
    await insertLeases(
        tx,
        slots.map((slot) => ({
            id: slot.leaseId,
            subjectKey: plan.subject.key,
            ipKey: plan.ip?.key ?? null,
            modelId: slot.modelId,
            admissionId,
            claimedAt: null,
            expiresAt,
            // What this slot pre-paid, so an unused one can hand it back.
            rateIpKey: access.ipKey,
            rateMinuteStart: minuteStart,
        }))
    );
    return { admissionId, slots, expiresAt };
};

export type ChatAdmissionGrant = {
    token: string;
    admissionId: string;
    expiresAt: string;
};

const buildAdmissionGrant = (
    access: ChatAccess,
    comparisonId: string,
    reserved: ReservedAdmission
): ChatAdmissionGrant => ({
    token: issueAdmissionToken(
        {
            version: 1,
            admissionId: reserved.admissionId,
            subjectKey: access.subjectKey,
            comparisonId,
            slots: reserved.slots,
            expiresAtMs: reserved.expiresAt.getTime(),
        },
        getSecret()
    ),
    admissionId: reserved.admissionId,
    expiresAt: reserved.expiresAt.toISOString(),
});

/**
 * Structured record of a concurrency refusal.
 *
 * Separate from the credit/cost decision log because it is a different layer,
 * and the fields that matter here (which scope, how full it was, how many slots
 * the action wanted) do not exist there. Everything identifying is already
 * hashed -- `subjectKey` and `ipScopeKey` are HMAC digests, never a raw IP,
 * user ID or guest cookie -- and no prompt text, USD figure or lease key is
 * included.
 */
const logConcurrencyRejection = (input: {
    traceId: string;
    phase: "chat_reservation" | "comparison_preflight";
    kind: AccessKind;
    subjectKey: string;
    error: ChatAccessError;
    comparisonId?: string | null;
    leaseTtlSeconds: number;
}) => {
    const details = input.error.details || {};
    console.warn(
        JSON.stringify({
            event: "chat_concurrency_rejected",
            traceId: input.traceId,
            phase: input.phase,
            code: input.error.code,
            limitLayer: details.limitLayer ?? null,
            leaseScope: details.scope ?? null,
            plan: input.kind === "guest" ? "Guest" : "user",
            subjectKey: input.subjectKey,
            activeRequests: details.activeRequests ?? null,
            requestedSlots: details.requestedSlots ?? null,
            concurrentLimit: details.concurrentLimit ?? null,
            leaseTtlSeconds: input.leaseTtlSeconds,
            comparisonId: input.comparisonId ?? null,
            timestamp: new Date().toISOString(),
        })
    );
};

const isConcurrencyCode = (code: string) =>
    code === SUBJECT_CONCURRENCY_EXCEEDED || code === IP_CONCURRENCY_EXCEEDED;

/**
 * Gives back every slot of an admission the caller never used.
 *
 * Exposed so a route that fails after a successful preflight (a model went
 * away, the conversation turned out to be locked, the browser aborted) can
 * unwind the reservation immediately rather than leaving the subject's
 * allowance held until the admission TTL.
 */
export const rollbackChatAdmission = async (
    admissionId: string,
    context?: { traceId?: string }
) => releaseUnclaimedAdmission(admissionId, context);

const safeBigIntNumber = (value: bigint) => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) {
        throw new Error("Credit cost allowance exceeds the supported range.");
    }
    return number;
};

/**
 * Aggregate admission for a guest's multi-model comparison.
 *
 * Guests have no credit ledger and no plan, so there is nothing here to check
 * that `acquireChatAccess` does not already check per model. What there *is* to
 * decide once, for the whole comparison, is concurrency: three panels are three
 * requests, and letting them race for slots individually is what produced the
 * "some answers ran, the rest were refused" report.
 */
const preflightGuestComparisonAdmission = async (
    access: ChatAccess,
    budgets: ChatBudget[],
    options: { traceId: string; comparisonId: string; enabledTools?: string[] }
): Promise<ChatAdmissionGrant> => {
    const now = new Date();
    const recordGuestDecision = async (error?: ChatAccessError) =>
        recordChatLimitDecision({
            traceId: options.traceId,
            subjectKey: access.subjectKey,
            plan: "Guest",
            phase: "comparison_preflight",
            decision: error ? "rejected" : "allowed",
            errorCode: error?.code ?? null,
            limitLayer: error
                ? textDetail(error.details, "limitLayer") ?? "entitlement"
                : null,
            limitScope: error ? textDetail(error.details, "scope") : null,
            models: decisionModelsFromBudgets(budgets),
            enabledTools: options.enabledTools ?? [],
            requiredCredits: budgets.reduce(
                (sum, budget) => sum + budget.usageCredits,
                0
            ),
            availableCredits: null,
            timeZone: "UTC",
            resetAt: null,
        }).catch(() => undefined);

    let reserved: ReservedAdmission;
    try {
        reserved = await prisma.$transaction(
            async (tx) =>
                reserveComparisonAdmission(
                    tx,
                    access,
                    budgets.map((budget) => budget.modelId),
                    now
                ),
            { maxWait: 5_000, timeout: 15_000 }
        );
    } catch (error) {
        if (error instanceof ChatAccessError) {
            await recordGuestDecision(error);
            if (isConcurrencyCode(error.code)) {
                logConcurrencyRejection({
                    traceId: options.traceId,
                    phase: "comparison_preflight",
                    kind: access.kind,
                    subjectKey: access.subjectKey,
                    error,
                    comparisonId: options.comparisonId,
                    leaseTtlSeconds: resolveAdmissionTtlSeconds(),
                });
            }
        }
        throw error;
    }
    if (shouldRecordAllowedDecisions()) await recordGuestDecision();
    return buildAdmissionGrant(access, options.comparisonId, reserved);
};

export const preflightChatComparisonAccess = async (
    access: ChatAccess,
    budgets: ChatBudget[],
    options?: {
        traceId?: string;
        enabledTools?: string[];
        /**
         * Ties the issued admission to the user action that requested it. Only
         * an identifier -- the security boundary is the signature plus the
         * conditional claim, not this string.
         */
        comparisonId?: string;
    }
) => {
    try {
        await assertOperationalFeatureEnabled("aiChatEnabled");
    } catch (error) {
        if (error instanceof OperationalFeatureDisabledError) {
            throw new ChatAccessError(
                503,
                "AI_CHAT_DISABLED_BY_ADMIN",
                "AI chat is temporarily paused for operational maintenance."
            );
        }
        throw error;
    }
    if (budgets.length < 2 || budgets.length > 3) {
        throw new ChatAccessError(
            400,
            "INVALID_COMPARISON_MODELS",
            "Choose two or three models for a comparison."
        );
    }
    if (new Set(budgets.map((budget) => budget.modelId)).size !== budgets.length) {
        throw new ChatAccessError(
            400,
            "DUPLICATE_COMPARISON_MODELS",
            "Comparison models must be unique."
        );
    }
    if (access.kind !== "user" || !access.userId) {
        const admission = await preflightGuestComparisonAdmission(
            access,
            budgets,
            {
                traceId: options?.traceId || randomUUID(),
                comparisonId: options?.comparisonId || "guest-comparison",
                enabledTools: options?.enabledTools,
            }
        );
        return {
            modelCount: budgets.length,
            requiredCredits: budgets.reduce(
                (sum, budget) => sum + budget.usageCredits,
                0
            ),
            reservedTokens: budgets.reduce(
                (sum, budget) => sum + getChatBudgetReservedTokens(budget),
                0
            ),
            reservedCostMicroUsd: budgets.reduce(
                (sum, budget) => sum + getChatBudgetReservedCostMicroUsd(budget),
                0
            ),
            timeZone: "UTC",
            dailyResetAt: null as string | null,
            admission,
        };
    }
    await assertUserOperationalAccess(access.userId);

    const now = new Date();
    const plan = access.plan || "Free";
    const guardrails = getChatCostGuardrails(plan, access.planLimits);
    const totalCredits = budgets.reduce(
        (sum, budget) => sum + budget.usageCredits,
        0
    );
    const totalReservedTokens = budgets.reduce(
        (sum, budget) => sum + getChatBudgetReservedTokens(budget),
        0
    );
    const totalReservedCost = budgets.reduce(
        (sum, budget) => sum + getChatBudgetReservedCostMicroUsd(budget),
        0
    );

    // Held in one object rather than three `let`s so the values assigned
    // inside the transaction callback are visible to the code after it.
    const decisionState: {
        timeZone: string;
        resetAt: Date | null;
        availableCredits: number | null;
    } = { timeZone: "UTC", resetAt: null, availableCredits: null };
    let reservedAdmission: ReservedAdmission | null = null;

    const recordDecision = async (error?: ChatAccessError) =>
        recordChatLimitDecision({
            traceId: options?.traceId || randomUUID(),
            subjectKey: access.subjectKey,
            userId: access.userId,
            plan,
            phase: "comparison_preflight",
            decision: error ? "rejected" : "allowed",
            errorCode: error?.code ?? null,
            limitLayer: error
                ? textDetail(error.details, "limitLayer") ?? "entitlement"
                : null,
            limitScope: error ? textDetail(error.details, "scope") : null,
            models: decisionModelsFromBudgets(budgets),
            enabledTools: options?.enabledTools ?? [],
            requiredCredits:
                numericDetail(error?.details, "requiredCredits") ??
                totalCredits,
            availableCredits: decisionState.availableCredits,
            usedAllowanceMicroUsd: numericDetail(
                error?.details,
                "internalUsedCostMicroUsd"
            ),
            requiredAllowanceMicroUsd:
                numericDetail(error?.details, "internalRequiredCostMicroUsd") ??
                totalReservedCost,
            limitMicroUsd: numericDetail(
                error?.details,
                "internalLimitCostMicroUsd"
            ),
            timeZone: decisionState.timeZone,
            resetAt:
                textDetail(error?.details, "resetAt") ?? decisionState.resetAt,
        }).catch(() => undefined);

    try {
        await prisma.$transaction(async (tx) => {
        await lockCreditAccount(tx, access.userId!);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${access.subjectKey}))`;
        const userDayWindow = await getUserDayWindow(tx, access.userId!, now);
        decisionState.timeZone = userDayWindow.timeZone;
        decisionState.resetAt = safeDailyResetAt(userDayWindow.end, now);

        const billingRisk = await tx.user.findUniqueOrThrow({
            where: { id: access.userId! },
            select: { billingRiskStatus: true },
        });
        if (billingRisk.billingRiskStatus === "disputed_hold") {
            throw new ChatAccessError(
                403,
                "BILLING_DISPUTE_HOLD",
                "AI access is temporarily paused while a payment dispute is reviewed."
            );
        }

        // Every slot and every unit of request rate this comparison needs,
        // taken in one go. A slot reserved here is claimed later by exactly one
        // model request; if any check below this line fails, the transaction
        // unwinds and both the slots and the rate units go with it, so a
        // refused comparison never leaves an allowance held.
        //
        // The per-minute rate used to be *read* here and charged later by each
        // model request, which is precisely how a comparison that this check
        // said would fit still lost its last panel to a 429.
        reservedAdmission = await reserveComparisonAdmission(
            tx,
            access,
            budgets.map((budget) => budget.modelId),
            now
        );

        const planRules = limitsFor(access);
        const dailyCreditRule = planRules.find((rule) => rule.period === "day");
        let dailyPlanCreditsUsed = 0;
        let dailyPlanCreditsRemaining: number | null = null;
        if (dailyCreditRule) {
            const start = userDayWindow.start;
            dailyPlanCreditsUsed = await readUsageCount(
                tx,
                access.subjectKey,
                "day",
                start
            );
            dailyPlanCreditsRemaining = Math.max(
                0,
                dailyCreditRule.limit - dailyPlanCreditsUsed
            );
        }

        const monthlyCreditRule = planRules.find(
            (rule) => rule.period === "month"
        );
        if (!monthlyCreditRule) {
            throw new ChatAccessError(
                503,
                "CHAT_PLAN_NOT_CONFIGURED",
                "Monthly plan credits are not configured."
            );
        }
        const monthStart = periodStart("month", now);
        const usedPlanCredits = await readUsageCount(
            tx,
            access.subjectKey,
            "month",
            monthStart
        );
        let planCreditsRemaining = Math.max(
            0,
            monthlyCreditRule.limit - usedPlanCredits
        );
        const lots = await tx.creditLot.findMany({
            where: {
                userId: access.userId!,
                status: "active",
                expiresAt: { gt: now },
                OR: [
                    { remainingCredits: { gt: 0 } },
                    { remainingFundedCostMicroUsd: { gt: 0 } },
                ],
            },
            select: {
                remainingCredits: true,
                remainingFundedCostMicroUsd: true,
            },
        });
        const purchasedCreditsAvailable = lots.reduce(
            (sum, lot) => sum + lot.remainingCredits,
            0
        );
        const purchasedCostAvailable = lots.reduce(
            (sum, lot) =>
                sum + safeBigIntNumber(lot.remainingFundedCostMicroUsd),
            0
        );
        const creditAllocation = getChatCreditAllocation({
            requiredCredits: totalCredits,
            monthlyPlanCreditsRemaining: planCreditsRemaining,
            dailyPlanCreditsRemaining,
            purchasedCreditsRemaining: purchasedCreditsAvailable,
        });
        decisionState.availableCredits = creditAllocation.totalCreditsAvailableNow;
        if (creditAllocation.dailyPlanGuardrailBlocked) {
            throw new ChatAccessError(
                429,
                "PLAN_DAILY_CREDIT_LIMIT_REACHED",
                "The daily plan-credit guardrail is reached. Purchased credits can be used now, or plan credits will be available again after the account-local reset.",
                retryAfterFor("day", now, userDayWindow.end),
                {
                    scope: "daily_plan_credits",
                    requiredCredits: totalCredits,
                    dailyPlanLimit: dailyCreditRule?.limit ?? 0,
                    dailyPlanUsed: dailyPlanCreditsUsed,
                    dailyPlanRemaining: dailyPlanCreditsRemaining ?? 0,
                    monthlyPlanRemaining: planCreditsRemaining,
                    purchasedCreditsAvailable,
                    // The same instant the decision record carries. A stale
                    // stored time zone rolls it forward here too, so the audit
                    // trail and the message the user reads agree.
                    resetAt: safeDailyResetAt(
                        userDayWindow.end,
                        now
                    ).toISOString(),
                }
            );
        }
        if (creditAllocation.balanceInsufficient) {
            // Plan credits exhausted with nothing purchased is a different
            // conversation from "you have credits, just not enough": the first
            // is answered by buying credits or upgrading, the second by asking
            // for less. They get different codes so the UI can say so.
            const planOnly = purchasedCreditsAvailable === 0;
            throw new ChatAccessError(
                402,
                planOnly
                    ? PLAN_ENTITLEMENT_EXHAUSTED
                    : CREDIT_BALANCE_INSUFFICIENT,
                planOnly
                    ? "This month's plan credits are used up. Buy additional credits or upgrade to keep comparing models."
                    : "The selected models need more credits than are currently available.",
                undefined,
                {
                    requiredCredits: totalCredits,
                    planCreditsAvailable: planCreditsRemaining,
                    purchasedCreditsAvailable,
                    shortfallCredits: Math.max(
                        0,
                        totalCredits - planCreditsRemaining - purchasedCreditsAvailable
                    ),
                    resetAt: monthlyResetAt(now).toISOString(),
                }
            );
        }

        let planReservedCost = 0;
        let purchasedReservedCost = 0;
        planCreditsRemaining = creditAllocation.planCreditsAvailableNow;
        for (const budget of budgets) {
            const reservedCost = getChatBudgetReservedCostMicroUsd(budget);
            const planCredits = Math.min(
                planCreditsRemaining,
                budget.usageCredits
            );
            planCreditsRemaining -= planCredits;
            const purchasedCredits = budget.usageCredits - planCredits;
            const purchasedCost =
                purchasedCredits > 0
                    ? Math.ceil(
                          (reservedCost * purchasedCredits) /
                              budget.usageCredits
                      )
                    : 0;
            purchasedReservedCost += purchasedCost;
            planReservedCost += reservedCost - purchasedCost;
        }
        if (purchasedReservedCost > purchasedCostAvailable) {
            throw new ChatAccessError(
                402,
                "CREDIT_COST_ALLOWANCE_INSUFFICIENT",
                "Purchased credits do not include enough remaining AI cost allowance for this comparison.",
                undefined,
                // `internal` prefixed so publicChatErrorDetails strips them.
                // These are provider spend in micro-USD, which never belongs
                // in a user-facing payload -- the figures live in the
                // limit-decision event and the Admin Console. The neighbouring
                // guardrail rejection says the same thing in a comment; these
                // two simply were not spelled to match, so the one mechanism
                // that enforces it could not see them.
                {
                    internalRequiredCostMicroUsd: purchasedReservedCost,
                    internalAvailableCostMicroUsd: purchasedCostAvailable,
                }
            );
        }

        if (plan === "Free") {
            const higherCostModelCount = budgets.filter(
                (budget) =>
                    budget.minimumPlan === "Free" &&
                    budget.modelUsageClass !== "standard"
            ).length;
            if (higherCostModelCount > 0) {
                const freeHigherCostMonthlyLimit = positiveInteger(
                    process.env.CHAT_FREE_PRO_MODEL_RESPONSES_PER_MONTH,
                    30
                );
                const used = await readUsageCount(
                    tx,
                    access.subjectKey,
                    "pro-model-month",
                    monthStart
                );
                if (used + higherCostModelCount > freeHigherCostMonthlyLimit) {
                    throw new ChatAccessError(
                        429,
                        "FREE_PRO_MODEL_QUOTA_EXCEEDED",
                        "The selected comparison needs more higher-cost model responses than remain in the Free plan this month.",
                        retryAfterFor("month", now),
                        {
                            requiredResponses: higherCostModelCount,
                            availableResponses: Math.max(
                                0,
                                freeHigherCostMonthlyLimit - used
                            ),
                        }
                    );
                }
            }
        }

        // Operational guardrails, not entitlement. `cost-*` counts only the
        // plan-funded share, so a user paying with purchased credits is bounded
        // by the funded cost allowance on their own credit lots instead of
        // being blocked a second time by a plan-shaped ceiling. `op-cost-*`
        // counts everything and is the abnormal-spend backstop.
        const costChecks = [
            {
                period: "cost-day",
                start: userDayWindow.start,
                limit: guardrails.planDay,
                required: planReservedCost,
                scope: "user_plan_cost_day",
                daily: true,
            },
            {
                period: "cost-month",
                start: monthStart,
                limit: guardrails.planMonth,
                required: planReservedCost,
                scope: "user_plan_cost_month",
                daily: false,
            },
            {
                period: "op-cost-day",
                start: userDayWindow.start,
                limit: guardrails.totalDay,
                required: totalReservedCost,
                scope: "user_total_cost_day",
                daily: true,
            },
            {
                period: "op-cost-month",
                start: monthStart,
                limit: guardrails.totalMonth,
                required: totalReservedCost,
                scope: "user_total_cost_month",
                daily: false,
            },
        ] as const;
        for (const check of costChecks) {
            const used = await readUsageCount(
                tx,
                access.subjectKey,
                check.period,
                check.start
            );
            if (check.required > 0 && used + check.required > check.limit) {
                throw new ChatAccessError(
                    429,
                    OPERATIONAL_COST_GUARDRAIL_TRIGGERED,
                    "An internal cost safety check paused this comparison. Your credits are unaffected -- try again shortly or choose fewer high-cost models.",
                    retryAfterFor(
                        check.daily ? "day" : "month",
                        now,
                        check.daily ? userDayWindow.end : undefined
                    ),
                    // Deliberately free of raw internal USD: the exact figures
                    // go to the limit-decision event and the admin console, not
                    // into an end-user response.
                    {
                        scope: check.scope,
                        limitLayer: "operational_guardrail",
                        resetAt: (check.daily
                            ? safeDailyResetAt(userDayWindow.end, now)
                            : monthlyResetAt(now)
                        ).toISOString(),
                        timeZone: check.daily ? userDayWindow.timeZone : "UTC",
                        // Carried for the caller's structured log/event only.
                        internalUsedCostMicroUsd: used,
                        internalRequiredCostMicroUsd: check.required,
                        internalLimitCostMicroUsd: check.limit,
                    }
                );
            }
        }

        const tokenLimits = [
            {
                period: "tokens-day",
                start: userDayWindow.start,
                limit: positiveInteger(
                    process.env.CHAT_USER_TOKENS_PER_DAY,
                    1_000_000
                ),
                retryPeriod: "day" as const,
            },
            {
                period: "tokens-month",
                start: monthStart,
                limit: positiveInteger(
                    process.env.CHAT_USER_TOKENS_PER_MONTH,
                    20_000_000
                ),
                retryPeriod: "month" as const,
            },
        ];
        for (const rule of tokenLimits) {
            const used = await readUsageCount(
                tx,
                access.subjectKey,
                rule.period,
                rule.start
            );
            if (used + totalReservedTokens > rule.limit) {
                throw new ChatAccessError(
                    429,
                    "CHAT_TOKEN_QUOTA_EXCEEDED",
                    "The selected models need more token capacity than is currently available.",
                    retryAfterFor(
                        rule.retryPeriod,
                        now,
                        rule.retryPeriod === "day" ? userDayWindow.end : undefined
                    ),
                    {
                        scope: rule.retryPeriod,
                        requiredTokens: totalReservedTokens,
                        availableTokens: Math.max(0, rule.limit - used),
                    }
                );
            }
        }

        const providerGroups = new Map<
            AiModel["provider"],
            { daily: number; monthly: number }
        >();
        for (const budget of budgets) {
            const cost = getChatBudgetReservedCostMicroUsd(budget);
            const current = providerGroups.get(budget.provider) || {
                daily: 0,
                monthly: 0,
            };
            current.daily += cost;
            current.monthly += cost;
            providerGroups.set(budget.provider, current);
        }
        for (const [provider, required] of providerGroups) {
            const providerKey = providerBucketKey(provider);
            const providerLimits = getProviderCostGuardrailLimits(provider);
            const providerChecks = [
                {
                    period: "provider-cost-day",
                    start: periodStart("day", now),
                    limit: providerLimits.day,
                    required: required.daily,
                    scope: "provider_cost_day",
                },
                {
                    period: "provider-cost-month",
                    start: monthStart,
                    limit: providerLimits.month,
                    required: required.monthly,
                    scope: "provider_cost_month",
                },
            ];
            for (const check of providerChecks) {
                const used = await readUsageCount(
                    tx,
                    providerKey,
                    check.period,
                    check.start
                );
                const utilisation = classifyProviderBudgetUtilisation({
                    usedMicroUsd: used,
                    requiredMicroUsd: check.required,
                    limitMicroUsd: check.limit,
                });
                // Report the approach, not just the wall. A provider budget
                // refuses everyone at once, so the first anyone hears of it
                // must not be the 503.
                if (utilisation.level !== "nominal") {
                    reportProviderBudgetUtilisation({
                        provider,
                        scope: check.scope,
                        level: utilisation.level,
                        ratio: utilisation.ratio,
                        usedMicroUsd: used,
                        requiredMicroUsd: check.required,
                        limitMicroUsd: check.limit,
                    });
                }
                if (utilisation.level === "exhausted") {
                    throw new ChatAccessError(
                        503,
                        PROVIDER_BUDGET_EXHAUSTED,
                        `The ${provider} provider is temporarily unavailable while its spend budget is reviewed. Choose another provider or try again later.`,
                        undefined,
                        {
                            provider,
                            scope: check.scope,
                            limitLayer: "operational_guardrail",
                            alternativeModelIds:
                                alternativeModelsForProvider(provider),
                            internalUsedCostMicroUsd: used,
                            internalRequiredCostMicroUsd: check.required,
                            internalLimitCostMicroUsd: check.limit,
                        }
                    );
                }
            }
        }
    }, {
            maxWait: 5_000,
            timeout: 15_000,
        });
    } catch (error) {
        if (error instanceof ChatAccessError) {
            await recordDecision(error);
            if (isConcurrencyCode(error.code)) {
                logConcurrencyRejection({
                    traceId: options?.traceId || "",
                    phase: "comparison_preflight",
                    kind: access.kind,
                    subjectKey: access.subjectKey,
                    error,
                    comparisonId: options?.comparisonId,
                    leaseTtlSeconds: resolveAdmissionTtlSeconds(),
                });
            }
        }
        throw error;
    }

    if (shouldRecordAllowedDecisions()) {
        await recordDecision();
    }

    if (!reservedAdmission) {
        throw new Error("Comparison admission slots were not reserved.");
    }

    return {
        modelCount: budgets.length,
        requiredCredits: totalCredits,
        reservedTokens: totalReservedTokens,
        reservedCostMicroUsd: totalReservedCost,
        timeZone: decisionState.timeZone,
        dailyResetAt: decisionState.resetAt?.toISOString() ?? null,
        admission: buildAdmissionGrant(
            access,
            options?.comparisonId || "comparison",
            reservedAdmission
        ),
    };
};

export const acquireChatAccess = async (
    access: ChatAccess,
    budget: ChatBudget,
    options?: {
        traceId?: string;
        source?: "chat" | "comparison_review";
        /** Tool names enabled for this turn, recorded on the limit decision. */
        enabledTools?: string[];
        /**
         * Admission token issued by the aggregate comparison preflight. When it
         * verifies and still has an unclaimed slot for this model, the request
         * occupies that slot instead of competing for a new one -- which is
         * what stops a three-model comparison from being admitted in part.
         */
        admissionToken?: string | null;
    }
): Promise<{
    leaseId: string;
    setCookie: string | undefined;
    usageReservation: ChatUsageReservation;
}> => {
    try {
        await assertOperationalFeatureEnabled("aiChatEnabled");
    } catch (error) {
        if (error instanceof OperationalFeatureDisabledError) {
            throw new ChatAccessError(
                503,
                "AI_CHAT_DISABLED_BY_ADMIN",
                "AI chat is temporarily paused for operational maintenance."
            );
        }
        throw error;
    }
    if (access.kind === "user" && access.userId) {
        await assertUserOperationalAccess(access.userId);
    }
    const now = new Date();
    let leaseId: string = randomUUID();
    const reservationId = randomUUID();
    const traceId = options?.traceId || reservationId;
    const reservationSource = options?.source || "chat";
    const reservationTtlSeconds = Math.min(
        1_800,
        Math.max(
            300,
            positiveInteger(process.env.CHAT_RESERVATION_TTL_SECONDS, 300)
        )
    );
    const reservationExpiresAt = new Date(
        now.getTime() + reservationTtlSeconds * 1000
    );
    const reservationEntries: ReservationEntry[] = [];
    let planReservedCredits = budget.usageCredits;
    let addOnReservedCredits = 0;
    let addOnReservedCost = 0;
    let addOnReservations: AddOnCreditReservationEntry[] = [];
    let durableReservation: ChatUsageReservation | null = null;
    const concurrencyPlan = resolveChatConcurrencyPlan(access);
    const leaseTtlSeconds = resolveLeaseTtlSeconds();
    // Signature and subject binding are verified here; whether the slot is
    // still available is decided by the conditional claim inside the
    // transaction. A token that fails either check is simply absent -- the
    // request then takes the ordinary single-slot path rather than failing.
    const admissionSlot = (() => {
        const token = options?.admissionToken?.trim();
        if (!token) return null;
        const verified = verifyAdmissionToken(token, {
            secret: getSecret(),
            subjectKey: access.subjectKey,
            modelId: budget.modelId,
            now,
        });
        if (!verified.ok) {
            console.warn(
                JSON.stringify({
                    event: "chat_admission_rejected",
                    traceId,
                    reason: verified.reason,
                    modelId: budget.modelId,
                    timestamp: now.toISOString(),
                })
            );
            return null;
        }
        const slot = admissionSlotFor(verified.payload, budget.modelId);
        return slot
            ? {
                  leaseId: slot.leaseId,
                  admissionId: verified.payload.admissionId,
                  comparisonId: verified.payload.comparisonId,
              }
            : null;
    })();
    const ipPerMinute = positiveInteger(process.env.CHAT_IP_PER_MINUTE, 40);
    const reservedTokens = getChatBudgetReservedTokens(budget);
    const reservedCost = getChatBudgetReservedCostMicroUsd(budget);
    const plan = access.plan || "Free";
    const guardrails = getChatCostGuardrails(plan, access.planLimits);
    const guestGuardrails = getGuestCostGuardrailLimits();
    const providerGuardrails = getProviderCostGuardrailLimits(budget.provider);
    const providerMonthlyLimit = providerGuardrails.month;
    const providerDailyLimit = providerGuardrails.day;
    const decisionState: {
        timeZone: string;
        resetAt: Date | null;
        availableCredits: number | null;
    } = { timeZone: "UTC", resetAt: null, availableCredits: null };

    const recordDecision = async (error?: ChatAccessError) =>
        recordChatLimitDecision({
            traceId,
            subjectKey: access.subjectKey,
            userId: access.userId,
            plan: access.kind === "guest" ? "Guest" : plan,
            phase: "chat_reservation",
            decision: error ? "rejected" : "allowed",
            errorCode: error?.code ?? null,
            limitLayer: error
                ? textDetail(error.details, "limitLayer") ?? "entitlement"
                : null,
            limitScope: error ? textDetail(error.details, "scope") : null,
            models: decisionModelsFromBudgets([budget]),
            enabledTools: options?.enabledTools ?? [],
            requiredCredits: budget.usageCredits,
            availableCredits: decisionState.availableCredits,
            usedAllowanceMicroUsd: numericDetail(
                error?.details,
                "internalUsedCostMicroUsd"
            ),
            requiredAllowanceMicroUsd:
                numericDetail(error?.details, "internalRequiredCostMicroUsd") ??
                reservedCost,
            limitMicroUsd: numericDetail(
                error?.details,
                "internalLimitCostMicroUsd"
            ),
            timeZone: decisionState.timeZone,
            resetAt:
                textDetail(error?.details, "resetAt") ?? decisionState.resetAt,
        }).catch(() => undefined);

    try {
    await prisma.$transaction(async (tx) => {
        if (access.kind === "user") {
            if (!access.userId) {
                throw new Error("Authenticated chat access is missing a user ID.");
            }
            await lockCreditAccount(tx, access.userId);
        }
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${access.subjectKey}))`;
        // Every lock this transaction will need, taken here, in the one order
        // the comparison preflight also takes them: credit account, subject,
        // lease-subject, lease-IP, and only then rows.
        //
        // This used to be taken further down, just before the lease insert,
        // which was harmless while the preflight touched no usage rows. It is
        // not harmless now: the preflight holds the lease-scope locks while it
        // reserves the comparison's minute buckets, so a request that charged
        // its own minute bucket first and asked for those locks afterwards
        // would hold a row the preflight wanted while waiting for a lock the
        // preflight held -- a genuine deadlock, which Postgres resolves by
        // killing one of the two with an error neither caller can act on.
        // Ordering is the fix; retrying is not.
        await lockConcurrencyScopes(tx, concurrencyPlan);
        // Expired leases go before anything is charged, for the same reason:
        // every path that touches both tables -- this one, the comparison
        // preflight, and the admission rollback -- writes lease rows before
        // usage rows, so no two of them can hold half of what the other is
        // waiting for. It also means the capacity check below counts live
        // slots rather than dead ones, which is what it was always for.
        await sweepExpiredLeasesForScopes(tx, {
            subjectKey: concurrencyPlan.subject.key,
            ipKey: concurrencyPlan.ip?.key ?? null,
        });
        // Claimed first, because the answer decides what this request still has
        // to pay for. A comparison that was admitted as a whole already
        // reserved this model's concurrency slot *and* its unit of per-minute
        // request rate in the preflight transaction; charging the minute
        // buckets again here would count one request twice and refuse the
        // comparison's own last panel with its own reservation.
        //
        // Claiming is a conditional update on a row the aggregate preflight
        // created, so a replayed, foreign, expired or forged token claims
        // nothing -- and a request that claims nothing pays for itself in
        // full, below, exactly as a single-model request does. The claim lives
        // inside this transaction, so a rejection further down releases it
        // along with everything else.
        let claimedAdmissionSlot = false;
        if (admissionSlot) {
            claimedAdmissionSlot = await claimAdmissionSlot(
                tx,
                {
                    leaseId: admissionSlot.leaseId,
                    admissionId: admissionSlot.admissionId,
                    subjectKey: access.subjectKey,
                    modelId: budget.modelId,
                },
                leaseTtlSeconds
            );
            if (claimedAdmissionSlot) {
                leaseId = admissionSlot.leaseId;
            } else {
                console.warn(
                    JSON.stringify({
                        event: "chat_admission_claim_missed",
                        traceId,
                        reason: "slot_unavailable",
                        modelId: budget.modelId,
                        timestamp: new Date().toISOString(),
                    })
                );
            }
        }
        const accessDayWindow =
            access.kind === "user"
                ? await getUserDayWindow(tx, access.userId!, now)
                : {
                      timeZone: "UTC",
                      start: periodStart("day", now),
                      end: new Date(periodStart("day", now).getTime() + 86_400_000),
                  };
        decisionState.timeZone = accessDayWindow.timeZone;
        decisionState.resetAt = safeDailyResetAt(accessDayWindow.end, now);
        const accessPeriodStart = (period: Period) =>
            period === "day" ? accessDayWindow.start : periodStart(period, now);
        const tokenLimits =
            access.kind === "user"
                ? [
                      {
                          period: "tokens-day",
                          start: accessDayWindow.start,
                          limit: positiveInteger(
                              process.env.CHAT_USER_TOKENS_PER_DAY,
                              1_000_000
                          ),
                      },
                      {
                          period: "tokens-month",
                          start: periodStart("month", now),
                          limit: positiveInteger(
                              process.env.CHAT_USER_TOKENS_PER_MONTH,
                              20_000_000
                          ),
                      },
                  ]
                : [
                      {
                          period: "tokens-day",
                          start: accessDayWindow.start,
                          limit: positiveInteger(
                              process.env.CHAT_GUEST_TOKENS_PER_DAY,
                              40_000
                          ),
                      },
                      {
                          period: "tokens-month",
                          start: periodStart("month", now),
                          limit: positiveInteger(
                              process.env.CHAT_GUEST_TOKENS_PER_MONTH,
                              200_000
                          ),
                      },
                  ];
        // `cost-*` tracks the plan-funded share only; `op-cost-*` tracks every
        // micro-USD including purchased-credit-funded spend. Both are
        // operational guardrails -- neither is the user's entitlement.
        const costLimits =
            access.kind === "user"
                ? [
                      {
                          period: "cost-day",
                          start: accessDayWindow.start,
                          limit: guardrails.planDay,
                          scope: "user_plan_cost_day",
                          planFundedOnly: true,
                          daily: true,
                      },
                      {
                          period: "cost-month",
                          start: periodStart("month", now),
                          limit: guardrails.planMonth,
                          scope: "user_plan_cost_month",
                          planFundedOnly: true,
                          daily: false,
                      },
                      {
                          period: "op-cost-day",
                          start: accessDayWindow.start,
                          limit: guardrails.totalDay,
                          scope: "user_total_cost_day",
                          planFundedOnly: false,
                          daily: true,
                      },
                      {
                          period: "op-cost-month",
                          start: periodStart("month", now),
                          limit: guardrails.totalMonth,
                          scope: "user_total_cost_month",
                          planFundedOnly: false,
                          daily: false,
                      },
                  ]
                : [
                      {
                          period: "cost-day",
                          start: accessDayWindow.start,
                          limit: guestGuardrails.day,
                          scope: "guest_cost_day",
                          planFundedOnly: false,
                          daily: true,
                      },
                      {
                          period: "cost-month",
                          start: periodStart("month", now),
                          limit: guestGuardrails.month,
                          scope: "guest_cost_month",
                          planFundedOnly: false,
                          daily: false,
                      },
                  ];
        if (access.kind === "user") {
            const billingRisk = await tx.user.findUniqueOrThrow({
                where: { id: access.userId! },
                select: { billingRiskStatus: true },
            });
            if (billingRisk.billingRiskStatus === "disputed_hold") {
                throw new ChatAccessError(
                    403,
                    "BILLING_DISPUTE_HOLD",
                    "AI access is temporarily paused while a payment dispute is reviewed."
                );
            }

            const monthStart = periodStart("month", now);
            const monthlyCost = await tx.chatUsageBucket.findUnique({
                where: {
                    key_period_periodStart: {
                        key: access.subjectKey,
                        period: "cost-month",
                        periodStart: monthStart,
                    },
                },
                select: { count: true },
            });
            const availableMonthlyCost = Math.max(
                0,
                guardrails.planMonth - usageBucketCount(monthlyCost?.count)
            );
            if (availableMonthlyCost > 0) {
                const debtOffset = await offsetCreditDebt(tx, {
                    userId: access.userId!,
                    availableCredits: 0,
                    availableFundedCostMicroUsd: BigInt(availableMonthlyCost),
                    type: "plan_offset",
                    metadata: {
                        source: "monthly_plan_cost_allowance",
                        periodStart: monthStart.toISOString(),
                    },
                });
                const costOffset = Number(debtOffset.offsetFundedCostMicroUsd);
                if (costOffset > 0) {
                    const allowed = await incrementUsage(
                        tx,
                        access.subjectKey,
                        "cost-month",
                        monthStart,
                        guardrails.planMonth,
                        costOffset
                    );
                    if (!allowed) {
                        throw new ChatAccessError(
                            409,
                            CONCURRENT_RESERVATION_CONFLICT,
                            "Credit debt balance changed. Please retry.",
                            undefined,
                            { conflictScope: "credit_debt_offset" }
                        );
                    }
                }
            }
        }
        for (const rule of limitsFor(access)) {
            if (
                access.kind === "user" &&
                (rule.period === "day" || rule.period === "month")
            ) {
                continue;
            }
            // Already paid for by the comparison's preflight, on behalf of this
            // exact model. Skipping it is what makes the reservation a
            // reservation rather than a second charge.
            if (claimedAdmissionSlot && rule.period === "minute") continue;
            const amount = rule.period === "minute" ? 1 : budget.usageCredits;
            const allowed = await incrementUsage(
                tx,
                access.subjectKey,
                rule.period,
                accessPeriodStart(rule.period),
                rule.limit,
                amount
            );
            if (!allowed) {
                const retryAfterSeconds = retryAfterFor(
                    rule.period,
                    now,
                    rule.period === "day" ? accessDayWindow.end : undefined
                );
                // A brief per-minute rate limit and a genuine day/month quota
                // exhaustion need different client responses (wait-and-retry
                // vs. a login/upgrade prompt for guests), so they get distinct
                // codes here -- matching the CHAT_RATE_LIMITED naming already
                // used for the same distinction in preflightChatComparisonAccess
                // above -- instead of collapsing everything into
                // CHAT_QUOTA_EXCEEDED regardless of which period tripped.
                if (rule.period === "minute") {
                    const scope = subjectRateScope(
                        access.kind,
                        access.subjectKey,
                        rule.limit
                    );
                    // The layer matters as much as the code: without it this
                    // rejection was recorded as `entitlement`, so a decision
                    // log could not tell someone who has to wait ten seconds
                    // from someone who is out of credits.
                    throw new ChatAccessError(
                        429,
                        CHAT_RATE_LIMITED,
                        rateLimitRejectionMessage(scope.scope),
                        retryAfterSeconds,
                        {
                            ...rateLimitRejectionDetails(scope, {
                                usedRequests: await readUsageCount(
                                    tx,
                                    scope.key,
                                    "minute",
                                    accessPeriodStart("minute")
                                ),
                                requestedRequests: 1,
                                retryAfterSeconds,
                                resetAt: new Date(
                                    accessPeriodStart("minute").getTime() +
                                        60_000
                                ),
                            }),
                            period: rule.period,
                        }
                    );
                }
                throw new ChatAccessError(
                    429,
                    "CHAT_QUOTA_EXCEEDED",
                    "AI response credit limit exceeded.",
                    retryAfterSeconds,
                    { period: rule.period, retryAfterSeconds }
                );
            }
            if (rule.period !== "minute") {
                reservationEntries.push({
                    key: access.subjectKey,
                    period: rule.period,
                    periodStart: accessPeriodStart(rule.period),
                    amount,
                    metric: "credits",
                });
            }
        }

        if (access.kind === "user") {
            if (!access.userId) throw new Error("Authenticated chat access is missing a user ID.");
            const monthRule = limitsFor(access).find((rule) => rule.period === "month");
            if (!monthRule) {
                throw new ChatAccessError(503, "CHAT_PLAN_NOT_CONFIGURED", "Monthly plan credits are not configured.");
            }
            const monthStart = periodStart("month", now);
            const current = await tx.chatUsageBucket.findUnique({
                where: {
                    key_period_periodStart: {
                        key: access.subjectKey,
                        period: "month",
                        periodStart: monthStart,
                    },
                },
                select: { count: true },
            });
            const rawPlanRemaining = Math.max(
                0,
                monthRule.limit - usageBucketCount(current?.count)
            );
            const debtOffset = await offsetCreditDebt(tx, {
                userId: access.userId,
                availableCredits: rawPlanRemaining,
                availableFundedCostMicroUsd: BigInt(0),
                type: "plan_offset",
                metadata: {
                    source: "monthly_plan_credits",
                    periodStart: monthStart.toISOString(),
                },
            });
            if (debtOffset.offsetCredits > 0) {
                const offsetAllowed = await incrementUsage(
                    tx,
                    access.subjectKey,
                    "month",
                    monthStart,
                    monthRule.limit,
                    debtOffset.offsetCredits
                );
                if (!offsetAllowed) {
                    throw new ChatAccessError(
                        409,
                        CONCURRENT_RESERVATION_CONFLICT,
                        "Credit debt balance changed. Please retry.",
                        undefined,
                        { conflictScope: "credit_debt_offset" }
                    );
                }
            }
            const planRemaining = rawPlanRemaining - debtOffset.offsetCredits;
            const dailyRule = limitsFor(access).find(
                (rule) => rule.period === "day"
            );
            const dailyPlanUsed = dailyRule
                ? await readUsageCount(
                      tx,
                      access.subjectKey,
                      "day",
                      accessDayWindow.start
                  )
                : 0;
            const dailyPlanRemaining = dailyRule
                ? Math.max(0, dailyRule.limit - dailyPlanUsed)
                : null;
            const creditAllocation = getChatCreditAllocation({
                requiredCredits: budget.usageCredits,
                monthlyPlanCreditsRemaining: planRemaining,
                dailyPlanCreditsRemaining: dailyPlanRemaining,
                purchasedCreditsRemaining: 0,
            });
            planReservedCredits = creditAllocation.planReservedCredits;
            addOnReservedCredits = creditAllocation.addOnCreditsRequired;
            decisionState.availableCredits = creditAllocation.planCreditsAvailableNow;
            if (planReservedCredits > 0) {
                if (dailyRule) {
                    const dailyAllowed = await incrementUsage(
                        tx,
                        access.subjectKey,
                        "day",
                        accessDayWindow.start,
                        dailyRule.limit,
                        planReservedCredits
                    );
                    if (!dailyAllowed) {
                        throw new ChatAccessError(
                            409,
                            CONCURRENT_RESERVATION_CONFLICT,
                            "Daily plan credit balance changed. Please retry.",
                            undefined,
                            { conflictScope: "daily_plan_credits" }
                        );
                    }
                    reservationEntries.push({
                        key: access.subjectKey,
                        period: "day",
                        periodStart: accessDayWindow.start,
                        amount: planReservedCredits,
                        metric: "plan-credits",
                    });
                }
                const allowed = await incrementUsage(
                    tx,
                    access.subjectKey,
                    "month",
                    monthStart,
                    monthRule.limit,
                    planReservedCredits
                );
                if (!allowed) {
                    throw new ChatAccessError(
                        409,
                        CONCURRENT_RESERVATION_CONFLICT,
                        "Credit balance changed. Please retry.",
                        undefined,
                        { conflictScope: "monthly_plan_credits" }
                    );
                }
                reservationEntries.push({
                    key: access.subjectKey,
                    period: "month",
                    periodStart: monthStart,
                    amount: planReservedCredits,
                    metric: "plan-credits",
                });
            }
            if (addOnReservedCredits > 0) {
                addOnReservedCost = Math.ceil(
                    (reservedCost * addOnReservedCredits) / budget.usageCredits
                );
                try {
                    addOnReservations = await reserveAddOnCredits(tx, {
                        userId: access.userId,
                        reservationId,
                        credits: addOnReservedCredits,
                        fundedCostMicroUsd: addOnReservedCost,
                        now,
                    });
                } catch (error) {
                    if (error instanceof AddOnCreditError) {
                        if (error.code === "ADDON_COST_ALLOWANCE_INSUFFICIENT") {
                            throw new ChatAccessError(
                                402,
                                "CREDIT_COST_ALLOWANCE_INSUFFICIENT",
                                "Purchased credits do not include enough remaining AI cost allowance for this request.",
                                undefined,
                                // Same rejection, same reason as the
                                // comparison path above: micro-USD is internal.
                                {
                                    internalRequiredCostMicroUsd:
                                        addOnReservedCost,
                                    internalAvailableCostMicroUsd:
                                        error.availableFundedCostMicroUsd,
                                }
                            );
                        }
                        const currentAllocation = getChatCreditAllocation({
                            requiredCredits: budget.usageCredits,
                            monthlyPlanCreditsRemaining: planRemaining,
                            dailyPlanCreditsRemaining: dailyPlanRemaining,
                            purchasedCreditsRemaining: error.availableCredits,
                        });
                        if (currentAllocation.dailyPlanGuardrailBlocked) {
                            throw new ChatAccessError(
                                429,
                                "PLAN_DAILY_CREDIT_LIMIT_REACHED",
                                "The daily plan-credit guardrail is reached. Buy additional credits to continue now, or wait for the account-local reset.",
                                retryAfterFor("day", now, accessDayWindow.end),
                                {
                                    scope: "daily_plan_credits",
                                    requiredCredits: budget.usageCredits,
                                    dailyPlanLimit: dailyRule?.limit ?? 0,
                                    dailyPlanUsed,
                                    dailyPlanRemaining:
                                        dailyPlanRemaining ?? 0,
                                    monthlyPlanRemaining: planRemaining,
                                    purchasedCreditsAvailable:
                                        error.availableCredits,
                                    // Rolled forward for the same reason as
                                    // the account path above.
                                    resetAt: safeDailyResetAt(
                                        accessDayWindow.end,
                                        now
                                    ).toISOString(),
                                }
                            );
                        }
                        const planOnly = error.availableCredits === 0;
                        throw new ChatAccessError(
                            402,
                            planOnly
                                ? PLAN_ENTITLEMENT_EXHAUSTED
                                : CREDIT_BALANCE_INSUFFICIENT,
                            planOnly
                                ? "This month's plan credits are used up. Buy additional credits or upgrade to keep sending requests."
                                : "Not enough credits are available for this request.",
                            undefined,
                            {
                                requiredCredits: budget.usageCredits,
                                planCreditsAvailable:
                                    currentAllocation.planCreditsAvailableNow,
                                purchasedCreditsAvailable: error.availableCredits,
                                shortfallCredits: Math.max(
                                    0,
                                    budget.usageCredits -
                                        currentAllocation.totalCreditsAvailableNow
                                ),
                                resetAt: monthlyResetAt(now).toISOString(),
                            }
                        );
                    }
                    throw error;
                }
            }
        }

        if (
            access.kind === "user" &&
            (access.plan || "Free") === "Free" &&
            budget.minimumPlan === "Free" &&
            budget.modelUsageClass !== "standard"
        ) {
            const freeProMonthlyLimit = positiveInteger(
                process.env.CHAT_FREE_PRO_MODEL_RESPONSES_PER_MONTH,
                30
            );
            const allowed = await incrementUsage(
                tx,
                access.subjectKey,
                "pro-model-month",
                periodStart("month", now),
                freeProMonthlyLimit
            );
            if (!allowed) {
                throw new ChatAccessError(
                    429,
                    "FREE_PRO_MODEL_QUOTA_EXCEEDED",
                    "The Free plan includes up to 30 selected higher-cost model responses per month.",
                    retryAfterFor("month", now)
                );
            }
            reservationEntries.push({
                key: access.subjectKey,
                period: "pro-model-month",
                periodStart: periodStart("month", now),
                amount: 1,
                metric: "pro-response",
            });
        }

        // Same reservation, aggregate scope: a claimed slot already holds one
        // unit of this IP's minute. An unclaimed request still charges it here,
        // which is what keeps the single-model path unchanged.
        if (!claimedAdmissionSlot) {
            const ipMinuteStart = periodStart("minute", now);
            const ipScope = ipRateScope(access.ipKey, ipPerMinute);
            const ipAllowed = await incrementUsage(
                tx,
                ipScope.key,
                "minute",
                ipMinuteStart,
                ipScope.limit,
                1
            );
            if (!ipAllowed) {
                const retryAfterSeconds = retryAfterFor("minute", now);
                throw new ChatAccessError(
                    429,
                    CHAT_RATE_LIMITED,
                    rateLimitRejectionMessage(ipScope.scope),
                    retryAfterSeconds,
                    rateLimitRejectionDetails(ipScope, {
                        usedRequests: await readUsageCount(
                            tx,
                            ipScope.key,
                            "minute",
                            ipMinuteStart
                        ),
                        requestedRequests: 1,
                        retryAfterSeconds,
                        resetAt: new Date(ipMinuteStart.getTime() + 60_000),
                    })
                );
            }
        }
        if (access.kind === "guest") {
            for (const rule of limitsFor(access).filter(
                (rule) => rule.period !== "minute"
            )) {
                const allowed = await incrementUsage(
                    tx,
                    access.ipKey,
                    `guest-ip-${rule.period}`,
                    periodStart(rule.period, now),
                    rule.limit * 3,
                    budget.usageCredits
                );
                if (!allowed) {
                    throw new ChatAccessError(
                        429,
                        "CHAT_IP_QUOTA_EXCEEDED",
                        "Guest usage limit exceeded.",
                        retryAfterFor(rule.period, now)
                    );
                }
                reservationEntries.push({
                    key: access.ipKey,
                    period: `guest-ip-${rule.period}`,
                    periodStart: periodStart(rule.period, now),
                    amount: budget.usageCredits,
                    metric: "credits",
                });
            }
        }

        for (const rule of tokenLimits) {
            const allowed = await incrementUsage(
                tx,
                access.subjectKey,
                rule.period,
                rule.start,
                rule.limit,
                reservedTokens
            );
            if (!allowed) {
                throw new ChatAccessError(
                    429,
                    "CHAT_TOKEN_QUOTA_EXCEEDED",
                    "Chat token quota exceeded.",
                    retryAfterFor(
                        rule.period === "tokens-day" ? "day" : "month",
                        now,
                        rule.period === "tokens-day"
                            ? accessDayWindow.end
                            : undefined
                    )
                );
            }
            reservationEntries.push({
                key: access.subjectKey,
                period: rule.period,
                periodStart: rule.start,
                amount: reservedTokens,
                metric: "tokens",
            });
            if (access.kind === "guest") {
                const ipPeriod = `ip-${rule.period}`;
                const ipAllowed = await incrementUsage(
                    tx,
                    access.ipKey,
                    ipPeriod,
                    rule.start,
                    rule.limit * 3,
                    reservedTokens
                );
                if (!ipAllowed) {
                    throw new ChatAccessError(
                        429,
                        "CHAT_IP_TOKEN_QUOTA_EXCEEDED",
                        "Guest token quota exceeded.",
                        retryAfterFor(
                            rule.period === "tokens-day" ? "day" : "month",
                            now,
                            rule.period === "tokens-day"
                                ? accessDayWindow.end
                                : undefined
                        )
                    );
                }
                reservationEntries.push({
                    key: access.ipKey,
                    period: ipPeriod,
                    periodStart: rule.start,
                    amount: reservedTokens,
                    metric: "tokens",
                });
            }
        }

        for (const rule of costLimits) {
            // Purchased credits carry their own funded cost allowance on the
            // credit lot, so the plan-shaped guardrail must not charge the
            // add-on-funded share a second time. Only the total-cost guardrail
            // and the provider budget see the whole amount.
            const reservedRuleCost = rule.planFundedOnly
                ? reservedCost - addOnReservedCost
                : reservedCost;
            if (reservedRuleCost <= 0) continue;
            const allowed = await incrementUsage(
                tx,
                access.subjectKey,
                rule.period,
                rule.start,
                rule.limit,
                reservedRuleCost
            );
            if (!allowed) {
                const usedCost = await readUsageCount(
                    tx,
                    access.subjectKey,
                    rule.period,
                    rule.start
                );
                throw new ChatAccessError(
                    429,
                    OPERATIONAL_COST_GUARDRAIL_TRIGGERED,
                    "An internal cost safety check paused this request. Your credits are unaffected -- try again shortly or choose a lower-cost model.",
                    retryAfterFor(
                        rule.daily ? "day" : "month",
                        now,
                        rule.daily ? accessDayWindow.end : undefined
                    ),
                    {
                        scope: rule.scope,
                        limitLayer: "operational_guardrail",
                        resetAt: (rule.daily
                            ? safeDailyResetAt(accessDayWindow.end, now)
                            : monthlyResetAt(now)
                        ).toISOString(),
                        timeZone: rule.daily
                            ? accessDayWindow.timeZone
                            : "UTC",
                        internalUsedCostMicroUsd: usedCost,
                        internalRequiredCostMicroUsd: reservedRuleCost,
                        internalLimitCostMicroUsd: rule.limit,
                    }
                );
            }
            reservationEntries.push({
                key: access.subjectKey,
                period: rule.period,
                periodStart: rule.start,
                amount: reservedRuleCost,
                metric: rule.planFundedOnly ? "plan-cost" : "cost",
            });
            if (access.kind === "guest") {
                const ipPeriod = `ip-${rule.period}`;
                const ipAllowed = await incrementUsage(
                    tx,
                    access.ipKey,
                    ipPeriod,
                    rule.start,
                    rule.limit * 3,
                    reservedRuleCost
                );
                if (!ipAllowed) {
                    throw new ChatAccessError(
                        429,
                        "CHAT_IP_COST_QUOTA_EXCEEDED",
                        "Guest cost quota exceeded.",
                        retryAfterFor(
                            rule.period === "cost-day" ? "day" : "month",
                            now,
                            rule.period === "cost-day"
                                ? accessDayWindow.end
                                : undefined
                        )
                    );
                }
                reservationEntries.push({
                    key: access.ipKey,
                    period: ipPeriod,
                    periodStart: rule.start,
                    amount: reservedRuleCost,
                    metric: "cost",
                });
            }
        }

        // Anchored before the hold, and regardless of whether one is taken.
        // The period a turn's provider spend belongs to is decided when the
        // turn is authorized, not when somebody later needs a date -- so a
        // free primary that gets a paid fallback across UTC midnight still has
        // one answer, and it is this one.
        const providerBudgetPeriodStarts = {
            day: periodStart("day", now),
            month: periodStart("month", now),
        };
        if (reservedCost > 0) {
            const providerKey = providerBucketKey(budget.provider);
            const providerDayStart = providerBudgetPeriodStarts.day;
            const providerDayAllowed = await incrementUsage(
                tx,
                providerKey,
                "provider-cost-day",
                providerDayStart,
                providerDailyLimit,
                reservedCost
            );
            if (!providerDayAllowed) {
                throw new ChatAccessError(
                    503,
                    PROVIDER_BUDGET_EXHAUSTED,
                    "This AI provider is temporarily unavailable.",
                    undefined,
                    {
                        provider: budget.provider,
                        scope: "provider_cost_day",
                        limitLayer: "operational_guardrail",
                        alternativeModelIds: alternativeModelsForProvider(
                            budget.provider
                        ),
                        internalRequiredCostMicroUsd: reservedCost,
                        internalLimitCostMicroUsd: providerDailyLimit,
                    }
                );
            }
            reservationEntries.push({
                key: providerKey,
                period: "provider-cost-day",
                periodStart: providerDayStart,
                amount: reservedCost,
                metric: "cost",
            });

            const providerStart = providerBudgetPeriodStarts.month;
            const providerAllowed = await incrementUsage(
                tx,
                providerKey,
                "provider-cost-month",
                providerStart,
                providerMonthlyLimit,
                reservedCost
            );
            if (!providerAllowed) {
                throw new ChatAccessError(
                    503,
                    PROVIDER_BUDGET_EXHAUSTED,
                    "This AI provider is temporarily unavailable.",
                    undefined,
                    {
                        provider: budget.provider,
                        scope: "provider_cost_month",
                        limitLayer: "operational_guardrail",
                        alternativeModelIds: alternativeModelsForProvider(
                            budget.provider
                        ),
                        internalRequiredCostMicroUsd: reservedCost,
                        internalLimitCostMicroUsd: providerMonthlyLimit,
                    }
                );
            }
            reservationEntries.push({
                key: providerKey,
                period: "provider-cost-month",
                periodStart: providerStart,
                amount: reservedCost,
                metric: "cost",
            });
        }

        // The slot itself was claimed at the top of this transaction, before
        // anything was charged. A request that claimed nothing takes the
        // ordinary single-slot path here, unchanged.
        if (!claimedAdmissionSlot) {
            // Locks and the expiry sweep both already happened at the top of
            // the transaction.
            await assertConcurrencyCapacity(tx, concurrencyPlan, 1);
            await insertLeases(tx, [
                {
                    id: leaseId,
                    subjectKey: concurrencyPlan.subject.key,
                    ipKey: concurrencyPlan.ip?.key ?? null,
                    modelId: budget.modelId,
                    admissionId: null,
                    claimedAt: now,
                    expiresAt: new Date(
                        now.getTime() + leaseTtlSeconds * 1000
                    ),
                },
            ]);
        }

        durableReservation = {
            reservationId,
            userId: access.userId,
            traceId,
            source: reservationSource,
            modelId: budget.modelId,
            provider: budget.provider,
            entries: reservationEntries,
            // The primary's own provider hold, recorded as attempt 0's.
            //
            // Not bookkeeping for its own sake: `serializeReservation` derives
            // the `provider:` entries from these, so a reservation that left
            // the primary's hold out of them would lose that entry the first
            // time a fallback added one of its own -- and settlement would
            // then release nothing for the provider that actually ran.
            providerBudgetPeriodStarts,
            attemptHolds: reservationEntries
                .filter((entry) => entry.key.startsWith(PROVIDER_BUCKET_PREFIX))
                .map((entry) => ({
                    attemptIndex: 0,
                    key: entry.key,
                    period: entry.period,
                    periodStart: entry.periodStart,
                    amount: entry.amount,
                })),
            // What attempt 0 was authorized to spend, and at what rates.
            //
            // Written for every dispatch, including one whose rates are all
            // zero. The hold beside it is not: a hold is money put in a budget
            // bucket, and zero authorized puts none there. Separating the two
            // is what lets a crashed free turn still say what it was allowed
            // to spend -- nothing -- instead of leaving a sweep to guess
            // between "authorized nothing" and "lost its authorization".
            attemptCostIntents: [
                {
                    attemptIndex: 0,
                    modelId: budget.modelId,
                    provider: budget.provider,
                    estimatedInputTokens: budget.inputTokens,
                    reservedOutputTokens: budget.reservedOutputTokens,
                    inputUsdPerMillionTokens: budget.inputUsdPerMillionTokens,
                    outputUsdPerMillionTokens: budget.outputUsdPerMillionTokens,
                    cachedInputPriceMultiplier: budget.cachedInputPriceMultiplier,
                    pricingVersion: budget.pricingVersion ?? null,
                    reservedCostMicroUsd: reservedCost,
                },
            ],
            usageCredits: budget.usageCredits,
            inputTokens: budget.inputTokens,
            maxOutputTokens: budget.maxOutputTokens,
            reservedOutputTokens: budget.reservedOutputTokens,
            inputUsdPerMillionTokens: budget.inputUsdPerMillionTokens,
            outputUsdPerMillionTokens: budget.outputUsdPerMillionTokens,
            cachedInputPriceMultiplier: budget.cachedInputPriceMultiplier,
            planReservedCredits,
            addOnReservedCredits,
            addOnReservations,
            // Frozen with the reservation: a later price change must never
            // re-settle an existing reservation at the new rate.
            pricingVersion: budget.pricingVersion,
            costSource: budget.costSource,
            longContextThresholdTokens: budget.longContextThresholdTokens,
        };
        await tx.chatCreditReservation.create({
            data: {
                id: reservationId,
                userId: access.userId || null,
                subjectKey: access.subjectKey,
                traceId,
                source: reservationSource,
                provider: budget.provider,
                modelId: budget.modelId,
                status: "reserved",
                idempotencyKey: `chat-credit-reservation:${reservationId}:v1`,
                reservationPayload: serializeReservation(durableReservation),
                reservedCredits: budget.usageCredits,
                reservedCostMicroUsd: BigInt(reservedCost),
                planReservedCredits,
                addOnReservedCredits,
                expiresAt: reservationExpiresAt,
            },
        });
    });
    } catch (error) {
        if (error instanceof ChatAccessError) {
            await recordDecision(error);
            if (isConcurrencyCode(error.code)) {
                logConcurrencyRejection({
                    traceId,
                    phase: "chat_reservation",
                    kind: access.kind,
                    subjectKey: access.subjectKey,
                    error,
                    comparisonId: admissionSlot?.comparisonId ?? null,
                    leaseTtlSeconds,
                });
            }
        }
        throw error;
    }

    if (!durableReservation) {
        throw new Error("Durable chat credit reservation was not created.");
    }
    if (shouldRecordAllowedDecisions()) {
        await recordDecision();
    }

    return {
        leaseId,
        setCookie: access.setCookie,
        usageReservation: durableReservation,
    };
};

export const settleChatUsage = async (
    reservation: ChatUsageReservation,
    turnUsage: {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
        /**
         * Reasoning/thinking tokens the provider reported. Already inside
         * `outputTokens` for every model priced here, so it is recorded for
         * observability rather than billed a second time.
         */
        reasoningTokens?: number;
        /** True when the numbers came from provider usage metadata. */
        usageFromProvider?: boolean;
        outcome: "completed" | "cancelled" | "failed" | "empty";
        /** Extra credits reserved on top of the base weight for a native web search attempt. */
        searchSurchargeCredits?: number;
        /** Whether the provider actually executed a search this turn -- refund the surcharge if not. */
        searchExecuted?: boolean;
        /** Native web search's own per-call provider cost (OpenAI/Anthropic/Google), from webSearchExecutionNormalizer's costMetadata. Never set for Perplexity -- its own reported response cost already covers search. */
        searchCostMicroUsd?: number;
        searchQueryCount?: number;
    },
    options?: {
        reconciled?: boolean;
        reason?: string;
        providerUsageSnapshot?: PerplexityUsageCostSnapshot | null;
        /**
         * Every dispatched attempt of this response, when there was more than
         * one (routing policy §7's automatic fallback).
         *
         * Absent is the whole of today's traffic and settles exactly as it
         * always has -- `turnUsage` above is the turn, priced at the reservation's
         * own snapshot. Present splits the two ledgers §7 keeps apart: the
         * user is charged from one accepted attempt, and every attempt's real
         * cost lands on its own provider's budget at its own rates. See
         * lib/chatMultiAttemptSettlement.ts for why that is two ledgers and
         * not one number.
         */
        attempts?: readonly AttemptUsage[];
    }
) => {
    // Validated before it is interpreted. A malformed attempt set settles
    // silently wrong -- a duplicate index overwrites an audit row, a gap means
    // an attempt was lost between dispatch and here -- so the refusal comes
    // first and, deliberately, before the transaction: nothing has been locked
    // and no money has moved when it raises.
    if (options?.attempts?.length) {
        const problems = attemptSetProblems(options.attempts);
        if (problems.length > 0) {
            throw new Error(
                `Chat attempt set cannot be settled: ${problems.join(" ")}`
            );
        }
    }
    const multiAttempt = options?.attempts?.length
        ? combineAttemptUsage(options.attempts)
        : null;
    const settlement = await prisma.$transaction(async (tx) => {
        if (reservation.userId) {
            await lockCreditAccount(tx, reservation.userId);
        }
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`chat-credit-reservation:${reservation.reservationId}`}))`;
        const durable = await tx.chatCreditReservation.findUnique({
            where: { id: reservation.reservationId },
        });
        if (!durable) {
            throw new Error("Durable chat credit reservation was not found.");
        }
        if (durable.status !== "reserved") {
            return {
                applied: false,
                status: durable.status,
                actualInput: 0,
                actualOutput: 0,
                actualCachedInput: 0,
                actualCost: 0,
                provider: durable.provider as AiModel["provider"],
                modelId: durable.modelId,
            };
        }
        if (
            durable.idempotencyKey !==
            `chat-credit-reservation:${reservation.reservationId}:v1`
        ) {
            throw new Error("Chat credit reservation idempotency key mismatch.");
        }

        const canonical = deserializeReservation(durable.reservationPayload);
        // The user's half of §7's split. With one dispatched attempt this *is*
        // the caller's `usage`; with two it is the accepted attempt's, because
        // the user is charged for the answer that arrived and not for
        // Tomverse's own decision to ask a second model. The other half --
        // every attempt's real cost at its own provider -- is applied to the
        // provider buckets further down and never passes through here.
        const billedAttempt = multiAttempt?.billedAttempt ?? null;
        const usage: typeof turnUsage = billedAttempt
            ? {
                  ...turnUsage,
                  inputTokens: billedAttempt.inputTokens,
                  cachedInputTokens: billedAttempt.cachedInputTokens,
                  outputTokens: billedAttempt.outputTokens,
                  reasoningTokens: billedAttempt.reasoningTokens,
                  usageFromProvider: billedAttempt.usageFromProvider,
                  outcome: multiAttempt!.outcome,
                  // Taken from the billed attempt too: the search cost is a
                  // per-call provider charge, and the primary's would be
                  // charged for a search the user's answer never used.
                  searchCostMicroUsd: billedAttempt.searchCostMicroUsd,
                  searchQueryCount: billedAttempt.searchQueryCount,
              }
            : turnUsage;
        const actualInput = Number.isSafeInteger(usage.inputTokens)
            ? Math.max(0, usage.inputTokens!)
            : canonical.inputTokens;
        const actualOutput = Number.isSafeInteger(usage.outputTokens)
            ? Math.max(0, usage.outputTokens!)
            : canonical.reservedOutputTokens;
        const actualCachedInput = Math.min(
            actualInput,
            Number.isSafeInteger(usage.cachedInputTokens)
                ? Math.max(0, usage.cachedInputTokens!)
                : 0
        );
        const actualTokens = actualInput + actualOutput;
        const actualCredits = getSettledUsageCredits({
            reservedCredits: canonical.usageCredits,
            reservedInputTokens: canonical.inputTokens,
            reservedOutputTokens: canonical.reservedOutputTokens,
            actualInputTokens: actualInput,
            actualOutputTokens: actualOutput,
            outcome: usage.outcome,
            searchSurchargeCredits: usage.searchSurchargeCredits,
            searchExecuted: usage.searchExecuted,
        });
        const tokenCostBreakdown = calculateProviderUsageCost({
            inputTokens: actualInput,
            cachedInputTokens: actualCachedInput,
            outputTokens: actualOutput,
            inputUsdPerMillionTokens: canonical.inputUsdPerMillionTokens,
            outputUsdPerMillionTokens: canonical.outputUsdPerMillionTokens,
            cachedInputPriceMultiplier:
                canonical.cachedInputPriceMultiplier,
        });
        const providerUsageSnapshot =
            canonical.provider === "perplexity" &&
            options?.providerUsageSnapshot?.source ===
                "perplexity_response_usage"
                ? options.providerUsageSnapshot
                : null;
        const baseCostBreakdown = providerUsageSnapshot
            ? {
                  ...tokenCostBreakdown,
                  costSource: "provider_response" as const,
                  tokenEstimatedTotalCostMicroUsd:
                      tokenCostBreakdown.totalCostMicroUsd,
                  totalCostMicroUsd:
                      providerUsageSnapshot.totalCostMicroUsd,
                  uncachedInputCostMicroUsd:
                      providerUsageSnapshot.inputTokensCostMicroUsd ??
                      tokenCostBreakdown.uncachedInputCostMicroUsd,
                  cachedInputCostMicroUsd: 0,
                  outputCostMicroUsd:
                      providerUsageSnapshot.outputTokensCostMicroUsd ??
                      tokenCostBreakdown.outputCostMicroUsd,
              }
            : { ...tokenCostBreakdown, costSource: "token_estimate" as const };
        // Provider usage metadata is authoritative; the estimator is only the
        // documented fallback for a response that never reported usage.
        const usageSource: "provider_usage_metadata" | "fallback_estimator" =
            usage.usageFromProvider === false
                ? "fallback_estimator"
                : Number.isSafeInteger(usage.outputTokens)
                  ? "provider_usage_metadata"
                  : "fallback_estimator";
        // Native web search's own per-call provider cost (never sent by the
        // client -- derived server-side from the AI SDK's provider response,
        // see lib/webSearchExecutionNormalizer.ts). Perplexity always takes
        // the providerUsageSnapshot branch above instead, so this stays 0
        // there and can never double-count its already-reported cost.
        const searchCostMicroUsd = Math.max(
            0,
            Number.isFinite(usage.searchCostMicroUsd)
                ? Math.round(usage.searchCostMicroUsd!)
                : 0
        );
        const costBreakdown =
            searchCostMicroUsd > 0
                ? {
                      ...baseCostBreakdown,
                      tokenCostMicroUsd: baseCostBreakdown.totalCostMicroUsd,
                      searchCostMicroUsd,
                      searchQueryCount: Math.max(
                          0,
                          Number.isSafeInteger(usage.searchQueryCount)
                              ? usage.searchQueryCount!
                              : 0
                      ),
                      totalCostMicroUsd:
                          baseCostBreakdown.totalCostMicroUsd + searchCostMicroUsd,
                  }
                : baseCostBreakdown;
        const actualCost = costBreakdown.totalCostMicroUsd;
        // One value for the cost row and its rollup, read once. A turn that
        // settles either side of midnight UTC must not put the row on one day
        // and the spend on another -- a later correction has to find both.
        const rollupDay = rollupDayOf();
        /**
         * The turn that dispatched once, as an attempt.
         *
         * Built here so the single-attempt path settles through exactly the
         * writer the fallback path uses: one row, one rollup, one transaction.
         * Null when nothing was used and nothing cost -- an expiry reconciled
         * to a full refund records no spend, and a row of zeroes would put a
         * call that never completed into the ledger of calls that did.
         */
        const singleAttempt: LedgerAttempt | null =
            !multiAttempt &&
            (actualInput > 0 || actualOutput > 0 || actualCost > 0)
                ? {
                      attemptIndex: 0,
                      price: {
                          provider: canonical.provider,
                          modelId: canonical.modelId,
                          inputUsdPerMillionTokens:
                              canonical.inputUsdPerMillionTokens,
                          outputUsdPerMillionTokens:
                              canonical.outputUsdPerMillionTokens,
                          cachedInputPriceMultiplier:
                              canonical.cachedInputPriceMultiplier,
                          pricingVersion: canonical.pricingVersion ?? null,
                      },
                      inputTokens: actualInput,
                      cachedInputTokens: actualCachedInput,
                      outputTokens: actualOutput,
                      reasoningTokens: Number.isSafeInteger(usage.reasoningTokens)
                          ? Math.max(0, usage.reasoningTokens!)
                          : undefined,
                      usageFromProvider: usageSource === "provider_usage_metadata",
                      outcome: usage.outcome,
                      costMicroUsd: actualCost,
                      costSource: costBreakdown.costSource,
                      userBilled: actualCredits > 0,
                      // From the reservation row, where
                      // `linkChatReservationProviderRequest` put them. A
                      // single-attempt turn has exactly one of each, so the
                      // reservation's own columns are the whole answer.
                      providerRequestId: durable.providerRequestId,
                      providerResponseId: durable.providerResponseId,
                  }
                : null;
        const planActualCredits = Math.min(
            actualCredits,
            canonical.planReservedCredits
        );
        const addOnActualCredits = Math.max(
            0,
            actualCredits - planActualCredits
        );
        const addOnActualCost =
            actualCredits > 0 && addOnActualCredits > 0
                ? Math.ceil((actualCost * addOnActualCredits) / actualCredits)
                : 0;
        const planActualCost = Math.max(0, actualCost - addOnActualCost);

        // A provider's spend bucket settles to what *that provider* was paid,
        // which stops being `actualCost` the moment a turn dispatches twice.
        // The primary's bucket is settled from the primary's own attempt and
        // the fallback provider -- which the reservation never held anything
        // against -- is incremented separately below.
        const providerCostFor = (key: string): number | null => {
            if (!multiAttempt || !key.startsWith(PROVIDER_BUCKET_PREFIX)) return null;
            const provider = key.slice(PROVIDER_BUCKET_PREFIX.length);
            return multiAttempt.costByProvider.get(
                provider as AiModel["provider"]
            ) ?? 0;
        };

        for (const entry of canonical.entries) {
            const providerCost = providerCostFor(entry.key);
            const actual =
                providerCost !== null
                    ? providerCost
                    : entry.metric === "tokens"
                    ? actualTokens
                    : entry.metric === "cost"
                      ? actualCost
                      : entry.metric === "plan-cost"
                        ? planActualCost
                        : entry.metric === "plan-credits"
                          ? planActualCredits
                          : entry.metric === "credits"
                            ? actualCredits
                            : actualCredits > 0
                              ? 1
                              : 0;
            const difference = actual - entry.amount;
            if (difference > 0) {
                await tx.chatUsageBucket.updateMany({
                    where: {
                        key: entry.key,
                        period: entry.period,
                        periodStart: entry.periodStart,
                    },
                    data: { count: { increment: difference } },
                });
            } else if (difference < 0) {
                const refundAmount = Math.abs(difference);
                await tx.$executeRaw`
                    UPDATE "ChatUsageBucket"
                    SET "count" = GREATEST(0, "count" - ${refundAmount}),
                        "updatedAt" = NOW()
                    WHERE "key" = ${entry.key}
                      AND "period" = ${entry.period}
                      AND "periodStart" = ${entry.periodStart}
                `;
            }
        }
        if (multiAttempt) {
            // The providers the reservation never held anything against.
            // Their spend has to land somewhere or a fallback is free as far
            // as the budget that is supposed to bound it can tell -- and a
            // provider budget that cannot see its own spend keeps saying yes.
            //
            // The period comes from the reservation's own anchor, decided when
            // the turn was authorized. It used to be borrowed from whichever
            // held entry happened to share the period -- which worked only
            // while something was held. A turn whose primary reserved nothing
            // had no entry to borrow from, so a fallback's real spend was
            // silently dropped: exactly the "a provider budget that cannot see
            // its own spend keeps saying yes" this block exists to prevent.
            //
            // Not a clock read here either. The attempts ran inside this
            // request, so they belong to the day the request was authorized
            // in, and "now" would put a turn that started at 23:59:59 in the
            // wrong one.
            const heldProviders = new Set(
                canonical.entries
                    .filter((entry) => entry.key.startsWith(PROVIDER_BUCKET_PREFIX))
                    .map((entry) => entry.key.slice(PROVIDER_BUCKET_PREFIX.length))
            );
            const anchor =
                canonical.providerBudgetPeriodStarts ??
                legacyProviderBudgetAnchor(canonical.attemptHolds ?? []);
            for (const [provider, cost] of multiAttempt.costByProvider) {
                if (heldProviders.has(provider) || cost <= 0) continue;
                if (!anchor) {
                    // A payload with neither an anchor nor a hold to recover
                    // one from. Recorded rather than guessed at: putting real
                    // spend in a period nobody chose is worse than an operator
                    // knowing a figure is missing.
                    console.error(JSON.stringify({
                        event: "chat_provider_spend_unanchored",
                        reservationId: durable.id,
                        provider,
                        costMicroUsd: cost,
                    }));
                    continue;
                }
                for (const period of PROVIDER_BUDGET_PERIODS) {
                    const periodStartForSpend =
                        period === "provider-cost-day" ? anchor.day : anchor.month;
                    await tx.$executeRaw`
                        INSERT INTO "ChatUsageBucket" ("key", "period", "periodStart", "count", "updatedAt")
                        VALUES (${providerBucketKey(provider)}, ${period}, ${periodStartForSpend}, ${cost}, NOW())
                        ON CONFLICT ("key", "period", "periodStart")
                        DO UPDATE SET
                            "count" = "ChatUsageBucket"."count" + ${cost},
                            "updatedAt" = NOW()
                    `;
                }
            }
        }
        if (canonical.userId && canonical.addOnReservations.length > 0) {
            await settleAddOnCredits(tx, {
                userId: canonical.userId,
                reservationId: canonical.reservationId,
                entries: canonical.addOnReservations,
                settledCredits: addOnActualCredits,
                settledFundedCostMicroUsd: addOnActualCost,
                outcome: usage.outcome,
            });
        }

        const terminalStatus = actualCredits > 0 ? "settled" : "refunded";
        await tx.chatCreditReservation.update({
            where: { id: durable.id },
            data: {
                status: terminalStatus,
                outcome: usage.outcome,
                settledCredits: actualCredits,
                settledCostMicroUsd: BigInt(actualCost),
                settledInputTokens: actualInput,
                settledCachedInputTokens: actualCachedInput,
                settledOutputTokens: actualOutput,
                pricingSnapshot: {
                    ...costBreakdown,
                    pricingVersion: canonical.pricingVersion ?? null,
                    reservationCostSource: canonical.costSource ?? null,
                    longContextThresholdTokens:
                        canonical.longContextThresholdTokens ?? null,
                    usageSource,
                    reasoningTokens: Number.isSafeInteger(usage.reasoningTokens)
                        ? Math.max(0, usage.reasoningTokens!)
                        : null,
                },
                providerUsageSnapshot: providerUsageSnapshot ?? undefined,
                // The attempt the user's charge came from, written in the same
                // transaction as the terminal status. Write-once at the
                // database, so a later goodwill refund cannot re-attribute it.
                //
                // Only when the user was actually charged. A full refund
                // charged for no attempt, and naming one would be a claim that
                // some attempt was billed when none was -- the case crash
                // reconciliation made ordinary.
                ...(multiAttempt?.billedAttempt
                    ? {
                          settlementAttemptIndex:
                              multiAttempt.billedAttempt.attemptIndex,
                      }
                    : singleAttempt && actualCredits > 0
                      ? { settlementAttemptIndex: 0 }
                      : {}),
                settledAt: new Date(),
                reconciledAt: options?.reconciled ? new Date() : null,
                lastError: options?.reason?.slice(0, 500) || null,
            },
        });

        // The last database work this transaction does, and deliberately so.
        //
        // `ProviderDailyUsage` is keyed on (provider, model, day), which makes
        // it one row shared by every turn on that model -- the hottest row this
        // system has. Whoever touches it holds it until COMMIT, so touching it
        // early would serialise every concurrent turn on that model across the
        // whole tail of this transaction: the add-on credits, the reservation
        // update, the shadow record. Touching it last narrows that to the
        // commit itself.
        //
        // Still inside the transaction, because the cost row and its rollup
        // have to be as durable as the settlement that justifies them -- and
        // for the same reason this is one call rather than a row-writing step
        // and a rollup step somebody could later forget to pair.
        //
        // Sorted by (provider, model) so two settlements that both touch two
        // rollup rows take them in one order and cannot deadlock on each other.
        const accruals = multiAttempt
            ? [...multiAttempt.attempts]
                  .sort((a, b) =>
                      `${a.price.provider}/${a.price.modelId}`.localeCompare(
                          `${b.price.provider}/${b.price.modelId}`
                      )
                  )
                  .map((attempt) => ({
                      reservationId: durable.id,
                      attempt,
                      rollupDate: rollupDay,
                      snapshot: { settlementVersion: multiAttempt.version },
                  }))
            : singleAttempt
              ? [
                    {
                        reservationId: durable.id,
                        attempt: singleAttempt,
                        rollupDate: rollupDay,
                        // Handed over rather than recomputed: a provider that
                        // reports its own component costs has already had them
                        // resolved here, and pricing from tokens again would
                        // write a different split for the same total.
                        rollup: {
                            uncachedInputCostMicroUsd:
                                costBreakdown.uncachedInputCostMicroUsd,
                            cachedInputCostMicroUsd:
                                costBreakdown.cachedInputCostMicroUsd,
                            outputCostMicroUsd: costBreakdown.outputCostMicroUsd,
                        },
                        // Named apart from the row's own `usageSource`
                        // column, which is derived and authoritative. They can
                        // legitimately differ -- a provider that reports a cost
                        // makes the column `provider_response_cost` while this
                        // stays `provider_usage_metadata` -- and one row saying
                        // two things under one name is a trap for whoever reads
                        // the snapshot.
                        snapshot: { settlementUsageSource: usageSource },
                    },
                ]
              : [];
        for (const accrual of accruals) {
            await recordAttemptCost(tx, accrual);
        }

        return {
            applied: true,
            status: terminalStatus,
            actualInput,
            actualOutput,
            actualCachedInput,
            actualCost,
            costBreakdown,
            provider: canonical.provider,
            modelId: canonical.modelId,
            shadow: {
                attemptId: reservation.reservationId,
                providerReportedInputTokens: Number.isSafeInteger(usage.inputTokens)
                    ? Math.max(0, usage.inputTokens!)
                    : null,
                inputUsageSource: resolveInputUsageSource({
                    providerReportedInputTokens: usage.inputTokens,
                    providerReturnedUsage: usage.usageFromProvider !== false,
                }),
                outcome:
                    usage.outcome === "completed"
                        ? ("completed" as const)
                        : usage.outcome === "cancelled"
                          ? ("cancelled" as const)
                          : ("failed" as const),
                // The settlement path receives no partial-stream signal, so
                // this stays false until it does. A cancelled turn is already
                // excluded from calibration on its own flag.
                isPartial: false,
                isCancelled: usage.outcome === "cancelled",
            },
        };
    });

    // Shadow telemetry, after the commit and never inside it.
    //
    // Two reasons, and the first is not about speed. `recordShadowSettlement`
    // swallows its own errors because the module's contract is that shadow
    // telemetry never fails a paid request -- but a statement that fails on a
    // transaction's own connection aborts that transaction whatever the caller
    // does with the exception, so running it inside would have made the
    // contract untrue in exactly the case it exists for. It also ran on the
    // global client while this transaction held a connection, which is a
    // second connection acquired per settlement and a pool that can deadlock
    // against itself under load.
    //
    // After the commit it also cannot record a settlement that did not happen:
    // a rolled-back turn now leaves no shadow sample claiming it settled.
    //
    // Provenance is decided from the provider's *input* count alone --
    // deliberately not from `usageSource`, which is decided by whether output
    // tokens arrived. A turn that reported output but not input has an input
    // figure that is the estimate itself, and calibrating on it would compare
    // an estimate with a copy of itself.
    if (settlement.applied && settlement.shadow) {
        await recordShadowSettlement(settlement.shadow);
    }

    // Every accrual now happens inside the settlement transaction, single
    // attempt and fallback alike, so nothing is recorded here.
    //
    // What stays outside is the alert, and deliberately: it is a notification
    // about a balance, it talks to something other than this database, and a
    // slow or failing provider API must not hold a settlement transaction open
    // or roll one back.
    if (
        settlement.applied &&
        !multiAttempt &&
        settlement.costBreakdown &&
        (settlement.actualInput > 0 ||
            settlement.actualOutput > 0 ||
            settlement.actualCost > 0)
    ) {
        if (settlement.provider === "zhipu") {
            await notifyProviderCreditIfNeeded(settlement.provider).catch(
                (error) =>
                    console.error("Provider credit alert failed:", {
                        provider: settlement.provider,
                        modelId: settlement.modelId,
                        error,
                    })
            );
        }
    }
    if (settlement.applied && multiAttempt) {
        // A notification, not accounting: fired after the transaction so a
        // provider alert cannot roll settlement back.
        for (const provider of multiAttempt.costByProvider.keys()) {
            if (provider !== "zhipu") continue;
            await notifyProviderCreditIfNeeded("zhipu").catch((error) =>
                console.error("Provider credit alert failed:", { provider, error })
            );
        }
    }
    return { applied: settlement.applied, status: settlement.status };
};

// Heartbeat for a reservation backing a long-running async job (Perplexity
// deep research can run well past the 30-minute ceiling acquireChatAccess
// clamps CHAT_RESERVATION_TTL_SECONDS to). Called on every poll that finds
// the job still running, so reconcileExpiredChatCreditReservations' 15-minute
// sweep doesn't forcibly refund/close a reservation whose job is still
// legitimately in progress. No-ops if the reservation already settled.
export const extendChatReservationExpiry = async (
    reservationId: string,
    additionalSeconds: number
) => {
    await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`chat-credit-reservation:${reservationId}`}))`;
        const durable = await tx.chatCreditReservation.findUnique({
            where: { id: reservationId },
            select: { status: true },
        });
        if (!durable || durable.status !== "reserved") return;
        await tx.chatCreditReservation.update({
            where: { id: reservationId },
            data: { expiresAt: new Date(Date.now() + additionalSeconds * 1000) },
        });
    });
};

/**
 * Takes an attempt's own provider-budget hold, and records whose it is.
 *
 * §10: every dispatch is authorized on the server "including fallback and
 * Planner pass-through", and a provider budget is one of those
 * authorizations.
 *
 * ## Every fallback reserves, including one on the same provider
 *
 * An earlier version returned early when the fallback ran on the provider the
 * primary was already holding against, on the grounds that "the hold already
 * covers it". It does not. A hold is sized for one attempt, and a second call
 * -- same provider, different model -- costs more. Settlement increments a
 * bucket past its hold without re-checking any limit, so the excess went
 * through as spend the guardrail had never authorized. That the second model
 * shares a bucket with the first is a fact about the key, not about the money.
 *
 * The hold goes into `attemptHolds` under this attempt's index, and the
 * provider entry is re-derived as the sum. See lib/chatProviderHolds.ts for
 * why the entries alone cannot carry this.
 */
/**
 * The provider entries of a pre-`attemptHolds` reservation, read as attempt
 * 0's holds.
 *
 * The primary is the only thing that can have put them there: the holds list
 * arrived with automatic fallback, and before it a turn dispatched once.
 */
const adoptLegacyProviderHolds = (
    reservation: ChatUsageReservation
): AttemptHold[] =>
    reservation.entries
        .filter((entry) => entry.key.startsWith(PROVIDER_BUCKET_PREFIX))
        .map((entry) => ({
            attemptIndex: 0,
            key: entry.key,
            period: entry.period,
            periodStart: entry.periodStart,
            amount: entry.amount,
        }));

export const reserveAttemptProviderBudget = async (input: {
    reservationId: string;
    userId?: string | null;
    attemptIndex: number;
    provider: string;
    reservedMicroUsd: number;
    /**
     * What this attempt is authorized to spend, at its own rates.
     *
     * Required, and stored in the same transaction as the hold: a hold with no
     * intent leaves a crash unable to record anything at all, which is the gap
     * this mechanism exists to close.
     */
    costIntent: Omit<AttemptCostIntent, "attemptIndex" | "reservedCostMicroUsd">;
}): Promise<
    | { reserved: false; reason: "reservation_not_open" }
    | { reserved: false; reason: "already_authorized" }
    | { reserved: false; reason: "no_provider_budget_period" }
    | { reserved: false; reason: "budget_exhausted"; scope: string }
    | { reserved: true; entries: ReservationEntry[] }
> => {
    const limits = getProviderCostGuardrailLimits(input.provider);
    const amount = Math.max(0, Math.round(input.reservedMicroUsd));
    const key = providerBucketKey(input.provider);

    return prisma.$transaction(async (tx) => {
        // Same order as settlement: the credit account first, then the
        // reservation's advisory lock. Two paths taking one pair of locks in
        // different orders is the deadlock this ordering exists to avoid.
        if (input.userId) {
            await lockCreditAccount(tx, input.userId);
        }
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`chat-credit-reservation:${input.reservationId}`}))`;
        const durable = await tx.chatCreditReservation.findUnique({
            where: { id: input.reservationId },
        });
        if (!durable || durable.status !== "reserved") {
            // Settled, refunded or reconciled while this turn was running.
            // A hold against a closed reservation is one nothing would release.
            throw new AttemptBudgetRefusal("reservation_not_open");
        }
        const canonical = deserializeReservation(durable.reservationPayload);

        // A reservation written before `attemptHolds` existed carries its
        // primary hold only in `entries`. Adopting it as attempt 0's is not
        // bookkeeping: `serializeReservation` derives the provider entries
        // from the holds, so writing a fallback hold onto an empty list would
        // rebuild the entries from that hold alone and the primary's would
        // vanish -- leaving a hold in the bucket that nothing would ever
        // release.
        //
        // Before the duplicate check, not after: an adopted hold is an
        // authorization this attempt has to be measured against too.
        const existing = canonical.attemptHolds ?? adoptLegacyProviderHolds(canonical);
        if (!canonical.attemptHolds && existing.length > 0) {
            // Adopted holds need adopted intents, or the payload fails its own
            // consistency check on the next read. The rates are the
            // reservation's own, which is what the primary ran at.
            canonical.attemptCostIntents = [
                {
                    attemptIndex: 0,
                    modelId: canonical.modelId,
                    provider: canonical.provider,
                    estimatedInputTokens: canonical.inputTokens,
                    reservedOutputTokens: canonical.reservedOutputTokens,
                    inputUsdPerMillionTokens: canonical.inputUsdPerMillionTokens,
                    outputUsdPerMillionTokens: canonical.outputUsdPerMillionTokens,
                    cachedInputPriceMultiplier: canonical.cachedInputPriceMultiplier,
                    pricingVersion: canonical.pricingVersion ?? null,
                    reservedCostMicroUsd: existing[0]?.amount ?? 0,
                },
            ];
        }
        const existingIntents = canonical.attemptCostIntents ?? [];

        // The period comes from the reservation, never from the caller and
        // never from a clock read here.
        //
        // A turn that began at 23:59:59 and reaches its fallback a second
        // later belongs to the day it was authorized in, and a caller passing
        // "now" would split one logical response across two provider budget
        // periods -- the second of which nothing would release, because
        // settlement releases what the payload says was held.
        //
        // A payload written before the anchor existed can still answer, from
        // the holds it already carries: those were taken at the same moment,
        // so their own periodStart *is* the anchor. One that carries neither
        // is refused. Reconstructing a period from a user's `day` bucket would
        // be reading an account-local reckoning as a UTC one, and from
        // `createdAt` would be reading the database's clock instead of the one
        // the reservation was computed against -- both are guesses, and a
        // guess here puts real money in the wrong period.
        const anchor =
            canonical.providerBudgetPeriodStarts ??
            legacyProviderBudgetAnchor(existing);
        if (!anchor) {
            throw new AttemptBudgetRefusal("no_provider_budget_period");
        }
        const checks = [
            {
                period: "provider-cost-day" as const,
                start: anchor.day,
                limit: limits.day,
                scope: "provider_cost_day",
            },
            {
                period: "provider-cost-month" as const,
                start: anchor.month,
                limit: limits.month,
                scope: "provider_cost_month",
            },
        ];

        // Already authorized, by either half.
        //
        // Checking the holds alone was enough while a hold was the only thing
        // an authorization produced. It stopped being enough the moment a zero
        // authorization began writing an intent and no hold: a second zero
        // call would find no hold, pass, and append a duplicate intent for one
        // index -- which the payload validator refuses on the next read, so
        // the reservation would stop being readable at all and its money would
        // be stuck. A retry of this call, or two dispatches claiming one
        // index, has to be refused whichever shape the first one left.
        if (
            existing.some((hold) => hold.attemptIndex === input.attemptIndex) ||
            existingIntents.some(
                (intent) => intent.attemptIndex === input.attemptIndex
            )
        ) {
            throw new AttemptBudgetRefusal("already_authorized");
        }

        const authorized = (reservedCostMicroUsd: number): AttemptCostIntent[] => [
            ...existingIntents,
            {
                ...input.costIntent,
                attemptIndex: input.attemptIndex,
                reservedCostMicroUsd,
            },
        ];

        // Nothing to put in a bucket, but there is still something to
        // authorize. The intent is written and the hold is not, which is
        // exactly the shape acquisition leaves for a free primary.
        //
        // Refusing on the budget would be the other way to handle zero, and it
        // is the wrong one: a call that reserves nothing consumes none of the
        // budget the guardrail bounds, so there is nothing for it to refuse.
        if (amount === 0) {
            await tx.chatCreditReservation.update({
                where: { id: durable.id },
                data: {
                    reservationPayload: serializeReservation({
                        ...canonical,
                        providerBudgetPeriodStarts: anchor,
                        attemptHolds: existing,
                        attemptCostIntents: authorized(0),
                    }),
                },
            });
            return { reserved: true as const, entries: [] };
        }

        const entries: ReservationEntry[] = [];
        for (const check of checks) {
            const allowed = await incrementUsage(
                tx,
                key,
                check.period,
                check.start,
                check.limit,
                amount
            );
            if (!allowed) {
                // Rolls the whole transaction back, including a day hold taken
                // before the month check refused.
                throw new AttemptBudgetRefusal(check.scope);
            }
            entries.push({
                key,
                period: check.period,
                periodStart: check.start,
                amount,
                metric: "cost",
            });
        }

        const holds: AttemptHold[] = [
            ...existing,
            ...entries.map((entry) => ({
                attemptIndex: input.attemptIndex,
                key: entry.key,
                period: entry.period,
                periodStart: entry.periodStart,
                amount: entry.amount,
            })),
        ];
        await tx.chatCreditReservation.update({
            where: { id: durable.id },
            data: {
                // `serializeReservation` re-derives the provider entries from
                // the holds, so a same-provider hold lands as a larger amount
                // on the one entry rather than a second row settlement would
                // pay twice.
                reservationPayload: serializeReservation({
                    ...canonical,
                    providerBudgetPeriodStarts: anchor,
                    attemptHolds: holds,
                    attemptCostIntents: authorized(amount),
                }),
            },
        });
        return { reserved: true as const, entries };
    }).catch((error) => {
        if (error instanceof AttemptBudgetRefusal) {
            return error.scope === "reservation_not_open" ||
                error.scope === "already_authorized" ||
                error.scope === "no_provider_budget_period"
                ? { reserved: false as const, reason: error.scope }
                : {
                      reserved: false as const,
                      reason: "budget_exhausted" as const,
                      scope: error.scope,
                  };
        }
        throw error;
    });
};

/**
 * Gives back one attempt's hold, and only that attempt's.
 *
 * By index, never by provider. Two attempts on one provider share a bucket, so
 * releasing "the provider's hold" would take the primary's away with the
 * fallback's -- the turn would then be holding nothing for a call that is
 * still running.
 *
 * The compensating half of the reservation above: an attempt that is
 * authorized and then fails to build its manifest, serialize, or reach the
 * provider has spent nothing, and a hold left behind counts against that
 * provider until the reservation expires for a call that was never made.
 *
 * Best-effort, and it says so by returning a boolean rather than raising. The
 * turn is already ending on a failure, and replacing that failure with a
 * worse one helps nobody. What it must not do is move one of the two without
 * the other, which is why they move in one transaction.
 */
export const releaseAttemptProviderBudget = async (input: {
    reservationId: string;
    userId?: string | null;
    attemptIndex: number;
}): Promise<boolean> =>
    prisma
        .$transaction(async (tx) => {
            if (input.userId) {
                await lockCreditAccount(tx, input.userId);
            }
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`chat-credit-reservation:${input.reservationId}`}))`;
            const durable = await tx.chatCreditReservation.findUnique({
                where: { id: input.reservationId },
            });
            if (!durable || durable.status !== "reserved") return false;

            const canonical = deserializeReservation(durable.reservationPayload);
            const holds = canonical.attemptHolds ?? [];
            const intents = canonical.attemptCostIntents ?? [];
            const mine = holds.filter(
                (hold) => hold.attemptIndex === input.attemptIndex
            );
            const hasIntent = intents.some(
                (intent) => intent.attemptIndex === input.attemptIndex
            );
            // Both halves, because a zero authorization has only the second.
            // Keying this on the holds alone left a free attempt's intent
            // behind after its dispatch failed -- an authorization on the
            // record for a preparation that was abandoned before it reached
            // anything. What proves a request reached a provider is
            // `RoutingAttempt.dispatchedAt` beside a finalized manifest; this
            // is about undoing the authorization completely, which is what
            // §6 asks of a preparation that failed.
            if (mine.length === 0 && !hasIntent) return false;

            for (const hold of mine) {
                await tx.$executeRaw`
                    UPDATE "ChatUsageBucket"
                    SET "count" = GREATEST(0, "count" - ${hold.amount}),
                        "updatedAt" = NOW()
                    WHERE "key" = ${hold.key}
                      AND "period" = ${hold.period}
                      AND "periodStart" = ${hold.periodStart}
                `;
            }
            await tx.chatCreditReservation.update({
                where: { id: durable.id },
                data: {
                    reservationPayload: serializeReservation({
                        ...canonical,
                        attemptHolds: withoutAttemptHolds(
                            holds,
                            input.attemptIndex
                        ),
                        // The intent goes with the hold. An intent left behind
                        // would let a sweep record a cost against budget that
                        // has already been given back.
                        attemptCostIntents: intents.filter(
                            (intent) => intent.attemptIndex !== input.attemptIndex
                        ),
                    }),
                },
            });
            return true;
        })
        .catch(() => false);

/**
 * The period a legacy payload's provider holds were taken in.
 *
 * Those holds carry their own `periodStart`, and they were taken at the moment
 * the reservation was authorized -- so they are the anchor rather than a
 * reconstruction of it. Null when there are none, which is the case the caller
 * has to refuse: nothing else in the payload knows the answer.
 */
const legacyProviderBudgetAnchor = (
    holds: readonly AttemptHold[]
): { day: Date; month: Date } | null => {
    const day = holds.find((hold) => hold.period === "provider-cost-day");
    const month = holds.find((hold) => hold.period === "provider-cost-month");
    if (!day || !month) return null;
    return { day: day.periodStart, month: month.periodStart };
};

class AttemptBudgetRefusal extends Error {
    constructor(readonly scope: string) {
        super(`Attempt provider budget refused: ${scope}`);
        this.name = "AttemptBudgetRefusal";
    }
}

export const linkChatReservationProviderRequest = async (
    reservationId: string,
    identifiers: {
        providerRequestId?: string | null;
        providerResponseId?: string | null;
    }
) => {
    const providerResponseId = boundedProviderIdentifier(
        identifiers.providerResponseId
    );
    const providerRequestId =
        boundedProviderIdentifier(identifiers.providerRequestId) ||
        providerResponseId;
    if (!providerRequestId && !providerResponseId) return false;
    const updated = await prisma.chatCreditReservation.updateMany({
        where: {
            id: reservationId,
            providerRequestId: null,
            providerResponseId: null,
        },
        data: {
            providerRequestId,
            providerResponseId,
            providerRequestLinkedAt: new Date(),
        },
    });
    return updated.count === 1;
};

export const reconcileExpiredChatCreditReservations = async (
    now = new Date(),
    maximum = 500
) => {
    const limit = Math.min(1_000, Math.max(1, maximum));
    const rows = await prisma.chatCreditReservation.findMany({
        where: { status: "reserved", expiresAt: { lte: now } },
        orderBy: [{ expiresAt: "asc" }, { createdAt: "asc" }],
        take: limit,
        select: {
            id: true,
            reservationPayload: true,
        },
    });
    let refunded = 0;
    let alreadyFinalized = 0;
    let failed = 0;
    for (const row of rows) {
        try {
            const reservation = deserializeReservation(row.reservationPayload);
            const result = await settleChatUsage(
                reservation,
                { inputTokens: 0, outputTokens: 0, outcome: "failed" },
                { reconciled: true, reason: "reservation_expired" }
            );
            if (result.applied && result.status === "refunded") refunded += 1;
            else alreadyFinalized += 1;
        } catch (error) {
            failed += 1;
            const message =
                error instanceof Error ? error.message.slice(0, 500) : "Unknown error";
            await prisma.chatCreditReservation.updateMany({
                where: { id: row.id, status: "reserved" },
                data: { lastError: `reconcile_failed:${message}` },
            }).catch(() => undefined);
        }
    }
    return {
        examined: rows.length,
        refunded,
        alreadyFinalized,
        failed,
    };
};

/**
 * Frees the concurrency slot a request was holding.
 *
 * Idempotent by construction, so the completed / provider-error / client-abort
 * / disconnect paths may all call it, and a retry after a partial failure is
 * safe. A failure that survives its retries is reported as an operational
 * event rather than swallowed into `console.error`, and
 * `reconcileExpiredChatRequestLeases` is the backstop that removes whatever a
 * dead process left behind.
 */
export const releaseChatAccess = async (
    leaseId: string,
    context?: { traceId?: string; reason?: string; subjectScope?: string }
) => releaseChatRequestLease(leaseId, context);

/**
 * Keeps a running stream's slot alive.
 *
 * The lease TTL is deliberately short so a crashed process frees its slot
 * quickly; a healthy long response stays admitted by renewing, not by having
 * been given a bigger constant up front.
 */
export const heartbeatChatAccess = async (leaseId: string) =>
    touchChatRequestLease(leaseId, resolveLeaseTtlSeconds());

export {
    reconcileExpiredChatRequestLeases,
} from "@/lib/chatRequestLease";
export { leaseHeartbeatIntervalMs, resolveLeaseTtlSeconds } from "@/lib/chatConcurrencyCore";

export const assertChatRequestSize = (request: Request) => {
    const contentLength = Number(request.headers.get("content-length"));
    if (
        Number.isFinite(contentLength) &&
        contentLength > CHAT_REQUEST_LIMITS.maxBodyBytes
    ) {
        throw new ChatAccessError(
            413,
            "CHAT_BODY_TOO_LARGE",
            "Chat request is too large."
        );
    }
};

export const readChatJsonBody = async (request: Request) => {
    if (!request.body) {
        throw new ChatAccessError(400, "INVALID_CHAT_REQUEST", "Invalid request.");
    }

    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let text = "";

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            totalBytes += value.byteLength;
            if (totalBytes > CHAT_REQUEST_LIMITS.maxBodyBytes) {
                await reader.cancel();
                throw new ChatAccessError(
                    413,
                    "CHAT_BODY_TOO_LARGE",
                    "Chat request is too large."
                );
            }
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
    } finally {
        reader.releaseLock();
    }

    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new ChatAccessError(
            400,
            "INVALID_CHAT_JSON",
            "Invalid JSON request."
        );
    }
};

export const validateChatPayload = (body: unknown) => {
    if (!body || typeof body !== "object") {
        throw new ChatAccessError(400, "INVALID_CHAT_REQUEST", "Invalid request.");
    }

    const payload = body as {
        messages?: unknown;
        modelId?: unknown;
        conversationId?: unknown;
        assistantMessageId?: unknown;
        turnstileToken?: unknown;
        deepResearchDepth?: unknown;
        webSearchMode?: unknown;
        admissionToken?: unknown;
        contextBundle?: unknown;
    };
    if (
        !Array.isArray(payload.messages) ||
        payload.messages.length === 0 ||
        payload.messages.length > CHAT_REQUEST_LIMITS.maxMessages
    ) {
        throw new ChatAccessError(
            400,
            "INVALID_CHAT_MESSAGES",
            "Invalid message count."
        );
    }
    if (
        payload.modelId !== undefined &&
        (typeof payload.modelId !== "string" || payload.modelId.length > 100)
    ) {
        throw new ChatAccessError(400, "INVALID_MODEL", "Invalid model.");
    }
    if (
        payload.conversationId !== undefined &&
        (typeof payload.conversationId !== "string" ||
            payload.conversationId.length < 1 ||
            payload.conversationId.length > 64 ||
            !/^[A-Za-z0-9_-]+$/.test(payload.conversationId))
    ) {
        throw new ChatAccessError(
            400,
            "INVALID_CONVERSATION",
            "Invalid conversation."
        );
    }
    if (
        payload.assistantMessageId !== undefined &&
        (typeof payload.assistantMessageId !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                payload.assistantMessageId
            ))
    ) {
        throw new ChatAccessError(
            400,
            "INVALID_MESSAGE_ID",
            "Invalid message ID."
        );
    }
    if (
        Boolean(payload.conversationId) !== Boolean(payload.assistantMessageId)
    ) {
        throw new ChatAccessError(
            400,
            "INVALID_PERSISTENCE_TARGET",
            "Incomplete persistence target."
        );
    }
    if (
        payload.turnstileToken !== undefined &&
        (typeof payload.turnstileToken !== "string" ||
            payload.turnstileToken.length < 1 ||
            payload.turnstileToken.length > 2_048)
    ) {
        throw new ChatAccessError(
            400,
            "INVALID_TURNSTILE_TOKEN",
            "Invalid guest verification token."
        );
    }
    if (
        payload.deepResearchDepth !== undefined &&
        payload.deepResearchDepth !== "quick" &&
        payload.deepResearchDepth !== "standard" &&
        payload.deepResearchDepth !== "deep"
    ) {
        throw new ChatAccessError(
            400,
            "INVALID_DEEP_RESEARCH_DEPTH",
            "Invalid deep research depth."
        );
    }
    if (
        payload.webSearchMode !== undefined &&
        !isWebSearchMode(payload.webSearchMode)
    ) {
        throw new ChatAccessError(
            400,
            "INVALID_WEB_SEARCH_MODE",
            "Invalid web search mode."
        );
    }
    // Shape only. A token that is well-formed but forged, expired, issued to
    // another subject or already consumed is rejected where it is used, and
    // the request then falls back to the ordinary single-slot admission.
    if (
        payload.admissionToken !== undefined &&
        (typeof payload.admissionToken !== "string" ||
            payload.admissionToken.length < 1 ||
            payload.admissionToken.length > 4_096)
    ) {
        throw new ChatAccessError(
            400,
            "INVALID_ADMISSION_TOKEN",
            "Invalid admission token."
        );
    }
    // Shape only, same as the admission token above and for the same reason:
    // a well-formed bundle that is forged, expired, bound to another subject
    // or already consumed is rejected where the context is built, which is
    // the only place that can tell (§10).
    if (
        payload.contextBundle !== undefined &&
        (typeof payload.contextBundle !== "string" ||
            payload.contextBundle.length < 1 ||
            payload.contextBundle.length > 8_192)
    ) {
        throw new ChatAccessError(
            400,
            "INVALID_CONTEXT_BUNDLE",
            "Invalid chat context."
        );
    }

    let totalCharacters = 0;
    for (const message of payload.messages) {
        if (!message || typeof message !== "object") {
            throw new ChatAccessError(400, "INVALID_CHAT_MESSAGE", "Invalid message.");
        }
        const candidate = message as {
            role?: unknown;
            content?: unknown;
            attachments?: unknown;
        };
        if (
            candidate.role !== "user" &&
            candidate.role !== "assistant"
        ) {
            throw new ChatAccessError(400, "INVALID_CHAT_ROLE", "Invalid role.");
        }
        if (
            typeof candidate.content !== "string" ||
            candidate.content.length > CHAT_REQUEST_LIMITS.maxMessageCharacters
        ) {
            throw new ChatAccessError(
                400,
                "INVALID_CHAT_CONTENT",
                "Invalid message content."
            );
        }
        totalCharacters += candidate.content.length;
        if (totalCharacters > CHAT_REQUEST_LIMITS.maxTotalCharacters) {
            throw new ChatAccessError(
                413,
                "CHAT_CONTENT_TOO_LARGE",
                "Chat history is too large."
            );
        }
        if (
            candidate.attachments !== undefined &&
            !Array.isArray(candidate.attachments)
        ) {
            throw new ChatAccessError(
                400,
                "INVALID_ATTACHMENTS",
                "Invalid attachments."
            );
        }
    }

    return payload as {
        messages: Array<{
            role: "user" | "assistant";
            content: string;
            attachments?: unknown[];
        }>;
        modelId?: string;
        conversationId?: string;
        assistantMessageId?: string;
        turnstileToken?: string;
        deepResearchDepth?: "quick" | "standard" | "deep";
        webSearchMode?: WebSearchMode;
        admissionToken?: string;
        contextBundle?: string;
    };
};

/**
 * Diagnostic fields prefixed `internal` are for the structured limit-decision
 * event, the admin console and logs only. Raw internal micro-USD is never worth
 * showing an end user and is exactly the kind of figure that made the previous
 * guardrail error read like a billing statement.
 */
/**
 * Everything a rejected caller is allowed to see, in one place.
 *
 * Two rules, both of which have to hold for *every* error response rather than
 * for the call sites that remembered: raw internal USD never leaves the server
 * (it goes to the limit-decision event and the Admin Console), and a reset
 * instant is either in the future or absent. `now` defaults to the moment the
 * response is built, which is the "creation time" the second rule is measured
 * against.
 */
export const publicChatErrorDetails = (
    details: ChatErrorDetails | undefined,
    now: Date = new Date()
) => {
    if (!details) return undefined;
    const entries = Object.entries(withFutureResetAt(details, now)).filter(
        ([key]) => !key.startsWith("internal")
    );
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

export const chatErrorResponse = (error: unknown) => {
    if (!(error instanceof ChatAccessError)) return null;

    const headers = new Headers({ "Content-Type": "application/json" });
    if (error.retryAfter) {
        headers.set("Retry-After", String(error.retryAfter));
    }
    const details = publicChatErrorDetails(error.details);
    return new Response(
        JSON.stringify({
            error: error.message,
            code: error.code,
            ...(details ? { details } : {}),
        }),
        { status: error.status, headers }
    );
};

// The usage-bucket primitives, shared with the image generation billing path
// (lib/imageGenerationService.ts). Image generation charges the same plan
// credit wallet and the same bucket table, and the conditional
// INSERT ... ON CONFLICT ... WHERE in incrementUsage IS the concurrency
// defence -- a second, slightly different copy of that SQL is exactly the
// kind of drift that corrupts a shared wallet, so the one implementation is
// exported instead of mirrored.
export {
    incrementUsage as incrementUsageBucket,
    readUsageCount as readUsageBucketCount,
    periodStart as usagePeriodStart,
    monthlyResetAt as usageMonthlyResetAt,
};
