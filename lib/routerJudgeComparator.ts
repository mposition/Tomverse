/**
 * Two model judges measured against the settled human verdicts, into the
 * shape `selectJudge` decides on.
 *
 * ## What this is, and what it deliberately is not
 *
 * It computes numbers. It does not decide. The thresholds live in
 * `lib/routerJudgeSelection.ts` and were frozen before any human label was
 * read; this file turns three verdict sets into that function's input and
 * hands over. Keeping the arithmetic apart from the rule is what lets the
 * rule be read on its own.
 *
 * ## The definitions, held fixed
 *
 *   margin_j  = mean(+1 baseline, -1 auto, 0 equivalent) x 100   over pairs
 *               both the judge and the humans settled
 *   D_j       = |margin_j - margin_human|
 *   dD        = D_Luna - D_Fable
 *
 * The sign is the calibration module's -- baseline positive -- because the
 * pilot's +48.10pp and +7.62pp are on that scale, and a comparison against
 * humans that silently flipped it would read the wrong judge as closer.
 * `lib/routerQualityEvalCore.ts`'s `pairScore` runs the other way; it is not
 * used here for that reason.
 *
 * ## Why dD gets its own bootstrap
 *
 * `calibrateJudges` already resamples one judge against one reference. dD is
 * a difference of two such distances over the SAME pairs, so its interval
 * has to come from resampling the pairs once and recomputing both distances
 * on each draw -- two separate intervals cannot be subtracted. Each resample
 * takes or leaves a pair for all three verdicts together.
 *
 * Seeded, so the interval in the record is the interval anyone re-running
 * this gets.
 */

import { seededRandom } from "./routerQualityEvalCore";
import {
    JUDGE_MARGIN_TOLERANCE_PP,
    JUDGE_OPPOSITE_VERDICT_CEILING,
    selectJudge,
    type JudgeComparison,
    type JudgeSelection,
} from "./routerJudgeSelection";

export type ArmVerdict = "auto" | "baseline" | "equivalent";
export type ArmVerdictRecord = { pairId: string; verdict: ArmVerdict };

export const COMPARATOR_VERSION = "router-judge-comparator-v1";
export const DEFAULT_RESAMPLES = 10_000;

const SCORE: Record<ArmVerdict, 1 | 0 | -1> = { baseline: 1, auto: -1, equivalent: 0 };

const percentile = (sorted: readonly number[], quantile: number): number => {
    if (sorted.length === 0) return Number.NaN;
    const position = (sorted.length - 1) * quantile;
    const low = Math.floor(position);
    const high = Math.ceil(position);
    if (low === high) return sorted[low];
    return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
};

const marginPp = (scores: readonly number[]): number =>
    scores.length === 0 ? Number.NaN : (scores.reduce((sum, s) => sum + s, 0) / scores.length) * 100;

/** A pair every one of the three graded, carrying all three verdicts. */
export type AlignedPair = {
    pairId: string;
    human: ArmVerdict;
    luna: ArmVerdict;
    fable: ArmVerdict;
};

/**
 * Only pairs all three graded. A pair the humans left as no-consensus, or a
 * judge returned nothing parseable on, is absent from the comparison rather
 * than filled in -- the same rule `calibrateJudges` applies between judges.
 */
