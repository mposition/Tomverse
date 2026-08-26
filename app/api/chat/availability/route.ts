export const dynamic = "force-dynamic";

import { randomUUID } from "node:crypto";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { usageBucketCount } from "@/lib/chatUsageBucketCount";
import {
    apiSecurityResponse,
    consumeApiRateLimit,
    readLimitedJson,
} from "@/lib/apiSecurity";
import {
    assertModelAccess,
    ChatAccessError,
    chatErrorResponse,
    createChatBudget,
    getChatBudgetReservedCostMicroUsd,
    getChatCostGuardrails,
    identifyChatCaller,
} from "@/lib/chatSecurity";
import {
    evaluateChatAvailability,
    splitReservedCost,
} from "@/lib/chatAvailabilityCore";
import { getChatCreditAllocation } from "@/lib/chatCreditAllocation";
import { getUserBillingPlan } from "@/lib/billingEntitlements";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { getPurchasedCreditSummary } from "@/lib/creditLedger";
import { getZonedDayWindow } from "@/lib/userTimeZone";
import { estimatePreflightAttachmentTokens } from "@/lib/chatAttachmentTokens";
import {
    atLeastOneToken,
    createTokenEstimateAccumulator,
} from "@/lib/chatTokenEstimate";
import { WEB_SEARCH_MODES } from "@/lib/appDefaults";
import {
    getWebSearchCapability,
    nativeSearchIsDispatchable,
} from "@/lib/webSearchCapability";
import { getWebSearchSurchargeCredits } from "@/lib/webSearchCredits";
import { reserveNativeSearchCost } from "@/lib/webSearchNativeCostReservation";
import {
    recordWebSearchCostRefusal,
    webSearchCostRefusalError,
} from "@/lib/webSearchCostRefusal";
import { getProviderCostGuardrailLimits } from "@/lib/providerCostBudget";
import { futureResetAt } from "@/lib/chatLimitDecisionCore";

const availabilitySchema = z
    .object({
        modelIds: z.array(z.string().min(1).max(100)).min(1).max(3),
        prompt: z.string().max(50_000).optional(),
        webSearchMode: z.enum(WEB_SEARCH_MODES).optional(),
        attachments: z
            .array(
                z
                    .object({
                        mediaType: z.string().min(1).max(160),
                        size: z.number().int().min(0).max(10 * 1024 * 1024),
                    })
                    .strict()
            )
            .max(5)
            .optional(),
    })
    .strict();

const monthStartUtc = (now: Date) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

const nextMonthStartUtc = (now: Date) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

/**
 * Read-only "can I send this right now" probe.
 *
 * Refreshed by the composer whenever the model selection or the web-search
 * toggle changes, so a request that cannot run is visible before it is sent
 * rather than only in the error that comes back afterwards. Writes nothing:
 * no bucket is incremented and no credit is reserved.
 */
