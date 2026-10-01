/**
 * Which model judge is adopted, decided against human labels.
 *
 * ## Why the thresholds are here and not in a paragraph
 *
 * `docs/ops/router-judge-selection-rule.md` says the judge with the smaller
 * margin error wins, that a tie goes to a larger sample, and that a judge far
 * from the humans is not adopted. Words like "tie" and "far" decide the
 * outcome, so they are numbers, and they are numbers written before any human
 * label is read -- the same reason `n` is pre-registered before the data.
 *
 * ## The quantities
 *
 *   D_j  = |judge baseline margin - human baseline margin|
 *   dD   = D_Luna - D_Fable
 *
 * A negative `dD` means Luna is closer. The claim "one judge is closer" is
 * made only when a pair-level bootstrap 95% interval on `dD` excludes zero.
 * Where it does not, the answer is not the judge with the better point
 * estimate and not the one with better exact agreement -- it is a larger human
 * sample. Forcing a choice out of a tie is how a coin flip becomes a finding.
 */

/**
 * How far a judge may sit from the humans and still be adoptable.
 *
 * 10pp, which is the primary sample's own resolution
 * (`docs/ops/tomverse-chat-router-evaluation-set.md` §5). A judge whose margin
 * error exceeds what the instrument can even measure is not a judge this
 * measurement can vouch for, whichever way the comparison went.
 */
export const JUDGE_MARGIN_TOLERANCE_PP = 10;

/**
 * The reversal rail.
 *
 * A judge that calls `auto` where a person called `baseline`, or the reverse,
 * has not merely disagreed -- it has inverted. 10% of pairs is the line.
 * Reversals cancel in an aggregate margin and will not cancel on a different
 * sample, so a good margin figure does not buy past this.
 */
export const JUDGE_OPPOSITE_VERDICT_CEILING = 0.1;

export type JudgeComparison = {
    judgeId: string;
    /** `judge baseline margin - human baseline margin`, in pp. Signed. */
    marginShiftPp: number;
    /** |marginShiftPp|. */
    marginErrorPp: number;
    exactAgreement: number;
    oppositeVerdictRate: number;
};

export type JudgeSelectionInput = {
    luna: JudgeComparison;
    fable: JudgeComparison;
    /**
     * Bootstrap 95% interval on `D_Luna - D_Fable`, pair-level, on the run's
     * own seed. Negative throughout means Luna is closer; positive throughout
     * means Fable is.
     */
    marginErrorDifferenceCi: { lowerPp: number; upperPp: number };
    humanPairs: number;
};

export const JUDGE_SELECTION_OUTCOMES = [
    /**
     * One judge is closer, and its error is inside what 60 pairs can see.
     *
     * Still not "unbiased": see `resolutionCaveat`.
     */
    "preferred",
    /** Neither is adoptable, or the two cannot be told apart. */
    "undecided",
] as const;
export type JudgeSelectionOutcome = (typeof JUDGE_SELECTION_OUTCOMES)[number];

export type JudgeSelection = {
    outcome: JudgeSelectionOutcome;
    judgeId: string | null;
    reasons: readonly string[];
    /** Whether `n` may be computed from the chosen judge yet. */
    activatesSampleSize: boolean;
    resolutionCaveat: string;
};

