/**
 * The content-free operational record of one AI Review run.
 *
 * docs/policy/ai-review-m5-quality-contract.md §7.
 *
 * Why this is not the analytics funnel. `comparison_review_started` and
 * `comparison_review_completed` are client events: they say what a browser
 * reported, which is the right instrument for a product funnel and the wrong
 * one for reliability. A browser that closed mid-run reports nothing, an ad
 * blocker reports nothing, and a guest run that reached the provider and
 * failed there is indistinguishable from one that was never attempted. Every
 * number in the reliability half of the M5 scorecard is therefore taken from
 * here -- written by the server, on the path that actually calls the model.
 *
 * Why it is not `ComparisonReview` either. That table holds the *result*, for
 * signed-in users only, and only when a review succeeded. It has nothing to
 * say about a guest run, a failed run, a refusal, or a cache hit -- which is
 * most of what reliability is about.
 *
 * The record is content-free by construction, not by convention: every field
 * below is an identifier, a closed enum, a count or a timestamp. There is no
 * field a question, an answer, a review sentence, a quote or a filename could
 * be written into, and `contentFreeViolations()` is the test that keeps it
 * that way.
 */

export const COMPARISON_REVIEW_RUN_OUTCOMES = [
    /** Both reviewers produced a verified result. */
    "completed_dual",
    /** The primary produced one; no second reviewer was available or it failed. */
    "completed_primary_only",
    /** Every reviewer attempt failed after reaching a provider. */
    "failed",
    /**
     * Refused before any provider was called -- no reviewer configured, out of
     * credits, over a limit, payload too large. Distinct from `failed` because
     * it says nothing about reviewer health and must not appear in a
     * provider-failure rate.
     */
    "refused_before_provider",
    /** Served from a stored `ComparisonReview` row; no provider was called. */
    "cached",
] as const;
export type ComparisonReviewRunOutcome =
    (typeof COMPARISON_REVIEW_RUN_OUTCOMES)[number];

export const COMPARISON_REVIEW_ATTEMPT_STATUSES = [
    "not_attempted",
    "completed",
    "failed",
    /** A local refusal (credits, limits, context window). Nothing was sent. */
    "refused",
] as const;
export type ComparisonReviewAttemptStatus =
    (typeof COMPARISON_REVIEW_ATTEMPT_STATUSES)[number];

export type ComparisonReviewAttemptRecord = {
    reviewerModelId: string | null;
    reviewerProvider: string | null;
    status: ComparisonReviewAttemptStatus;
    durationMs: number | null;
    /** A closed error code, never a provider message. */
    errorCode: string | null;
    errorCategory: string | null;
    inputTokens: number;
    outputTokens: number;
    /** Credits the reservation held before the call. */
    reservedCredits: number;
    /**
     * What settlement actually charged.
     *
     * Null means settlement did not run or did not report, which is NOT the
     * same as 0. `settlementStatus` alone cannot answer "did the reservation
     * and the settlement agree": "settled" says credits were taken, not how
     * many, so a reservation of 8 settling at 3 and one settling at 8 read
     * identically -- and reconciliation is exactly that comparison.
     */
    settledCredits: number | null;
    /** What settlement did with them: settled, refunded, or unknown. */
    settlementStatus: string | null;
    retryCount: number;
};

export const emptyAttemptRecord = (): ComparisonReviewAttemptRecord => ({
    reviewerModelId: null,
    reviewerProvider: null,
    status: "not_attempted",
    durationMs: null,
    errorCode: null,
    errorCategory: null,
    inputTokens: 0,
    outputTokens: 0,
    reservedCredits: 0,
    settledCredits: null,
    settlementStatus: null,
    retryCount: 0,
});

/**
 * One attempt as it is stored: the record plus where it sat in the run.
 *
 * A run keeps ALL of these, not two. The run row's primary/secondary slots say
 * which reviewer produced the result the user saw; this list says what
 * actually happened. A run where the first candidate failed and the second
 * succeeded has one primary and two attempts, and collapsing the two questions
 * is what let a fallback hide the failure that preceded it.
 */
export type ComparisonReviewAttemptEntry = ComparisonReviewAttemptRecord & {
    /** 1-based order tried, across the whole run. */
    ordinal: number;
    slot: "primary" | "secondary";
};

/**
 * Attempts that actually dispatched, which is the only population a reviewer
 * failure rate may be computed over. A local refusal sent nothing and says
 * nothing about the model.
 */