export async function POST(request: Request) {
    const traceId = randomUUID();
    /** The probe's models and caller, hoisted for the catch. */
    let refusalModelsForLog: Array<{ modelId: string; provider: string }> = [];
    let refusalSubjectForLog: {
        subjectKey: string;
        userId: string | null;
        plan: string | null;
    } | null = null;
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.id) {
            return Response.json(
                {
                    error: "Sign in to check request availability.",
                    code: "AUTHENTICATION_REQUIRED",
                    traceId,
                },
                { status: 401, headers: { "X-Request-ID": traceId } }
            );
        }

        await consumeApiRateLimit(
            request,
            session.user.id,
            "chat-availability",
            { minute: 60, day: 3_000 }
        );
        const payload = await readLimitedJson(
            request,
            64 * 1024,
            availabilitySchema
        );
        const uniqueModelIds = Array.from(new Set(payload.modelIds));

        const billingPlan = await getUserBillingPlan(session.user.id);
        const access = identifyChatCaller(
            request,
            session.user.id,
            billingPlan.tier,
            {
                dailyMessageLimit: billingPlan.dailyMessageLimit,
                monthlyMessageLimit: billingPlan.monthlyMessageLimit,
            }
        );

        const runtimeModels = await getRuntimeModels();
        const runtimeModelMap = new Map(
            runtimeModels.map((model) => [model.id, model])
        );
        const models = uniqueModelIds.map((modelId) => {
            const candidate = runtimeModelMap.get(modelId);
            const model =
                candidate?.enabled && !candidate.catalogDeleted
                    ? candidate
                    : undefined;
            if (!model) {
                throw new ChatAccessError(
                    400,
                    "MODEL_NOT_AVAILABLE",
                    "One or more selected models are unavailable."
                );
            }
            assertModelAccess(access, model);
            return model;
        });
        refusalSubjectForLog = {
            subjectKey: access.subjectKey,
            userId: access.userId ?? null,
            plan: access.kind === "guest" ? "Guest" : (access.plan ?? "Free"),
        };
        refusalModelsForLog = models.map((model) => ({
            modelId: model.id,
            provider: model.provider,
        }));

        const webSearchMode = payload.webSearchMode ?? "off";
        const budgets = models.map((model) => {
            const capability = getWebSearchCapability(model.id);
            const attachmentTokens = estimatePreflightAttachmentTokens(
                model,
                payload.attachments ?? []
            );
            // Derived as the chat route derives it, from dispatchability
            // rather than from declared support: this probe answers "can I
            // send this right now", and a model whose native search no request
            // may carry does not attach a tool, so pricing one here would
            // quote a turn nobody is going to send.
            const nativeSearchEnabled =
                webSearchMode === "always" &&
                nativeSearchIsDispatchable(capability);
            // The per-query half of a searching turn's provider cost, which
            // this probe used to leave out entirely -- so it could report a
            // request runnable against a provider budget that the chat route
            // then measured the same request against and refused.
            const nativeSearchReservation = reserveNativeSearchCost({
                model,
                capability,
                nativeSearchEnabled,
            });
            if (!nativeSearchReservation.ok) {
                // The honest answer to "can I send this": no, with the reason
                // the dispatch would give. Unreachable while every registered
                // capability's ceiling is known, since `nativeSearchEnabled` is
                // false for the ones without one.
                throw webSearchCostRefusalError(
                    nativeSearchReservation.reason
                );
            }
            return createChatBudget(
                access.kind,
                model,
                atLeastOneToken(
                    createTokenEstimateAccumulator()
                        .addText(payload.prompt ?? "")
                        // Attachment cost is a per-model estimate, not text, so
                        // it stays out of the segment terms.
                        .addTokens(attachmentTokens)
                        .breakdown()
                ),
                {
                    webSearchSurchargeCredits: getWebSearchSurchargeCredits(
                        webSearchMode,
                        capability
                    ),
                    nativeSearchEnabled,
                    nativeSearch: nativeSearchReservation,
                }
            );
        });

        const now = new Date();
        const settings = await prisma.userSettings.findUnique({
            where: { userId: session.user.id },
            select: { timeZone: true },
        });
        const dayWindow = getZonedDayWindow(settings?.timeZone, now);
        const monthStart = monthStartUtc(now);
        const providerCosts = new Map<string, number>();
        for (const budget of budgets) {
            providerCosts.set(
                budget.provider,
                (providerCosts.get(budget.provider) || 0) +
                    getChatBudgetReservedCostMicroUsd(budget)
            );
        }

        const [buckets, providerBuckets, purchased] = await Promise.all([
            prisma.chatUsageBucket.findMany({
                where: {
                    key: access.subjectKey,
                    OR: [
                        { period: "day", periodStart: dayWindow.start },
                        { period: "month", periodStart: monthStart },
                        { period: "cost-day", periodStart: dayWindow.start },
                        { period: "cost-month", periodStart: monthStart },
                        { period: "op-cost-day", periodStart: dayWindow.start },
                        { period: "op-cost-month", periodStart: monthStart },
                    ],
                },
                select: { period: true, count: true },
            }),
            prisma.chatUsageBucket.findMany({
                where: {
                    key: {
                        in: Array.from(providerCosts.keys()).map(
                            (provider) => `provider:${provider}`
                        ),
                    },
                    OR: [
                        {
                            period: "provider-cost-day",
                            periodStart: new Date(
                                Date.UTC(
                                    now.getUTCFullYear(),
                                    now.getUTCMonth(),
                                    now.getUTCDate()
                                )
                            ),
                        },
                        {
                            period: "provider-cost-month",
                            periodStart: monthStart,
                        },
                    ],
                },
                select: { key: true, period: true, count: true },
            }),
            getPurchasedCreditSummary(session.user.id, now),
        ]);

        const bucketCount = (period: string) =>
            usageBucketCount(buckets.find((row) => row.period === period)?.count);
        const providerBucketCount = (provider: string, period: string) =>
            usageBucketCount(
                providerBuckets.find(
                    (row) =>
                        row.key === `provider:${provider}` && row.period === period
                )?.count
            );

        const requiredCredits = budgets.reduce(
            (sum, budget) => sum + budget.usageCredits,
            0
        );
        const planCreditsRemaining = Math.max(
            0,
            billingPlan.monthlyMessageLimit - bucketCount("month")
        );
        const dailyPlanCreditsRemaining =
            billingPlan.dailyMessageLimit > 0
                ? Math.max(
                      0,
                      billingPlan.dailyMessageLimit - bucketCount("day")
                  )
                : null;
        const allocation = getChatCreditAllocation({
            requiredCredits,
            monthlyPlanCreditsRemaining: planCreditsRemaining,
            dailyPlanCreditsRemaining,
            purchasedCreditsRemaining: purchased.remainingCredits,
        });
        const { planCost, purchasedCost } = splitReservedCost(
            budgets.map((budget) => ({
                usageCredits: budget.usageCredits,
                reservedCostMicroUsd:
                    getChatBudgetReservedCostMicroUsd(budget),
            })),
            allocation.planCreditsAvailableNow
        );
        const guardrails = getChatCostGuardrails(billingPlan.tier, {
            dailyMessageLimit: billingPlan.dailyMessageLimit,
            monthlyMessageLimit: billingPlan.monthlyMessageLimit,
        });

        const availability = evaluateChatAvailability({
            requiredCredits,
            planCreditsRemaining,
            dailyPlanCreditsRemaining,
            purchasedCreditsRemaining: purchased.remainingCredits,
            purchasedFundedCostMicroUsd: purchased.remainingFundedCostMicroUsd,
            totalReservedCostMicroUsd: planCost + purchasedCost,
            planReservedCostMicroUsd: planCost,
            purchasedReservedCostMicroUsd: purchasedCost,
            guardrails,
            usage: {
                planCostDayMicroUsd: bucketCount("cost-day"),
                planCostMonthMicroUsd: bucketCount("cost-month"),
                totalCostDayMicroUsd: bucketCount("op-cost-day"),
                totalCostMonthMicroUsd: bucketCount("op-cost-month"),
            },
            providers: Array.from(providerCosts.entries()).map(
                ([provider, requiredCostMicroUsd]) => {
                    const limits = getProviderCostGuardrailLimits(provider);
                    return {
                        provider,
                        requiredCostMicroUsd,
                        usedDayMicroUsd: providerBucketCount(
                            provider,
                            "provider-cost-day"
                        ),
                        usedMonthMicroUsd: providerBucketCount(
                            provider,
                            "provider-cost-month"
                        ),
                        dayLimitMicroUsd: limits.day,
                        monthLimitMicroUsd: limits.month,
                    };
                }
            ),
        });

        // Guardrail internals never leave the server; the client gets the
        // decision, the credit arithmetic and when things reset.
        return Response.json(
            {
                traceId,
                plan: billingPlan.tier,
                runnable: availability.runnable,
                blockCode: availability.block?.code ?? null,
                blockLayer: availability.block?.layer ?? null,
                webSearchMode,
                estimate: {
                    requiredCredits: availability.requiredCredits,
                    planCreditsUsedByRequest:
                        availability.planCreditsUsedByRequest,
                    purchasedCreditsUsedByRequest:
                        availability.purchasedCreditsUsedByRequest,
                    models: budgets.map((budget) => ({
                        modelId: budget.modelId,
                        credits: budget.usageCredits,
                        estimatedInputTokens: budget.inputTokens,
                        estimatedOutputTokens: budget.reservedOutputTokens,
                    })),
                },
                entitlement: {
                    dailyCreditLimit: billingPlan.dailyMessageLimit,
                    dailyCreditsUsed: bucketCount("day"),
                    dailyCreditsRemaining: dailyPlanCreditsRemaining,
                    hasDailyCreditLimit: billingPlan.dailyMessageLimit > 0,
                    planCreditsRemaining,
                    purchasedCreditsRemaining: purchased.remainingCredits,
                    creditsAvailableNow: availability.creditsAvailableNow,
                    creditShortfall: availability.creditShortfall,
                    timeZone: dayWindow.timeZone,
                    dailyResetsAt: (
                        futureResetAt(dayWindow.end, now) ??
                        new Date(dayWindow.end.getTime() + 86_400_000)
                    ).toISOString(),
                    planResetsAt: nextMonthStartUtc(now).toISOString(),
                },
            },
            {
                headers: {
                    "Cache-Control": "no-store",
                    "X-Request-ID": traceId,
                },
            }
        );
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) {
            securityResponse.headers.set("X-Request-ID", traceId);
            return securityResponse;
        }
        const accessResponse = chatErrorResponse(error);
        if (accessResponse) {
            // This probe writes nothing by design -- no bucket, no credit. A
            // refusal is the exception: it is the one thing here worth being
            // able to look up afterwards, and it is a decision the probe made
            // rather than usage it recorded.
            await recordWebSearchCostRefusal(error, {
                traceId,
                phase: "availability_probe",
                subjectKey: refusalSubjectForLog?.subjectKey ?? null,
                userId: refusalSubjectForLog?.userId ?? null,
                plan: refusalSubjectForLog?.plan ?? null,
                models: refusalModelsForLog,
            });
            accessResponse.headers.set("X-Request-ID", traceId);
            return accessResponse;
        }
        console.error(
            JSON.stringify({
                event: "chat_availability_failed",
                traceId,
                timestamp: new Date().toISOString(),
            })
        );
        return Response.json(
            {
                error: "Request availability could not be checked.",
                code: "CHAT_AVAILABILITY_FAILED",
                traceId,
            },
            { status: 500, headers: { "X-Request-ID": traceId } }
        );
    }
}
