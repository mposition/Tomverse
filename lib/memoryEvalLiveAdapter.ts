/**
 * The one definition of "how an eval calls the provider".
 *
 * ## Why this is a module rather than a function in the harness
 *
 * Three live runs died on the difference between the harness's own provider
 * call and the product's: a system message the SDK refuses, then an output
 * ceiling the harness had picked for itself. The fix was to stop hand-rolling
 * the call and delegate to `createExtractionProviderAdapter`, the same
 * function `memoryExtractionWorker` uses.
 *
 * That fix held for exactly as long as there was one harness. A second script
 * — the development probe — would have had to build the same adapter again,
 * and "the same" is a claim nobody checks until a run fails. So the
 * delegation lives here and both callers import it.
 *
 * An eval differs from the product in three ways and no others: nothing to
 * abort, no durable cost row, and a usage hook so the spend ceiling has real
 * numbers instead of an estimate. Everything else — the model, the output
 * ceiling, the request shape — comes from the product.
 *
 * ## Loaded late on purpose
 *
 * The imports are dynamic. A run refused before it reaches a provider must
 * not have pulled the AI SDK into its module graph on the way, because "is a
 * model being called yet?" should be answerable by reading imports rather
 * than by tracing control flow.
 */

export type EvalLiveAdapterInput = {
    modelId: string;
    /** Called with the USD cost of each completed request. */
    onCostUsd: (usd: number) => void;
    /**
     * Called when pricing could not be resolved for a request.
     *
     * Counted rather than thrown: pricing feeds the spend ceiling, so a
     * resolution failure must not abort a run that is otherwise fine. It must
     * not be silent either — `resolveModelPricing` was once called with the
     * wrong argument shape, threw on every call, and the swallowed error left
     * the accrued cost at zero for a whole live run while the spend ceiling
     * of docs/policy/external-conversation-import-and-memory.md §12.5
     * never bound.
     */
    onPricingFailure: () => void;
};

/**
 * Builds the adapter an eval run hands to `analyzeExtractionChunk`.
 *
 * Returns a function rather than the adapter itself so the dynamic imports
 * happen on first use — inside a run that has already been allowed to reach a
 * provider — rather than at module load.
 */
export function createEvalLiveAdapter(
    input: EvalLiveAdapterInput
): (chunk: unknown) => Promise<unknown> {
    return async (chunk: unknown) => {
        const [
            { createExtractionProviderAdapter },
            { MEMORY_EXTRACTION_CHUNK_MAX_OUTPUT_TOKENS },
            { getModel },
            { resolveModelPricing },
        ] = await Promise.all([
            import("@/lib/memoryExtractionProvider"),
            import("@/lib/memoryExtractionWorker"),
            import("@/lib/models"),
            import("@/lib/modelPricing"),
        ]);
        const model = getModel(input.modelId);
        if (!model) {
            // Refused rather than defaulted. A probe or eval that quietly ran
            // against a different model than the one named would report that
            // model's quality under this one's name.
            throw new Error(`unknown model: ${input.modelId}`);
        }
        const adapter = createExtractionProviderAdapter({
            model,
            maxOutputTokens: MEMORY_EXTRACTION_CHUNK_MAX_OUTPUT_TOKENS,
            // An eval has no deadline of its own: the run is bounded by the
            // spend ceiling and the consecutive-failure guard, both of which
            // stop it between cases rather than mid-request.
            signal: new AbortController().signal,
            onCallIssued: () => {},
            onResult: (result: {
                usage: { inputTokens?: number; outputTokens?: number };
            }) => {
                try {
                    const pricing = resolveModelPricing(model, {
                        estimatedPromptTokens: result.usage.inputTokens ?? 0,
                    });
                    input.onCostUsd(
                        ((result.usage.inputTokens ?? 0) *
                            pricing.inputUsdPerMillionTokens +
                            (result.usage.outputTokens ?? 0) *
                                pricing.outputUsdPerMillionTokens) /
                            1_000_000
                    );
                } catch {
                    input.onPricingFailure();
                }
            },
        } as never);
        return (adapter as (value: unknown) => Promise<unknown>)(chunk);
    };
}