export const dispatchedAttempts = (
    attempts: readonly ComparisonReviewAttemptEntry[]
) =>
    attempts.filter(
        (attempt) => attempt.status === "completed" || attempt.status === "failed"
    );

/**
 * How the credits an attempt held were resolved.
 *
 * ## Why the population is every attempt that held credits, not the completed ones
 *
 * The first version of this asked the question only of `completed` attempts,
 * on the reasoning that settlement is what a completed call does. That left
 * the other half of the reservation lifecycle unmeasured. A reviewer that
 * fails after reserving still has to give the credits back, and that refund
 * can fail on its own -- the service records the outcome of BOTH calls, and a
 * refund that threw is written down as `settledCredits: null` exactly as an
 * unreported settlement is.
 *
 * So a window with twenty clean completions and five failures whose refunds
 * never reported read as `unreported 0 / 20, status ok`: five reservations
 * were still holding a user's credits and the operational record said the
 * reconciliation was clean. That is the shape `zero_credit_reconciliation_mismatch`
 * exists to refuse, and it would have passed.
 *
 * The population is therefore every attempt that reached a provider AND held
 * credits, and the two halves are judged by different rules:
 *
 *   * a completed attempt may settle anywhere from 0 up to what it reserved --
 *     settling BELOW is normal, since the unused part is released. Settling
 *     ABOVE means more was charged than was ever held.
 *   * a failed attempt was refunded, so its settled figure must be 0. Anything
 *     above that is a user charged for a review they did not get.
 *
 * An attempt that reserved nothing is outside all of this: there is no
 * reservation to reconcile, so counting it would only dilute the rate.
 */
export type ComparisonReviewSettlementReconciliation = {
    /** Attempts that reached a provider holding credits. The denominator. */
    held: number;
    /** Of those, the ones settlement or refund reported a figure for. */
    reported: number;
    /** Of those, the ones neither reported -- "we do not know". */
    unreported: number;
    /** Completed attempts charged more than they reserved. */
    overSettled: number;
    /** Failed attempts that were not fully refunded. */
    unrefunded: number;
    /** overSettled + unrefunded. Both are credits owed in the wrong direction. */
    mismatched: number;
};

/**
 * The four fields reconciliation reads, and nothing else.
 *
 * Stated structurally so the scorecard can pass its own narrower row type in
 * rather than casting. A cast here would be the seam where the two modules
 * quietly stop agreeing about what an attempt is.
 */
export type SettleableAttempt = {
    status: string;
    reservedCredits: number;
    settledCredits: number | null;
};

/** Attempts that reached a provider and held credits: the whole population. */
export const heldCreditAttempts = <T extends SettleableAttempt>(
    attempts: readonly T[]
): readonly T[] =>
    attempts.filter(
        (attempt) =>
            (attempt.status === "completed" || attempt.status === "failed") &&
            attempt.reservedCredits > 0
    );

export const settlementReconciliation = (
    attempts: readonly SettleableAttempt[]
): ComparisonReviewSettlementReconciliation => {
    const held = heldCreditAttempts(attempts);
    const reported = held.filter((attempt) => attempt.settledCredits !== null);
    const overSettled = reported.filter(
        (attempt) =>
            attempt.status === "completed" &&
            (attempt.settledCredits as number) > attempt.reservedCredits
    ).length;
    const unrefunded = reported.filter(
        (attempt) =>
            attempt.status === "failed" && (attempt.settledCredits as number) > 0
    ).length;
    return {
        held: held.length,
        reported: reported.length,
        unreported: held.length - reported.length,
        overSettled,
        unrefunded,
        mismatched: overSettled + unrefunded,
    };
};

