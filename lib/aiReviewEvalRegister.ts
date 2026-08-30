/**
 * Code register of AI Review reviewer pairs (reviewer model + prompt version)
 * and their evaluation evidence.
 *
 * docs/policy/ai-review-m5-quality-contract.md §3.
 *
 * The register is code for the same reason the memory-extraction one is
 * (lib/memoryExtractionEvalRegister.ts): commit history is the audit record,
 * and a check in the PR gate refuses an `approved` entry whose evidence is
 * incomplete. An implementation agent may add `candidate` entries; moving one
 * to `approved` is the human procedure in §6 and is never automatic.
 *
 * A pair here is deliberately (reviewerModelId, promptVersion) and not the
 * *panel*. AI Review runs a primary and, when one is available, a second
 * independent reviewer; the panel that results depends on which keys are
 * configured and which models are runtime-available at that moment, so it is
 * not a stable thing to approve. What is stable is "this model, running this
 * prompt version, produces reviews of measured quality" -- and the scorecard
 * separately reports whether the pairs production is actually serving are the
 * approved ones (`registerDrift` below).
 */

import {
    findThresholdSet,
    thresholdShortfalls,
    type AiReviewApprovalArmMetrics,
    type AiReviewApprovalMetrics,
} from "@/lib/aiReviewQualityThresholds";

export const AI_REVIEW_EVAL_REGISTER_MIN_INDEPENDENT_RUNS = 2;

export type AiReviewEvalEntry = {
    reviewerModelId: string;
    promptVersion: string;
    /** candidate → approved is human-only; revoked entries stay for audit. */
    status: "candidate" | "approved" | "revoked";
    owner: string;
    registeredAt: string;
    notes?: string;
    /**
     * §5: human-approved budget for paid evaluation runs. Required before the
     * harness will call a provider for anything beyond smoke mode.
     */
    evalBudget: {
        approvedBy: string;
        maxUsd: number;
        ticket: string;
        approvedAt: string;
    } | null;
    /**
     * §3.2 evidence. Required and complete on an approved entry; null while
     * the pair is a candidate.
     *
     * `runOrdinals` carries the two independent decision runs by ordinal, so
     * an approval resting on one run re-reported twice is visible as a single
     * ordinal rather than hidden inside a prose claim.
     */
    evaluation: {
        artifactRefs: readonly string[];
        runOrdinals: readonly number[];
        evaluatedCommit: string;
        datasetVersion: string;
        datasetSchemaVersion: number;
        datasetDigest: string;
        languages: readonly string[];
        sampleCounts: Readonly<Record<string, number>>;
        /**
         * Which threshold set the approval was granted under.
         *
         * Named rather than implied, so lowering a bar later cannot silently
         * re-bless an approval that was granted against the old one.
         */
        thresholdVersion: string;
        metrics: AiReviewApprovalMetrics;
        /**
         * Per-arm numbers, recorded because the aggregate is exactly what
         * hides a collapsed arm. The language gap rule and the task-type
         * shortfall rule are computed from these and cannot be checked
         * without them.
         */
        byLanguage: readonly AiReviewApprovalArmMetrics[];
        byTaskType: readonly AiReviewApprovalArmMetrics[];
        zeroToleranceViolations: number;
        /**
         * How many of the five zero-tolerance rules a person actually judged.
         * A run screens three by term list; an approval that examined only
         * those has not examined the other two, and the count says so rather
         * than letting a total of zero imply all five came back clean.
         */
        zeroToleranceRulesHumanJudged: number;
        /** The blind human review that produced the human-judged verdicts. */
        blindReviewRef: string;
        approver: string;
        approvedAt: string;
        expiresAt: string;
        knownLimitations: string;
    } | null;
};

/**
 * No pair is approved. This is the honest state on the day the harness
 * landed: the dataset is a development set, no decision run has been funded,
 * and no person has reviewed a blind sheet. An empty-looking register is the
 * point -- it is what makes `M5 eligible` fail loudly instead of quietly.
 */