const pp = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}pp`;

/**
 * The decision, from the numbers alone.
 *
 * There is no `accepted` outcome, and that is deliberate. 60 pairs resolve to
 * roughly +-10pp, so no result from them can certify that a judge's residual
 * bias is smaller than ROUTE-01's -2pp decision boundary. The best available
 * verdict is `preferred`: this judge is measurably closer to people than the
 * other one, at an instrument coarser than the decision it feeds. Activating
 * `n` on that basis is a separate call for a person to make, which is why
 * `activatesSampleSize` is false for every outcome this function can return.
 */
export const selectJudge = (input: JudgeSelectionInput): JudgeSelection => {
    const { luna, fable, marginErrorDifferenceCi: ci } = input;
    const undecided = (reasons: readonly string[]): JudgeSelection => ({
        outcome: "undecided",
        judgeId: null,
        reasons,
        activatesSampleSize: false,
        resolutionCaveat: resolutionCaveat(input.humanPairs),
    });

    // Separation first. Zero inside the interval means the data does not
    // distinguish them, and exact agreement does not break it: a rule that
    // falls through to a second criterion whenever the first is inconclusive
    // is a rule that always decides, which is the thing being avoided.
    const separated = ci.lowerPp > 0 || ci.upperPp < 0;
    if (!separated) {
        return undecided([
            `the 95% interval on D_${luna.judgeId} - D_${fable.judgeId} is ` +
                `[${pp(ci.lowerPp)}, ${pp(ci.upperPp)}], which contains zero: this sample does not ` +
                "establish that either judge is closer to the humans",
            "the next step is a larger human sample, not a decision on exact agreement",
        ]);
    }

    const closer = ci.upperPp < 0 ? luna : fable;
    const other = closer === luna ? fable : luna;
    const reasons: string[] = [
        `${closer.judgeId} is closer to the humans on baseline margin ` +
            `(${pp(closer.marginErrorPp)} against ${pp(other.marginErrorPp)}), and the 95% interval on the ` +
            `difference [${pp(ci.lowerPp)}, ${pp(ci.upperPp)}] excludes zero`,
    ];

    // Tolerance is applied to the judge that would be adopted. Testing "both"
    // separately would be unreachable: if the closer one is beyond tolerance
    // then so is the further one, so this single check covers that case and
    // says so when it holds.
    if (closer.marginErrorPp > JUDGE_MARGIN_TOLERANCE_PP) {
        const bothFar = other.marginErrorPp > JUDGE_MARGIN_TOLERANCE_PP;
        return undecided([
            ...reasons,
            `but ${closer.judgeId} still misses the human margin by ${pp(closer.marginErrorPp)}, over the ` +
                `${JUDGE_MARGIN_TOLERANCE_PP}pp tolerance` +
                (bothFar
                    ? `, and so does ${other.judgeId} at ${pp(other.marginErrorPp)} — neither is a judge ` +
                      "this comparison can vouch for"
                    : " — being the closer of two is not the same as being close enough"),
            "the next step is a larger human sample or a third judge, not the closer of two distant judges",
        ]);
    }

    if (closer.oppositeVerdictRate > JUDGE_OPPOSITE_VERDICT_CEILING) {
        return undecided([
            ...reasons,
            `but ${closer.judgeId} reverses ${(closer.oppositeVerdictRate * 100).toFixed(1)}% of pairs ` +
                `against the humans, over the ${(JUDGE_OPPOSITE_VERDICT_CEILING * 100).toFixed(0)}% rail. ` +
                "Reversals cancel in an aggregate margin and will not cancel on another sample",
        ]);
    }

    reasons.push(
        `it agrees exactly with the humans on ${(closer.exactAgreement * 100).toFixed(1)}% of pairs and ` +
            `reverses ${(closer.oppositeVerdictRate * 100).toFixed(1)}%, inside the ` +
            `${(JUDGE_OPPOSITE_VERDICT_CEILING * 100).toFixed(0)}% rail`
    );

    return {
        outcome: "preferred",
        judgeId: closer.judgeId,
        reasons,
        // Never true from this function. Whether a +-10pp instrument may
        // activate a sample size behind a -2pp decision is a judgement for a
        // person, recorded as its own decision.
        activatesSampleSize: false,
        resolutionCaveat: resolutionCaveat(input.humanPairs),
    };
};

const resolutionCaveat = (humanPairs: number) =>
    `${humanPairs} human-labelled pairs resolve to roughly +-10pp. That is enough to say which judge is ` +
    "closer to people, and not enough to certify that the chosen judge's residual bias is smaller than " +
    "ROUTE-01's -2pp decision boundary. Any report turning on a margin near -2pp must say so.";
