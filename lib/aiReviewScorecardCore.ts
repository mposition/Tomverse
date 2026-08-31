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

import { settlementReconciliation } from "@/lib/comparisonReviewRunCore";

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

/**
 * One provider attempt, as the scorecard reads it.
 *
 * Reviewer health, the retry rate and the reconciliation counts are all
 * computed from these and not from the run row's two slots. The slots name the
 * reviewer that produced each result, so a run where the first candidate
 * failed and the second succeeded shows only the success there -- which made
 * every reviewer look healthier than it was.
 */
export type ScorecardAttemptRow = {
    reviewerModelId: string;
    reviewerProvider: string;
    status: string;
    retryCount: number;
    reservedCredits: number;
    settledCredits: number | null;
    settlementStatus: string | null;
};

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
    /** The process that wrote the row, and its own attempt counter. */
    writerId: string;
    writerSequence: number;
    attempts: readonly ScorecardAttemptRow[];
};

/**
 * How many telemetry writes were attempted, and how many landed.
 *
 * ## The question no query over the table can answer on its own
 *
 * Every rate on this scorecard is computed from rows that exist. If some
 * inserts fail and others do not, the surviving rows are a biased sample of a
 * healthy-looking subset, and nothing about them says how many are missing.
 * That was the state this replaces: the telemetry module's own comment
 * promised a `missingTraceRate` and the repository contained the name nowhere
 * else.
 *
 * Each writer stamps a sequence that increments on every ATTEMPTED write. So
 * within one writer, the span from its lowest to its highest sequence is how
 * many writes it tried, and the rows present are how many landed.
 *
 * ## What it cannot see, stated rather than implied
 *
 *   * Writes lost at the end of a process's life have no later row to anchor
 *     them, so the span stops at the last row that landed.
 *   * A process whose every write failed leaves no rows at all and therefore
 *     no writer to count.
 *   * A window boundary cuts a writer's sequence, so the first and last rows
 *     inside the window are the anchors, not the process's true first and
 *     last.
 *
 * All three make this a LOWER bound on what went missing, and the second case
 * is not a corner: a writer whose every write failed is INVISIBLE. Eighty
 * writes that landed from one process and twenty that were all lost from
 * another report as `attempted 80, landed 80, missing 0` -- a fifth of the
 * window gone and the arithmetic clean.
 *
 * So this detects loss; it does not measure completeness, and nothing may
 * approve completeness from it. A count above zero is proof of a gap and a
 * reason to refuse; a count of zero is not evidence there was none. Measuring
 * completeness needs an attempted total from outside this table -- the
 * `comparison_review_run` log line is emitted for every run BEFORE the write,
 * so counting those over the window is the independent total, and
 * `summariseReliability` computes `traceCompleteness` only when it is given
 * one.
 *
 * Rows written before the writer columns existed carry an empty writer id and
 * are excluded -- counting them as one enormous writer would invent a span of
 * every row ever written.
 */
