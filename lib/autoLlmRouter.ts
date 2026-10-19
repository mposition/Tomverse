import "server-only";

import { generateText, jsonSchema, Output } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";
import { getActiveAiModel } from "@/lib/activeAiModel";
import type { AiModel } from "@/lib/models";
import { prisma } from "@/lib/prisma";
import { readAutoLlmRouterModelId } from "@/lib/autoLlmRouterSettings";
import {
    AUTO_LLM_ROUTER_MAX_OUTPUT_TOKENS,
    AUTO_LLM_ROUTER_MAX_PROMPT_CHARS,
    AUTO_LLM_ROUTER_SYSTEM,
    AUTO_LLM_ROUTER_TIMEOUT_MS,
    AUTO_LLM_ROUTER_VERSION,
    autoLlmRouterCandidates,
    autoLlmRouterOutputSchema,
    autoLlmRouterUserMessage,
    parseAutoLlmRouterOutput,
    resolveAutoLlmRouterModel,
} from "@/lib/autoLlmRouterCore";

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
    eligibleModelIds: readonly string[];
    models: readonly AiModel[];
    creditsByModelId: Readonly<Record<string, number>>;
    ruleModelId: string;
    taskKind: string;
    userId: string | null;
    conversationId: string | null;
    traceId: string;
}): Promise<string | null> {
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

    const startedAt = Date.now();
    let outcome: "picked" | "invalid" | "error" = "error";
    let picked: string | null = null;
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
    try {
        const generated = await generateText({
            model: getActiveAiModel(routerModel),
            system: AUTO_LLM_ROUTER_SYSTEM,
            prompt: autoLlmRouterUserMessage(input.prompt, candidates),
            maxOutputTokens: AUTO_LLM_ROUTER_MAX_OUTPUT_TOKENS,
            maxRetries: 0,
            abortSignal: AbortSignal.timeout(AUTO_LLM_ROUTER_TIMEOUT_MS),
            output: Output.object({
                schema: jsonSchema(
                    autoLlmRouterOutputSchema(candidates) as unknown as JSONSchema7
                ),
                name: "auto_model_choice",
            }),
            providerOptions: { openai: { strictJsonSchema: true } },
        });
        usage = generated.usage as typeof usage;
        picked = parseAutoLlmRouterOutput(generated.output, candidates);
        outcome = picked ? "picked" : "invalid";
    } catch {
        outcome = "error";
    }
    const latencyMs = Date.now() - startedAt;
    console.info(
        JSON.stringify({
            event: "chat_auto_llm_router",
            version: AUTO_LLM_ROUTER_VERSION,
            traceId: input.traceId,
            routerModelId: routerModel.id,
            candidateCount: candidates.length,
            ruleModelId: input.ruleModelId,
            pickedModelId: picked,
            outcome,
            latencyMs,
        })
    );

    if (input.userId && input.conversationId) {
        void prisma.autoRouterDecision
            .create({
                data: {
                    version: AUTO_LLM_ROUTER_VERSION,
                    traceId: input.traceId,
                    userId: input.userId,
                    conversationId: input.conversationId,
                    routerInput: input.prompt.slice(0, AUTO_LLM_ROUTER_MAX_PROMPT_CHARS),
                    candidates,
                    taskKind: input.taskKind,
                    ruleModelId: input.ruleModelId,
                    routerModelId: routerModel.id,
                    pickedModelId: picked,
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
    return picked;
}
