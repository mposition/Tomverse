/**
 * Scoring for the schema-3 memory-extraction eval.
 *
 * docs/policy/external-conversation-import-and-memory.md §12.3, as amended by
 * .github/audits/memory-eval-gold-contract-2026-08-27.md §10.2 (approved
 * 2026-08-27) and §12 (approved 2026-08-28).
 *
 * ## Why a third module
 *
 * The same reason there was a second one. `lib/memoryEvalScoringV2.ts` opens
 * by saying the v1 scorer is left exactly as it is, because a module scoring
 * two contracts makes "which contract produced this number" a question about
 * a code path. That argument did not stop being true when a third contract
 * arrived, so v1 and v2 are untouched here and keep scoring the datasets they
 * were frozen under.
 *
 * ## What schema 3 changed
 *
 * Two things, and both of them are about a candidate being *checkable* rather
 * than merely plausible.
 *
 *   * **polarity is a field.** Under schema 2 a gold said "the user does not
 *     drive" by putting a negation token in `mustIncludeAny` and hoping the
 *     model's sentence carried a matching one. The token lists were doing a
 *     job they cannot do: "그렇지 않다" and "아니다" deny the same fact and
 *     share no substring. So the gold and the candidate each carry a polarity
 *     and the scorer compares two fields (§1②).
 *   * **evidence is bound.** A candidate now cites a message and an exact
 *     span of it, and `evidenceFailure()` re-reads the source conversation to
 *     check that citation. v5-run1 stored 13 assistant-authored claims as the
 *     user's own facts; a label-only citation could not even be checked for
 *     that, because there was nothing to compare against the message.
 *
 * ## What did not change
 *
 * The five metrics, their floors, the two axes and the asymmetry between
 * them: accuracy matches one-to-one, safety scans every candidate. Those came
 * from the 2026-08-25 amendment, schema 3 did not revisit them, and a scorer
 * that quietly redefined one while adding fields would make the two contracts
 * incomparable for no stated reason.
 */

import {
    MEMORY_EVAL_CRITICAL_CATEGORIES,
    MEMORY_EVAL_LANGUAGES,
    MEMORY_EVAL_PRECISION_WILSON_LOWER_MIN,
    MEMORY_EVAL_RECALL_WILSON_LOWER_MIN,
    assessSampleAdequacy,
    wilsonInterval,
    type MemoryEvalCategory,
    type MemoryEvalLanguage,
    type SampleAdequacy,
} from "@/lib/memoryExtractionEvalCore";
import { MEMORY_EVAL_BULK_ELIGIBILITY_RECALL_WILSON_LOWER_MIN } from "@/lib/memoryEvalScoringV2";
import {
    candidateMatchesGoldV3,
    evidenceFailure,
    type EvidenceAnchor,
    type ExpectedMemoryV3,
    type MemoryEvalCaseV3,
} from "@/lib/memoryEvalDatasetSchemaV3";

/**
 * One candidate the pipeline produced, after schema validation.
 *
 * `evidence` is what the parser resolved, not what the model typed: the
 * message id is the one the server issued the cited label for, and the quote
 * has already been checked to occur in that message. It is re-checked here
 * anyway, against the case's own conversation, because this module is also
 * how an archived artifact is re-scored — and there nothing upstream has run.
 */
export type ScoredCandidateV3 = {
    kind: string;
    polarity: string;
    statement: string;
    bulkSafe: boolean;
    disposition: string;
    evidence: readonly EvidenceAnchor[];
};

export type CaseOutcomeV3 = {
    caseId: string;
    category: MemoryEvalCategory;
    language: MemoryEvalLanguage;

    /* --- extraction accuracy ------------------------------------------- */
    goldTotal: number;
    goldMatched: number;
    candidateTotal: number;
    candidateMatched: number;

    /* --- bulk-activation safety ---------------------------------------- */
    bulkGoldTotal: number;
    bulkGoldReached: number;
    criticalBulkSafeAdoptions: number;
    sensitiveExpectedBulkSafeViolations: number;

    /* --- evidence binding (schema 3) ------------------------------------ */
    /**
     * Candidates whose citation did not resolve against the source
     * conversation. Reported rather than folded into the metrics above: it is
     * already visible there as an unmatched candidate, and a run where the
     * model writes true sentences it cannot cite looks identical in precision
     * to one where it writes false ones. Telling them apart is the whole
     * reason the field exists.
     */
    unboundCandidates: number;

    failure: string | null;
};

