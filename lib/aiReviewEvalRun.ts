/**
 * What an AI Review evaluation run is allowed to do, and whether the artifact
 * it produced may be cited.
 *
 * docs/policy/ai-review-m5-quality-contract.md §5.
 *
 * Pure and separate from the harness for the same reason
 * `decideEvalRunMode()` is in the memory eval: the runner's only job is to
 * exit on a refusal BEFORE it dynamically imports anything that could reach a
 * provider. A static import check cannot see a dynamic one, so the guarantee
 * has to come from a truth table that can be tested directly.
 */

import { createHash } from "node:crypto";
import {
    AI_REVIEW_EVAL_DATASET_SCHEMA_VERSION,
    AI_REVIEW_EVAL_LANGUAGES,
    AI_REVIEW_EVAL_MODES,
    AI_REVIEW_EVAL_PHENOMENA,
    AI_REVIEW_EVAL_RESPONSE_LABELS,
    AI_REVIEW_EVAL_TASK_TYPES,
    AI_REVIEW_EVAL_FINDING_KINDS,
    type AiReviewEvalCase,
    type AiReviewEvalDataset,
} from "@/lib/aiReviewEvalCore";

// ---------------------------------------------------------------------------
// Dataset validation
// ---------------------------------------------------------------------------

const isNonEmptyString = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;

/**
 * The digest covers the cases and nothing else, so a freeze record can be
 * written into the same file without invalidating itself.
 */
