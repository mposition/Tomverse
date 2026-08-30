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
 * How much of the bundle a calibration may fail to cover.
 *
 * A judge that returns nothing parseable on a pair leaves it out of that
 * pass, and the comparison is over the pairs both judges graded. That is a
 * structural shortfall rather than one selected on the answers -- the same
 * distinction lib/routerHumanReviewSample.ts draws for a reserve -- so it is
 * tolerated and disclosed rather than refused outright.
 *
 * The bound is the exclusion ceiling
 * docs/ops/tomverse-chat-router-evaluation-set.md §9 already refuses a report
 * for, reused rather than invented: past 5% the survivors are the pairs the
 * judges managed to grade, and that is a population nobody chose.
 */
export const CALIBRATION_MIN_COVERAGE = 0.95;

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

/**
 * The file a decision report cites, as opposed to the numbers alone.
 *
 * `CalibrationResult` is the arithmetic. This is the arithmetic plus everything
 * a reader needs to decide whether it is the right measurement for the run
 * citing it -- which judge it is about, which answers it graded, whether that
 * grading finished, and which set those answers came from. None of that can be
 * recovered from the numbers later, so it is written beside them.
 */
export type JudgeCalibrationArtefact = CalibrationResult & {
    targetIdentity: ModelIdentity;
    referenceIdentity: ModelIdentity;
    /** Every model that wrote an answer in the bundle, canonically. */
    answerIdentities: readonly string[];
    bundleDigest: string;
    /** Entries in the bundle, against `pairs` actually graded by both judges. */
    bundlePairs: number;
    /** What the run that produced the answers set out to cover. */
    bundlePlannedItems: number;
    bundleMode: string;
    evaluationSetVersion: string;
    evaluationSetPurpose: string;
    judgeTemplateVersion: string;
    producedAt: string;
};

/**
 * Why a calibration artefact cannot be cited by this run. Empty means it can.
 *
 * The check this replaces asked only whether a `biasMeasurement` field was
 * present, which is satisfied by any object at all -- including the artefact
 * of a different judge, a different set, or a run that stopped at its cost
 * ceiling halfway through. Every clause below is a way that a report can carry
 * a real-looking calibration figure that says nothing about the run citing it.
 */
