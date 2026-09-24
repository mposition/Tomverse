/**
 * Load guard.
 *
 * The sentence is: check credential capacity and deployment load before and
 * after softmax; treat a momentary saturation by decaying weight; do not move
 * all traffic onto the next provider in one step.
 *
 * This module does not run a softmax. `lib/routingAllocation.ts` keeps
 * allocation inside a lexicographic tie because a softmax temperature would
 * be a quality-versus-cost trade nobody has set. Inventing that temperature
 * here would be the same trade. The two phase names are therefore a checklist
 * the caller fills, not a claim that a softmax ran.
 *
 * The decay factor is the caller's. Zero would drop the candidate and hand
 * its share to whoever remains, which is the move this guard exists to
 * refuse. One is not a decay. A number outside (0, 1) is not applied.
 *
 * Pure. The request path does not import this.
 */

export const LOAD_GUARD_PHASES = ["before_softmax", "after_softmax"] as const;

export type LoadGuardPhase = (typeof LOAD_GUARD_PHASES)[number];

export type LoadSignals = {
    /** Credential capacity is full: retry-after, concurrency, or an empty bucket. */
    capacitySaturated: boolean;
    /** The deployment itself is momentarily loaded. */
    deploymentLoaded: boolean;
};

const finiteNonNegative = (value: number) => Number.isFinite(value) && value >= 0;

const usableDecay = (decay: number | null): decay is number =>
    typeof decay === "number" && Number.isFinite(decay) && decay > 0 && decay < 1;

/**
 * The weight to keep when these signals are on.
 *
 * A quiet candidate is returned unchanged, and a missing decay does not
 * matter for it. A hot candidate with no usable decay returns null: the
 * caller does not get a zero, and does not get a factor this module chose.
 * An unusable weight returns null rather than a clamped substitute.
 */
export const guardedWeight = (
    weight: number,
    signals: LoadSignals,
    decay: number | null
): number | null => {
    if (!finiteNonNegative(weight)) return null;
    if (!signals.capacitySaturated && !signals.deploymentLoaded) return weight;
    if (!usableDecay(decay)) return null;
    return weight * decay;
};

export type WeightedProvider = {
    providerId: string;
    weight: number;
};

const summed = (
    rows: readonly WeightedProvider[]
): Map<string, number> | null => {
    const totals = new Map<string, number>();
    for (const row of rows) {
        if (!finiteNonNegative(row.weight) || row.providerId.length === 0) return null;
        totals.set(row.providerId, (totals.get(row.providerId) ?? 0) + row.weight);
    }
    return totals;
};

const positiveIds = (totals: Map<string, number>) =>
    [...totals.entries()].filter((entry) => entry[1] > 0).map((entry) => entry[0]);

/**
 * Whether `after` moved every remaining positive share onto one provider
 * by dropping at least one provider that was positive in `before`.
 *
 * Two or more providers still positive is not this. A field that was already
 * a single provider is not this. Invalid weights return null.
 */
export const allocationHerds = (
    before: readonly WeightedProvider[],
    after: readonly WeightedProvider[]
): boolean | null => {
    const earlier = summed(before);
    const later = summed(after);
    if (!earlier || !later) return null;
    const wasPositive = positiveIds(earlier);
    if (wasPositive.length < 2) return false;
    const stillPositive = positiveIds(later);
    if (stillPositive.length !== 1) return false;
    const survivor = stillPositive[0];
    return wasPositive.some(
        (providerId) => providerId !== survivor && (later.get(providerId) ?? 0) === 0
    );
};

/**
 * Both named phases have to be present. Either one alone is not the check
 * the ADR names, and this does not treat a missing half as done.
 */
export const loadGuardPhasesChecked = (phases: readonly string[]): boolean =>
    LOAD_GUARD_PHASES.every((phase) => phases.includes(phase));
