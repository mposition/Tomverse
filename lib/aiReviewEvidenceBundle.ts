/**
 * The evidence an approval rests on, checked as one thing.
 *
 * docs/ops/ai-review-eval-runbook.md §6b.
 *
 * ## Why this is one module and not conditions in two scripts
 *
 * An approval cites five artefacts that only mean anything together: the
 * dataset, the run's journal, the answer key, the blind review record, and the
 * artifact. Adjudication reads them to produce numbers; the gate reads them to
 * check numbers. While those were two separate piles of conditions, each pile
 * checked what its author remembered, and the gaps were the same shape every
 * time -- a file was opened, its shape was validated, and nothing compared its
 * CONTENT with the thing it was supposed to agree with.
 *
 * Three of those gaps, all found after the individual checks were added:
 *
 *   * a verdict edited in the record after adjudication left the artifact
 *     stale, and the gate passed: it validated the record's format and the
 *     artifact's numbers, never that one produced the other;
 *   * an empty answer key and a record with no rows adjudicated to "five rules
 *     judged" over zero cases, because every validation loop over an empty
 *     population simply ends;
 *   * a journal missing twenty of its cases re-scored 1,420 and inherited
 *     `completedCases: 1,440` from the artifact it was adjudicating.
 *
 * So the bundle is verified as a bundle, once, by both callers. Everything
 * below is derived from the files themselves -- nothing is inherited from the
 * artifact's own summary, because the summary is what is being checked.
 */

import { createHash } from "node:crypto";

import {
    aggregateOutcomes,
    assessSampleAdequacy,
    breakdownOutcomes,
    scoreCase,
    AI_REVIEW_EVAL_BLIND_SHEET_RULES,
    type AiReviewArmBreakdown,
    type AiReviewArmMetrics,
    type AiReviewEvalCase,
    type AiReviewEvalObservation,
} from "@/lib/aiReviewEvalCore";
import {
    blindReviewRecordProblems,
    humanVerdictsByCase,
    parseBlindReviewRecord,
    type AiReviewBlindReviewIdentity,
} from "@/lib/aiReviewBlindReviewRecord";
import { approvalBlockDrift } from "@/lib/aiReviewApprovalBlock";
import { approvalMetricsFromArm } from "@/lib/aiReviewQualityThresholds";
import { datasetDigest, datasetProblems, freezeDrift } from "@/lib/aiReviewEvalRun";

/** A digest of a file's bytes, so an artifact can name the exact file it used. */
export const fileDigest = (contents: string): string =>
    `sha256:${createHash("sha256").update(contents, "utf8").digest("hex")}`;

export type AiReviewJournalEntry = {
    caseId?: string;
    observation?: AiReviewEvalObservation | null;
    failure?: string | null;
};

export type AiReviewEvidenceInputs = {
    /** The parsed dataset, and its bytes, from the tree. */
    dataset: { version?: string; schemaVersion?: number; purpose?: string; cases?: AiReviewEvalCase[]; frozenAt?: string | null; frozenBy?: string | null };
    journal: readonly AiReviewJournalEntry[];
    journalText: string;
    answerKey: Readonly<Record<string, { caseId?: string }>>;
    answerKeyText: string;
    recordText: string;
    /** What the record must be about. Compared field by field. */
    identity: AiReviewBlindReviewIdentity;
    /**
     * The approved coverage bar, when the caller has one.
     *
     * Omitted by adjudication, which is not an approval and only has to refuse
     * an empty review. Supplied by the gate from the threshold set the entry
     * names, so the bar an approval is judged against is the signed one.
     */
    minimumReviewedCases?: number;
};

export type AiReviewEvidenceBundle = {
    problems: readonly string[];
    /** Present only when nothing above refused. */
    metrics: AiReviewArmBreakdown | null;
    zeroToleranceViolations: number;
    /** Counts derived from the files, never inherited from the artifact. */
    derived: {
        plannedCases: number;
        completedCases: number;
        reviewedCases: number;
        sampleAdequate: boolean;
        recordDigest: string;
        answerKeyDigest: string;
        journalDigest: string;
        datasetDigest: string;
        signedBy: string | null;
        signedAt: string | null;
    };
};