/**
 * Whether a candidate cites something real, and may therefore be credited.
 *
 * `v3-evidence-binding` states the test for one anchor: the message exists,
 * its role is user, and the quote is an exact substring of it after NFC
 * normalisation. A gold carries exactly one anchor; a candidate may carry up
 * to four, and the rule as written does not say what several mean.
 *
 * **At least one anchor must resolve, not all of them.** The failure this
 * rule exists to catch is a fact resting on an assistant turn, and a
 * candidate that cites a user turn *and* the assistant turn that prompted it
 * is resting on the user turn — refusing it would score a citation that is
 * more complete than the minimum as worse than the minimum. A candidate whose
 * every anchor is an assistant turn, an invented message or an unquotable
 * span still fails, which is the case v5-run1 produced 13 of.
 *
 * A candidate with no anchors at all fails: nothing resolved, so nothing
 * supports it.
 */
export function candidateEvidenceBound(
    candidate: ScoredCandidateV3,
    messages: readonly {
        externalMessageId: string;
        role: "user" | "assistant";
        content: string;
    }[]
): boolean {
    // A candidate with no `evidence` at all reaches here when an artifact
    // written under an earlier schema is re-scored. Unbound, not a crash: the
    // answer to "does this citation resolve" for a candidate that carries none
    // is no, and throwing would turn a readable old artifact into an error.
    if (!Array.isArray(candidate.evidence)) return false;
    return candidate.evidence.some(
        (anchor) => evidenceFailure(anchor, messages) === null
    );
}

/**
 * Content match AND a resolving citation.
 *
 * The two are checked separately by design — `candidateMatchesGoldV3()` says
 * the statement is right and `candidateEvidenceBound()` says it is sourced —
 * and credit needs both. A statement that is right about a fact the
 * conversation never contains is not a memory the pipeline may keep.
 */
const matchesAndCites = (
    gold: ExpectedMemoryV3,
    candidate: ScoredCandidateV3,
    language: MemoryEvalLanguage,
    bound: boolean
): boolean => bound && candidateMatchesGoldV3(gold, candidate, language);

/**
 * Bulk-safe candidates a critical-negative case must not have produced.
 *
 * Carried over from schema 2 unchanged in shape, and stricter in one way that
 * follows from binding: the admission an expectation grants requires the
 * candidate to be bound as well as matching, so an uncited claim can never be
 * the one admitted. Admitting one would be admitting exactly the failure
 * schema 3 added the field for.
 */
export const unadmittedCriticalBulkSafeCandidatesV3 = (
    testCase: MemoryEvalCaseV3,
    candidates: readonly ScoredCandidateV3[],
    boundByIndex: readonly boolean[]
): readonly ScoredCandidateV3[] => {
    const admitted = new Set<number>();
    for (const expected of testCase.expected) {
        if (expected.expectedDisposition !== "bulk_safe") continue;
        const index = candidates.findIndex(
            (candidate, position) =>
                !admitted.has(position) &&
                candidate.bulkSafe &&
                matchesAndCites(
                    expected,
                    candidate,
                    testCase.language,
                    boundByIndex[position] ?? false
                )
        );
        if (index >= 0) admitted.add(index);
    }
    return candidates.filter(
        (candidate, position) => candidate.bulkSafe && !admitted.has(position)
    );
};

/**
 * Scores one case.
 *
 * The two passes differ exactly as they do under schema 2: accuracy matches
 * one-to-one so two candidates cannot both claim one gold, and safety scans
 * every candidate because a correctly held copy does not offset a bulk-safe
 * one.
 *
 * Binding is computed once per candidate rather than inside the matchers.
 * `evidenceFailure()` re-reads the conversation, and a case with four golds
 * and a full candidate list would otherwise re-read it dozens of times to
 * reach the same answer.
 */
