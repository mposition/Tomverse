/**
 * Run-level aggregation of judged AI Review cases.
 *
 * docs/ops/ai-review-eval-scoring-contract.md, and the decision it implements:
 * `.github/audits/ai-review-judged-metric-definitions-2026-09-09.md`
 * (approved by mposition, 2026-09-09).
 *
 * ## What this is not
 *
 * It is not the approval gate. `check:ai-review-eval` still reads the keyword
 * metrics, the thresholds here are nobody's, and no number this produces is
 * carried over from or into the keyword scale. Those are separate decisions,
 * and none of them was approved with the definitions below.
 *
 * ## The two rules that shape everything here
 *
 * **A case being verified and a run being aggregable are different
 * questions.** `verifyJudgedScoringEvidence()` already separates them per
 * case; this does the same for the run, and refuses BEFORE producing any
 * number. Computing over the cases that happened to survive is the failure
 * this exists to prevent: a judgement nobody finished then reads as a good
 * score.
 *
 * **Identity comes from the verified artifact, never from a caller's label.**
 * The plan and the evidence are joined on `(caseId, observationRef)` as the
 * artifact states them, so keeping an entry's outer label while swapping the
 * files inside it does not pass.
 *
 * **The run's dataset is admitted once, before anything reads through it.**
 * Saying "the frozen dataset" is not checking one. `verifyJudgedScoringEvidence()`
 * binds each case's question and answers, and deliberately nothing else -- so
 * the metadata that decides a case's DENOMINATOR was bound to nothing at all,
 * and a repeated id, a missing freeze record, or a phenomenon edited to
 * another valid value all passed. Admission runs `datasetProblems()` and
 * `freezeDrift()`, the same checks the evaluation set's own validator runs,
 * and refuses before a single case is read out of the array.
 *
 * Nothing here calls a provider, reads the network, or writes a file.
 */

import {
    AI_REVIEW_EVAL_FINDING_KINDS,
    AI_REVIEW_EVAL_NEGATIVE_PHENOMENA,
    AI_REVIEW_EVAL_PHENOMENA,
    type AiReviewEvalFindingKind,
    type AiReviewEvalPhenomenon,
} from "@/lib/aiReviewEvalCore";
import {
    AI_REVIEW_SCORING_CONTRACT_VERSION,
    judgedScoredClaims,
    verifyJudgedScoringEvidence,
    type AiReviewJudgedScoringArtifact,
    type AiReviewJudgementRecord,
} from "@/lib/aiReviewEvalJudgement";
import { datasetProblems, freezeDrift } from "@/lib/aiReviewEvalRun";
import { wilsonInterval } from "@/lib/memoryExtractionEvalCore";

/** One row of what the run set out to measure. */
export type AiReviewJudgedRunPlanItem = {
    caseId: string;
    observationRef: string;
};

/** One case's evidence bundle. It carries no journal and no dataset of its own. */
export type AiReviewJudgedRunEntry = {
    testCase: unknown;
    observation: unknown;
    record: unknown;
    artifact: unknown;
};

/**
 * The run's own inputs, supplied once.
 *
 * Per-entry copies would mean every bundle was checked against a journal that
 * agrees with it, which is the same defect as joining on a caller's label.
 */
export type AiReviewJudgedRunInputs = {
    journal: unknown;
    dataset: unknown;
};

/**
 * A rate, or the reason there is not one.
 *
 * `null` where the denominator is zero. That is NOT `0`: nothing was measured,
 * and a zero would report a perfect run.
 */
export type AiReviewJudgedRunRate = {
    numerator: number;
    denominator: number;
    /** `null` when the denominator is zero. */
    rate: number | null;
    /** Wilson 95% bounds, `null` for the same reason. */
    wilsonLower: number | null;
    wilsonUpper: number | null;
    /** Present exactly when there is no rate, and says so in words. */
    insufficientEvidence?: "the denominator is zero: nothing in this run is measured by it";
};

