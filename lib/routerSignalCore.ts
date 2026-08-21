/**
 * The Router's measured tie-break signals, computed from dispatch outcomes.
 *
 * Criteria 3 and 4 of `ROUTER_TIE_BREAK_ORDER` are "recent success rate" and
 * "time to first token, p95". Both describe what a user actually got, so both
 * are computed here from `RoutingAttempt` rows -- one population, one window,
 * one definition of success.
 *
 * ## Why probe results are not in this file
 *
 * `ProviderProbeResult` is the other thing in this repository that looks like a
 * success rate, and mixing the two would be the mistake this module exists to
 * avoid. A probe is a synthetic request the scheduler makes to find out whether
 * a provider is answering at all; a dispatch is a person waiting for a reply.
 * They are different populations, and a comparator ranking one model's probe
 * rate against another's dispatch rate would be comparing two different
 * questions and reporting the answer as a preference.
 *
 * So the split is by what the number is *for*: probes decide whether a model is
 * a candidate at all (`lib/modelHealthRollup.ts`, a hard filter and a
 * degradation flag), and dispatches decide the order of the candidates that
 * survive. Neither is ever folded into the other.
 *
 * The probe coverage makes this concrete rather than theoretical:
 * `getProbeModelFor` probes one model per provider -- the cheapest standard one
 * -- so probe evidence exists for about ten of the thirty enabled models, and
 * for none of Perplexity's. A success rate built from that would be absent for
 * two thirds of the catalogue and, where present, would be a measurement of a
 * different model's traffic than the one being ranked.
 *
 * ## Absent is absent
 *
 * A model with too few observations gets no entry, and an absent entry makes
 * the criterion abstain (`lib/routerSelection.ts`). There is no default rate
 * and no zero: a model nobody has dispatched has not failed, and giving it a
 * number would rank it against models that earned theirs.
 *
 * Pure. No database, no clock beyond what the caller passes, no I/O.
 */

/**
 * Outcomes that count toward the success rate, and what counts as a success.
 *
 * Deliberately narrower than the full `RoutingAttempt.outcome` list:
 *
 *   `not_dispatched`         never reached a provider, so it says nothing about
 *                            the model -- it is the Router or the budget having
 *                            refused, which is already recorded elsewhere.
 *   `cancelled`              the person stopped reading. Counting it against the
 *                            model would rank models by how often users change
 *                            their minds.
 *   `pending`                has not ended.
 *   `unknown_after_dispatch` the process died before it could record what
 *                            happened. Counting it as a failure blames the
 *                            model for a crash; counting it as a success hides
 *                            one. It is unknown, and unknown is excluded.
 */
export const DISPATCH_OUTCOMES_COUNTED = [
    "succeeded",
    "failed_pre_token",
    "failed_post_token",
] as const;

export const DISPATCH_OUTCOME_SUCCEEDED = "succeeded";

export type DispatchObservation = {
    modelId: string;
    /** `RoutingAttempt.outcome`, verbatim. */
    outcome: string;
    /**
     * Milliseconds from dispatch to the first visible token, where both
     * timestamps exist. Null on an attempt that never produced one, which is a
     * failure the success rate already counts rather than a slow answer.
     */
    ttftMs: number | null;
};

export type ModelDispatchSignals = {
    /** Attempts whose outcome counts toward the rate. */
    countedAttempts: number;
    /** Null until `minSuccessObservations` is reached. Never defaulted. */
    successRate: number | null;
    /** Attempts that produced a first visible token and a measurable delay. */
    ttftObservations: number;
    /** Null until `minTtftObservations` is reached. */
    ttftP95Ms: number | null;
};

/**
 * p95 by nearest-rank, the same convention `lib/routingShadowReport.ts` uses
 * for its latency percentiles. One definition of a percentile per repository;
 * two would disagree at small sample sizes, which is exactly where these are.
 */
const nearestRankPercentile = (sorted: readonly number[], fraction: number) => {
    if (sorted.length === 0) return null;
    const rank = Math.ceil(fraction * sorted.length);
    return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
};

export function summariseDispatchSignals(
    observations: readonly DispatchObservation[],
    {
        minSuccessObservations,
        minTtftObservations,
    }: { minSuccessObservations: number; minTtftObservations: number }
): Map<string, ModelDispatchSignals> {
    const counted = new Set<string>(DISPATCH_OUTCOMES_COUNTED);
    const byModel = new Map<
        string,
        { countedAttempts: number; successes: number; ttft: number[] }
    >();

    for (const observation of observations) {
        if (!counted.has(observation.outcome)) continue;
        const entry = byModel.get(observation.modelId) ?? {
            countedAttempts: 0,
            successes: 0,
            ttft: [],
        };
        entry.countedAttempts += 1;
        if (observation.outcome === DISPATCH_OUTCOME_SUCCEEDED) entry.successes += 1;
        if (
            typeof observation.ttftMs === "number" &&
            Number.isFinite(observation.ttftMs) &&
            observation.ttftMs >= 0
        ) {
            entry.ttft.push(observation.ttftMs);
        }
        byModel.set(observation.modelId, entry);
    }

    const summarised = new Map<string, ModelDispatchSignals>();
    for (const [modelId, entry] of byModel) {
        const sortedTtft = [...entry.ttft].sort((left, right) => left - right);
        summarised.set(modelId, {
            countedAttempts: entry.countedAttempts,
            successRate:
                entry.countedAttempts >= minSuccessObservations
                    ? entry.successes / entry.countedAttempts
                    : null,
            ttftObservations: sortedTtft.length,
            ttftP95Ms:
                sortedTtft.length >= minTtftObservations
                    ? nearestRankPercentile(sortedTtft, 0.95)
                    : null,
        });
    }
    return summarised;
}

/** The two maps `RouterTieBreakSignals` wants, with the nulls dropped. */
export function toTieBreakSignalMaps(
    summarised: ReadonlyMap<string, ModelDispatchSignals>
): {
    recentSuccessRateByModelId: Record<string, number>;
    ttftP95MsByModelId: Record<string, number>;
} {
    const recentSuccessRateByModelId: Record<string, number> = {};
    const ttftP95MsByModelId: Record<string, number> = {};
    for (const [modelId, signals] of summarised) {
        // An absent key is what makes the criterion abstain. A null written
        // into the map would be a value, and `typeof null !== "number"` is a
        // coincidence this should not rely on.
        if (signals.successRate !== null) {
            recentSuccessRateByModelId[modelId] = signals.successRate;
        }
        if (signals.ttftP95Ms !== null) {
            ttftP95MsByModelId[modelId] = signals.ttftP95Ms;
        }
    }
    return { recentSuccessRateByModelId, ttftP95MsByModelId };
}