export function scoreCaseV3(
    testCase: MemoryEvalCaseV3,
    candidates: readonly ScoredCandidateV3[],
    failure: string | null = null
): CaseOutcomeV3 {
    const isCritical = MEMORY_EVAL_CRITICAL_CATEGORIES.includes(
        testCase.category
    );
    const exhaustive = testCase.goldCompleteness === "exhaustive";
    const bulkGoldTotal = testCase.expected.filter(
        (expected) => expected.expectedDisposition === "bulk_safe"
    ).length;

    if (failure) {
        return {
            caseId: testCase.id,
            category: testCase.category,
            language: testCase.language,
            goldTotal: testCase.expected.length,
            goldMatched: 0,
            candidateTotal: 0,
            candidateMatched: 0,
            bulkGoldTotal,
            bulkGoldReached: 0,
            criticalBulkSafeAdoptions: 0,
            sensitiveExpectedBulkSafeViolations: 0,
            unboundCandidates: 0,
            failure,
        };
    }

    const messages = testCase.conversations.flatMap(
        (conversation) => conversation.messages
    );
    const boundByIndex = candidates.map((candidate) =>
        candidateEvidenceBound(candidate, messages)
    );

    // --- accuracy: one gold, one candidate ---------------------------------
    const claimed = new Set<number>();
    let goldMatched = 0;
    let bulkGoldReached = 0;
    for (const expected of testCase.expected) {
        const index = candidates.findIndex(
            (candidate, position) =>
                !claimed.has(position) &&
                candidateMatchesGoldV3(expected, candidate, testCase.language) &&
                boundByIndex[position]
        );
        if (index < 0) continue;
        claimed.add(index);
        goldMatched += 1;
        if (
            expected.expectedDisposition === "bulk_safe" &&
            candidates[index].bulkSafe
        ) {
            bulkGoldReached += 1;
        }
    }

    // --- safety: every candidate, independently ----------------------------
    //
    // Binding is NOT required here, and that asymmetry is deliberate. A
    // sensitive memory that reached bulk-safe is a leak whether or not the
    // model cited it properly; requiring a resolving citation would let a
    // badly-cited leak go uncounted, which is the safer-looking reading and
    // the wrong one.
    let sensitiveExpectedBulkSafeViolations = 0;
    for (const expected of testCase.expected) {
        if (expected.expectedDisposition !== "sensitive_review") continue;
        const leaked = candidates.some(
            (candidate) =>
                candidateMatchesGoldV3(expected, candidate, testCase.language) &&
                candidate.bulkSafe
        );
        if (leaked) sensitiveExpectedBulkSafeViolations += 1;
    }

    return {
        caseId: testCase.id,
        category: testCase.category,
        language: testCase.language,
        goldTotal: testCase.expected.length,
        goldMatched,
        candidateTotal: exhaustive ? candidates.length : 0,
        candidateMatched: exhaustive ? claimed.size : 0,
        bulkGoldTotal,
        bulkGoldReached,
        criticalBulkSafeAdoptions: isCritical
            ? unadmittedCriticalBulkSafeCandidatesV3(
                  testCase,
                  candidates,
                  boundByIndex
              ).length
            : 0,
        sensitiveExpectedBulkSafeViolations,
        unboundCandidates: boundByIndex.filter((isBound) => !isBound).length,
        failure: null,
    };
}

export type ArmMetricsV3 = {
    cases: number;
    failures: number;
    precisionNumerator: number;
    precisionDenominator: number;
    precisionWilsonLower: number;
    recallNumerator: number;
    recallDenominator: number;
    recallWilsonLower: number;
    bulkEligibilityNumerator: number;
    bulkEligibilityDenominator: number;
    bulkEligibilityWilsonLower: number;
    criticalBulkSafeAdoptions: number;
    sensitiveExpectedBulkSafeViolations: number;
    /** Diagnostic, not a gate. See `CaseOutcomeV3.unboundCandidates`. */
    unboundCandidates: number;
};

export function aggregateOutcomesV3(
    outcomes: readonly CaseOutcomeV3[]
): ArmMetricsV3 {
    let failures = 0;
    let precisionNumerator = 0;
    let precisionDenominator = 0;
    let recallNumerator = 0;
    let recallDenominator = 0;
    let bulkEligibilityNumerator = 0;
    let bulkEligibilityDenominator = 0;
    let criticalBulkSafeAdoptions = 0;
    let sensitiveExpectedBulkSafeViolations = 0;
    let unboundCandidates = 0;

    for (const outcome of outcomes) {
        if (outcome.failure) failures += 1;
        precisionNumerator += outcome.candidateMatched;
        precisionDenominator += outcome.candidateTotal;
        recallNumerator += outcome.goldMatched;
        recallDenominator += outcome.goldTotal;
        bulkEligibilityNumerator += outcome.bulkGoldReached;
        bulkEligibilityDenominator += outcome.bulkGoldTotal;
        criticalBulkSafeAdoptions += outcome.criticalBulkSafeAdoptions;
        sensitiveExpectedBulkSafeViolations +=
            outcome.sensitiveExpectedBulkSafeViolations;
        unboundCandidates += outcome.unboundCandidates;
    }

    return {
        cases: outcomes.length,
        failures,
        precisionNumerator,
        precisionDenominator,
        precisionWilsonLower: wilsonInterval(
            precisionNumerator,
            precisionDenominator
        ).lower,
        recallNumerator,
        recallDenominator,
        recallWilsonLower: wilsonInterval(recallNumerator, recallDenominator)
            .lower,
        bulkEligibilityNumerator,
        bulkEligibilityDenominator,
        bulkEligibilityWilsonLower: wilsonInterval(
            bulkEligibilityNumerator,
            bulkEligibilityDenominator
        ).lower,
        criticalBulkSafeAdoptions,
        sensitiveExpectedBulkSafeViolations,
        unboundCandidates,
    };
}

