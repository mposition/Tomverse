import "server-only";

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
    canUseModelWithPlan,
    getModelBillingProfile,
    getModelUsageProfile,
    getSettledUsageCredits,
    getWeightedUsageCredits,
    type AiModel,
    type ModelMinimumPlan,
    type ModelTier,
    type ModelUsageClass,
} from "@/lib/models";
import { getAnonymousClientKey } from "@/lib/clientIp";
import { recordInternalProviderUsage } from "@/lib/providerUsageAccounting";
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
    maxOutputTokens: number;
    reservedOutputTokens: number;
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
    cachedInputPriceMultiplier: number;
    provider: AiModel["provider"];
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
        usageCredits: z.number().int().positive(),
        inputTokens: z.number().int().nonnegative(),
        maxOutputTokens: z.number().int().nonnegative(),
        reservedOutputTokens: z.number().int().nonnegative().optional(),
        inputUsdPerMillionTokens: z.number().nonnegative(),
        outputUsdPerMillionTokens: z.number().nonnegative(),
        cachedInputPriceMultiplier: z.number().min(0).max(1).default(1),
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

const serializeReservation = (
    reservation: ChatUsageReservation
): Prisma.InputJsonValue => {
    const { userId, ...rest } = reservation;
    return {
        ...rest,
        entries: reservation.entries.map((entry) => ({
            ...entry,
            periodStart: entry.periodStart.toISOString(),
        })),
        ...(userId ? { userId } : {}),
    };
};

const deserializeReservation = (payload: Prisma.JsonValue) => {
    const parsed = durableReservationPayloadSchema.parse(payload);
    return {
        ...parsed,
        reservedOutputTokens:
            parsed.reservedOutputTokens ?? parsed.maxOutputTokens,
        provider: parsed.provider as AiModel["provider"],
        entries: parsed.entries.map((entry) => ({
            ...entry,
            periodStart: new Date(entry.periodStart),
        })),
    } satisfies ChatUsageReservation;
};

export class ChatAccessError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
        public readonly retryAfter?: number,
        public readonly details?: Record<string, number | string>
    ) {
        super(message);
    }
}

const positiveInteger = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const getPlanEstimatedCostLimits = (plan: ModelTier) => ({
    day:
        plan === "Max"
            ? positiveInteger(
                  process.env.CHAT_MAX_COST_MICROUSD_PER_DAY,
                  3_000_000
              )
            : plan === "Pro"
              ? positiveInteger(
                    process.env.CHAT_PRO_COST_MICROUSD_PER_DAY,
                    1_500_000
                )
              : positiveInteger(
                    process.env.CHAT_FREE_COST_MICROUSD_PER_DAY,
                    250_000
                ),
    month:
        plan === "Max"
            ? positiveInteger(
                  process.env.CHAT_MAX_COST_MICROUSD_PER_MONTH,
                  9_000_000
              )
            : plan === "Pro"
              ? positiveInteger(
                    process.env.CHAT_PRO_COST_MICROUSD_PER_MONTH,
                    4_500_000
                )
              : positiveInteger(
                    process.env.CHAT_FREE_COST_MICROUSD_PER_MONTH,
                    500_000
                ),
});

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
    estimatedInputTokens: number
): ChatBudget => {
    const profile = getModelBillingProfile(model);
    const maxInputTokens =
        kind === "guest"
            ? positiveInteger(process.env.CHAT_GUEST_MAX_INPUT_TOKENS, 16_000)
            : positiveInteger(process.env.CHAT_USER_MAX_INPUT_TOKENS, 128_000);

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

    return {
        modelId: model.id,
        minimumPlan: model.minimumPlan,
        modelUsageClass: model.usageClass,
        usageCredits: getWeightedUsageCredits(model, estimatedInputTokens),
        inputTokens: estimatedInputTokens,
        maxOutputTokens: profile.maxOutputTokens,
        reservedOutputTokens: profile.reservationOutputTokens,
        inputUsdPerMillionTokens: profile.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: profile.outputUsdPerMillionTokens,
        cachedInputPriceMultiplier: profile.cachedInputPriceMultiplier,
        provider: model.provider,
    };
};

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
    createHash("sha256")
        .update(`${scope}:${value}:${getSecret()}`)
        .digest("hex");