/**
 * Two different questions, and only one of them is this module's.
 *
 * **Did a review happen at all** is structural. An empty answer key and a
 * record with only a header adjudicated cleanly, reporting five rules judged
 * over no cases, because every check that walks a population does nothing when
 * the population is empty. Refusing that needs no approval; it is not a
 * judgement about quality, it is the observation that nothing was judged.
 *
 * **Did it cover enough cases to mean anything** is a quality threshold, and
 * this repository's whole design says a quality threshold is versioned and
 * signed. It was briefly a bare `20` in this file, gating approvals, which is
 * exactly the thing the threshold module exists to prevent -- and the runbook
 * suggested 60 while the sheet generator defaulted to 24, so there were three
 * numbers and no decision. It now lives in `AiReviewThresholdSet` as
 * `minBlindReviewedCases`, so a caller with an approved set passes that value
 * and a caller without one gets the structural check alone.
 */
export const AI_REVIEW_BLIND_REVIEW_MUST_NOT_BE_EMPTY = 1;

export const verifyEvidenceBundle = (
    input: AiReviewEvidenceInputs
): AiReviewEvidenceBundle => {
    const problems: string[] = [];
    const empty = (): AiReviewEvidenceBundle => ({
        problems,
        metrics: null,
        zeroToleranceViolations: 0,
        derived: {
            plannedCases: 0,
            completedCases: 0,
            reviewedCases: 0,
            sampleAdequate: false,
            recordDigest: fileDigest(input.recordText),
            answerKeyDigest: fileDigest(input.answerKeyText),
            journalDigest: fileDigest(input.journalText),
            datasetDigest: "",
            signedBy: null,
            signedAt: null,
        },
    });

    problems.push(...datasetProblems(input.dataset).map((p) => `dataset: ${p}`));
    if (problems.length > 0) return empty();

    const cases = (input.dataset.cases ?? []) as AiReviewEvalCase[];
    const byId = new Map(cases.map((testCase) => [testCase.id, testCase]));

    // --- journal against the dataset, one to one ---------------------------
    //
    // A journal missing cases used to re-score whatever it had and leave the
    // artifact's own completedCases untouched, so a run that lost twenty cases
    // still declared itself complete. Neither direction is allowed to be
    // loose: an id the dataset does not contain is a journal from another set,
    // and a duplicate is one case counted twice.
    const observed = new Map<string, AiReviewEvalObservation>();
    for (const [index, entry] of input.journal.entries()) {
        const caseId = entry.caseId;
        if (typeof caseId !== "string" || caseId === "") {
            problems.push(`journal[${index}]: no case id`);
            continue;
        }
        if (!byId.has(caseId)) {
            problems.push(`journal: "${caseId}" is not in this dataset`);
            continue;
        }
        if (observed.has(caseId)) {
            problems.push(`journal: "${caseId}" appears more than once`);
            continue;
        }
        if (!entry.observation) {
            problems.push(
                `journal: "${caseId}" has no observation${entry.failure ? ` (${entry.failure})` : ""}`
            );
            continue;
        }
        observed.set(caseId, entry.observation);
    }
    for (const testCase of cases) {
        if (!observed.has(testCase.id)) {
            problems.push(`journal: "${testCase.id}" was never scored`);
        }
    }

    // --- answer key against the journal ------------------------------------
    const labels = Object.keys(input.answerKey);
    if (labels.length === 0) {
        problems.push(
            "the answer key is empty, so the blind review covered no case at all"
        );
    }
    const reviewedCaseIds = new Set<string>();
    for (const label of labels) {
        const caseId = input.answerKey[label]?.caseId;
        if (typeof caseId !== "string" || caseId === "") {
            problems.push(`answer key: ${label} names no case`);
            continue;
        }
        if (!byId.has(caseId)) {
            problems.push(`answer key: ${label} names "${caseId}", which is not in this dataset`);
            continue;
        }
        if (!observed.has(caseId)) {
            problems.push(`answer key: ${label} names "${caseId}", which the run never scored`);
            continue;
        }
        if (reviewedCaseIds.has(caseId)) {
            problems.push(`answer key: "${caseId}" is mapped by more than one label`);
            continue;
        }
        reviewedCaseIds.add(caseId);
    }
    const coverageFloor = input.minimumReviewedCases ?? 0;
    if (labels.length > 0 && labels.length < coverageFloor) {
        problems.push(
            `the blind review covered ${labels.length} case(s); the approved threshold ` +
                `set asks for ${coverageFloor}`
        );
    }

    // --- the record against the answer key and the run ---------------------
    const { record, problems: parseProblems } = parseBlindReviewRecord(input.recordText);
    problems.push(...parseProblems);
    problems.push(
        ...blindReviewRecordProblems({
            record,
            sheetLabels: labels,
            identity: input.identity,
        })
    );
    if (record.rows.length === 0) {
        problems.push("the record has no answered row, so nobody judged anything");
    }

    if (problems.length > 0) {
        return { ...empty(), derived: { ...empty().derived, signedBy: record.signedBy, signedAt: record.signedAt } };
    }

    // --- re-score, with the verdicts -------------------------------------
    const verdicts = humanVerdictsByCase(record, input.answerKey as Record<string, { caseId: string }>);
    const outcomes = cases.map((testCase) =>
        scoreCase(
            testCase,
            observed.get(testCase.id) as AiReviewEvalObservation,
            verdicts.get(testCase.id) ?? []
        )
    );
    const aggregate = aggregateOutcomes(outcomes);
    const adequacy = assessSampleAdequacy(cases);

    return {
        problems,
        metrics: breakdownOutcomes(outcomes),
        zeroToleranceViolations: Object.values(aggregate.zeroToleranceViolations).reduce(
            (sum, count) => sum + count,
            0
        ),
        derived: {
            plannedCases: cases.length,
            completedCases: observed.size,
            reviewedCases: record.rows.length,
            sampleAdequate: adequacy.adequate,
            recordDigest: fileDigest(input.recordText),
            answerKeyDigest: fileDigest(input.answerKeyText),
            journalDigest: fileDigest(input.journalText),
            datasetDigest: datasetDigest({ cases }),
            signedBy: record.signedBy,
            signedAt: record.signedAt,
        },
    };
};

