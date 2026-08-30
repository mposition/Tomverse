/**
 * The AI Review M5 scorecard, as pure aggregation.
 *
 * docs/policy/ai-review-m5-quality-contract.md §8.
 *
 * One core, two surfaces: the CLI report and (when it is built) the admin
 * screen both call these functions, so the two cannot quote different numbers
 * for the same window. The functions take rows and return metrics; nothing
 * here reads a database, a clock it was not given, or an environment
 * variable.
 *
 * Three rules the type system enforces rather than the prose:
 *
 *   * **Every metric carries its own denominator.** A rate without one is a
 *     number nobody can argue with, which is the opposite of what a scorecard
 *     is for.
 *   * **Too little data is `insufficient_evidence`, never 0 and never M5.**
 *     A denominator below the metric's floor produces a null value and a
 *     status that says so. A zero would read as a measured failure and a
 *     rounded-up rate as a measured success; both would be inventions.
 *   * **Reliability and adoption are computed from different sources and are
 *     never mixed.** Reliability comes from `ComparisonReviewRun`, written by
 *     the server on the path that calls the model. Adoption comes from
 *     `ProductAnalyticsEvent`, which is consented client telemetry. Folding
 *     them into one score would make a consent decision look like an outage.
 */

export type ScorecardStatus = "ok" | "insufficient_evidence";

export type ScorecardMetric = {
    /** null whenever the status is not "ok". */
    value: number | null;
    numerator: number;
    denominator: number;
    /** What the denominator counts, in one clause, for the screen. */
    denominatorLabel: string;
    /** Rows deliberately left out of the denominator, and why. */
    excluded?: string;
    minimumDenominator: number;
    status: ScorecardStatus;
};

export const metric = (
    numerator: number,
    denominator: number,
    denominatorLabel: string,
    options: { minimumDenominator?: number; excluded?: string } = {}
): ScorecardMetric => {
    const minimumDenominator = options.minimumDenominator ?? 1;
    const enough = denominator >= minimumDenominator && denominator > 0;
    return {
        value: enough ? numerator / denominator : null,
        numerator,
        denominator,
        denominatorLabel,
        excluded: options.excluded,
        minimumDenominator,
        status: enough ? "ok" : "insufficient_evidence",
    };
};

// ---------------------------------------------------------------------------
// Reliability -- from ComparisonReviewRun
// ---------------------------------------------------------------------------

export type ScorecardRunRow = {
    outcome: string;
    durationMs: number;
    dualReviewRequested: boolean;
    dualReviewAvailable: boolean;
    dualReviewCompleted: boolean;
    primaryModelId: string | null;
    primaryProvider: string | null;
    primaryStatus: string;
    primaryRetryCount: number;
    primaryReservedCredits: number;
    primarySettlementStatus: string | null;
    secondaryModelId: string | null;
    secondaryProvider: string | null;
    secondaryStatus: string;
    secondaryRetryCount: number;
    secondaryReservedCredits: number;
    secondarySettlementStatus: string | null;
    subjectKind: string;
    createdAt: Date;
};

/**
 * The percentile of a duration sample.
 *
 * Nearest-rank, not interpolated. With the sample sizes this feature has, an
 * interpolated p95 invents a duration no run had; the nearest rank is always
 * a real observation.
 */
export const percentile = (
    values: readonly number[],
    fraction: number
): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const rank = Math.max(
        1,
        Math.min(sorted.length, Math.ceil(fraction * sorted.length))
    );
    return sorted[rank - 1];
};

export type ReviewerHealthRow = {
    reviewerModelId: string;
    provider: string | null;
    attempts: number;
    failures: number;
    failureRate: ScorecardMetric;
};

export type ReliabilityScorecard = {
    windowDays: number;
    runs: number;
    /** Runs that actually started a provider call, the denominator most rates use. */
    providerRuns: number;
    byOutcome: Readonly<Record<string, number>>;
    completionRate: ScorecardMetric;
    primaryOnlyRate: ScorecardMetric;
    dualAvailabilityRate: ScorecardMetric;
    dualCompletionRate: ScorecardMetric;
    cachedRate: ScorecardMetric;
    retryRate: ScorecardMetric;
    /**
     * Attempts whose reservation has no recorded settlement outcome. Not a
     * proof of a lost credit -- the settlement call is fire-and-forget and its
     * own failure is already logged -- but the only number that would move if
     * reservations stopped being settled, which is why it is on the card.
     */
    unreconciledSettlements: ScorecardMetric;
    p50DurationMs: number | null;
    p95DurationMs: number | null;
    reviewerHealth: readonly ReviewerHealthRow[];
    guestRuns: number;
    accountRuns: number;
};

