import "server-only";

import { generateText, jsonSchema, Output } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";
import { getActiveAiModel } from "@/lib/activeAiModel";
import type { AiModel } from "@/lib/models";
import {
    AUTO_LLM_ROUTER_MAX_OUTPUT_TOKENS,
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
 * The log line carries ids, counts and timings only, never the prompt.
 */
export async function pickAutoModelWithLlm(input: {
    prompt: string;
    eligibleModelIds: readonly string[];
    models: readonly AiModel[];
    creditsByModelId: Readonly<Record<string, number>>;
    traceId: string;
}): Promise<string | null> {
    const routerModel = resolveAutoLlmRouterModel(
        input.models,
        process.env.CHAT_AUTO_LLM_ROUTER_MODEL_ID
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
        picked = parseAutoLlmRouterOutput(generated.output, candidates);
        outcome = picked ? "picked" : "invalid";
    } catch {
        outcome = "error";
    }
    console.info(
        JSON.stringify({
            event: "chat_auto_llm_router",
            version: AUTO_LLM_ROUTER_VERSION,
            traceId: input.traceId,
            routerModelId: routerModel.id,
            candidateCount: candidates.length,
            pickedModelId: picked,
            outcome,
            latencyMs: Date.now() - startedAt,
        })
    );
    return picked;
}