export const AI_REVIEW_EVAL_REGISTER: readonly AiReviewEvalEntry[] = [
    {
        reviewerModelId: "mistral-medium-3-1",
        promptVersion: "comparison-review-v3",
        status: "candidate",
        owner: "mposition",
        registeredAt: "2026-08-30",
        notes:
            "First candidate in COMPARISON_REVIEW_DEFAULT_MODEL_IDS and therefore " +
            "the primary reviewer in most production runs today. Registered as a " +
            "candidate so the drift report has something to compare production " +
            "against; no evaluation has been run.",
        evalBudget: null,
        evaluation: null,
    },
    {
        reviewerModelId: "claude-sonnet-5",
        promptVersion: "comparison-review-v3",
        status: "candidate",
        owner: "mposition",
        registeredAt: "2026-08-30",
        notes:
            "Second candidate, and therefore the usual secondary reviewer. A " +
            "secondary reviewer's quality is not a lesser question: its findings " +
            "are shown to the user in their own tab.",
        evalBudget: null,
        evaluation: null,
    },
    {
        reviewerModelId: "qwen3.7-plus",
        promptVersion: "comparison-review-v3",
        status: "candidate",
        owner: "mposition",
        registeredAt: "2026-08-30",
        notes:
            "Third candidate. Reached only when one of the first two is " +
            "unavailable, which is exactly when nobody is watching.",
        evalBudget: null,
        evaluation: null,
    },
];

export const findAiReviewEvalEntry = (
    reviewerModelId: string,
    promptVersion: string
) =>
    AI_REVIEW_EVAL_REGISTER.find(
        (entry) =>
            entry.reviewerModelId === reviewerModelId &&
            entry.promptVersion === promptVersion
    ) ?? null;

export const approvedAiReviewPairs = () =>
    AI_REVIEW_EVAL_REGISTER.filter((entry) => entry.status === "approved");

/**
 * What is wrong with an entry that claims to be approved.
 *
 * Returned as a list of problems rather than a boolean so the gate can say
 * which requirement is missing. Kept pure: the PR-gate script and the
 * scorecard both call it, and neither may reach a different conclusion.
 */
export const approvedEntryProblems = (
    entry: AiReviewEvalEntry
): readonly string[] => {
    if (entry.status !== "approved") return [];
    const problems: string[] = [];
    const evaluation = entry.evaluation;
    if (!evaluation) {
        return ["approved without any evaluation evidence"];
    }
    if (evaluation.artifactRefs.length === 0) {
        problems.push("no evaluation artifact reference");
    }
    const ordinals = new Set(evaluation.runOrdinals);
    if (ordinals.size < AI_REVIEW_EVAL_REGISTER_MIN_INDEPENDENT_RUNS) {
        problems.push(
            `${ordinals.size} distinct run ordinal(s); ` +
                `${AI_REVIEW_EVAL_REGISTER_MIN_INDEPENDENT_RUNS} independent runs are required`
        );
    }
    if (!evaluation.evaluatedCommit || evaluation.evaluatedCommit === "unknown") {
        problems.push("the evaluated commit is not named");
    }
    if (!evaluation.datasetDigest.startsWith("sha256:")) {
        problems.push("the dataset digest is missing or not a sha256 digest");
    }
    if (!evaluation.blindReviewRef) {
        problems.push(
            "no blind human review reference; the human-judged zero-tolerance " +
                "rules cannot have been evaluated"
        );
    }
    if (!evaluation.approver) problems.push("no approver");
    if (!evaluation.expiresAt) problems.push("no re-evaluation deadline");

    // Every zero-tolerance rule has to have been looked at by a person, not
    // just screened. The blind sheet asks about all five; an approval that
    // records fewer has a total of zero standing for rules nobody examined.
    if (evaluation.zeroToleranceRulesHumanJudged < 5) {
        problems.push(
            `${evaluation.zeroToleranceRulesHumanJudged} of 5 zero-tolerance rules were ` +
                `judged by a person; a screened rule is not an examined one`
        );
    }

    // The numbers themselves. Until this existed, an approval that named an
    // artifact, a commit and two ordinals was accepted whatever it measured --
    // "the metrics are present" is not "the metrics are sufficient".
    const thresholds = findThresholdSet(evaluation.thresholdVersion);
    if (!thresholds) {
        problems.push(
            `threshold set "${evaluation.thresholdVersion}" does not exist`
        );
    } else if (!thresholds.approvedBy) {
        // An unapproved set is a proposal. An approval may not rest on one,
        // which is why no pair can be approved today.
        problems.push(
            `threshold set "${thresholds.version}" is a proposal and has no approver; ` +
                `a quality approval cannot rest on an unapproved bar`
        );
    } else {
        problems.push(
            ...thresholdShortfalls({
                thresholds,
                aggregate: evaluation.metrics,
                byLanguage: evaluation.byLanguage,
                byTaskType: evaluation.byTaskType,
                zeroToleranceViolations: evaluation.zeroToleranceViolations,
            })
        );
    }
    return problems;
};

