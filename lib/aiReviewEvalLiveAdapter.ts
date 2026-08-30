/**
 * The only place an AI Review evaluation run can reach a provider.
 *
 * Everything the SDK needs is imported dynamically, inside a call that has
 * already been admitted by `decideAiReviewEvalRunMode()`. The runner
 * (scripts/eval-ai-review.mjs) therefore has no static path to a provider at
 * all, which makes "is this invocation able to spend money yet?" a question
 * about imports rather than about control flow -- the same boundary
 * `lib/memoryEvalLiveAdapter.ts` draws, for the same reason.
 */

import type {
    AiReviewEvalCase,
    AiReviewEvalObservation,
} from "@/lib/aiReviewEvalCore";

export type AiReviewEvalCallOutcome = {
    observation: AiReviewEvalObservation | null;
    /** Sanitised failure label; never a provider message that could carry a key. */
    failure: string | null;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
};

export type AiReviewEvalAdapterInput = {
    reviewerModelId: string;
    /** Hard per-request output cap, so a single case cannot run away. */
    maxOutputTokens: number;
    onPricingFailure: () => void;
};

/**
 * Builds the function a run calls once per case.
 *
 * The product's own prompt builder is used, not a copy: an eval that reviews
 * with a different prompt than production measures a prompt nobody ships.
 * `includeSynthesis` is false throughout -- the synthesis is prose the scorer
 * deliberately does not read as a finding, and paying for it in every case
 * would inflate the run's cost without changing a single metric.
 */
export function createAiReviewEvalAdapter(
    input: AiReviewEvalAdapterInput
): (testCase: AiReviewEvalCase) => Promise<AiReviewEvalCallOutcome> {
    return async (testCase: AiReviewEvalCase) => {
        const started = Date.now();
        const [
            { generateText, Output },
            { getActiveAiModel },
            { getModelGenerationSettings },
            {
                buildComparisonReviewPrompt,
                comparisonReviewResultSchema,
                verifyComparisonReviewResult,
            },
            { getEnabledModel },
            { resolveModelPricing },
            { buildObservation },
        ] = await Promise.all([
            import("ai"),
            import("@/lib/activeAiModel"),
            import("@/lib/modelGenerationCompatibility"),
            import("@/lib/comparisonReview"),
            import("@/lib/models"),
            import("@/lib/modelPricing"),
            import("@/lib/aiReviewEvalCore"),
        ]);

        const model = getEnabledModel(input.reviewerModelId);
        if (!model) {
            // Refused rather than defaulted: a run that quietly reviewed with
            // a different model would report that model's quality under this
            // one's name.
            throw new Error(`unknown or disabled reviewer: ${input.reviewerModelId}`);
        }

        const prompt = buildComparisonReviewPrompt({
            question: testCase.question,
            responses: testCase.responses.map((response, index) => ({
                messageId: `${testCase.id}-${index}`,
                modelId: response.modelId,
                modelName: response.modelId,
                provider: response.provider as never,
                content: response.content,
            })),
            reviewMode: testCase.mode,
            includeSynthesis: false,
            language: testCase.language,
        });

        try {
            const generated = await generateText({
                model: getActiveAiModel(model),
                system: prompt.system,
                prompt: prompt.prompt,
                output: Output.object({ schema: comparisonReviewResultSchema }),
                // The same generation settings the product uses, prompt cache
                // path included: an eval that reviews under different settings
                // than production measures a configuration nobody ships.
                ...getModelGenerationSettings(model, {
                    temperature: 0.1,
                    promptCachePath: "comparison_review",
                }),
                maxOutputTokens: input.maxOutputTokens,
                maxRetries: 1,
                abortSignal: AbortSignal.timeout(60_000),
            });

            const inputTokens = generated.usage.inputTokens ?? 0;
            const outputTokens = generated.usage.outputTokens ?? 0;
            let costUsd = 0;
            try {
                const pricing = resolveModelPricing(model, {
                    estimatedPromptTokens: inputTokens,
                });
                costUsd =
                    (inputTokens * pricing.inputUsdPerMillionTokens +
                        outputTokens * pricing.outputUsdPerMillionTokens) /
                    1_000_000;
            } catch {
                // Counted, not thrown: pricing feeds the spend ceiling, so a
                // resolution failure must not abort an otherwise fine run --
                // and must not be silent either, or the ceiling stops binding.
                input.onPricingFailure();
            }

            const parsed = comparisonReviewResultSchema.safeParse(generated.output);
            if (!parsed.success) {
                return {
                    observation: null,
                    failure: "schema_invalid",
                    costUsd,
                    inputTokens,
                    outputTokens,
                    durationMs: Date.now() - started,
                };
            }
            const verified = verifyComparisonReviewResult(
                parsed.data,
                prompt.contentByResponseId
            );
            return {
                observation: buildObservation(verified, { schemaValid: true }),
                failure: null,
                costUsd,
                inputTokens,
                outputTokens,
                durationMs: Date.now() - started,
            };
        } catch (error) {
            // Only the error's class name travels. A provider message can
            // contain a request echo, and an eval artifact is committed.
            return {
                observation: null,
                failure:
                    error instanceof Error ? error.name || "Error" : "UnknownError",
                costUsd: 0,
                inputTokens: 0,
                outputTokens: 0,
                durationMs: Date.now() - started,
            };
        }
    };
}
