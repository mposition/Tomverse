import "server-only";

import { generateText, jsonSchema, Output } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";
import { getActiveAiModel } from "@/lib/activeAiModel";
import type { AiModel } from "@/lib/models";
import { prisma } from "@/lib/prisma";
import { readAutoLlmRouterModelId, readAutoLlmRouterRewrite } from "@/lib/autoLlmRouterSettings";
import { readActiveRouterGuidance } from "@/lib/autoLlmRouterGuidance";
import { callCostMicroUsd } from "@/lib/autoRouterOptimizerCore";
import { holdChatUsageBucket } from "@/lib/chatSecurity";
import { providerBucketKey } from "@/lib/chatProviderHolds";
import { resolveModelPricing } from "@/lib/modelPricing";
import { getProviderCostBudget } from "@/lib/providerCostBudget";
import {
    AUTO_LLM_ROUTER_MAX_OUTPUT_TOKENS,
    AUTO_LLM_ROUTER_MAX_PROMPT_CHARS,
    AUTO_LLM_ROUTER_REWRITE_MAX_OUTPUT_TOKENS,
    AUTO_LLM_ROUTER_REWRITE_SOURCE_MAX_CHARS,
    AUTO_LLM_ROUTER_REWRITE_TIMEOUT_MS,
    AUTO_LLM_ROUTER_SESSION_PICKS,
    AUTO_LLM_ROUTER_TIMEOUT_MS,
    autoLlmRouterCandidates,
    autoLlmRouterDecisionVersion,
    autoLlmRouterOutputSchema,
    autoLlmRouterProviderOptions,
    autoLlmRouterSession,
    autoLlmRouterUserMessage,
    autoLlmRouterWorstCaseMicroUsd,
    buildAutoLlmRouterSystem,
    parseAutoLlmRouterOutput,
    resolveAutoLlmRouterModel,
    type AutoLlmRouterCandidate,
    type AutoLlmRouterPick,
    type AutoLlmRouterSession,
} from "@/lib/autoLlmRouterCore";

export type AutoLlmRouterCallResult = {
    outcome: "picked" | "invalid" | "error";
    pick: AutoLlmRouterPick | null;
    usage: { inputTokens?: number; outputTokens?: number } | undefined;
};

/**
 * One router call with the given guidance. Shared by the live turn and the
 * optimizer's replay (lib/autoRouterOptimizer.ts), so a cycle measures the
 * same request the product sends. Never throws.
 */
type AutoLlmRouterCallInput = {
    routerModel: AiModel;
    guidance: string;
    prompt: string;
    previousAnswer: string | null;
    candidates: readonly AutoLlmRouterCandidate[];
    session: AutoLlmRouterSession | null;
    /** Ask the same call for a self-contained rewrite of the message. */
    rewrite?: boolean;
    /** The rewrite guidance in force; the code default when not given. */
    rewriteGuidance?: string;
    /** The live turn's deadline unless given; the optimizer's replay waits longer. */
    timeoutMs?: number;
};

/** What the call sends, built once so its cost bound is of the same request. */
const routerRequest = (input: AutoLlmRouterCallInput) => {
    const rewrite = input.rewrite === true;
    return {
        rewrite,
        system: buildAutoLlmRouterSystem(input.guidance, {
            rewrite,
            rewriteGuidance: input.rewriteGuidance,
        }),
        prompt: autoLlmRouterUserMessage(
            input.prompt,
            input.previousAnswer,
            input.candidates,
            input.session
        ),
        maxOutputTokens: rewrite
            ? AUTO_LLM_ROUTER_REWRITE_MAX_OUTPUT_TOKENS
            : AUTO_LLM_ROUTER_MAX_OUTPUT_TOKENS,
    };
};

export async function callAutoLlmRouter(
    input: AutoLlmRouterCallInput
): Promise<AutoLlmRouterCallResult> {
    const { rewrite, system, prompt, maxOutputTokens } = routerRequest(input);
    try {
        const generated = await generateText({
            model: getActiveAiModel(input.routerModel),
            system,
            prompt,
            maxOutputTokens,
            maxRetries: 0,
            abortSignal: AbortSignal.timeout(
                input.timeoutMs ??
                    (rewrite ? AUTO_LLM_ROUTER_REWRITE_TIMEOUT_MS : AUTO_LLM_ROUTER_TIMEOUT_MS)
            ),
            output: Output.object({
                schema: jsonSchema(
                    autoLlmRouterOutputSchema(input.candidates, { rewrite }) as unknown as JSONSchema7
                ),
                name: "auto_model_choice",
            }),
            providerOptions: autoLlmRouterProviderOptions(input.routerModel.provider),
        });
        const usage = generated.usage as AutoLlmRouterCallResult["usage"];
        const pick = parseAutoLlmRouterOutput(
            generated.output,
            input.candidates,
            rewrite ? input.prompt : null
        );
        return { outcome: pick ? "picked" : "invalid", pick, usage };
    } catch {
        return { outcome: "error", pick: null, usage: undefined };
    }
}