/**
 * What an adjudicated artifact must say about the bundle it came from, and
 * whether it still says the truth.
 *
 * The check the gate was missing entirely. A verdict changed in the record
 * after adjudication left the artifact carrying the old numbers, and the gate
 * passed: it validated the record's shape and the artifact's numbers, never
 * that one produced the other. So the numbers are recomputed and compared, and
 * the three files are bound by digest -- a record swapped for another of the
 * same shape is a different record.
 */
export const adjudicatedArtifactProblems = (input: {
    artifact: { summary?: Record<string, unknown>; metrics?: unknown };
    bundle: AiReviewEvidenceBundle;
}): readonly string[] => {
    const problems: string[] = [];
    const summary = (input.artifact.summary ?? {}) as Record<string, unknown>;
    const { bundle } = input;

    if (bundle.problems.length > 0) return bundle.problems;
    if (!bundle.metrics) return ["the evidence bundle produced no metrics"];

    const bind = (key: string, expected: string) => {
        const stated = summary[key];
        if (typeof stated !== "string" || stated === "") {
            problems.push(`the artifact does not record ${key}`);
        } else if (stated !== expected) {
            problems.push(
                `${key}: the artifact was adjudicated from ${stated}, and the file here is ${expected}`
            );
        }
    };
    bind("blindReviewRecordDigest", bundle.derived.recordDigest);
    bind("blindReviewAnswerKeyDigest", bundle.derived.answerKeyDigest);
    bind("journalDigest", bundle.derived.journalDigest);

    const number = (key: string, expected: number) => {
        if (summary[key] !== expected) {
            problems.push(
                `${key}: the artifact says ${String(summary[key])}, the evidence says ${expected}`
            );
        }
    };
    number("plannedCases", bundle.derived.plannedCases);
    number("completedCases", bundle.derived.completedCases);
    number("blindReviewCasesJudged", bundle.derived.reviewedCases);
    number("zeroToleranceViolations", bundle.zeroToleranceViolations);
    if (summary.sampleAdequate !== bundle.derived.sampleAdequate) {
        problems.push(
            `sampleAdequate: the artifact says ${String(summary.sampleAdequate)}, ` +
                `the evidence says ${bundle.derived.sampleAdequate}`
        );
    }
    if (summary.blindReviewRulesJudged !== AI_REVIEW_EVAL_BLIND_SHEET_RULES.length) {
        problems.push(
            `blindReviewRulesJudged: the artifact says ${String(summary.blindReviewRulesJudged)}, ` +
                `and the form asks about ${AI_REVIEW_EVAL_BLIND_SHEET_RULES.length}`
        );
    }

    // The numbers themselves, recomputed by the same scorer over the same
    // files. This is what makes a verdict edited after adjudication visible:
    // the artifact keeps the old figure, the evidence produces the new one,
    // and until this comparison existed the gate looked at each separately and
    // agreed with both.
    problems.push(
        ...armDrift(
            (input.artifact as { metrics?: AiReviewArmBreakdown }).metrics,
            bundle.metrics
        )
    );

    return problems;
};