export type AiReviewJudgedRunMetrics = {
    /**
     * Cases where nothing planted was reported at all.
     *
     * Approved as A1: the numerator is `truePositives` summed across kinds
     * being zero. A finding a person judged insufficient is not a true
     * positive, so a reviewer that gestured at every planted requirement
     * without naming one counts here -- the requirement did not reach the
     * reader. `missedEveryPlantedIssueAimedAt` reports how many of those
     * cases did at least gesture, so the two states cannot vanish into one
     * number.
     */
    missedEveryPlantedIssueRate: AiReviewJudgedRunRate;
    /** Diagnostic, not folded into the rate above. */
    missedEveryPlantedIssueAimedAt: number;
    /**
     * Cases carrying at least one finding a person ruled invented.
     *
     * Approved as B2: the denominator is every scored case, because a
     * finding invented beside a correct one is the same failure as one
     * invented on a case with nothing to find.
     *
     * Deliberately NOT named `inventedIssueRate`: that identifier belongs to
     * the keyword metric, which is still what the approval gate reads, and
     * two different measurements under one name is what this whole contract
     * exists to stop. The identifier itself was not part of the approval.
     */
    inventedFindingRate: AiReviewJudgedRunRate;
    /** The same metric restricted on BOTH sides to negative-phenomenon cases. */
    inventedFindingRateNegativeSubset: AiReviewJudgedRunRate;
    /** Findings, not cases. A case counts once above however many it invented. */
    inventedFindingCount: number;
};

export type AiReviewJudgedRunAggregate =
    | {
          aggregable: false;
          /** Everything that stops a number being produced. Never partial. */
          blockers: readonly string[];
      }
    | {
          aggregable: true;
          contractVersion: string;
          cases: number;
          metrics: AiReviewJudgedRunMetrics;
      };

const rateOf = (numerator: number, denominator: number): AiReviewJudgedRunRate => {
    if (denominator === 0) {
        return {
            numerator,
            denominator,
            rate: null,
            wilsonLower: null,
            wilsonUpper: null,
            insufficientEvidence:
                "the denominator is zero: nothing in this run is measured by it",
        };
    }
    const interval = wilsonInterval(numerator, denominator);
    return {
        numerator,
        denominator,
        rate: numerator / denominator,
        wilsonLower: interval.lower,
        wilsonUpper: interval.upper,
    };
};

const planKeyOf = (caseId: string, observationRef: string) =>
    `${caseId}::${observationRef}`;

/**
 * Findings this reviewer put forward and a person ruled invented.
 *
 * Counted from `judgedScoredClaims()` -- the population the score itself was
 * computed from -- and not from the raw claims array, which still holds an
 * explanation excluded as supporting material and a quotation filed into a
 * findings field. Both carry a verdict and neither is a finding put forward.
 *
 * No separate outside-the-gold test: `verifyJudgementRecord()` refuses
 * `outsideGoldVerdict` on a claim the gold contains, so on a verified record
 * the field's presence is that fact.
 *
 * A lone `support` claim gets no special case in either direction. Nothing
 * excludes it, so it stays in the population, and then meets the same three
 * conditions as every other claim or does not.
 */
export function judgedInventedFindings(
    record: AiReviewJudgementRecord
): readonly { targetLabel: string; requirementId: string; submittedAs: AiReviewEvalFindingKind }[] {
    return judgedScoredClaims(record)
        .filter(
            (claim) =>
                claim.speechAct === "finding" &&
                claim.status === "confirmed" &&
                claim.outsideGoldVerdict === "false_finding"
        )
        .map((claim) => ({
            targetLabel: claim.targetLabel,
            requirementId: claim.requirementId,
            submittedAs: claim.submittedAs,
        }));
}

const isPhenomenon = (value: unknown): value is AiReviewEvalPhenomenon =>
    typeof value === "string" &&
    (AI_REVIEW_EVAL_PHENOMENA as readonly string[]).includes(value);

/**
 * Aggregate one run, or say why it cannot be aggregated.
 *
 * Order matters and is the point: the plan is checked before anything is read
 * through it, evidence is verified before it is counted, and the plan and the
 * evidence are reconciled in both directions before a single number exists.
 */