/**
 * The router's memory of this conversation: its own latest decisions here.
 * Null when there are none or they cannot be read -- memory is an aid, and a
 * failed read must not cost the turn its pick.
 */
async function readRouterSession(
    conversationId: string | null
): Promise<AutoLlmRouterSession | null> {
    if (!conversationId) return null;
    try {
        const rows = await prisma.autoRouterDecision.findMany({
            where: { conversationId },
            orderBy: { createdAt: "desc" },
            take: AUTO_LLM_ROUTER_SESSION_PICKS,
            select: { sessionTopic: true, pickedModelId: true, taskKind: true },
        });
        return autoLlmRouterSession(rows);
    } catch {
        return null;
    }
}

// The provider's operational budget, shared with chat, memory extraction and
// the optimizer (docs/policy/credit-and-cost-limits.md): the same
// ChatUsageBucket keys and periods.
const providerPeriods = (now: Date) => [
    {
        period: "provider-cost-day",
        start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
    },
    {
        period: "provider-cost-month",
        start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    },
];

class RouterBudgetRefused extends Error {}

/**
 * Holds the call's worst case under the provider's day and month budgets,
 * both or neither. False -- and no call -- when either is spent or the hold
 * cannot be written: the router fails closed on money, the turn does not.
 * Exported for the database test.
 */
