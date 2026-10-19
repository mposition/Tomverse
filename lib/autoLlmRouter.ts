import "server-only";

import { generateText, jsonSchema, Output } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";
import { getActiveAiModel } from "@/lib/activeAiModel";
import type { AiModel } from "@/lib/models";
import { prisma } from "@/lib/prisma";
import { readAutoLlmRouterModelId, readAutoLlmRouterRewrite } from "@/lib/autoLlmRouterSettings";
import { readActiveRouterGuidance } from "@/lib/autoLlmRouterGuidance";
import { autoLlmRouterVersionFor } from "@/lib/autoRouterOptimizerCore";
import {
    AUTO_LLM_ROUTER_MAX_OUTPUT_TOKENS,
    AUTO_LLM_ROUTER_MAX_PROMPT_CHARS,
    AUTO_LLM_ROUTER_REWRITE_MAX_OUTPUT_TOKENS,
    AUTO_LLM_ROUTER_REWRITE_SOURCE_MAX_CHARS,
    AUTO_LLM_ROUTER_REWRITE_TIMEOUT_MS,
    AUTO_LLM_ROUTER_SESSION_PICKS,
    AUTO_LLM_ROUTER_TIMEOUT_MS,
    AUTO_LLM_ROUTER_VERSION,
    autoLlmRouterCandidates,
    autoLlmRouterOutputSchema,
    autoLlmRouterSession,
    autoLlmRouterUserMessage,
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
export async function callAutoLlmRouter(input: {
    routerModel: AiModel;
    guidance: string;
    prompt: string;
    previousAnswer: string | null;
    candidates: readonly AutoLlmRouterCandidate[];
    session: AutoLlmRouterSession | null;
    /** Ask the same call for a self-contained rewrite of the message. */
    rewrite?: boolean;
}): Promise<AutoLlmRouterCallResult> {
    const rewrite = input.rewrite === true;
    try {
        const generated = await generateText({
            model: getActiveAiModel(input.routerModel),
            system: buildAutoLlmRouterSystem(input.guidance, { rewrite }),
            prompt: autoLlmRouterUserMessage(
                input.prompt,
                input.previousAnswer,
                input.candidates,
                input.session
            ),
            maxOutputTokens: rewrite
                ? AUTO_LLM_ROUTER_REWRITE_MAX_OUTPUT_TOKENS
                : AUTO_LLM_ROUTER_MAX_OUTPUT_TOKENS,
            maxRetries: 0,
            abortSignal: AbortSignal.timeout(
                rewrite ? AUTO_LLM_ROUTER_REWRITE_TIMEOUT_MS : AUTO_LLM_ROUTER_TIMEOUT_MS
            ),
            output: Output.object({
                schema: jsonSchema(
                    autoLlmRouterOutputSchema(input.candidates, { rewrite }) as unknown as JSONSchema7
                ),
                name: "auto_model_choice",
            }),
            providerOptions: { openai: { strictJsonSchema: true } },
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
    const version =
        autoLlmRouterVersionFor(AUTO_LLM_ROUTER_VERSION, active.cycleId) + (rewrite ? "+rewrite" : "");
    const startedAt = Date.now();
    const { outcome, pick, usage } = await callAutoLlmRouter({
        routerModel,
        guidance: active.guidance,
        prompt: input.prompt,
        previousAnswer: input.previousAnswer,
        candidates,
        session,
        rewrite,
    });
    const latencyMs = Date.now() - startedAt;
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
