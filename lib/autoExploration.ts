/**
 * Session-seeded exploration inside one credit-equal tie.
 *
 * The ranking's cost criterion treats internal cost within 5% as one bucket,
 * so two models in that bucket can still bill different credit prices. The
 * spread is the tie, further limited to models whose billed credits for this
 * turn equal the sorted top. A hash never moves a turn onto a more expensive
 * credit price.
 *
 * The seed is the conversation id and the recorded grain is `session`. A turn
 * with no conversation id is not given a seed, and the sorted top answers.
 * There is no per-request seed. Softmax is not this function.
 *
 * `enabled` has no default. A missing flag is off.
 */

import {
    allocateWithinTie,
    type RoutingAllocationMode,
    type RoutingAllocationSeedGrain,
} from "@/lib/routingAllocation";

export type AutoExplorationDecision = {
    chosenModelId: string;
    /** Models the hash was allowed to pick, including the sorted top. */
    spreadModelIds: readonly string[];
    allocationMode: RoutingAllocationMode;
    /** Null exactly when the mode is `deterministic`. */
    allocationSeedGrain: RoutingAllocationSeedGrain | null;
};

export const applyAutoExploration = (input: {
    /** Best first. The first id is the sorted top the credit check anchors on. */
    rankedModelIds: readonly string[];
    /**
     * Candidates the real criteria could not separate from the top.
     *
     * This is the tie before the arbitrary model-id order. Passing the fully
     * ranked list here would be a tie of one, because model id always splits
     * it, and exploration would never run.
     */
    tiedModelIds: readonly string[];
    /** This turn's billed credits, per model. A missing entry is not zero. */
    billedCreditsByModelId: Readonly<Record<string, number>>;
    enabled: boolean;
    /** Conversation id. Empty and null both mean "no seed". */
    conversationId: string | null;
}): AutoExplorationDecision | null => {
    const top = input.rankedModelIds[0];
    if (!top) return null;

    const topCredits = input.billedCreditsByModelId[top];
    const sameCredit =
        typeof topCredits === "number"
            ? input.tiedModelIds.filter(
                  (modelId) => input.billedCreditsByModelId[modelId] === topCredits
              )
            : [];
    // The top is the anchor. A tie list that forgot it must not drop it, and
    // a top with no credit price is not something to spread away from.
    const spread = sameCredit.includes(top) ? sameCredit : [top];
    const ordered = [top, ...spread.filter((modelId) => modelId !== top)];

    const seed = input.conversationId?.trim() ?? "";
    // Session only. A request seed would re-roll every turn and drop the
    // prefix cache. No conversation id is not a seed.
    const exploration =
        input.enabled && seed.length > 0
            ? { enabled: true as const, seedGrain: "session" as const, seed }
            : null;

    const allocated = allocateWithinTie(
        ordered,
        () => true,
        (modelId) => modelId,
        exploration
    );
    if (!allocated) return null;

    return {
        chosenModelId: allocated.chosen,
        spreadModelIds: ordered,
        allocationMode: allocated.allocationMode,
        allocationSeedGrain: allocated.allocationSeedGrain,
    };
};