export const getUserChatUsageKey = (userId: string) =>
    `user:${hashKey("user", userId)}`;

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
    const dayLimit = limitsFor(access).find((rule) => rule.period === "day")?.limit ?? 0;
    const bucket = await prisma.chatUsageBucket.findUnique({
        where: {
            key_period_periodStart: {
                key: access.subjectKey,
                period: "day",
                periodStart: dayStart,
            },
        },
        select: { count: true },
    });
    const used = bucket?.count || 0;
    return {
        used,
        limit: dayLimit,
        remaining: Math.max(0, dayLimit - used),
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
    return bucket?.count || 0;
};

const safeBigIntNumber = (value: bigint) => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) {
        throw new Error("Credit cost allowance exceeds the supported range.");
    }
    return number;
};

export const preflightChatComparisonAccess = async (
    access: ChatAccess,
    budgets: ChatBudget[]
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
    if (access.kind !== "user" || !access.userId) {
        throw new ChatAccessError(
            401,
            "COMPARISON_AUTHENTICATION_REQUIRED",
            "Sign in before comparing multiple models."
        );
    }
    try {
        await enforceUserOperationalSecurity(access.userId);
    } catch (error) {
        if (error instanceof UserOperationalRestrictionError) {
            throw new ChatAccessError(403, error.code, error.message);
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

    const now = new Date();
    const plan = access.plan || "Free";
    const costLimits = getPlanEstimatedCostLimits(plan);
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

    await prisma.$transaction(async (tx) => {
        await lockCreditAccount(tx, access.userId!);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${access.subjectKey}))`;
        const userDayWindow = await getUserDayWindow(tx, access.userId!, now);

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

        const concurrentLimit = positiveInteger(
            process.env.CHAT_USER_CONCURRENT,
            3
        );
        await tx.$executeRaw`
            DELETE FROM "ChatRequestLease"
            WHERE "subjectKey" = ${access.subjectKey} AND "expiresAt" <= NOW()
        `;
        const activeLeaseRows = await tx.$queryRaw<Array<{ count: bigint }>>`
            SELECT COUNT(*)::bigint AS "count"
            FROM "ChatRequestLease"
            WHERE "subjectKey" = ${access.subjectKey}
        `;
        const activeLeaseCount = Number(activeLeaseRows[0]?.count || 0);
        if (activeLeaseCount + budgets.length > concurrentLimit) {
            throw new ChatAccessError(
                429,
                "CHAT_CONCURRENCY_EXCEEDED",
                "The selected comparison would exceed the number of chats that can run at once. Wait for the current response to finish and try again.",
                5,
                {
                    activeRequests: activeLeaseCount,
                    requestedModels: budgets.length,
                    concurrentLimit,
                }
            );
        }

        const planRules = limitsFor(access);
        const minuteRule = planRules.find((rule) => rule.period === "minute");
        if (minuteRule) {
            const start = periodStart("minute", now);
            const used = await readUsageCount(
                tx,
                access.subjectKey,
                "minute",
                start
            );
            if (used + budgets.length > minuteRule.limit) {
                throw new ChatAccessError(
                    429,
                    "CHAT_RATE_LIMITED",
                    "The selected comparison would exceed the current request rate limit. Wait briefly and try again.",
                    retryAfterFor("minute", now)
                );
            }
        }
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
                    resetAt: userDayWindow.end.toISOString(),
                }
            );
        }
        if (creditAllocation.balanceInsufficient) {
            throw new ChatAccessError(
                402,
                "CREDIT_BALANCE_INSUFFICIENT",
                "The selected models need more credits than are currently available.",
                undefined,
                {
                    requiredCredits: totalCredits,
                    planCreditsAvailable: planCreditsRemaining,
                    purchasedCreditsAvailable,
                    shortfallCredits: Math.max(
                        0,
                        totalCredits - planCreditsRemaining - purchasedCreditsAvailable
                    ),
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
                {
                    requiredCostMicroUsd: purchasedReservedCost,
                    availableCostMicroUsd: purchasedCostAvailable,
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

        const costChecks = [
            {
                period: "cost-day",
                start: userDayWindow.start,
                limit: costLimits.day,
                required: totalReservedCost,
                code: "INTERNAL_DAILY_COST_SAFETY_LIMIT",
                scope: "daily",
            },
            {
                period: "cost-month",
                start: monthStart,
                limit: costLimits.month,
                required: planReservedCost,
                code: "INTERNAL_MONTHLY_COST_SAFETY_LIMIT",
                scope: "monthly",
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
                    check.code,
                    check.scope === "daily"
                        ? "This model comparison exceeds the remaining internal daily cost safety allowance. Choose fewer high-cost models or try again after the daily reset."
                        : "This model comparison exceeds the remaining internal monthly cost safety allowance. Choose lower-cost models or wait for the monthly reset.",
                    retryAfterFor(
                        check.scope === "daily" ? "day" : "month",
                        now,
                        check.scope === "daily" ? userDayWindow.end : undefined
                    ),
                    {
                        scope: check.scope,
                        plan,
                        usedCostMicroUsd: used,
                        newEstimatedCostMicroUsd: check.required,
                        limitCostMicroUsd: check.limit,
                        requiredCostMicroUsd: check.required,
                        availableCostMicroUsd: Math.max(0, check.limit - used),
                        resetAt:
                            check.scope === "daily"
                                ? userDayWindow.end.toISOString()
                                : monthlyResetAt(now).toISOString(),
                        timeZone:
                            check.scope === "daily"
                                ? userDayWindow.timeZone
                                : "UTC",
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
            const providerKey = `provider:${provider}`;
            const dailyLimit = positiveInteger(
                process.env[
                    `CHAT_PROVIDER_${provider.toUpperCase()}_COST_MICROUSD_PER_DAY`
                ],
                10_000_000
            );
            const monthlyLimit = positiveInteger(
                process.env[
                    `CHAT_PROVIDER_${provider.toUpperCase()}_COST_MICROUSD_PER_MONTH`
                ],
                100_000_000
            );
            const providerChecks = [
                {
                    period: "provider-cost-day",
                    start: periodStart("day", now),
                    limit: dailyLimit,
                    required: required.daily,
                    code: "PROVIDER_DAILY_SPEND_LIMIT_REACHED",
                },
                {
                    period: "provider-cost-month",
                    start: monthStart,
                    limit: monthlyLimit,
                    required: required.monthly,
                    code: "PROVIDER_SPEND_LIMIT_REACHED",
                },
            ];
            for (const check of providerChecks) {
                const used = await readUsageCount(
                    tx,
                    providerKey,
                    check.period,
                    check.start
                );
                if (used + check.required > check.limit) {
                    throw new ChatAccessError(
                        503,
                        check.code,
                        `The ${provider} provider cost safety limit is currently reached. Choose another provider or try again later.`,
                        undefined,
                        { provider }
                    );
                }
            }
        }
    }, {
        maxWait: 5_000,
        timeout: 15_000,
    });

    return {
        modelCount: budgets.length,
        requiredCredits: totalCredits,
        reservedTokens: totalReservedTokens,
        reservedCostMicroUsd: totalReservedCost,
    };
};

export const acquireChatAccess = async (
    access: ChatAccess,
    budget: ChatBudget,
    options?: {
        traceId?: string;
        source?: "chat" | "comparison_review";
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
        try {
            await enforceUserOperationalSecurity(access.userId);
        } catch (error) {
            if (error instanceof UserOperationalRestrictionError) {
                throw new ChatAccessError(403, error.code, error.message);
            }
            throw error;
        }
    }
    const now = new Date();
    const leaseId = randomUUID();
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
    const concurrentLimit =
        access.kind === "user"
            ? positiveInteger(process.env.CHAT_USER_CONCURRENT, 3)
            : positiveInteger(process.env.CHAT_GUEST_CONCURRENT, 3);
    const ipPerMinute = positiveInteger(process.env.CHAT_IP_PER_MINUTE, 40);
    const reservedTokens = getChatBudgetReservedTokens(budget);
    const reservedCost = getChatBudgetReservedCostMicroUsd(budget);
    const plan = access.plan || "Free";
    const estimatedCostLimits = getPlanEstimatedCostLimits(plan);
    const providerMonthlyEnvKey = `CHAT_PROVIDER_${budget.provider.toUpperCase()}_COST_MICROUSD_PER_MONTH`;
    const providerMonthlyLimit = positiveInteger(
        process.env[providerMonthlyEnvKey],
        100_000_000
    );
    const providerDailyEnvKey = `CHAT_PROVIDER_${budget.provider.toUpperCase()}_COST_MICROUSD_PER_DAY`;
    const providerDailyLimit = positiveInteger(
        process.env[providerDailyEnvKey],
        10_000_000
    );

    await prisma.$transaction(async (tx) => {
        if (access.kind === "user") {
            if (!access.userId) {
                throw new Error("Authenticated chat access is missing a user ID.");
            }
            await lockCreditAccount(tx, access.userId);
        }
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${access.subjectKey}))`;
        const accessDayWindow =
            access.kind === "user"
                ? await getUserDayWindow(tx, access.userId!, now)
                : {
                      timeZone: "UTC",
                      start: periodStart("day", now),
                      end: new Date(periodStart("day", now).getTime() + 86_400_000),
                  };
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
        const costLimits =
            access.kind === "user"
                ? [
                      {
                          period: "cost-day",
                          start: accessDayWindow.start,
                          limit: estimatedCostLimits.day,
                      },
                      {
                          period: "cost-month",
                          start: periodStart("month", now),
                          limit: estimatedCostLimits.month,
                      },
                  ]
                : [
                      {
                          period: "cost-day",
                          start: accessDayWindow.start,
                          limit: positiveInteger(
                              process.env.CHAT_GUEST_COST_MICROUSD_PER_DAY,
                              20_000
                          ),
                      },
                      {
                          period: "cost-month",
                          start: periodStart("month", now),
                          limit: positiveInteger(
                              process.env.CHAT_GUEST_COST_MICROUSD_PER_MONTH,
                              100_000
                          ),
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
                estimatedCostLimits.month - (monthlyCost?.count || 0)
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
                        estimatedCostLimits.month,
                        costOffset
                    );
                    if (!allowed) {
                        throw new ChatAccessError(
                            409,
                            "CREDIT_DEBT_OFFSET_CONFLICT",
                            "Credit debt balance changed. Please retry."
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
                const isRateLimit = rule.period === "minute";
                throw new ChatAccessError(
                    429,
                    isRateLimit ? "CHAT_RATE_LIMITED" : "CHAT_QUOTA_EXCEEDED",
                    isRateLimit
                        ? "Chat request rate limit exceeded."
                        : "AI response credit limit exceeded.",
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
                monthRule.limit - (current?.count || 0)
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
                        "CREDIT_DEBT_OFFSET_CONFLICT",
                        "Credit debt balance changed. Please retry."
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
                            "CREDIT_RESERVATION_CONFLICT",
                            "Daily plan credit balance changed. Please retry."
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
                    throw new ChatAccessError(409, "CREDIT_RESERVATION_CONFLICT", "Credit balance changed. Please retry.");
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
                                {
                                    requiredCostMicroUsd: addOnReservedCost,
                                    availableCostMicroUsd:
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
                                    resetAt: accessDayWindow.end.toISOString(),
                                }
                            );
                        }
                        throw new ChatAccessError(
                            402,
                            "CREDIT_BALANCE_INSUFFICIENT",
                            "Not enough credits are available for this request.",
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

        const ipAllowed = await incrementUsage(
            tx,
            access.ipKey,
            "minute",
            periodStart("minute", now),
            ipPerMinute
        );
        if (!ipAllowed) {
            throw new ChatAccessError(
                429,
                "CHAT_RATE_LIMITED",
                "Too many chat requests.",
                retryAfterFor("minute", now)
            );
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
            const reservedRuleCost =
                access.kind === "user" && rule.period === "cost-month"
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
                const isDailySafetyLimit = rule.period === "cost-day";
                const usedCost = await readUsageCount(
                    tx,
                    access.subjectKey,
                    rule.period,
                    rule.start
                );
                throw new ChatAccessError(
                    429,
                    isDailySafetyLimit
                        ? "INTERNAL_DAILY_COST_SAFETY_LIMIT"
                        : "INTERNAL_MONTHLY_COST_SAFETY_LIMIT",
                    isDailySafetyLimit
                        ? "This request exceeds the remaining internal daily cost safety allowance. Choose fewer high-cost models or try again after the daily reset."
                        : "This request exceeds the remaining internal monthly cost safety allowance. Choose lower-cost models or wait for the monthly reset.",
                    retryAfterFor(
                        isDailySafetyLimit ? "day" : "month",
                        now,
                        isDailySafetyLimit ? accessDayWindow.end : undefined
                    ),
                    {
                        scope: isDailySafetyLimit ? "daily" : "monthly",
                        plan: access.kind === "guest" ? "Guest" : plan,
                        usedCostMicroUsd: usedCost,
                        newEstimatedCostMicroUsd: reservedRuleCost,
                        requiredCostMicroUsd: reservedRuleCost,
                        availableCostMicroUsd: Math.max(
                            0,
                            rule.limit - usedCost
                        ),
                        reservedCostMicroUsd: reservedRuleCost,
                        limitMicroUsd: rule.limit,
                        limitCostMicroUsd: rule.limit,
                        resetAt: isDailySafetyLimit
                            ? accessDayWindow.end.toISOString()
                            : monthlyResetAt(now).toISOString(),
                        timeZone: isDailySafetyLimit
                            ? accessDayWindow.timeZone
                            : "UTC",
                    }
                );
            }
            reservationEntries.push({
                key: access.subjectKey,
                period: rule.period,
                periodStart: rule.start,
                amount: reservedRuleCost,
                metric:
                    access.kind === "user" && rule.period === "cost-month"
                        ? "plan-cost"
                        : "cost",
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

        if (reservedCost > 0) {
            const providerKey = `provider:${budget.provider}`;
            const providerDayStart = periodStart("day", now);
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
                    "PROVIDER_DAILY_SPEND_LIMIT_REACHED",
                    "This AI provider is temporarily unavailable."
                );
            }
            reservationEntries.push({
                key: providerKey,
                period: "provider-cost-day",
                periodStart: providerDayStart,
                amount: reservedCost,
                metric: "cost",
            });

            const providerStart = periodStart("month", now);
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
                    "PROVIDER_SPEND_LIMIT_REACHED",
                    "This AI provider is temporarily unavailable."
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

        const leaseSubjectKey =
            access.kind === "guest" ? access.ipKey : access.subjectKey;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${leaseSubjectKey}))`;
        await tx.$executeRaw`
            DELETE FROM "ChatRequestLease"
            WHERE "subjectKey" = ${leaseSubjectKey} AND "expiresAt" <= NOW()
        `;
        const activeRows = await tx.$queryRaw<Array<{ count: bigint }>>`
            SELECT COUNT(*)::bigint AS "count"
            FROM "ChatRequestLease"
            WHERE "subjectKey" = ${leaseSubjectKey}
        `;
        if (Number(activeRows[0]?.count || 0) >= concurrentLimit) {
            throw new ChatAccessError(
                429,
                "CHAT_CONCURRENCY_EXCEEDED",
                "Too many chats are running at once.",
                5
            );
        }

        await tx.$executeRaw`
            INSERT INTO "ChatRequestLease" ("id", "subjectKey", "expiresAt", "createdAt")
            VALUES (${leaseId}, ${leaseSubjectKey}, ${new Date(now.getTime() + 120_000)}, NOW())
        `;

        durableReservation = {
            reservationId,
            userId: access.userId,
            traceId,
            source: reservationSource,
            modelId: budget.modelId,
            provider: budget.provider,
            entries: reservationEntries,
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

    if (!durableReservation) {
        throw new Error("Durable chat credit reservation was not created.");
    }

    return {
        leaseId,
        setCookie: access.setCookie,
        usageReservation: durableReservation,
    };
};

export const settleChatUsage = async (
    reservation: ChatUsageReservation,
    usage: {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
        outcome: "completed" | "cancelled" | "failed" | "empty";
    },
    options?: {
        reconciled?: boolean;
        reason?: string;
        providerUsageSnapshot?: PerplexityUsageCostSnapshot | null;
    }
) => {
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
        const costBreakdown = providerUsageSnapshot
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
            : tokenCostBreakdown;
        const actualCost = costBreakdown.totalCostMicroUsd;
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

        for (const entry of canonical.entries) {
            const actual =
                entry.metric === "tokens"
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
                pricingSnapshot: costBreakdown,
                providerUsageSnapshot: providerUsageSnapshot ?? undefined,
                settledAt: new Date(),
                reconciledAt: options?.reconciled ? new Date() : null,
                lastError: options?.reason?.slice(0, 500) || null,
            },
        });

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
        };
    });

    if (
        settlement.applied &&
        settlement.costBreakdown &&
        (settlement.actualInput > 0 ||
            settlement.actualOutput > 0 ||
            settlement.actualCost > 0)
    ) {
        await recordInternalProviderUsage({
            provider: settlement.provider,
            modelId: settlement.modelId,
            inputTokens: settlement.actualInput,
            cachedInputTokens: settlement.actualCachedInput,
            outputTokens: settlement.actualOutput,
            estimatedCostMicroUsd: settlement.actualCost,
            uncachedInputCostMicroUsd:
                settlement.costBreakdown.uncachedInputCostMicroUsd,
            cachedInputCostMicroUsd:
                settlement.costBreakdown.cachedInputCostMicroUsd,
            outputCostMicroUsd: settlement.costBreakdown.outputCostMicroUsd,
        });
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
    return { applied: settlement.applied, status: settlement.status };
};

const boundedProviderIdentifier = (value: string | null | undefined) => {
    const normalized = value?.trim();
    if (!normalized) return null;
    return normalized.replace(/[^A-Za-z0-9._:/-]/g, "").slice(0, 240) || null;
};

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

export const releaseChatAccess = async (leaseId: string) => {
    try {
        await prisma.$executeRaw`
            DELETE FROM "ChatRequestLease" WHERE "id" = ${leaseId}
        `;
    } catch (error) {
        console.error("Failed to release chat request lease:", error);
    }
};

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
    };
};

export const chatErrorResponse = (error: unknown) => {
    if (!(error instanceof ChatAccessError)) return null;

    const headers = new Headers({ "Content-Type": "application/json" });
    if (error.retryAfter) {
        headers.set("Retry-After", String(error.retryAfter));
    }
    return new Response(
        JSON.stringify({
            error: error.message,
            code: error.code,
            ...(error.details ? { details: error.details } : {}),
        }),
        { status: error.status, headers }
    );
};
