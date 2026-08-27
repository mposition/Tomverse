/**
 * Comparing two judges over the same answers.
 *
 * ## What this measures, and what it does not
 *
 * `--mode=judge-bias` put the judge's own model in the Auto arm and reported
 * its own-answer win rate as a self-preference figure. That number mixes three
 * things it cannot separate: the two models' real quality difference, the
 * judge's preference for its own output, and style interactions between the
 * two. Fifty per cent is only "no self-preference" if the two models are
 * equally good, which nothing established.
 *
 * This module answers a narrower question that a pair of judging passes can
 * actually settle: **given the same answers, how far apart are two judges?**
 * `judgeShiftPp` is how much more the target judge favours the baseline arm
 * than the reference judge does, over the same pairs.
 *
 * That is a measurement of disagreement. Reading it as self-preference needs
 * the reference judge to have no preference of its own between these two
 * models, which is an assumption rather than a result. Human labels on a
 * stratified sample are what ground it; `docs/ops/tomverse-chat-router-evaluation-set.md`
 * §5 asks for the measurement, and this is the shape of it that can be
 * defended.
 *
 * ## Paired, at pair level
 *
 * Both judges see the same pair, so the two rates are not independent samples
 * and a difference of two separate intervals would be wider than the truth.
 * The bootstrap resamples pairs and recomputes both rates on the same
 * resample, which is what keeps the pairing.
 */

import type { JudgeVerdict } from "./routerQualityEvalCore";
import { seededRandom } from "./routerQualityEvalCore";
import type { ModelIdentity } from "./routerAnswerBundle";
import { canonicalIdentity } from "./routerAnswerBundle";

export const JUDGE_CALIBRATION_VERSION = "router-judge-calibration-v1";

export type JudgeVerdictRecord = {
    pairId: string;
    verdict: JudgeVerdict;
};

export type JudgePass = {
    identity: ModelIdentity;
    /** The bundle these verdicts were produced from, so two passes can be shown to match. */
    bundleDigest: string;
    verdicts: readonly JudgeVerdictRecord[];
};

const VERDICTS: readonly JudgeVerdict[] = ["auto", "baseline", "equivalent"];

/**
 * +1 when the baseline arm was preferred, -1 for Auto, 0 for equivalent.
 *
 * Signed towards the baseline rather than Auto because the question here is
 * how much a judge favours the arm whose answers it may have written.
 */
const towardsBaseline = (verdict: JudgeVerdict): 1 | 0 | -1 =>
    verdict === "baseline" ? 1 : verdict === "auto" ? -1 : 0;

const mean = (values: readonly number[]): number =>
    values.length === 0 ? Number.NaN : values.reduce((sum, value) => sum + value, 0) / values.length;

const percentile = (sorted: readonly number[], quantile: number): number => {
    if (sorted.length === 0) return Number.NaN;
    const position = (sorted.length - 1) * quantile;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
};

export type CalibrationProblem = string;

/**
 * Why these two passes cannot be compared. Empty means they can.
 *
 * Checked rather than assumed because every one of these has a failure mode
 * that produces a number: two passes over different pairs, a reference judge
 * that wrote one of the answers, or a pass whose bundle is not the other's.
 */
export const calibrationProblems = (
    target: JudgePass,
    reference: JudgePass,
    answerIdentities: readonly string[] = []
): readonly CalibrationProblem[] => {
    const problems: CalibrationProblem[] = [];

    if (canonicalIdentity(target.identity) === canonicalIdentity(reference.identity)) {
        problems.push(
            `both passes were judged by ${canonicalIdentity(target.identity)}, so there is nothing to compare`
        );
    }
    // Internal ids are not the comparison: this catalogue has an id whose API
    // model is a different model entirely, so an id-level check would call a
    // judge independent of answers it wrote.
    const referenceIdentity = canonicalIdentity(reference.identity);
    if (answerIdentities.includes(referenceIdentity)) {
        problems.push(
            `the reference judge ${referenceIdentity} wrote answers in this bundle, so it is not independent of them`
        );
    }
    if (target.bundleDigest !== reference.bundleDigest) {
        problems.push(
            "the two passes name different bundles, so they did not grade the same answers"
        );
    }

    const targetIds = new Set(target.verdicts.map((record) => record.pairId));
    const referenceIds = new Set(reference.verdicts.map((record) => record.pairId));
    if (targetIds.size !== target.verdicts.length) problems.push("the target pass repeats a pair");
    if (referenceIds.size !== reference.verdicts.length) problems.push("the reference pass repeats a pair");
    const missing = [...targetIds].filter((id) => !referenceIds.has(id));
    const extra = [...referenceIds].filter((id) => !targetIds.has(id));
    if (missing.length > 0 || extra.length > 0) {
        problems.push(
            `the passes cover different pairs: ${missing.length} only in the target, ${extra.length} only in the reference`
        );
    }
    if (target.verdicts.length === 0) problems.push("the target pass has no verdicts");
    return problems;
};