/**
 * Where an artifact's stored breakdown and a freshly computed one differ.
 *
 * Compared through the approval shape rather than by deep equality on the raw
 * metrics: the approval shape is what a threshold is applied to, so a
 * difference that shape cannot see is a difference no approval rests on.
 * Anything it CAN see is reported to the digit.
 */
const armsOf = (group: Readonly<Record<string, AiReviewArmMetrics>> | undefined) =>
    Object.entries(group ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([arm, metrics]) => ({
            arm,
            cases: metrics?.cases ?? -1,
            ...approvalMetricsFromArm(metrics),
        }));

const armDrift = (
    stored: AiReviewArmBreakdown | undefined,
    computed: AiReviewArmBreakdown
): readonly string[] => {
    // `metrics: {}` is what the runner writes before adjudication, so an
    // absent aggregate is the ordinary un-adjudicated case rather than a
    // corruption -- and it must be a reported problem, not a thrown one.
    if (!stored?.aggregate) {
        return ["the artifact carries no metrics to compare"];
    }
    return approvalBlockDrift(
        {
            metrics: approvalMetricsFromArm(stored.aggregate),
            byLanguage: armsOf(stored.byLanguage),
            byTaskType: armsOf(stored.byTaskType),
            // Compared above against the summary; zero on both sides keeps
            // this function about the arms alone.
            zeroToleranceViolations: 0,
        },
        {
            summary: { zeroToleranceViolations: 0 },
            metrics: computed,
        }
    );
};

/** The dataset half, kept here so both callers apply the same freeze rules. */
export const decisionDatasetProblems = (dataset: {
    version?: string;
    schemaVersion?: number;
    purpose?: string;
    frozenAt?: string | null;
    frozenBy?: string | null;
    cases?: AiReviewEvalCase[];
}): readonly string[] => {
    const problems: string[] = [...datasetProblems(dataset)];
    if (dataset.purpose !== "decision") {
        problems.push("not a decision set");
    }
    if (!dataset.frozenAt || !dataset.frozenBy) {
        problems.push("not frozen; an approval cannot rest on a set that can still change");
    }
    const drift = freezeDrift(dataset as Parameters<typeof freezeDrift>[0]);
    if (drift) problems.push(drift);
    return problems;
};