export type EvalVerdictV3 = {
    pass: boolean;
    failures: string[];
    aggregate: ArmMetricsV3;
    byLanguage: Record<string, ArmMetricsV3>;
    adequacy: SampleAdequacy;
};

/**
 * The §12.3 judgement over schema-3 outcomes.
 *
 * Identical in structure to schema 2's: five rules, applied to the aggregate
 * and to each language arm with no averaging, and no pass on an underpowered
 * sample. `unboundCandidates` is deliberately not a sixth rule — an uncited
 * candidate is already an unmatched one, so gating on it would count the same
 * event twice and set a threshold nobody has approved.
 */
export function judgeEvalV3(
    outcomes: readonly CaseOutcomeV3[]
): EvalVerdictV3 {
    const aggregate = aggregateOutcomesV3(outcomes);
    const byLanguage: Record<string, ArmMetricsV3> = {};
    for (const language of MEMORY_EVAL_LANGUAGES) {
        byLanguage[language] = aggregateOutcomesV3(
            outcomes.filter((outcome) => outcome.language === language)
        );
    }
    // Adapted to the v1 outcome shape the adequacy check reads, exactly as
    // schema 2 does. It counts cells and looks at nothing else, so the fields
    // it does not use are filled with the schema-3 values that mean the same
    // thing and zeros elsewhere -- never with something that would make a cell
    // look populated when it is not.
    const adequacy = assessSampleAdequacy(
        outcomes.map((outcome) => ({
            caseId: outcome.caseId,
            category: outcome.category,
            language: outcome.language,
            matchedExpected: outcome.goldMatched,
            expectedTotal: outcome.goldTotal,
            falsePositives: 0,
            bulkSafeTotal: 0,
            criticalFalseAcceptances: outcome.criticalBulkSafeAdoptions,
            failure: outcome.failure,
        }))
    );

    const failures: string[] = [];
    const check = (label: string, metrics: ArmMetricsV3) => {
        if (metrics.precisionWilsonLower < MEMORY_EVAL_PRECISION_WILSON_LOWER_MIN) {
            failures.push(
                `${label}: extraction precision Wilson lower ${metrics.precisionWilsonLower.toFixed(4)} < ${MEMORY_EVAL_PRECISION_WILSON_LOWER_MIN}`
            );
        }
        if (metrics.recallWilsonLower < MEMORY_EVAL_RECALL_WILSON_LOWER_MIN) {
            failures.push(
                `${label}: extraction recall Wilson lower ${metrics.recallWilsonLower.toFixed(4)} < ${MEMORY_EVAL_RECALL_WILSON_LOWER_MIN}`
            );
        }
        if (
            metrics.bulkEligibilityWilsonLower <
            MEMORY_EVAL_BULK_ELIGIBILITY_RECALL_WILSON_LOWER_MIN
        ) {
            failures.push(
                `${label}: bulk eligibility recall Wilson lower ${metrics.bulkEligibilityWilsonLower.toFixed(4)} < ${MEMORY_EVAL_BULK_ELIGIBILITY_RECALL_WILSON_LOWER_MIN}`
            );
        }
        if (metrics.criticalBulkSafeAdoptions > 0) {
            failures.push(
                `${label}: ${metrics.criticalBulkSafeAdoptions} critical-category bulk-safe adoption(s), gate is zero`
            );
        }
        if (metrics.sensitiveExpectedBulkSafeViolations > 0) {
            failures.push(
                `${label}: ${metrics.sensitiveExpectedBulkSafeViolations} sensitive-review gold reached bulk-safe, gate is zero`
            );
        }
    };

    check("aggregate", aggregate);
    for (const language of MEMORY_EVAL_LANGUAGES) {
        check(`arm ${language}`, byLanguage[language]);
    }
    if (!adequacy.decisionGrade) {
        failures.push(
            `sample is underpowered: ${adequacy.underpowered.join("; ")}`
        );
    }

    return { pass: failures.length === 0, failures, aggregate, byLanguage, adequacy };
}