export type ComparisonReviewRunRecord = {
    traceId: string;
    /** "guest" or "account". Guests are the majority of first AI Review runs. */
    subjectKind: "guest" | "account";
    /**
     * The caller's own subject key, exactly as the chat limit decisions record
     * it. Not the user's content and not derived from it; anonymised on
     * account deletion by the same registry rule.
     */
    subjectKey: string;
    userId: string | null;
    conversationId: string | null;
    reviewMode: string;
    language: string;
    responseCount: number;
    promptVersion: string;
    outcome: ComparisonReviewRunOutcome;
    /** The run's own terminal code, when it has one. */
    errorCode: string | null;
    startedAt: Date;
    completedAt: Date;
    durationMs: number;
    dualReviewRequested: boolean;
    /** Whether a second distinct reviewer candidate existed at all. */
    dualReviewAvailable: boolean;
    dualReviewCompleted: boolean;
    /**
     * Whether the two reviewers ran at different providers.
     *
     * Recorded because "two independent reviewers" is only as independent as
     * the providers behind them, and the candidate loop picks the next
     * candidate by model id -- a configuration with two models at one provider
     * would still produce a "dual" review. Nothing in the product claims
     * different providers today; this is what would make such a claim
     * checkable rather than assumed.
     */
    crossProvider: boolean | null;
    /** The reviewer that produced the primary result, not the first tried. */
    primary: ComparisonReviewAttemptRecord;
    secondary: ComparisonReviewAttemptRecord;
    /** Every attempt, in the order they were tried. */
    attempts: readonly ComparisonReviewAttemptEntry[];
    groundingTotalQuotes: number;
    groundingMatchedQuotes: number;
    /** The stored bucket, or null when nothing was quoted. */
    sourceGroundingLevel: string | null;
};

export type ComparisonReviewRunInput = Omit<
    ComparisonReviewRunRecord,
    "durationMs" | "dualReviewCompleted" | "crossProvider"
> & { durationMs?: number };

/**
 * Builds the record from what a run observed.
 *
 * Derived rather than passed for three fields, so a caller cannot report a
 * dual review that did not happen:
 *
 *   * `durationMs` from the two timestamps;
 *   * `dualReviewCompleted` from the secondary attempt's own status;
 *   * `crossProvider` from the two providers, and null when there is no
 *     second attempt to compare.
 */
export const buildComparisonReviewRunRecord = (
    input: ComparisonReviewRunInput
): ComparisonReviewRunRecord => {
    const durationMs =
        input.durationMs ??
        Math.max(0, input.completedAt.getTime() - input.startedAt.getTime());
    const dualReviewCompleted = input.secondary.status === "completed";
    const crossProvider =
        input.primary.reviewerProvider && input.secondary.reviewerProvider
            ? input.primary.reviewerProvider !== input.secondary.reviewerProvider
            : null;
    return {
        ...input,
        durationMs,
        dualReviewCompleted,
        crossProvider,
    };
};

/**
 * Any place a piece of user content ended up in a record.
 *
 * The guarantee this module makes is structural -- there is no free-text
 * field -- but "structural" has to be enforced by something, or the next
 * field added for a good reason quietly becomes the one that carries a
 * question. Every string in the record is compared against the run's actual
 * content; a non-empty result is a defect, not a warning.
 */
export const contentFreeViolations = (
    record: ComparisonReviewRunRecord,
    forbidden: readonly string[]
): readonly string[] => {
    const violations: string[] = [];
    const needles = forbidden
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length >= 8);

    const walk = (value: unknown, path: string) => {
        if (typeof value === "string") {
            const haystack = value.toLowerCase();
            for (const needle of needles) {
                if (haystack.includes(needle)) {
                    violations.push(`${path} contains user content`);
                    return;
                }
            }
            return;
        }
        if (value && typeof value === "object" && !(value instanceof Date)) {
            for (const [key, child] of Object.entries(value)) {
                walk(child, `${path}.${key}`);
            }
        }
    };

    walk(record, "record");
    return violations;
};

/**
 * The outcome of a run, from what its two attempts did.
 *
 * Pure and here rather than inline in the service, because the distinction it
 * makes is a contract and not a detail: a run where every candidate refused
 * locally -- out of credits, over a limit, longer than the context window --
 * never sent anything, so it says nothing about reviewer health and must not
 * land in a provider-failure rate. `failed` and `refused_before_provider` are
 * different outcomes precisely so that case is visible as itself.
 */
export const comparisonReviewRunOutcome = (input: {
    primaryCompleted: boolean;
    secondaryCompleted: boolean;
    /** True once any attempt actually dispatched to a provider. */
    reachedProvider: boolean;
}): ComparisonReviewRunOutcome => {
    if (input.primaryCompleted) {
        return input.secondaryCompleted
            ? "completed_dual"
            : "completed_primary_only";
    }
    return input.reachedProvider ? "failed" : "refused_before_provider";
};

/** Whether a run reached a provider at all, for the failure-rate denominator. */
export const reachedProvider = (record: ComparisonReviewRunRecord) =>
    record.primary.status === "completed" ||
    record.primary.status === "failed" ||
    record.secondary.status === "completed" ||
    record.secondary.status === "failed";