/**
 * Whether the reviewer pairs production would actually serve match what the
 * register approved.
 *
 * `servedPairs` comes from the live catalogue and the running prompt version,
 * never from this file, which is the whole point: a register that described
 * itself would never report drift.
 */
export type AiReviewRegisterDrift = {
    approvedPairs: readonly string[];
    servedPairs: readonly string[];
    servedButNotApproved: readonly string[];
    approvedButNotServed: readonly string[];
    inSync: boolean;
};

const pairKey = (reviewerModelId: string, promptVersion: string) =>
    `${reviewerModelId}@${promptVersion}`;

export const registerDrift = (
    served: readonly { reviewerModelId: string; promptVersion: string }[]
): AiReviewRegisterDrift => {
    const approved = approvedAiReviewPairs().map((entry) =>
        pairKey(entry.reviewerModelId, entry.promptVersion)
    );
    const servedKeys = [
        ...new Set(
            served.map((pair) => pairKey(pair.reviewerModelId, pair.promptVersion))
        ),
    ].sort();
    const servedButNotApproved = servedKeys.filter(
        (key) => !approved.includes(key)
    );
    const approvedButNotServed = approved.filter(
        (key) => !servedKeys.includes(key)
    );
    return {
        approvedPairs: approved,
        servedPairs: servedKeys,
        servedButNotApproved,
        approvedButNotServed,
        inSync:
            servedButNotApproved.length === 0 && approvedButNotServed.length === 0,
    };
};

// ---------------------------------------------------------------------------
// Promotion evidence
// ---------------------------------------------------------------------------

/**
 * The evidence M5 promotion rests on that no evaluation run can supply.
 *
 * This block exists because the readiness report used to hard-code `false` for
 * the production half of the checklist. That was honest about today and
 * useless tomorrow: no amount of accumulated evidence could ever have moved
 * those items, so the report could never say YES no matter what happened. The
 * fields below are where that evidence lands, and every one of them is written
 * by a person.
 *
 * `null` throughout is the current, correct state.
 */
export type AiReviewObservationPolicy = {
    approvedBy: string;
    approvedAt: string;
    /** How long production reliability must hold before promotion. */
    minObservationDays: number;
    /** How many recorded runs the trend must rest on. */
    minRecordedRuns: number;
    /** Minimum completion rate over the observation window. */
    minCompletionRate: number;
    /** Minimum comparison→review conversion. */
    minComparisonToReviewRate: number;
    /** Minimum first→second review conversion. */
    minRepeatUseRate: number;
    rationale: string;
};

export type AiReviewRollbackDrill = {
    performedBy: string;
    performedAt: string;
    /** What was actually exercised, not what the runbook says. */
    scenarios: readonly string[];
    recordRef: string;
};

export type AiReviewPromotionSignature = {
    signedBy: string;
    signedAt: string;
    /** The reviewer pair the signature covers. */
    reviewerModelId: string;
    promptVersion: string;
    notes: string;
};

export type AiReviewM5Promotion = {
    observationPolicy: AiReviewObservationPolicy | null;
    rollbackDrill: AiReviewRollbackDrill | null;
    promotionSignature: AiReviewPromotionSignature | null;
};

export const AI_REVIEW_M5_PROMOTION: AiReviewM5Promotion = {
    // Not "we forgot": the thresholds a production observation is judged
    // against have to be set after somebody has seen the baseline, and there
    // is no baseline yet.
    observationPolicy: null,
    // Writing docs/ops/ai-review-rollback.md is not performing the drill.
    rollbackDrill: null,
    promotionSignature: null,
};