export const datasetDigest = (dataset: {
    cases: readonly AiReviewEvalCase[];
}): string => {
    const sample = [...dataset.cases]
        .map((testCase) => ({
            id: testCase.id,
            language: testCase.language,
            taskType: testCase.taskType,
            phenomenon: testCase.phenomenon,
            mode: testCase.mode,
            question: testCase.question,
            responses: testCase.responses.map((response) => ({
                label: response.label,
                modelId: response.modelId,
                provider: response.provider,
                content: response.content,
            })),
            gold: testCase.gold,
            goldCompleteness: testCase.goldCompleteness,
            injectionMarkers: testCase.injectionMarkers ?? null,
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
    return `sha256:${createHash("sha256").update(JSON.stringify(sample)).digest("hex")}`;
};

/**
 * Everything structurally wrong with a dataset file.
 *
 * Returns problems rather than throwing so the validator can print all of
 * them at once -- a validator that stops at the first bad case turns fixing a
 * 1,200-case set into 1,200 runs.
 */
export const datasetProblems = (value: unknown): readonly string[] => {
    const problems: string[] = [];
    if (typeof value !== "object" || value === null) {
        return ["the dataset file is not an object"];
    }
    const dataset = value as Partial<AiReviewEvalDataset>;
    if (!isNonEmptyString(dataset.version)) problems.push("no version");
    if (dataset.schemaVersion !== AI_REVIEW_EVAL_DATASET_SCHEMA_VERSION) {
        problems.push(
            `schemaVersion ${String(dataset.schemaVersion)} != ${AI_REVIEW_EVAL_DATASET_SCHEMA_VERSION}`
        );
    }
    if (dataset.purpose !== "development" && dataset.purpose !== "decision") {
        problems.push(`purpose ${String(dataset.purpose)} is not development|decision`);
    }
    if (!Array.isArray(dataset.cases) || dataset.cases.length === 0) {
        problems.push("no cases");
        return problems;
    }

    const seen = new Set<string>();
    for (const [index, raw] of dataset.cases.entries()) {
        const label = isNonEmptyString((raw as AiReviewEvalCase)?.id)
            ? (raw as AiReviewEvalCase).id
            : `case[${index}]`;
        const testCase = raw as Partial<AiReviewEvalCase>;
        if (!isNonEmptyString(testCase.id)) {
            problems.push(`${label}: no id`);
        } else if (seen.has(testCase.id)) {
            problems.push(`${label}: duplicate id`);
        } else {
            seen.add(testCase.id);
        }
        if (!AI_REVIEW_EVAL_LANGUAGES.includes(testCase.language as never)) {
            problems.push(`${label}: language ${String(testCase.language)} is not supported`);
        }
        if (!AI_REVIEW_EVAL_TASK_TYPES.includes(testCase.taskType as never)) {
            problems.push(`${label}: taskType ${String(testCase.taskType)} is not supported`);
        }
        if (!AI_REVIEW_EVAL_PHENOMENA.includes(testCase.phenomenon as never)) {
            problems.push(`${label}: phenomenon ${String(testCase.phenomenon)} is not supported`);
        }
        if (!AI_REVIEW_EVAL_MODES.includes(testCase.mode as never)) {
            problems.push(`${label}: mode ${String(testCase.mode)} is not supported`);
        }
        if (!isNonEmptyString(testCase.question)) {
            problems.push(`${label}: no question`);
        }
        const responses = testCase.responses;
        if (!Array.isArray(responses) || responses.length < 2 || responses.length > 3) {
            problems.push(`${label}: needs 2-3 responses`);
        } else {
            for (const [position, response] of responses.entries()) {
                if (!isNonEmptyString(response?.content)) {
                    problems.push(`${label}: response[${position}] has no content`);
                }
                if (!isNonEmptyString(response?.modelId)) {
                    problems.push(`${label}: response[${position}] has no modelId`);
                }
            }
            // Labels, checked here as well as in the drafter's parser.
            //
            // A gold refers to an answer by its label and the drafting
            // assignment is stated in them, so a duplicate or an invented one
            // makes a case's own gold ambiguous. They also reach a regular
            // expression in `goldLeadLabels()`, which escapes them -- but a
            // label outside the allowed set is a defect in the case, not
            // something for a counter to cope with.
            const labels = responses.map((response) => response?.label);
            if (labels.some((value) => !isNonEmptyString(value))) {
                problems.push(`${label}: a response has no label`);
            } else {
                const unknown = labels.filter(
                    (value) => !AI_REVIEW_EVAL_RESPONSE_LABELS.includes(value as never)
                );
                if (unknown.length > 0) {
                    problems.push(
                        `${label}: response label(s) ${unknown
                            .map((value) => `"${String(value)}"`)
                            .join(", ")} are not among ` +
                            AI_REVIEW_EVAL_RESPONSE_LABELS.join(", ")
                    );
                }
                if (new Set(labels).size !== labels.length) {
                    problems.push(`${label}: two responses share a label`);
                }
            }
        }

        const gold = testCase.gold ?? {};
        const completeness = testCase.goldCompleteness ?? {};
        let goldItems = 0;
        for (const kind of AI_REVIEW_EVAL_FINDING_KINDS) {
            const items = gold[kind];
            if (items === undefined) continue;
            if (!Array.isArray(items)) {
                problems.push(`${label}: gold.${kind} is not an array`);
                continue;
            }
            goldItems += items.length;
            for (const item of items) {
                if (!isNonEmptyString(item?.id)) {
                    problems.push(`${label}: a gold.${kind} item has no id`);
                }
                if (!Array.isArray(item?.anyOf) || item.anyOf.length === 0) {
                    problems.push(`${label}: gold.${kind}.${item?.id} has no anyOf terms`);
                }
                if (!isNonEmptyString(item?.description)) {
                    problems.push(`${label}: gold.${kind}.${item?.id} has no description`);
                }
            }
            // The field is what stops an incomplete gold from being used as a
            // precision denominator, so leaving it unstated is a defect and
            // not a default: an unstated completeness would be read as
            // "false" and silently drop the case out of precision, which is
            // the same number arriving with no note that it shrank.
            if (typeof completeness[kind] !== "boolean") {
                problems.push(
                    `${label}: gold.${kind} exists but goldCompleteness.${kind} is not stated`
                );
            }
        }
        for (const kind of Object.keys(completeness)) {
            if (!AI_REVIEW_EVAL_FINDING_KINDS.includes(kind as never)) {
                problems.push(`${label}: goldCompleteness.${kind} is not a finding kind`);
            }
        }

        const negative =
            testCase.phenomenon === "genuine_consensus" ||
            testCase.phenomenon === "no_issue" ||
            testCase.phenomenon === "verbosity_bias" ||
            testCase.phenomenon === "position_bias";
        if (!negative && goldItems === 0 && testCase.phenomenon !== "prompt_injection") {
            problems.push(
                `${label}: a positive phenomenon with no gold item cannot be scored`
            );
        }
        if (testCase.phenomenon === "prompt_injection") {
            if (
                !Array.isArray(testCase.injectionMarkers) ||
                testCase.injectionMarkers.length === 0
            ) {
                problems.push(
                    `${label}: a prompt_injection case needs injectionMarkers, or nothing can detect compliance`
                );
            }
        }
    }
    problems.push(...adoptionProblems(dataset));

    return problems;
};

/**
 * The cases in a decision set that nobody has adopted.
 *
 * Separated from the rest of `datasetProblems()` because two questions are
 * being asked of the same file and they have different answers while a set is
 * being written:
 *
 *   * "may this stand as evidence?" -- no, and that is what every caller of
 *     `datasetProblems()` is asking, so the rule stays inside it;
 *   * "may this file exist in the tree?" -- yes. The set is filled by 330
 *     drafting calls and adopted by a person over weeks, and a rule that
 *     failed the repository's own gate for the whole of that time would make
 *     the work impossible to commit. The gate subtracts these problems while
 *     the set carries no freeze record at all, and reports them as a count.
 *
 * Freezing is the moment a set stops being under construction and becomes
 * evidence, so every evidence rule attaches there -- which is why the gate's
 * relaxation is keyed on the freeze record and not on a flag somebody passes.
 *
 * Adoption is the judgement -- "this really is a contradiction, and this list
 * is exhaustive" -- and a judgement made by the same kind of system under
 * evaluation is not evidence about it. The drafting tool writes
 * `status: "candidate"` with no adopter, and absence is read as candidate
 * rather than adopted, so a case that arrives without the field cannot slip
 * through.
 *
 * Development sets are exempt: they exist to iterate on the harness and are
 * never evidence, which is why `artifactAdmissibilityProblems()` refuses one
 * outright.
 */
export const adoptionProblems = (value: unknown): readonly string[] => {
    const dataset = value as Partial<AiReviewEvalDataset>;
    if (dataset?.purpose !== "decision" || !Array.isArray(dataset.cases)) return [];
    const problems: string[] = [];
    for (const raw of dataset.cases) {
        const testCase = raw as Partial<AiReviewEvalCase>;
        const label = isNonEmptyString(testCase.id) ? testCase.id : "a case";
        if (testCase.status !== "adopted") {
            problems.push(
                `${label}: status is ${String(testCase.status ?? "candidate")}; ` +
                    `a decision set holds only cases a person adopted`
            );
        } else if (!isNonEmptyString(testCase.adoptedBy)) {
            problems.push(`${label}: adopted, but nobody is named as the adopter`);
        }
    }
    return problems;
};

/**
 * Splits a set's problems into the ones that are defects and the ones that are
 * just where the set is in its life.
 *
 * A decision set is written over months -- 330 drafting calls, then a person
 * adopting each case -- and for all of that time every case is a candidate. So
 * "no adopter" is a defect once the set is evidence and a description of
 * ordinary progress before then, and the difference is the freeze record.
 *
 * Shared by the gate and the coverage report because they were not sharing it,
 * and the coverage report went on printing one validation problem per
 * unadopted case: 1,240 of them at the end of the build, in the block an
 * operator reads to see progress. Noise there is not cosmetic -- it teaches
 * the reader to skip the block where a real structural fault would appear.
 */
export const partitionDatasetProblems = (
    value: unknown
): { readonly blocking: readonly string[]; readonly buildState: readonly string[] } => {
    const all = datasetProblems(value);
    const dataset = value as Partial<AiReviewEvalDataset>;
    if (dataset?.purpose !== "decision" || !isUnfrozenDraft(dataset)) {
        return { blocking: all, buildState: [] };
    }
    const adoption = new Set(adoptionProblems(dataset));
    return {
        blocking: all.filter((problem) => !adoption.has(problem)),
        buildState: all.filter((problem) => adoption.has(problem)),
    };
};

/**
 * Whether a set carries no freeze record at all -- the "still being written"
 * state, as opposed to a freeze that is present but broken.
 *
 * A half-written freeze (a date with no digest, a digest with no name) is not
 * this state and must keep failing: it is a set that claims to be pinned and
 * is not, which is worse than one that never claimed to be.
 */
export const isUnfrozenDraft = (value: unknown): boolean => {
    const dataset = value as Partial<AiReviewEvalDataset>;
    return (
        !isNonEmptyString(dataset?.frozenAt) &&
        !isNonEmptyString(dataset?.frozenBy) &&
        !isNonEmptyString(dataset?.frozenDigest)
    );
};

/**
 * Whether the sample the file names is still the sample that was frozen.
 * Same shape as the router eval's `freezeDrift()`, for the same reason.
 */
export const freezeDrift = (dataset: AiReviewEvalDataset): string | null => {
    if (!(isNonEmptyString(dataset.frozenAt) && isNonEmptyString(dataset.frozenBy))) {
        return "the dataset carries no freeze record, so there is no moment its contents are pinned to";
    }
    if (!isNonEmptyString(dataset.frozenDigest)) {
        return (
            `the freeze record (${dataset.frozenAt}, ${dataset.frozenBy}) carries no digest, ` +
            `so nothing distinguishes the set that was frozen from the set as it stands now`
        );
    }
    const current = datasetDigest(dataset);
    if (dataset.frozenDigest !== current) {
        return (
            `the sample has changed since it was frozen at ${dataset.frozenAt}: ` +
            `frozen as ${dataset.frozenDigest}, now ${current}`
        );
    }
    return null;
};

// ---------------------------------------------------------------------------
// Run admission
// ---------------------------------------------------------------------------

export type AiReviewEvalRunMode =
    | { mode: "smoke" }
    | { mode: "live"; ceilingUsd: number }
    | {
          mode: "refused";
          reason:
              | "unknown_pair"
              | "pair_not_runnable"
              | "no_eval_budget"
              | "no_api_key"
              | "dataset_not_frozen"
              | "legacy_dataset_schema"
              | "unknown_commit"
              | "dirty_working_tree"
              | "missing_run_ordinal"
              | "duplicate_run_ordinal"
              | "run_cap_above_approved_ceiling";
      };

/**
 * Decides whether this invocation may call a provider.
 *
 * The two conditions that are not in the memory eval's version, and why:
 *
 *   * `runOrdinal`. §6 requires two INDEPENDENT decision runs. A harness that
 *     does not make the run say which one it is cannot tell two runs from one
 *     run reported twice, and "we ran it twice" is precisely the claim the
 *     approval rests on. A live run must name an ordinal, and an ordinal
 *     already present in the journal is refused rather than overwritten.
 *   * `workingTreeDirty`. The memory eval refuses an unknown commit; this
 *     also refuses a known commit with uncommitted changes, because the
 *     artifact would name a commit whose code is not the code that ran.
 */
export function decideAiReviewEvalRunMode(input: {
    live: boolean;
    registerEntry:
        | {
              status?: "candidate" | "approved" | "revoked";
              evalBudget: { maxUsd: number } | null;
          }
        | null
        | undefined;
    hasApiKey: boolean;
    datasetFrozen: boolean;
    datasetPurpose?: "development" | "decision";
    datasetSchemaVersion?: number | null;
    commitKnown: boolean;
    workingTreeDirty: boolean;
    runOrdinal?: number | null;
    usedRunOrdinals?: readonly number[];
    requestedRunCapUsd?: number | null;
}): AiReviewEvalRunMode {
    if (!input.live) return { mode: "smoke" };
    if (!input.registerEntry) return { mode: "refused", reason: "unknown_pair" };
    if (
        input.registerEntry.status !== undefined &&
        input.registerEntry.status !== "candidate" &&
        input.registerEntry.status !== "approved"
    ) {
        return { mode: "refused", reason: "pair_not_runnable" };
    }
    const budget = input.registerEntry.evalBudget;
    if (!budget) return { mode: "refused", reason: "no_eval_budget" };
    if (!input.hasApiKey) return { mode: "refused", reason: "no_api_key" };
    if (!input.datasetFrozen && input.datasetPurpose !== "development") {
        return { mode: "refused", reason: "dataset_not_frozen" };
    }
    if (input.datasetSchemaVersion !== AI_REVIEW_EVAL_DATASET_SCHEMA_VERSION) {
        return { mode: "refused", reason: "legacy_dataset_schema" };
    }
    if (!input.commitKnown) return { mode: "refused", reason: "unknown_commit" };
    if (input.workingTreeDirty) {
        return { mode: "refused", reason: "dirty_working_tree" };
    }
    if (!Number.isSafeInteger(input.runOrdinal) || (input.runOrdinal as number) < 1) {
        return { mode: "refused", reason: "missing_run_ordinal" };
    }
    if ((input.usedRunOrdinals ?? []).includes(input.runOrdinal as number)) {
        return { mode: "refused", reason: "duplicate_run_ordinal" };
    }
    const requested = input.requestedRunCapUsd;
    if (requested != null && requested > budget.maxUsd) {
        return { mode: "refused", reason: "run_cap_above_approved_ceiling" };
    }
    return {
        mode: "live",
        ceilingUsd: requested != null ? requested : budget.maxUsd,
    };
}

// ---------------------------------------------------------------------------
// Artifact admissibility
// ---------------------------------------------------------------------------

export type AiReviewEvalArtifactSummary = {
    decisionGrade?: boolean;
    datasetPurpose?: string;
    datasetVersion?: string;
    datasetDigest?: string;
    datasetSchemaVersion?: number;
    commitSha?: string;
    workingTreeDirty?: boolean;
    reviewerModelId?: string;
    promptVersion?: string;
    runOrdinal?: number;
    seed?: number;
    completedCases?: number;
    plannedCases?: number;
    sampleAdequate?: boolean;
    humanBlindReviewRef?: string | null;
    zeroToleranceViolations?: number;
    /** Set by the adjudication step, never by the run. */
    adjudicated?: boolean;
    blindReviewSignedBy?: string | null;
    blindReviewSignedAt?: string | null;
    blindReviewCasesJudged?: number;
};

/**
 * Why an artifact may not be cited as evidence.
 *
 * Deliberately strict about the difference between "the run finished" and
 * "the run answers the question": a partial run, a development dataset, a
 * dirty tree and a missing blind review each produce real numbers, and each
 * of those numbers means something narrower than an approval needs.
 */
export const artifactRunProblems = (
    artifact: AiReviewEvalArtifactSummary | null | undefined
): readonly string[] => {
    if (!artifact) return ["no artifact"];
    const problems: string[] = [];
    if (artifact.decisionGrade !== true) {
        problems.push("the artifact does not declare itself decision-grade");
    }
    if (artifact.datasetPurpose !== "decision") {
        problems.push(
            `dataset purpose is ${String(artifact.datasetPurpose)}; a development set cannot produce evidence`
        );
    }
    if (artifact.datasetSchemaVersion !== AI_REVIEW_EVAL_DATASET_SCHEMA_VERSION) {
        problems.push(
            `dataset schema ${String(artifact.datasetSchemaVersion)} != ${AI_REVIEW_EVAL_DATASET_SCHEMA_VERSION}`
        );
    }
    if (!isNonEmptyString(artifact.datasetDigest)) {
        problems.push("no dataset digest, so the sample cannot be identified");
    }
    if (!isNonEmptyString(artifact.commitSha) || artifact.commitSha === "unknown") {
        problems.push("no commit sha");
    }
    if (artifact.workingTreeDirty === true) {
        problems.push("the working tree was dirty, so the named commit is not the code that ran");
    }
    if (!Number.isSafeInteger(artifact.runOrdinal) || (artifact.runOrdinal ?? 0) < 1) {
        problems.push("no run ordinal");
    }
    if (
        !Number.isSafeInteger(artifact.completedCases) ||
        !Number.isSafeInteger(artifact.plannedCases) ||
        artifact.completedCases !== artifact.plannedCases
    ) {
        problems.push(
            `partial run: ${String(artifact.completedCases)} of ${String(artifact.plannedCases)} cases completed`
        );
    }
    if (artifact.sampleAdequate !== true) {
        problems.push("the sample was not adequate for the per-arm rules");
    }
    return problems;
};

/**
 * Why an artifact may not be cited as evidence.
 *
 * The run-level checks above, plus the ones that are only answerable after a
 * person has judged the blind sheet. Split from them because a run that has
 * just finished is not defective for lacking a review that happens afterwards
 * -- and reporting it as four failures, at the moment somebody is deciding
 * whether the run is worth reviewing at all, answers a question nobody asked.
 */
export const artifactAdmissibilityProblems = (
    artifact: AiReviewEvalArtifactSummary | null | undefined
): readonly string[] => {
    if (!artifact) return ["no artifact"];
    const problems: string[] = [...artifactRunProblems(artifact)];
    if (!isNonEmptyString(artifact.humanBlindReviewRef)) {
        problems.push(
            "no blind human review reference; the human-judged zero-tolerance rules were not evaluated"
        );
    }
    // A run scored without a person's verdicts carries only what a term list
    // could screen. Two of the five rules have no mechanical form at all, so
    // an un-adjudicated artifact reporting zero violations is reporting zero
    // for rules nothing looked at.
    //
    // This function is pure and cannot open the record it names, so it asks
    // for the flag the adjudication step sets; the check script opens the file
    // and re-validates it row by row.
    if (artifact.adjudicated !== true) {
        problems.push(
            "not adjudicated: the blind review's verdicts were never folded in, so the " +
                "violation count is only what a term list screened"
        );
    }
    if (!isNonEmptyString(artifact.blindReviewSignedBy)) {
        problems.push("the blind review is unsigned");
    }
    return problems;
};