const REACHED_PROVIDER_STATUSES = new Set(["completed", "failed"]);

export const summariseReliability = (
    rows: readonly ScorecardRunRow[],
    windowDays: number,
    minimums: { rate?: number } = {}
): ReliabilityScorecard => {
    const minimumDenominator = minimums.rate ?? 20;
    const byOutcome: Record<string, number> = {};
    for (const row of rows) {
        byOutcome[row.outcome] = (byOutcome[row.outcome] ?? 0) + 1;
    }

    // A run that never reached a provider says nothing about whether the
    // feature works, so it is out of the completion denominator -- and named
    // on the screen as excluded rather than silently dropped.
    const providerRows = rows.filter(
        (row) =>
            REACHED_PROVIDER_STATUSES.has(row.primaryStatus) ||
            REACHED_PROVIDER_STATUSES.has(row.secondaryStatus)
    );
    const completed = providerRows.filter(
        (row) =>
            row.outcome === "completed_dual" ||
            row.outcome === "completed_primary_only"
    );

    const durations = completed.map((row) => row.durationMs);

    const health = new Map<string, { provider: string | null; attempts: number; failures: number }>();
    const noteAttempt = (
        modelId: string | null,
        provider: string | null,
        status: string
    ) => {
        if (!modelId || !REACHED_PROVIDER_STATUSES.has(status)) return;
        const entry = health.get(modelId) ?? { provider, attempts: 0, failures: 0 };
        entry.attempts += 1;
        if (status === "failed") entry.failures += 1;
        health.set(modelId, entry);
    };
    for (const row of rows) {
        noteAttempt(row.primaryModelId, row.primaryProvider, row.primaryStatus);
        noteAttempt(row.secondaryModelId, row.secondaryProvider, row.secondaryStatus);
    }

    const settledAttempts = rows.flatMap((row) =>
        [
            { status: row.primaryStatus, settlement: row.primarySettlementStatus },
            { status: row.secondaryStatus, settlement: row.secondarySettlementStatus },
        ].filter((attempt) => attempt.status === "completed")
    );

    const retryingAttempts = rows.flatMap((row) =>
        [
            { status: row.primaryStatus, retries: row.primaryRetryCount },
            { status: row.secondaryStatus, retries: row.secondaryRetryCount },
        ].filter((attempt) => REACHED_PROVIDER_STATUSES.has(attempt.status))
    );

    return {
        windowDays,
        runs: rows.length,
        providerRuns: providerRows.length,
        byOutcome,
        completionRate: metric(
            completed.length,
            providerRows.length,
            "runs that reached a provider",
            {
                minimumDenominator,
                excluded:
                    "cache hits and refusals before any provider call; neither says whether a reviewer worked",
            }
        ),
        primaryOnlyRate: metric(
            completed.filter((row) => row.outcome === "completed_primary_only").length,
            completed.length,
            "completed runs",
            { minimumDenominator }
        ),
        dualAvailabilityRate: metric(
            rows.filter((row) => row.dualReviewAvailable).length,
            rows.filter((row) => row.dualReviewRequested).length,
            "runs that asked for a second reviewer",
            { minimumDenominator }
        ),
        dualCompletionRate: metric(
            rows.filter((row) => row.dualReviewCompleted).length,
            rows.filter((row) => row.dualReviewAvailable).length,
            "runs where a second reviewer was available",
            { minimumDenominator }
        ),
        cachedRate: metric(rows.filter((row) => row.outcome === "cached").length, rows.length, "all runs", {
            minimumDenominator,
        }),
        retryRate: metric(
            retryingAttempts.filter((attempt) => attempt.retries > 0).length,
            retryingAttempts.length,
            "reviewer attempts that reached a provider",
            { minimumDenominator }
        ),
        unreconciledSettlements: metric(
            settledAttempts.filter((attempt) => !attempt.settlement).length,
            settledAttempts.length,
            "completed reviewer attempts",
            { minimumDenominator }
        ),
        p50DurationMs: percentile(durations, 0.5),
        p95DurationMs: percentile(durations, 0.95),
        reviewerHealth: [...health.entries()]
            .map(([reviewerModelId, entry]) => ({
                reviewerModelId,
                provider: entry.provider,
                attempts: entry.attempts,
                failures: entry.failures,
                failureRate: metric(
                    entry.failures,
                    entry.attempts,
                    "attempts that reached this model",
                    { minimumDenominator }
                ),
            }))
            .sort((left, right) => left.reviewerModelId.localeCompare(right.reviewerModelId)),
        guestRuns: rows.filter((row) => row.subjectKind === "guest").length,
        accountRuns: rows.filter((row) => row.subjectKind === "account").length,
    };
};

