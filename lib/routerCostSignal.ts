/**
 * What this turn would cost on each candidate, from the pricing registry.
 *
 * The Router's second tie-break criterion is expected total cost, and a
 * criterion with no data behind it is not a criterion -- with quality bands
 * level and no cost figures, ranking would fall through to the stable model
 * id, which is deterministic but arbitrary. This supplies the figures from
 * something already measured: the per-model prices in `lib/modelPricing.ts`.
 *
 * **Same token counts for every model, per-model prices.** The input figure is
 * what the request really sends and the output figure is the cap this
 * application asked for, both identical across candidates, so the ordering
 * this produces reflects price and nothing else. Two alternatives were
 * rejected:
 *
 *   - the candidate's *fitted* output room, which differs per model. A model
 *     with a larger context window would look more expensive for having more
 *     room, which is not a cost the turn would incur.
 *   - the profile's `expectedOutputLength`. It is a coarse reading of the
 *     request that nothing has calibrated, and turning it into dollars would
 *     give an unmeasured label a price. It stays recorded and unused.
 *
 * So this is a comparison, not a forecast. It ranks candidates by what they
 * charge for the same work; it does not predict a bill, and nothing bills from
 * it -- credit reservation and settlement remain the financial source of truth
 * (`docs/policy/tomverse-chat-routing.md` §2).
 *
 * Pure enough for the decision path: registry lookups and environment-declared
 * price overrides, no database, no network, no clock.
 */

import type { AiModel } from "@/lib/models";
import { resolveModelPricing } from "@/lib/modelPricing";

export const expectedTotalCostUsdByModel = ({
    models,
    reservedInputTokens,
    requestOutputCapTokens,
}: {
    models: readonly AiModel[];
    reservedInputTokens: number;
    requestOutputCapTokens: number;
}): Record<string, number> => {
    const inputTokens = Math.max(0, reservedInputTokens);
    const outputTokens = Math.max(0, requestOutputCapTokens);
    const costs: Record<string, number> = {};

    for (const model of models) {
        const pricing = resolveModelPricing(model, {
            estimatedPromptTokens: inputTokens,
        });
        costs[model.id] =
            (inputTokens / 1_000_000) * pricing.inputUsdPerMillionTokens +
            (outputTokens / 1_000_000) * pricing.outputUsdPerMillionTokens;
    }

    return costs;
};
