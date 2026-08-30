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
        metrics: {
            contradictionRecallWilsonLower: number;
            contradictionPrecisionWilsonLower: number;
            omissionRecallWilsonLower: number;
            omissionPrecisionWilsonLower: number;
            falseConsensusRateWilsonUpper: number;
            exactQuoteMatchRateWilsonLower: number;
        };
        zeroToleranceViolations: number;
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
    if (evaluation.zeroToleranceViolations !== 0) {
        problems.push(
            `${evaluation.zeroToleranceViolations} zero-tolerance violation(s) recorded`
        );
    }
    if (!evaluation.approver) problems.push("no approver");
    if (!evaluation.expiresAt) problems.push("no re-evaluation deadline");
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