export const telemetryCompleteness = (
    rows: readonly Pick<ScorecardRunRow, "writerId" | "writerSequence">[]
): { attempted: number; landed: number; missing: number; writers: number } => {
    const spans = new Map<string, { min: number; max: number; count: number }>();
    for (const row of rows) {
        if (!row.writerId) continue;
        if (!Number.isSafeInteger(row.writerSequence) || row.writerSequence < 1) {
            continue;
        }
        const span = spans.get(row.writerId);
        if (!span) {
            spans.set(row.writerId, {
                min: row.writerSequence,
                max: row.writerSequence,
                count: 1,
            });
            continue;
        }
        span.min = Math.min(span.min, row.writerSequence);
        span.max = Math.max(span.max, row.writerSequence);
        span.count += 1;
    }
    let attempted = 0;
    let landed = 0;
    for (const span of spans.values()) {
        attempted += span.max - span.min + 1;
        landed += span.count;
    }
    return { attempted, landed, missing: attempted - landed, writers: spans.size };
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
    /**
     * Attempts the service itself retried.
     *
     * A LOWER bound on provider requests retried: the SDK call runs with
     * maxRetries: 1, and a request it retried and won returns as an ordinary
     * success with nothing to count. Making this exact would mean taking the
     * SDK's retry away and doing it here, which would also take away its
     * backoff -- an immediate re-request on a 429 is worse behaviour than an
     * unmeasured one, so the number is labelled rather than the behaviour
     * changed.
     */
    retryRate: ScorecardMetric;
    /**
     * Provider-reached attempts that held credits and have no figure at all --
     * neither a settlement nor a refund reported one.
     *
     * Not proof of a lost credit on its own, but the number that moves when
     * reservations stop being resolved. The population is deliberately not
     * "completed attempts": a failed attempt's refund can fail too, and while
     * this asked only about completions those reservations were invisible.
     */
    unreconciledSettlements: ScorecardMetric;
    /**
     * Credits resolved in the wrong direction, over both halves of the
     * lifecycle: a completed attempt charged MORE than it reserved, or a
     * failed attempt that was not fully refunded.
     *
     * Settling below a reservation is normal -- the unused part is released.
     * Settling above it, or charging anything at all for a failure, means a
     * user is out credits nothing entitles the app to. This is the metric the
     * `zero_credit_reconciliation_mismatch` eligibility item reads.
     */
    creditReconciliation: ScorecardMetric;
    /** The completed half of `creditReconciliation`, on its own denominator. */
    overSettledRate: ScorecardMetric;
    /** The failed half: refunds that reported a figure above zero. */
    unrefundedFailureRate: ScorecardMetric;
    /**
     * Writes this window is missing that the sequence arithmetic can SEE.
     *
     * A count, deliberately not a rate. A rate invites being read as "the
     * window is 99% complete", and this number cannot support that: a writer
     * whose every write failed leaves no rows, so it leaves no span, so it is
     * invisible here. Eighty landed writes from one process and twenty lost
     * ones from another produce `missing: 0`.
     *
     * So: above zero is proof of loss and a reason to refuse. Zero is not
     * evidence of completeness, and nothing may approve completeness from it.
     */
    detectedTraceGaps: {
        missing: number;
        /** Writes accounted for inside the spans that were visible. */
        withinSpans: number;
        writers: number;
    };
    /**
     * Actual completeness, against an attempted total counted OUTSIDE this
     * table.
     *
     * `null` when no such total was supplied, and null is the honest answer
     * rather than a zero: completeness is unknown until something that is not
     * the surviving rows says how many writes there should have been. The
     * `comparison_review_run` log line is emitted for every run before its
     * write, so the log platform's count over the window is that total.
     */
    traceCompleteness: ScorecardMetric | null;
    /** Who attested the attempted total. Null when none was supplied. */
    traceCompletenessSource: string | null;
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
    minimums: { rate?: number } = {},
    /**
     * How many writes were attempted, counted somewhere other than this table.
     *
     * Without it `traceCompleteness` is null and stays null: the gap
     * arithmetic cannot supply it, because a writer whose every write failed
     * leaves nothing to count. The `comparison_review_run` log line is emitted
     * for every run before the write, so the log platform's count over the
     * same window is the independent total.
     */
    evidence: {
        attemptedWrites?: number | null;
        attemptedWritesSource?: string | null;
    } = {}
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

    // Everything below reads the ATTEMPT rows, never the run's two slots. The
    // slots hold whoever produced each result, so a fallback -- first reviewer
    // fails, second succeeds -- recorded only the success there, and every
    // reviewer's failure rate came out better than production was.
    const attempts = rows.flatMap((row) => row.attempts);
    const dispatched = attempts.filter((attempt) =>
        REACHED_PROVIDER_STATUSES.has(attempt.status)
    );

    const health = new Map<
        string,
        { provider: string | null; attempts: number; failures: number }
    >();
    for (const attempt of dispatched) {
        const entry = health.get(attempt.reviewerModelId) ?? {
            provider: attempt.reviewerProvider,
            attempts: 0,
            failures: 0,
        };
        entry.attempts += 1;
        if (attempt.status === "failed") entry.failures += 1;
        health.set(attempt.reviewerModelId, entry);
    }

    // Reconciliation is computed by the run core, not here. Two modules
    // deriving the same figure is how the CLI report and a screen come to
    // quote different numbers, and the population rule below is subtle enough
    // that a second copy of it would drift.
    const reconciliation = settlementReconciliation(attempts);
    const completeness = telemetryCompleteness(rows);
    const completedWithFigure = attempts.filter(
        (attempt) =>
            attempt.status === "completed" &&
            attempt.reservedCredits > 0 &&
            attempt.settledCredits !== null
    );
    const failedWithFigure = attempts.filter(
        (attempt) =>
            attempt.status === "failed" &&
            attempt.reservedCredits > 0 &&
            attempt.settledCredits !== null
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
        // Counts the SERVICE's own retry loop only. The SDK call underneath it
        // runs with maxRetries: 1, and a request the SDK retried successfully
        // returns as a first-try success, so `retryCount` never sees it. The
        // rate is therefore a lower bound on provider requests retried, and
        // says so rather than being read as the whole picture.
        retryRate: metric(
            dispatched.filter((attempt) => attempt.retryCount > 0).length,
            dispatched.length,
            "reviewer attempts that reached a provider",
            {
                minimumDenominator,
                excluded:
                    "retries the provider SDK made and won on its own; those return as a first-try success, so this is a lower bound on requests retried",
            }
        ),
        // Both halves of the reservation lifecycle, over every attempt that
        // reached a provider holding credits. Asking only about completions
        // let a failed refund -- credits still held, nobody releasing them --
        // report as a clean window.
        unreconciledSettlements: metric(
            reconciliation.unreported,
            reconciliation.held,
            "reviewer attempts that reached a provider holding credits",
            {
                minimumDenominator,
                excluded:
                    "attempts that reserved nothing; there is no reservation to reconcile",
            }
        ),
        creditReconciliation: metric(
            reconciliation.mismatched,
            reconciliation.reported,
            "attempts with a settled or refunded figure",
            {
                minimumDenominator,
                excluded:
                    "attempts whose settlement did not report; those are counted by unreconciledSettlements instead",
            }
        ),
        // The two mismatches split out, because they call for different
        // investigations: one is a pricing or settlement bug, the other is a
        // refund that did not happen.
        overSettledRate: metric(
            reconciliation.overSettled,
            completedWithFigure.length,
            "completed attempts with a settled figure",
            { minimumDenominator }
        ),
        unrefundedFailureRate: metric(
            reconciliation.unrefunded,
            failedWithFigure.length,
            "failed attempts with a refund figure",
            {
                minimumDenominator,
                excluded:
                    "failed attempts whose refund did not report; those are counted by unreconciledSettlements instead",
            }
        ),
        detectedTraceGaps: {
            missing: completeness.missing,
            withinSpans: completeness.attempted,
            writers: completeness.writers,
        },
        traceCompleteness:
            typeof evidence.attemptedWrites === "number" &&
            evidence.attemptedWrites > 0
                ? metric(
                      Math.max(0, evidence.attemptedWrites - rows.length),
                      evidence.attemptedWrites,
                      "telemetry writes attempted, counted outside this table",
                      {
                          minimumDenominator,
                          excluded:
                              `attested by: ${evidence.attemptedWritesSource ?? "an unnamed source"}`,
                      }
                  )
                : null,
        traceCompletenessSource: evidence.attemptedWritesSource ?? null,
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
    /**
     * `return_day_N` among AI Review users.
     *
     * Named for what it is. The event fires on the day the ACCOUNT turns N
     * days old, not N days after a review, so this answers "how many AI Review
     * users were also around on their own day N" -- it is not review-anchored
     * retention and must never be labelled as such. It is kept because it is
     * comparable with the product-wide funnel, which uses the same events.
     */
    accountAgeReturnDay1: ScorecardMetric;
    accountAgeReturnDay7: ScorecardMetric;
    accountAgeReturnDay30: ScorecardMetric;
    /**
     * Came back at least N days after their FIRST AI Review.
     *
     * Anchored on the review, which is the question the value case actually
     * asks. Computed from any later event by the same actor, so it is a floor:
     * a user who returned but generated no analytics event that day is not
     * counted.
     *
     * The denominator is the cohort whose N-day window has CLOSED. A user who
     * reviewed yesterday has not had a thirtieth day, and counting them scored
     * them as a non-return -- twenty such users reported `0 / 20, status ok`,
     * a confident zero about a question nobody had waited long enough to ask.
     */
    reviewAnchoredReturnDay1: ScorecardMetric;
    reviewAnchoredReturnDay7: ScorecardMetric;
    reviewAnchoredReturnDay30: ScorecardMetric;
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

/**
 * Actors who generated any event at least `days` after their first review.
 *
 * A floor, not a rate: a user who came back and did something analytics does
 * not record is invisible here. Stated on the card rather than left for a
 * reader to assume.
 */
/**
 * Came back at least `days` after their first AI Review.
 *
 * ## Why the denominator is not everyone who reviewed
 *
 * It was, and that made the D30 figure meaningless. A user whose first review
 * was yesterday cannot have returned thirty days later yet -- there has not
 * been a thirtieth day. Counting them in the denominator scores them as "did
 * not return", so twenty users who each reviewed once, yesterday, produced
 * `0 / 20, status ok`: a confident zero about a question nobody had waited
 * long enough to ask.
 *
 * The population is therefore the cohort whose window has actually closed:
 * first review at least `days` before `observedThrough`. That shrinks the
 * denominator, and a shrunken denominator below the metric's floor reports
 * `insufficient_evidence` -- which is the correct answer for a feature that is
 * three weeks old and being asked about day 30.
 */
const reviewAnchoredReturn = (
    rows: readonly ScorecardEventRow[],
    days: number,
    observedThrough: Date
): { returned: number; population: number } => {
    const firstReview = firstOccurrence(rows, ["comparison_review_completed"]);
    const window = days * 86_400_000;
    const observable = new Map<string, Date>();
    for (const [actorKey, anchor] of firstReview) {
        if (observedThrough.getTime() - anchor.getTime() >= window) {
            observable.set(actorKey, anchor);
        }
    }
    const returned = new Set<string>();
    for (const row of rows) {
        const anchor = observable.get(row.actorKey);
        if (!anchor) continue;
        if (row.occurredAt.getTime() - anchor.getTime() >= window) {
            returned.add(row.actorKey);
        }
    }
    return { returned: returned.size, population: observable.size };
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

/** The earliest time each actor did one of these things, if they did. */
const firstOccurrence = (
    rows: readonly ScorecardEventRow[],
    eventNames: readonly string[]
) => {
    const names = new Set(eventNames);
    const earliest = new Map<string, Date>();
    for (const row of rows) {
        if (!names.has(row.eventName)) continue;
        const current = earliest.get(row.actorKey);
        if (!current || row.occurredAt < current) {
            earliest.set(row.actorKey, row.occurredAt);
        }
    }
    return earliest;
};

/**
 * Actors who did the second thing AFTER they did the first.
 *
 * The whole point, and the defect it replaces: a conversion used to be "this
 * actor has both events somewhere in the window". A user who sent a follow-up
 * in the morning and opened their first AI Review that afternoon counted as
 * "AI Review led to a follow-up". So did one whose follow-up was in an
 * entirely different conversation. Neither is a conversion, and a rate built
 * from them says nothing about whether the feature caused anything.
 *
 * Ordering is the strongest claim this event stream can support. It is still
 * not causation -- the events carry no conversation id, so a follow-up after a
 * review may belong to another thread -- and the scorecard says so rather than
 * implying otherwise.
 */
export const sequencedConversion = (
    rows: readonly ScorecardEventRow[],
    fromEvents: readonly string[],
    toEvents: readonly string[]
): { converted: number; population: number } => {
    const from = firstOccurrence(rows, fromEvents);
    const toNames = new Set(toEvents);
    const converted = new Set<string>();
    for (const row of rows) {
        if (!toNames.has(row.eventName)) continue;
        const anchor = from.get(row.actorKey);
        if (anchor && row.occurredAt > anchor) converted.add(row.actorKey);
    }
    return { converted: converted.size, population: from.size };
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

    // Every conversion below is ORDERED: the second event has to follow the
    // first. Counting any actor who has both somewhere in the window credited
    // a morning follow-up to an afternoon review.
    const toFollowUp = sequencedConversion(
        rows,
        ["comparison_review_completed"],
        ["followup_sent"]
    );
    const toSaveOrShare = sequencedConversion(
        rows,
        ["comparison_review_completed"],
        ["conversation_saved", "share_created"]
    );
    const toItemCheck = sequencedConversion(
        rows,
        ["comparison_review_completed"],
        ["comparison_review_item_verified"]
    );
    const comparisonToReviewSeq = sequencedConversion(
        rows,
        ["multi_model_compare_completed"],
        ["comparison_review_started"]
    );
    const anchored1 = reviewAnchoredReturn(rows, 1, options.now);
    const anchored7 = reviewAnchoredReturn(rows, 7, options.now);
    const anchored30 = reviewAnchoredReturn(rows, 30, options.now);

    const orderedNote =
        "ordered: the second event must follow the first. Still not causation -- " +
        "these events carry no conversation id, so a later action may belong to another thread";

    return {
        windowDays,
        weeklyActiveReviewUsers: weeklyActive.size,
        comparisonToReview: metric(
            comparisonToReviewSeq.converted,
            comparisonToReviewSeq.population,
            "users who completed a multi-model comparison",
            { minimumDenominator, excluded: orderedNote }
        ),
        reviewToFollowUp: metric(
            toFollowUp.converted,
            toFollowUp.population,
            "users who completed an AI Review",
            { minimumDenominator, excluded: orderedNote }
        ),
        reviewToSaveOrShare: metric(
            toSaveOrShare.converted,
            toSaveOrShare.population,
            "users who completed an AI Review",
            { minimumDenominator, excluded: orderedNote }
        ),
        reviewToItemWebCheck: metric(
            toItemCheck.converted,
            toItemCheck.population,
            "users who completed an AI Review",
            { minimumDenominator, excluded: orderedNote }
        ),
        firstToSecondReview: metric(
            secondReviewActors,
            completionCounts.size,
            "users who completed at least one AI Review",
            { minimumDenominator }
        ),
        accountAgeReturnDay1: metric(
            intersectionSize(reviewCompleted, returned1),
            reviewCompleted.size,
            "users who completed an AI Review",
            {
                minimumDenominator,
                excluded:
                    "anchored on ACCOUNT age, not on the review; this is not review retention",
            }
        ),
        accountAgeReturnDay7: metric(
            intersectionSize(reviewCompleted, returned7),
            reviewCompleted.size,
            "users who completed an AI Review",
            {
                minimumDenominator,
                excluded:
                    "anchored on ACCOUNT age, not on the review; this is not review retention",
            }
        ),
        accountAgeReturnDay30: metric(
            intersectionSize(reviewCompleted, returned30),
            reviewCompleted.size,
            "users who completed an AI Review",
            {
                minimumDenominator,
                excluded:
                    "anchored on ACCOUNT age, not on the review; this is not review retention",
            }
        ),
        reviewAnchoredReturnDay1: metric(
            anchored1.returned,
            anchored1.population,
            "users whose first AI Review was at least 1 day(s) ago",
            {
                minimumDenominator,
                excluded:
                    "users whose 1-day window has not closed yet; they cannot have returned on day 1 and counting them would score them as a non-return. Also a floor: a silent return is not counted",
            }
        ),
        reviewAnchoredReturnDay7: metric(
            anchored7.returned,
            anchored7.population,
            "users whose first AI Review was at least 7 day(s) ago",
            {
                minimumDenominator,
                excluded:
                    "users whose 7-day window has not closed yet; they cannot have returned on day 7 and counting them would score them as a non-return. Also a floor: a silent return is not counted",
            }
        ),
        reviewAnchoredReturnDay30: metric(
            anchored30.returned,
            anchored30.population,
            "users whose first AI Review was at least 30 day(s) ago",
            {
                minimumDenominator,
                excluded:
                    "users whose 30-day window has not closed yet; they cannot have returned on day 30 and counting them would score them as a non-return. Also a floor: a silent return is not counted",
            }
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

/**
 * The tools exist and are wired together.
 *
 * Split out from readiness because conflating them is what produced a
 * `readiness complete: YES` on a repository whose only evaluation sample was
 * 24 development cases. "The instrument is built" and "the instrument has been
 * calibrated and pointed at something" are different claims, and the first one
 * is worth reporting -- just not under the second one's name.
 */
export const AI_REVIEW_M5_SCAFFOLDING_ITEMS = [
    "decision_grade_eval_harness",
    "scored_and_verified_evaluator",
    "paid_run_budget_contract",
    "server_run_telemetry",
    "shared_scorecard_core",
    "item_feedback_loop",
    "cached_review_compatibility",
    "documented_rollback",
    "reviewer_pair_drift_detection",
] as const;
export type AiReviewM5ScaffoldingItem =
    (typeof AI_REVIEW_M5_SCAFFOLDING_ITEMS)[number];

/**
 * What has to be true before a decision-grade evaluation can even be run and
 * believed. Every item here is decidable from the repository, and none of them
 * is satisfied by a file existing.
 */
export const AI_REVIEW_M5_READINESS_ITEMS = [
    /** A decision dataset that is valid, frozen, and meets the sample floors. */
    "frozen_adequate_decision_dataset",
    /** Thresholds a person has signed, so an approval has a bar to clear. */
    "approved_quality_thresholds",
    /** Every zero-tolerance rule has a detection path, screened or human. */
    "complete_zero_tolerance_coverage",
    /** Every provider attempt is recorded, so a fallback cannot hide a failure. */
    "per_attempt_reliability_record",
    /** Reservation and settlement are both recorded, so mismatch is computable. */
    "credit_reconciliation_measurable",
    /**
     * A telemetry write that did not land is countable, and a completeness
     * figure can be computed when an attempted total is supplied.
     *
     * Two halves, because detection alone is not completeness. The sequence
     * arithmetic finds writes missing between rows that landed; it cannot see
     * a writer whose every write failed, since that leaves no rows to find a
     * gap in. So the instrument must also accept an attempted total counted
     * outside the table, and eligibility -- not this list -- is where an
     * actual total gets judged.
     */
    "telemetry_loss_detection",
    /** Conversions are ordered in time, so a rate means what it says. */
    "sequenced_conversion_metrics",
    /** There is somewhere for production evidence to be recorded. */
    "promotion_evidence_structure",
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
    /**
     * The window being judged is not missing rows.
     *
     * Separate from the readiness item above: being able to measure the gap
     * and having measured it to be within an approved bound are different
     * facts, and only the second one licenses a promotion.
     */
    "telemetry_complete_over_approved_window",
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
    scaffoldingComplete: boolean;
    readinessComplete: boolean;
    eligible: boolean;
    scaffolding: readonly ReadinessCheck[];
    readiness: readonly ReadinessCheck[];
    eligibility: readonly ReadinessCheck[];
};

/**
 * The three states, judged separately and never collapsed.
 *
 * None implies another, and this function will not derive one from another --
 * it takes three lists and requires every item of each. Scaffolding says the
 * instrument is built; readiness says it is calibrated and has something to
 * measure; eligibility says it was pointed at production and a person signed
 * the result.
 *
 * The middle state exists because it was missing: a report that called a built
 * harness "readiness complete" said the loudest possible thing about a
 * repository whose only sample was 24 development cases.
 */
export const judgeM5 = (
    scaffolding: readonly ReadinessCheck[],
    readiness: readonly ReadinessCheck[],
    eligibility: readonly ReadinessCheck[]
): M5Verdict => ({
    scaffoldingComplete:
        scaffolding.length > 0 && scaffolding.every((check) => check.met),
    readinessComplete: readiness.length > 0 && readiness.every((check) => check.met),
    eligible: eligibility.length > 0 && eligibility.every((check) => check.met),
    scaffolding,
    readiness,
    eligibility,
});
