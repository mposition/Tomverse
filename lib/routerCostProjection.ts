/**
 * What a run can cost, as four numbers rather than one.
 *
 * ## Why a single estimate is not admissible here
 *
 * mposition's ruling, and the reason is in the data this would be fitted to.
 * Every usage observation available comes from runs that asked for 2,048
 * output tokens, and 60 of those calls hit that ceiling. Those observations
 * are **censored**: what they record is not how long the answers were, it is
 * where the answers were cut off. Fitting a mean to them and calling it an
 * estimate for a run with a 384,000-token budget projects a limit that no
 * longer applies.
 *
 * So a projection carries four values and says which of them the evidence
 * actually supports:
 *
 *   * `observedLowerBoundUsd` — what the censored runs actually spent. A floor,
 *     and known to be one: the answers it paid for were truncated.
 *   * `expectedUsd` — the planning number, from an uncensored answer length.
 *   * `conservativeUsd` — the P95 case.
 *   * `theoreticalCeilingUsd` — every request filling its whole budget. Not a
 *     forecast; the number a ceiling has to survive.
 *
 * ## The one a global ceiling cannot catch
 *
 * A `--max-cost-usd` ceiling is tested between calls, because tokens are only
 * known once a response returns. A single call whose worst case already
 * exceeds the ceiling therefore breaches it with nothing able to intervene.
 * `perRequestWorstCaseUsd` is that number, and it has to be checked before
 * dispatch rather than discovered afterwards.
 */

import type { ResolvedCallLimit } from "./routerCallLimits";

/** Why an observation cannot be read as an answer length. */
export type ObservationCensoring = {
    censored: boolean;
    /** The cap the observations were collected under. */
    observedUnderMaxOutputTokens: number | null;
    /** How many of them reached that cap. */
    observationsAtCap: number;
    note: string;
};

export type CallProjectionInput = {
    limit: ResolvedCallLimit;
    calls: number;
    promptTokens: number;
    /** Answer length used for the planning number. */
    expectedOutputTokens: number;
    /** Answer length used for the conservative number. */
    p95OutputTokens: number;
    /** What calls of this shape actually cost, where a run has been observed. */
    observedOutputTokens?: number;
};

export type CostProjection = {
    observedLowerBoundUsd: number | null;
    expectedUsd: number;
    conservativeUsd: number;
    theoreticalCeilingUsd: number;
    perRequestWorstCaseUsd: number;
};

const usd = (tokens: number, perMillion: number) => (tokens * perMillion) / 1_000_000;

const callCost = (limit: ResolvedCallLimit, promptTokens: number, outputTokens: number) =>
    usd(promptTokens, limit.inputUsdPerMillionTokens) +
    usd(outputTokens, limit.outputUsdPerMillionTokens);

export const projectCallCost = (input: CallProjectionInput): CostProjection => {
    const { limit, calls, promptTokens } = input;
    const at = (outputTokens: number) => calls * callCost(limit, promptTokens, outputTokens);
    return {
        observedLowerBoundUsd:
            input.observedOutputTokens === undefined ? null : at(input.observedOutputTokens),
        expectedUsd: at(input.expectedOutputTokens),
        conservativeUsd: at(input.p95OutputTokens),
        // Every call filling its budget. Reasoning is billed as output for
        // every model in the pre-registration, so the budget is the ceiling
        // whether it is spent thinking or answering.
        theoreticalCeilingUsd: at(limit.requestedMaxOutputTokens),
        perRequestWorstCaseUsd: callCost(limit, promptTokens, limit.requestedMaxOutputTokens),
    };
};

export const sumProjections = (projections: readonly CostProjection[]): CostProjection => ({
    observedLowerBoundUsd: projections.every((p) => p.observedLowerBoundUsd === null)
        ? null
        : projections.reduce((sum, p) => sum + (p.observedLowerBoundUsd ?? 0), 0),
    expectedUsd: projections.reduce((sum, p) => sum + p.expectedUsd, 0),
    conservativeUsd: projections.reduce((sum, p) => sum + p.conservativeUsd, 0),
    theoreticalCeilingUsd: projections.reduce((sum, p) => sum + p.theoreticalCeilingUsd, 0),
    // Not a sum: it is the worst *one* call across the stages, because that is
    // the one a between-calls ceiling cannot stop.
    perRequestWorstCaseUsd: Math.max(0, ...projections.map((p) => p.perRequestWorstCaseUsd)),
});

/**
 * Whether a ceiling can actually hold this stage.
 *
 * Two separate failures, kept separate because they are fixed differently: a
 * ceiling below the expected cost will stop a healthy run part-way, while a
 * ceiling below one request's worst case cannot be enforced at all.
 */
export const ceilingProblems = (
    projection: CostProjection,
    ceilingUsd: number
): readonly string[] => {
    const problems: string[] = [];
    if (projection.perRequestWorstCaseUsd > ceilingUsd) {
        problems.push(
            `one request can cost up to $${projection.perRequestWorstCaseUsd.toFixed(4)}, over the ` +
                `$${ceilingUsd.toFixed(2)} ceiling — a between-calls ceiling cannot stop a single ` +
                "call, so this must be refused before dispatch"
        );
    }
    if (projection.expectedUsd > ceilingUsd) {
        problems.push(
            `the expected cost $${projection.expectedUsd.toFixed(4)} already exceeds the ` +
                `$${ceilingUsd.toFixed(2)} ceiling, so a healthy run would be truncated`
        );
    }
    return problems;
};