export type CrossTab = Record<JudgeVerdict, Record<JudgeVerdict, number>>;

export type CalibrationResult = {
    calibrationVersion: typeof JUDGE_CALIBRATION_VERSION;
    targetJudge: string;
    referenceJudge: string;
    pairs: number;
    /** Rows are the target judge's verdict, columns the reference judge's. */
    crossTab: CrossTab;
    exactAgreementRate: number;
    /** Mean of +1 baseline / -1 auto / 0 equivalent, in percentage points. */
    targetBaselineMarginPp: number;
    referenceBaselineMarginPp: number;
    /** Target minus reference. Positive: the target favours the baseline more. */
    judgeShiftPp: number;
    ci95LowerPp: number;
    ci95UpperPp: number;
    seed: number;
    resamples: number;
};

export const DEFAULT_RESAMPLES = 10_000;

/**
 * Compare two passes over the same bundle.
 *
 * Callers check `calibrationProblems` first: this computes what it is given
 * and cannot tell a comparable pair of passes from an incomparable one.
 */
export const calibrateJudges = (
    target: JudgePass,
    reference: JudgePass,
    options: { seed: number; resamples?: number }
): CalibrationResult => {
    const resamples = options.resamples ?? DEFAULT_RESAMPLES;
    const referenceByPair = new Map(reference.verdicts.map((record) => [record.pairId, record.verdict]));

    const crossTab = Object.fromEntries(
        VERDICTS.map((row) => [row, Object.fromEntries(VERDICTS.map((column) => [column, 0]))])
    ) as CrossTab;

    const paired: { targetScore: number; referenceScore: number }[] = [];
    let agreed = 0;
    for (const record of target.verdicts) {
        const referenceVerdict = referenceByPair.get(record.pairId);
        if (referenceVerdict === undefined) continue;
        crossTab[record.verdict][referenceVerdict] += 1;
        if (record.verdict === referenceVerdict) agreed += 1;
        paired.push({
            targetScore: towardsBaseline(record.verdict),
            referenceScore: towardsBaseline(referenceVerdict),
        });
    }

    const targetMargin = mean(paired.map((pair) => pair.targetScore));
    const referenceMargin = mean(paired.map((pair) => pair.referenceScore));

    // Resample pairs, not verdicts: both judges saw the same pair, so a
    // resample has to take or leave both of their answers to it together.
    const random = seededRandom(options.seed);
    const shifts: number[] = [];
    for (let round = 0; round < resamples && paired.length > 0; round += 1) {
        let targetSum = 0;
        let referenceSum = 0;
        for (let draw = 0; draw < paired.length; draw += 1) {
            const picked = paired[Math.floor(random() * paired.length)];
            targetSum += picked.targetScore;
            referenceSum += picked.referenceScore;
        }
        shifts.push(((targetSum - referenceSum) / paired.length) * 100);
    }
    shifts.sort((left, right) => left - right);

    return {
        calibrationVersion: JUDGE_CALIBRATION_VERSION,
        targetJudge: canonicalIdentity(target.identity),
        referenceJudge: canonicalIdentity(reference.identity),
        pairs: paired.length,
        crossTab,
        exactAgreementRate: paired.length === 0 ? Number.NaN : agreed / paired.length,
        targetBaselineMarginPp: targetMargin * 100,
        referenceBaselineMarginPp: referenceMargin * 100,
        judgeShiftPp: (targetMargin - referenceMargin) * 100,
        ci95LowerPp: percentile(shifts, 0.025),
        ci95UpperPp: percentile(shifts, 0.975),
        seed: options.seed,
        resamples,
    };
};