export function aggregateJudgedRun(input: {
    plan: readonly AiReviewJudgedRunPlanItem[];
    entries: readonly AiReviewJudgedRunEntry[];
    runInputs: AiReviewJudgedRunInputs;
}): AiReviewJudgedRunAggregate {
    const blockers: string[] = [];
    const { plan, entries, runInputs } = input;

    // 1. The plan itself.
    //
    // A repeated row is refused rather than deduplicated. One row copied a
    // hundred times took 2/2/2 to 102/2/2 without a single new judgement, and
    // quietly fixing such a plan hides that somebody wrote it.
    const planKeys = new Set<string>();
    for (const item of plan) {
        const key = planKeyOf(item.caseId, item.observationRef);
        if (planKeys.has(key)) {
            blockers.push(`${item.caseId}: the run's plan lists this case and output twice`);
        }
        planKeys.add(key);
    }
    // Two different states, two different refusals. "Nothing was planned" is
    // not "nothing was judged", and reporting either as the other sends the
    // operator to the wrong file.
    if (plan.length === 0) {
        blockers.push("the run planned no cases, so there is nothing to aggregate");
    }
    if (entries.length === 0 && plan.length > 0) {
        blockers.push("the run planned cases and nothing in it was judged");
    }

    // 2. The run's dataset, admitted as a whole and before anything reads
    // through it.
    //
    // Three failures lived in the gap between "the shared check verified this
    // case" and "the aggregator read the dataset again":
    //
    //   * The shared check reads the FIRST case with a given id; this file
    //     built its phenomenon map by iterating, so the LAST one won. A
    //     duplicate id appended to the end silently moved a case out of a
    //     denominator while every judgement and artifact stayed valid.
    //   * "Frozen" was a word in a comment. A set with no freeze record, or
    //     one whose recorded digest did not match its contents, aggregated.
    //     `datasetDigest()` covers `phenomenon`, so binding the run to it is
    //     also what catches a phenomenon edited to another legal value --
    //     which `sourceCaseDigest` cannot see, and should not: it covers the
    //     question and the answers, by design.
    //   * A `null` in `cases` made this file throw while walking an array the
    //     shared check had already rejected.
    //
    // `datasetProblems()` is the evaluation set's own validator: structure,
    // duplicate ids, and the phenomenon vocabulary among much else. Using it
    // rather than a private check here is the point -- what a dataset is gets
    // decided once.
    //
    // What is NOT decided here: whether the set must be a decision set.
    // `decisionDatasetProblems()` also requires `purpose: "decision"`, and
    // whether a judged run may be aggregated on a development set is a
    // separate question nobody has answered.
    const datasetIssues = datasetProblems(runInputs.dataset);
    for (const problem of datasetIssues) {
        blockers.push(`the run's dataset: ${problem}`);
    }
    if (datasetIssues.length === 0) {
        const drift = freezeDrift(runInputs.dataset as Parameters<typeof freezeDrift>[0]);
        if (drift) blockers.push(`the run's dataset: ${drift}`);
    }
    // Return here rather than carrying on. Everything below reads the dataset
    // -- the shared evidence check is handed it, and the phenomenon map walks
    // it -- and reading an array that has just been declared malformed is how
    // a refusal became a crash.
    if (blockers.length > 0) return { aggregable: false, blockers };

    // 3. Every entry, through the shared verification path.
    const verified = new Map<
        string,
        { artifact: AiReviewJudgedScoringArtifact; record: AiReviewJudgementRecord }
    >();
    for (const entry of entries) {
        const evidence = verifyJudgedScoringEvidence({
            testCase: entry.testCase,
            observation: entry.observation,
            record: entry.record,
            artifact: entry.artifact,
            journal: runInputs.journal,
            dataset: runInputs.dataset,
        });
        const artifact = entry.artifact as AiReviewJudgedScoringArtifact | null;
        const named = typeof artifact?.caseId === "string" ? artifact.caseId : "(id unreadable)";
        if (!evidence.eligibleForAggregation) {
            blockers.push(
                `${named}: ${evidence.problems[0] ?? evidence.ineligibleReasons[0]}`
            );
            continue;
        }
        if (artifact === null) continue;
        if (artifact.contractVersion !== AI_REVIEW_SCORING_CONTRACT_VERSION) {
            blockers.push(
                `${named}: scored under ${artifact.contractVersion}, this run is ` +
                    `${AI_REVIEW_SCORING_CONTRACT_VERSION}`
            );
            continue;
        }
        const key = planKeyOf(artifact.caseId, artifact.observationRef);
        if (verified.has(key)) {
            blockers.push(`${named}: judged twice for the same output`);
            continue;
        }
        verified.set(key, {
            artifact,
            record: entry.record as AiReviewJudgementRecord,
        });
    }

    // 4. Both directions. Planned and never judged, judged and never planned.
    for (const key of planKeys) {
        if (!verified.has(key)) {
            blockers.push(`${key.split("::")[0]}: planned in the run and never judged`);
        }
    }
    for (const key of verified.keys()) {
        if (!planKeys.has(key)) {
            blockers.push(
                `${key.split("::")[0]}: judged, but the run's plan has no such case and output`
            );
        }
    }

    // 5. The phenomenon of each case, which decides two denominators and is
    // not in the judged case at all.
    //
    // Read from the admitted dataset above: its structure, its unique ids and
    // its phenomenon vocabulary have all been checked, so `find()` here reads
    // the same single row the shared evidence check read. The remaining
    // guard is for a case the run judged that the set does not hold at all --
    // which the evidence check also refuses, and which is stated rather than
    // defaulted, because guessing puts a case in or out of a denominator.
    const datasetCases = (runInputs.dataset as { cases: readonly { id: string; phenomenon?: unknown }[] })
        .cases;
    const phenomenonOf = new Map<string, AiReviewEvalPhenomenon>();
    for (const row of datasetCases) {
        if (phenomenonOf.has(row.id)) continue;
        if (isPhenomenon(row.phenomenon)) phenomenonOf.set(row.id, row.phenomenon);
    }
    for (const { artifact } of verified.values()) {
        if (!phenomenonOf.has(artifact.caseId)) {
            blockers.push(
                `${artifact.caseId}: the frozen dataset does not give this case a known ` +
                    `phenomenon, so whether it belongs in either denominator is unknown`
            );
        }
    }

    if (blockers.length > 0) return { aggregable: false, blockers };

    // 6. Only now, over the distinct verified cases, which steps 1-4 have
    // shown to be exactly the planned ones.
    let missedNumerator = 0;
    let missedDenominator = 0;
    let missedAimedAt = 0;
    let inventedCases = 0;
    let inventedFindingCount = 0;
    let inventedNegativeCases = 0;
    let inventedNegativeDenominator = 0;

    for (const { artifact, record } of verified.values()) {
        const outcome = artifact.outcome;
        // Eligibility has already refused an unscored artifact; this keeps the
        // types honest rather than re-deciding.
        if (!outcome.scored) continue;
        const phenomenon = phenomenonOf.get(artifact.caseId) as AiReviewEvalPhenomenon;
        const negative = AI_REVIEW_EVAL_NEGATIVE_PHENOMENA.includes(phenomenon);

        const truePositives = AI_REVIEW_EVAL_FINDING_KINDS.reduce(
            (total, kind) => total + outcome.byKind[kind].truePositives,
            0
        );
        const planted = AI_REVIEW_EVAL_FINDING_KINDS.reduce(
            (total, kind) =>
                total + outcome.byKind[kind].truePositives + outcome.byKind[kind].falseNegatives,
            0
        );
        const insufficient = AI_REVIEW_EVAL_FINDING_KINDS.reduce(
            (total, kind) => total + outcome.byKind[kind].insufficientFindings,
            0
        );

        if (!negative && planted > 0) {
            missedDenominator += 1;
            if (truePositives === 0) {
                missedNumerator += 1;
                if (insufficient > 0) missedAimedAt += 1;
            }
        }

        const invented = judgedInventedFindings(record);
        inventedFindingCount += invented.length;
        // Every scored case is in this denominator, and a case counts once
        // however many findings it invented: three branches of one
        // misreading and three separate inventions are different facts, and
        // summing findings makes the first look like the second.
        const inventedHere = invented.length > 0 ? 1 : 0;
        inventedCases += inventedHere;
        if (negative) {
            // Restricted on BOTH sides. The whole numerator over this
            // denominator is a proportion of nothing.
            inventedNegativeDenominator += 1;
            inventedNegativeCases += inventedHere;
        }
    }

    return {
        aggregable: true,
        contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
        cases: verified.size,
        metrics: {
            missedEveryPlantedIssueRate: rateOf(missedNumerator, missedDenominator),
            missedEveryPlantedIssueAimedAt: missedAimedAt,
            inventedFindingRate: rateOf(inventedCases, verified.size),
            inventedFindingRateNegativeSubset: rateOf(
                inventedNegativeCases,
                inventedNegativeDenominator
            ),
            inventedFindingCount,
        },
    };
}