export async function reserveRouterCost(provider: string, microUsd: number, now: Date) {
    const budget = getProviderCostBudget(provider);
    const limits = [budget.day, budget.month];
    try {
        await prisma.$transaction(async (tx) => {
            for (const [index, { period, start }] of providerPeriods(now).entries()) {
                const held = await holdChatUsageBucket(
                    tx,
                    providerBucketKey(provider),
                    period,
                    start,
                    limits[index],
                    microUsd
                );
                if (!held) throw new RouterBudgetRefused();
            }
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * Moves the hold to what the call actually cost: gives back what it did not
 * use, or adds what it used beyond the bound. Only called with usage the
 * provider reported; a failed or timed-out call keeps its whole hold, because
 * it may still have been billed. Exported for the database test.
 */
export async function settleRouterCost(provider: string, deltaMicroUsd: number, reservedAt: Date) {
    if (!Number.isSafeInteger(deltaMicroUsd) || deltaMicroUsd === 0) return;
    try {
        await prisma.$transaction(async (tx) => {
            for (const { period, start } of providerPeriods(reservedAt)) {
                await tx.$executeRaw`
                    UPDATE "ChatUsageBucket"
                    SET "count" = GREATEST(0, "count" + ${deltaMicroUsd}), "updatedAt" = NOW()
                    WHERE "key" = ${providerBucketKey(provider)}
                      AND "period" = ${period}
                      AND "periodStart" = ${start}
                `;
            }
        });
    } catch (error) {
        // The hold stays as it was; over-counted is the usual side of it.
        console.error(
            JSON.stringify({
                event: "chat_auto_llm_router_settle_failed",
                provider,
                error: error instanceof Error ? error.name : "unknown",
            })
        );
    }
}

/** Null when the price cannot be resolved; the call is then not made. */
const routerPrices = (model: AiModel) => {
    try {
        const pricing = resolveModelPricing(model);
        return {
            inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens,
            outputUsdPerMillionTokens: pricing.outputUsdPerMillionTokens,
        };
    } catch {
        return null;
    }
};

/**
 * Ask a small model which eligible candidate should answer this prompt.
 *
 * Returns null -- and the turn keeps the deterministic choice -- when the
 * feature is off, there is nothing to choose between, or the call fails,
 * times out or answers outside the candidate set. It never throws: routing
 * must not be the reason a turn fails.
 *
 * Every call is kept as one `AutoRouterDecision` row: the labelled data a
 * Tomverse-trained triage will learn from. The write is not awaited by the
 * turn, and a failed write is logged, not raised. The log line carries ids,
 * counts and timings only, never the prompt.
 */
export async function pickAutoModelWithLlm(input: {
    prompt: string;
    /** Start of the answer the prompt replies to; see previousAnswerExcerpt. */
    previousAnswer: string | null;
    eligibleModelIds: readonly string[];
    models: readonly AiModel[];
    creditsByModelId: Readonly<Record<string, number>>;
    ruleModelId: string;
    taskKind: string;
    userId: string | null;
    conversationId: string | null;
    traceId: string;
    /**
     * False when the turn cannot be rewritten (attachments anywhere in the
     * conversation): the call then does not ask for one at all.
     */
    rewriteAllowed?: boolean;
}): Promise<{ modelId: string; rewrite: string | null } | null> {
    const routerModel = resolveAutoLlmRouterModel(
        input.models,
        (await readAutoLlmRouterModelId()) ?? undefined
    );
    if (!routerModel) return null;
    const candidates = autoLlmRouterCandidates(
        input.eligibleModelIds,
        input.models,
        input.creditsByModelId
    );
    if (candidates.length < 2 || !input.prompt.trim()) return null;

    const [session, active, rewriteOn] = await Promise.all([
        readRouterSession(input.conversationId),
        readActiveRouterGuidance(),
        readAutoLlmRouterRewrite(),
    ]);
    // Rewriting pays off on short, context-dependent turns; a long message is
    // routed as it is.
    const rewrite =
        rewriteOn &&
        input.rewriteAllowed === true &&
        input.prompt.trim().length <= AUTO_LLM_ROUTER_REWRITE_SOURCE_MAX_CHARS;
    // Read only when a rewrite is asked for, so a turn with rewriting off
    // makes the same reads and sends the same prompt as before.
    const rewriteGuidance = rewrite ? await readActiveRouterGuidance(prisma, "rewrite") : null;
    const version = autoLlmRouterDecisionVersion({
        routingCycleId: active.cycleId,
        rewrite,
        rewriteCycleId: rewriteGuidance?.cycleId ?? null,
    });
    const call: AutoLlmRouterCallInput = {
        routerModel,
        guidance: active.guidance,
        prompt: input.prompt,
        previousAnswer: input.previousAnswer,
        candidates,
        session,
        rewrite,
        rewriteGuidance: rewriteGuidance?.guidance,
    };
    const prices = routerPrices(routerModel);
    const request = routerRequest(call);
    const worstCase = prices ? autoLlmRouterWorstCaseMicroUsd({ ...request, ...prices }) : null;
    const reservedAt = new Date();
    if (worstCase === null || !(await reserveRouterCost(routerModel.provider, worstCase, reservedAt))) {
        console.info(
            JSON.stringify({
                event: "chat_auto_llm_router_skipped",
                traceId: input.traceId,
                routerModelId: routerModel.id,
                reason: worstCase === null ? "unpriced" : "provider_budget",
            })
        );
        return null;
    }
    const startedAt = Date.now();
    const { outcome, pick, usage } = await callAutoLlmRouter(call);
    const latencyMs = Date.now() - startedAt;
    if (prices && usage?.inputTokens !== undefined && usage.outputTokens !== undefined) {
        const actual = callCostMicroUsd({
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            ...prices,
            worstCaseMicroUsd: worstCase,
        });
        void settleRouterCost(routerModel.provider, actual - worstCase, reservedAt);
    }
    console.info(
        JSON.stringify({
            event: "chat_auto_llm_router",
            version,
            traceId: input.traceId,
            routerModelId: routerModel.id,
            candidateCount: candidates.length,
            ruleModelId: input.ruleModelId,
            pickedModelId: pick?.modelId ?? null,
            hasContext: input.previousAnswer !== null,
            hasSession: session !== null,
            rewriteAsked: rewrite,
            rewriteKept: Boolean(pick?.rewrite),
            outcome,
            latencyMs,
        })
    );

    if (input.userId && input.conversationId) {
        void prisma.autoRouterDecision
            .create({
                data: {
                    version,
                    traceId: input.traceId,
                    userId: input.userId,
                    conversationId: input.conversationId,
                    routerInput: input.prompt.slice(0, AUTO_LLM_ROUTER_MAX_PROMPT_CHARS),
                    routerContext: input.previousAnswer,
                    routerSession: session ?? undefined,
                    candidates,
                    taskKind: input.taskKind,
                    ruleModelId: input.ruleModelId,
                    routerModelId: routerModel.id,
                    pickedModelId: pick?.modelId ?? null,
                    reason: pick?.reason ?? null,
                    sessionTopic: pick?.topic ?? null,
                    rewrite: pick?.rewrite ?? null,
                    outcome,
                    latencyMs,
                    inputTokens: usage?.inputTokens ?? null,
                    outputTokens: usage?.outputTokens ?? null,
                },
            })
            .catch((error: unknown) => {
                console.error(
                    JSON.stringify({
                        event: "chat_auto_llm_router_record_failed",
                        traceId: input.traceId,
                        error: error instanceof Error ? error.name : "unknown",
                    })
                );
            });
    }
    return pick ? { modelId: pick.modelId, rewrite: pick.rewrite } : null;
}
