import "server-only";

import {
    APICallError, generateText, JSONParseError, jsonSchema,
    NoObjectGeneratedError, NoOutputGeneratedError, Output, TypeValidationError,
} from "ai";
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
    autoLlmRouterFailureDetail,
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
    type AutoLlmRouterFailure,
    type AutoFileGenerationContext,
    withAutoFileCapabilities,
} from "@/lib/autoLlmRouterCore";
import { effectiveRouterTimeoutMs, withoutExcludedModels } from "@/lib/autoRouterTunablesCore";
import { readAutoRouterTunables } from "@/lib/autoRouterTunablesRead";

export type AutoLlmRouterCallResult = {
    outcome: "picked" | "invalid" | "error" | "timeout";
    pick: AutoLlmRouterPick | null;
    usage: { inputTokens?: number; outputTokens?: number } | undefined;
    failure?: AutoLlmRouterFailure;
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
    traceId?: string;
    cycleId?: string;
    decisionId?: string;
};

/** What the call sends, built once so its cost bound is of the same request. */
const routerRequest = (input: AutoLlmRouterCallInput) => {
    const rewrite = input.rewrite === true;
    const candidates = withAutoFileCapabilities(input.candidates);
    return {
        rewrite,
        candidates,
        system: buildAutoLlmRouterSystem(input.guidance, {
            rewrite,
            rewriteGuidance: input.rewriteGuidance,
        }),
        prompt: autoLlmRouterUserMessage(
            input.prompt,
            input.previousAnswer,
            candidates,
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
    const { rewrite, system, prompt, maxOutputTokens, candidates } = routerRequest(input);
    const timeoutMs = input.timeoutMs ??
        (rewrite ? AUTO_LLM_ROUTER_REWRITE_TIMEOUT_MS : AUTO_LLM_ROUTER_TIMEOUT_MS);
    const abortSignal = AbortSignal.timeout(timeoutMs);
    let usage: AutoLlmRouterCallResult["usage"];
    let finishReason: string | undefined;
    let stage: "generate" | "output" = "generate";
    // Deliberately omit exception messages, response bodies and model output:
    // all three can contain the user's message or provider credentials.
    const logFailure = (failure: string, detail: Record<string, unknown> = {}) => console.warn(
        JSON.stringify({
            event: "auto_llm_router_call_failed",
            traceId: input.traceId,
            cycleId: input.cycleId,
            decisionId: input.decisionId,
            routerModelId: input.routerModel.id,
            provider: input.routerModel.provider,
            rewrite,
            timeoutMs,
            stage,
            failure,
            finishReason,
            inputTokens: usage?.inputTokens ?? null,
            outputTokens: usage?.outputTokens ?? null,
            ...detail,
        })
    );
    try {
        const generated = await generateText({
            model: getActiveAiModel(input.routerModel),
            system,
            prompt,
            maxOutputTokens,
            maxRetries: 0,
            abortSignal,
            output: Output.object({
                schema: jsonSchema(
                    autoLlmRouterOutputSchema(candidates, { rewrite }) as unknown as JSONSchema7
                ),
                name: "auto_model_choice",
            }),
            providerOptions: autoLlmRouterProviderOptions(input.routerModel.provider),
        });
        usage = generated.usage as AutoLlmRouterCallResult["usage"];
        finishReason = generated.finishReason;
        stage = "output";
        const output = generated.output;
        const pick = parseAutoLlmRouterOutput(
            output,
            candidates,
            rewrite ? input.prompt : null
        );
        if (!pick) {
            const value = output as { modelId?: unknown; requiresFileGeneration?: unknown } | null;
            logFailure("invalid_pick", {
                modelIdPresent: typeof value?.modelId === "string",
                modelIdEligible: candidates.some(candidate => candidate.id === value?.modelId),
                fileIntentType: typeof value?.requiresFileGeneration,
            });
        }
        return { outcome: pick ? "picked" : "invalid", pick, usage,
            ...(!pick ? { failure: { kind: "invalid_output" as const } } : {}) };
    } catch (error) {
        const structured = NoObjectGeneratedError.isInstance(error);
        const empty = NoOutputGeneratedError.isInstance(error);
        if (structured) {
            usage = error.usage ?? usage;
            finishReason = error.finishReason ?? finishReason;
            stage = "output";
        }
        const failure = autoLlmRouterFailureDetail(error, abortSignal.aborted);
        const failureCode = failure.kind === "timeout" ? "timeout"
            : structured ? (JSONParseError.isInstance(error.cause) ? "output_parse"
                : TypeValidationError.isInstance(error.cause) ? "output_schema" : "output_invalid")
            : empty ? "empty_output"
            : APICallError.isInstance(error) ? "provider_error" : "call_error";
        logFailure(failureCode, {
            ...(structured ? { outputChars: error.text?.length ?? 0 } : {}),
            ...(APICallError.isInstance(error) ? {
                statusCode: error.statusCode,
                retryable: error.isRetryable,
            } : {}),
        });
        return {
            outcome: failure.kind === "timeout" ? "timeout" : structured || empty ? "invalid" : "error",
            pick: null,
            usage,
            failure,
        };
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
    fileContext?: AutoFileGenerationContext;
    /**
     * Resolves false when this turn turned out not to be a chat turn at all
     * (an Auto Chat image request, lib/chatImageIntent.ts): its decision row
     * is then not kept, so routing data, the optimizer's samples and the
     * session memory hold only turns a chat model answered. Absent is true.
     */
    recordDecision?: Promise<boolean> | ((pick: AutoLlmRouterPick | null) => Promise<boolean>);
}): Promise<{ modelId: string; rewrite: string | null; requiresFileGeneration?: true } | null> {
    const routerModel = resolveAutoLlmRouterModel(
        input.models,
        (await readAutoLlmRouterModelId()) ?? undefined
    );
    if (!routerModel) return null;
    // The optimizer's own setting changes, applied under the owner's switch
    // (lib/autoRouterTunablesCore.ts): a tuned deadline and models left out
    // for a while after their calls kept failing.
    const tunables = await readAutoRouterTunables();
    const candidates = withoutExcludedModels(
        autoLlmRouterCandidates(input.eligibleModelIds, input.models, input.creditsByModelId, input.fileContext),
        tunables,
        Date.now()
    );
    if (candidates.length < 2 || !input.prompt.trim()) return null;

    const [session, active, rewriteOn] = await Promise.all([
        readRouterSession(input.conversationId),
        readActiveRouterGuidance(),
        readAutoLlmRouterRewrite(),
    ]);
    const timeoutMs = effectiveRouterTimeoutMs(tunables, AUTO_LLM_ROUTER_TIMEOUT_MS);
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
        traceId: input.traceId,
        routerModel,
        guidance: active.guidance,
        prompt: input.prompt,
        previousAnswer: input.previousAnswer,
        candidates,
        session,
        rewrite,
        rewriteGuidance: rewriteGuidance?.guidance,
        // A rewrite needs its own longer deadline; a tuned one only ever adds to it.
        timeoutMs: rewrite ? Math.max(AUTO_LLM_ROUTER_REWRITE_TIMEOUT_MS, timeoutMs) : timeoutMs,
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
    const { outcome, pick, usage, failure } = await callAutoLlmRouter(call);
    const latencyMs = Date.now() - startedAt;
    if (prices && usage?.inputTokens !== undefined && usage.outputTokens !== undefined) {
        const actual = callCostMicroUsd({
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            ...prices,
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
            timeoutMs: call.timeoutMs,
            ...(failure ? { failure } : {}),
        })
    );

    if (input.userId && input.conversationId) {
        const userId = input.userId;
        const conversationId = input.conversationId;
        void Promise.resolve()
            .then(() => typeof input.recordDecision === "function"
                ? input.recordDecision(pick) : input.recordDecision ?? true)
            .then((keep) => {
                if (!keep) return;
                return prisma.autoRouterDecision.create({
                    data: {
                        version,
                        traceId: input.traceId,
                        userId,
                        conversationId,
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
                });
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
    return pick ? {
        modelId: pick.modelId,
        rewrite: pick.rewrite,
        ...(pick.requiresFileGeneration ? { requiresFileGeneration: true as const } : {}),
    } : null;
}