export const calibrationArtefactProblems = (
    artefact: unknown,
    run: {
        /** The decision run's judge, as an identity rather than a catalogue id. */
        judgeIdentity: ModelIdentity;
        judgeTemplateVersion: string;
        /** The purpose of the set the decision run used, to keep the two apart. */
        evaluationSetPurpose?: string;
    }
): readonly CalibrationProblem[] => {
    if (!artefact || typeof artefact !== "object") {
        return ["the cited calibration is not an object"];
    }
    const record = artefact as Partial<JudgeCalibrationArtefact> & {
        ownAnswerPreferenceRate?: unknown;
    };
    const problems: CalibrationProblem[] = [];

    // The superseded --mode=judge-bias artefact is an object with numbers in
    // it, so a presence check accepts it. It is refused by name because the
    // figure it carries is not a calibration: see this file's header.
    if (record.ownAnswerPreferenceRate !== undefined && record.calibrationVersion === undefined) {
        return [
            "this is a judge-bias artefact, whose own-answer preference rate mixes the two models' " +
                "quality difference with the judge's preference for its own output. Run " +
                "--mode=judge-calibration against an independent judge instead.",
        ];
    }
    if (record.calibrationVersion !== JUDGE_CALIBRATION_VERSION) {
        problems.push(
            `calibration version ${String(record.calibrationVersion)} is not ${JUDGE_CALIBRATION_VERSION}`
        );
    }

    // Whose bias this is about. Compared canonically because this catalogue
    // has ids whose API model is a different model entirely, so an id-level
    // match would accept a calibration of something else.
    const wanted = canonicalIdentity(run.judgeIdentity);
    const target = record.targetIdentity ? canonicalIdentity(record.targetIdentity) : null;
    if (target === null) {
        problems.push("the artefact does not say which judge it measured");
    } else if (target !== wanted) {
        problems.push(
            `the calibration is of ${target}, but this run's judge is ${wanted}`
        );
    }

    const reference = record.referenceIdentity ? canonicalIdentity(record.referenceIdentity) : null;
    if (reference === null) {
        problems.push("the artefact does not say which judge it compared against");
    } else if (target !== null && reference === target) {
        problems.push(`${reference} was compared against itself, so nothing was measured`);
    }
    // Without the answer authors the independence check has nothing to run
    // against, so an artefact that omits them is not one where independence
    // was established -- it is one where it was not looked at.
    if (!Array.isArray(record.answerIdentities) || record.answerIdentities.length === 0) {
        problems.push(
            "the artefact does not list who wrote the answers, so nothing shows the reference judge is independent of them"
        );
    } else if (reference !== null && record.answerIdentities.includes(reference)) {
        problems.push(
            `the reference judge ${reference} wrote answers in the bundle, so it is not independent of them`
        );
    }

    // docs/ops/tomverse-chat-router-evaluation-set.md §7: every look at the
    // decision set costs a use, and a calibration is a look. It belongs on the
    // development set.
    if (!record.evaluationSetPurpose) {
        problems.push("the artefact does not say which set the graded answers came from");
    } else if (record.evaluationSetPurpose !== "development") {
        problems.push(
            `the calibration graded ${record.evaluationSetPurpose}-set answers; it belongs on the ` +
                "development set, because grading the decision set spends one of its uses"
        );
    } else if (run.evaluationSetPurpose === record.evaluationSetPurpose) {
        problems.push(
            `the calibration and this run both used the ${run.evaluationSetPurpose} set, so they are not separate looks`
        );
    }

    // A bundle that stopped at its cost ceiling is a population that stops
    // wherever the money ran out, and a calibration over it is a calibration
    // over that same arbitrary prefix.
    const bundlePairs = record.bundlePairs;
    const planned = record.bundlePlannedItems;
    if (typeof bundlePairs !== "number" || typeof planned !== "number") {
        problems.push("the artefact does not say whether the run that produced the answers finished");
    } else if (bundlePairs < planned) {
        problems.push(
            `the answers were graded from a bundle holding ${bundlePairs} of ${planned} planned pair(s), ` +
                "so the run that produced them stopped early"
        );
    }

    // Paired judging: the comparison is only paired where both judges answered
    // the same pair, and `pairs` counts exactly those.
    const pairs = record.pairs;
    if (typeof pairs !== "number" || pairs <= 0) {
        problems.push("the calibration graded no pairs");
    } else if (
        typeof bundlePairs === "number" &&
        bundlePairs > 0 &&
        pairs < bundlePairs * CALIBRATION_MIN_COVERAGE
    ) {
        problems.push(
            `only ${pairs} of the bundle's ${bundlePairs} pair(s) carry both judges' verdicts ` +
                `(${((pairs / bundlePairs) * 100).toFixed(1)}%, under the ` +
                `${(CALIBRATION_MIN_COVERAGE * 100).toFixed(0)}% floor), so the comparison is over ` +
                "the pairs the judges managed to grade rather than over the bundle"
        );
    } else if (typeof bundlePairs === "number" && pairs > bundlePairs) {
        problems.push(
            `the calibration reports ${pairs} pair(s) from a bundle of ${bundlePairs}, so it counted something twice`
        );
    }

    for (const [label, value] of [
        ["judge shift", record.judgeShiftPp],
        ["95% lower bound", record.ci95LowerPp],
        ["95% upper bound", record.ci95UpperPp],
        ["exact agreement rate", record.exactAgreementRate],
    ] as const) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            problems.push(`the calibration has no ${label}`);
        }
    }
    const { judgeShiftPp, ci95LowerPp, ci95UpperPp } = record;
    if (
        typeof judgeShiftPp === "number" &&
        typeof ci95LowerPp === "number" &&
        typeof ci95UpperPp === "number" &&
        Number.isFinite(judgeShiftPp) &&
        Number.isFinite(ci95LowerPp) &&
        Number.isFinite(ci95UpperPp) &&
        !(ci95LowerPp <= judgeShiftPp && judgeShiftPp <= ci95UpperPp)
    ) {
        problems.push(
            `the interval [${ci95LowerPp}, ${ci95UpperPp}] does not contain the point estimate ${judgeShiftPp}`
        );
    }
    if (!(typeof record.seed === "number" && Number.isInteger(record.seed) && record.seed > 0)) {
        problems.push("the calibration has no seed, so its interval cannot be replayed");
    }
    if (!(typeof record.resamples === "number" && record.resamples >= DEFAULT_RESAMPLES)) {
        problems.push(
            `the bootstrap ran ${String(record.resamples)} resamples, under the ${DEFAULT_RESAMPLES} the interval is quoted at`
        );
    }
    if (!record.bundleDigest) {
        problems.push("the artefact does not name the bundle it graded");
    }
    if (record.judgeTemplateVersion !== run.judgeTemplateVersion) {
        problems.push(
            `the calibration used rubric ${String(record.judgeTemplateVersion)} and this run used ` +
                `${run.judgeTemplateVersion}; two graders on two rubrics do not measure one judge's shift`
        );
    }
    return problems;
};