/**
 * How far the server's own record and the client funnel disagree.
 *
 * Not a defect on its own -- a client event needs analytics consent and a
 * browser that stayed open, so the two were never going to match -- but a gap
 * that moves is the only signal that one of the two instruments has stopped
 * working. Reported as a comparison, never folded into a reliability rate.
 */
export const telemetryCoverage = (
    serverRuns: number,
    clientStartedEvents: number
): { serverRuns: number; clientStartedEvents: number; ratio: ScorecardMetric } => ({
    serverRuns,
    clientStartedEvents,
    ratio: metric(
        clientStartedEvents,
        serverRuns,
        "server-recorded runs",
        {
            minimumDenominator: 20,
            excluded:
                "nothing; a ratio far from 1 means one of the two instruments is missing runs, not that a run failed",
        }
    ),
});

// ---------------------------------------------------------------------------
// Adoption and value -- from ProductAnalyticsEvent
// ---------------------------------------------------------------------------

export type ScorecardEventRow = {
    eventName: string;
    actorKey: string;
    occurredAt: Date;
};

export type AdoptionScorecard = {
    windowDays: number;
    weeklyActiveReviewUsers: number;
    comparisonToReview: ScorecardMetric;
    reviewToFollowUp: ScorecardMetric;
    reviewToSaveOrShare: ScorecardMetric;
    reviewToItemWebCheck: ScorecardMetric;
    firstToSecondReview: ScorecardMetric;
    returnDay1: ScorecardMetric;
    returnDay7: ScorecardMetric;
    returnDay30: ScorecardMetric;
    /**
     * The comparison-only cohort against the AI Review cohort, on the same
     * return metric. Presented side by side and never as a causal claim: the
     * two cohorts self-selected, so a difference is a difference in who used
     * the feature as much as in what it did for them.
     */
    cohortReturnDay7: {
        comparisonOnly: ScorecardMetric;
        aiReview: ScorecardMetric;
    };
};

const actorsWith = (
    rows: readonly ScorecardEventRow[],
    eventNames: readonly string[]
) => {
    const names = new Set(eventNames);
    const actors = new Set<string>();
    for (const row of rows) if (names.has(row.eventName)) actors.add(row.actorKey);
    return actors;
};

const intersectionSize = (left: ReadonlySet<string>, right: ReadonlySet<string>) => {
    let count = 0;
    for (const value of left) if (right.has(value)) count += 1;
    return count;
};