export const alignVerdicts = (input: {
    human: readonly ArmVerdictRecord[];
    luna: readonly ArmVerdictRecord[];
    fable: readonly ArmVerdictRecord[];
}): { aligned: readonly AlignedPair[]; problems: readonly string[] } => {
    const problems: string[] = [];
    const index = (records: readonly ArmVerdictRecord[], who: string) => {
        const map = new Map<string, ArmVerdict>();
        for (const record of records) {
            if (map.has(record.pairId)) problems.push(`${who} grades ${record.pairId} twice`);
            if (!(record.verdict in SCORE)) problems.push(`${who} has an unknown verdict "${record.verdict}" on ${record.pairId}`);
            map.set(record.pairId, record.verdict);
        }
        return map;
    };
    const human = index(input.human, "the human record");
    const luna = index(input.luna, "Luna");
    const fable = index(input.fable, "Fable");
    const aligned: AlignedPair[] = [];
    for (const [pairId, h] of [...human.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const l = luna.get(pairId);
        const f = fable.get(pairId);
        if (l === undefined || f === undefined) continue;
        aligned.push({ pairId, human: h, luna: l, fable: f });
    }
    if (human.size === 0) problems.push("the human record settles no pairs");
    return { aligned, problems };
};

const compareOne = (
    judgeId: string,
    aligned: readonly AlignedPair[],
    pick: (pair: AlignedPair) => ArmVerdict
): JudgeComparison => {
    const humanMargin = marginPp(aligned.map((p) => SCORE[p.human]));
    const judgeMargin = marginPp(aligned.map((p) => SCORE[pick(p)]));
    const agree = aligned.filter((p) => pick(p) === p.human).length;
    // An inversion, not a disagreement: one side says auto, the other baseline.
    const opposite = aligned.filter(
        (p) => (pick(p) === "auto" && p.human === "baseline") || (pick(p) === "baseline" && p.human === "auto")
    ).length;
    const shift = judgeMargin - humanMargin;
    return {
        judgeId,
        marginShiftPp: shift,
        marginErrorPp: Math.abs(shift),
        exactAgreement: aligned.length === 0 ? Number.NaN : agree / aligned.length,
        oppositeVerdictRate: aligned.length === 0 ? Number.NaN : opposite / aligned.length,
    };
};

export type JudgeComparisonReport = {
    version: typeof COMPARATOR_VERSION;
    pairs: number;
    humanBaselineMarginPp: number;
    luna: JudgeComparison;
    fable: JudgeComparison;
    /** D_Luna - D_Fable on the full sample. Negative: Luna closer. */
    marginErrorDifferencePp: number;
    marginErrorDifferenceCi: { lowerPp: number; upperPp: number };
    seed: number;
    resamples: number;
    thresholds: { tolerancePp: number; oppositeVerdictCeiling: number };
    selection: JudgeSelection;
};

/**
 * The whole comparison, from aligned pairs to a decision.
 *
 * `seed` is the run's own -- the pilot used 20260826 -- so the interval is
 * reproducible and was not chosen once it was known what it would say.
 */
export const compareJudgesAgainstHumans = (
    aligned: readonly AlignedPair[],
    options: { seed: number; resamples?: number }
): JudgeComparisonReport => {
    const resamples = options.resamples ?? DEFAULT_RESAMPLES;
    const luna = compareOne("luna", aligned, (p) => p.luna);
    const fable = compareOne("fable", aligned, (p) => p.fable);
    const humanBaselineMarginPp = marginPp(aligned.map((p) => SCORE[p.human]));

    // Paired: one draw of pair indices, three verdicts each, both distances
    // from the same draw. That is what makes dD's interval a statement about
    // the difference rather than about two unrelated samples.
    const random = seededRandom(options.seed);
    const differences: number[] = [];
    if (aligned.length >= 2) {
        for (let round = 0; round < resamples; round += 1) {
            let h = 0, l = 0, f = 0;
            for (let i = 0; i < aligned.length; i += 1) {
                const p = aligned[Math.floor(random() * aligned.length)];
                h += SCORE[p.human]; l += SCORE[p.luna]; f += SCORE[p.fable];
            }
            const n = aligned.length;
            const dLuna = Math.abs((l - h) / n) * 100;
            const dFable = Math.abs((f - h) / n) * 100;
            differences.push(dLuna - dFable);
        }
        differences.sort((a, b) => a - b);
    }
    const ci = {
        lowerPp: percentile(differences, 0.025),
        upperPp: percentile(differences, 0.975),
    };

    return {
        version: COMPARATOR_VERSION,
        pairs: aligned.length,
        humanBaselineMarginPp,
        luna,
        fable,
        marginErrorDifferencePp: luna.marginErrorPp - fable.marginErrorPp,
        marginErrorDifferenceCi: ci,
        seed: options.seed,
        resamples,
        thresholds: {
            tolerancePp: JUDGE_MARGIN_TOLERANCE_PP,
            oppositeVerdictCeiling: JUDGE_OPPOSITE_VERDICT_CEILING,
        },
        selection: selectJudge({ luna, fable, marginErrorDifferenceCi: ci, humanPairs: aligned.length }),
    };
};