export const summariseAdoption = (
    rows: readonly ScorecardEventRow[],
    windowDays: number,
    options: { now: Date; minimumDenominator?: number }
): AdoptionScorecard => {
    const minimumDenominator = options.minimumDenominator ?? 20;

    const compared = actorsWith(rows, ["multi_model_compare_completed"]);
    const reviewStarted = actorsWith(rows, ["comparison_review_started"]);
    const reviewCompleted = actorsWith(rows, ["comparison_review_completed"]);
    const followUp = actorsWith(rows, ["followup_sent"]);
    const savedOrShared = actorsWith(rows, ["conversation_saved", "share_created"]);
    const itemChecked = actorsWith(rows, ["comparison_review_item_verified"]);
    const returned1 = actorsWith(rows, ["return_day_1"]);
    const returned7 = actorsWith(rows, ["return_day_7"]);
    const returned30 = actorsWith(rows, ["return_day_30"]);

    const weekAgo = new Date(options.now.getTime() - 7 * 86_400_000);
    const weeklyActive = new Set(
        rows
            .filter(
                (row) =>
                    row.occurredAt >= weekAgo &&
                    (row.eventName === "comparison_review_started" ||
                        row.eventName === "comparison_review_completed")
            )
            .map((row) => row.actorKey)
    );

    // "Second review" is counted from completions, not starts: a user who
    // started twice and finished once did not come back to a result.
    const completionCounts = new Map<string, number>();
    for (const row of rows) {
        if (row.eventName !== "comparison_review_completed") continue;
        completionCounts.set(row.actorKey, (completionCounts.get(row.actorKey) ?? 0) + 1);
    }
    const secondReviewActors = [...completionCounts.values()].filter(
        (count) => count >= 2
    ).length;

    const comparisonOnly = new Set(
        [...compared].filter((actor) => !reviewStarted.has(actor))
    );

    return {
        windowDays,
        weeklyActiveReviewUsers: weeklyActive.size,
        comparisonToReview: metric(
            intersectionSize(compared, reviewStarted),
            compared.size,
            "users who completed a multi-model comparison",
            { minimumDenominator }
        ),
        reviewToFollowUp: metric(
            intersectionSize(reviewCompleted, followUp),
            reviewCompleted.size,
            "users who completed an AI Review",
            { minimumDenominator }
        ),
        reviewToSaveOrShare: metric(
            intersectionSize(reviewCompleted, savedOrShared),
            reviewCompleted.size,
            "users who completed an AI Review",
            { minimumDenominator }
        ),
        reviewToItemWebCheck: metric(
            intersectionSize(reviewCompleted, itemChecked),
            reviewCompleted.size,
            "users who completed an AI Review",
            { minimumDenominator }
        ),
        firstToSecondReview: metric(
            secondReviewActors,
            completionCounts.size,
            "users who completed at least one AI Review",
            { minimumDenominator }
        ),
        returnDay1: metric(
            intersectionSize(reviewCompleted, returned1),
            reviewCompleted.size,
            "users who completed an AI Review",
            { minimumDenominator }
        ),
        returnDay7: metric(
            intersectionSize(reviewCompleted, returned7),
            reviewCompleted.size,
            "users who completed an AI Review",
            { minimumDenominator }
        ),
        returnDay30: metric(
            intersectionSize(reviewCompleted, returned30),
            reviewCompleted.size,
            "users who completed an AI Review",
            { minimumDenominator }
        ),
        cohortReturnDay7: {
            comparisonOnly: metric(
                intersectionSize(comparisonOnly, returned7),
                comparisonOnly.size,
                "users who compared but never opened AI Review",
                { minimumDenominator }
            ),
            aiReview: metric(
                intersectionSize(reviewCompleted, returned7),
                reviewCompleted.size,
                "users who completed an AI Review",
                { minimumDenominator }
            ),
        },
    };
};

// ---------------------------------------------------------------------------
// The readiness verdict
// ---------------------------------------------------------------------------

export const AI_REVIEW_M5_READINESS_ITEMS = [
    "decision_grade_eval_harness",
    "versioned_eval_dataset",
    "scored_and_tested_evaluator",
    "paid_run_budget_contract",
    "server_run_telemetry",
    "shared_scorecard_core",
    "item_feedback_loop",
    "cached_review_compatibility",
    "documented_rollback",
    "reviewer_pair_drift_detection",
] as const;
export type AiReviewM5ReadinessItem =
    (typeof AI_REVIEW_M5_READINESS_ITEMS)[number];

export const AI_REVIEW_M5_ELIGIBILITY_ITEMS = [
    "two_independent_decision_runs",
    "human_blind_review_signed",
    "production_pair_matches_approved_pair",
    "reliability_trend_over_approved_period",
    "sufficient_production_sample",
    "zero_credit_reconciliation_mismatch",
    "zero_critical_quality_violations",
    "adoption_and_repeat_use_thresholds_met",
    "rollback_drill_completed",
    "human_m5_promotion_signature",
] as const;
export type AiReviewM5EligibilityItem =
    (typeof AI_REVIEW_M5_ELIGIBILITY_ITEMS)[number];

export type ReadinessCheck = {
    item: string;
    met: boolean;
    /** Why, in a sentence, whichever way it went. */
    detail: string;
};

export type M5Verdict = {
    readinessComplete: boolean;
    eligible: boolean;
    readiness: readonly ReadinessCheck[];
    eligibility: readonly ReadinessCheck[];
};

/**
 * The two states, judged separately and never collapsed.
 *
 * `readinessComplete` is decidable from the repository: the tools exist, are
 * tested, and refuse the things they must refuse. `eligible` is not, and this
 * function will not derive it from readiness -- it takes the eligibility
 * checks as given and requires every one, so an eligibility claim can only
 * come from evidence somebody supplied.
 */
export const judgeM5 = (
    readiness: readonly ReadinessCheck[],
    eligibility: readonly ReadinessCheck[]
): M5Verdict => ({
    readinessComplete: readiness.length > 0 && readiness.every((check) => check.met),
    eligible: eligibility.length > 0 && eligibility.every((check) => check.met),
    readiness,
    eligibility,
});
