import "server-only";

import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { isMissingDatabaseSchemaError } from "@/lib/databaseError";
import {
    buildComparisonReviewRunRecord,
    emptyAttemptRecord,
    type ComparisonReviewAttemptEntry,
    type ComparisonReviewAttemptRecord,
    type ComparisonReviewRunInput,
    type ComparisonReviewRunOutcome,
    type ComparisonReviewRunRecord,
} from "@/lib/comparisonReviewRunCore";

/**
 * Writes the content-free operational record of an AI Review run.
 *
 * docs/policy/ai-review-m5-quality-contract.md §7.
 *
 * Two properties this module has to hold at once, and they pull in opposite
 * directions:
 *
 *   * a failure to record must never cost the user a review that actually
 *     succeeded -- so nothing here throws, and every call is awaited only for
 *     its own error handling;
 *   * a missing record must not be invisible -- so every failure emits a
 *     structured log line AND leaves a countable hole in the table. A
 *     telemetry gap that nothing reports is worse than no telemetry, because
 *     the numbers still look complete.
 *
 * ## How a missing row is counted
 *
 * The second property was, for a while, only half true. The failure log line
 * existed; the rate the comment promised did not, and could not -- the
 * scorecard reads rows that landed, and no query over the rows that landed can
 * count the ones that did not. A partial outage, inserts failing for some runs
 * and succeeding for others, left every rate looking healthy.
 *
 * So each write carries the identity of the process that made it and a
 * sequence number that increments on every ATTEMPT, landed or not. Within one
 * writer the highest sequence minus the lowest, plus one, is how many writes
 * were tried; the number of rows present is how many landed; the difference is
 * the gap. `telemetryCompleteness()` in lib/aiReviewScorecardCore.ts does that
 * arithmetic and the scorecard reports it as `missingTraceRate`.
 *
 * Two things this cannot see, and the metric says so rather than implying
 * otherwise: writes lost at the very end of a process's life, which have no
 * later row to anchor them, and a process every one of whose writes failed,
 * which leaves no rows and therefore no writer. The rate is a lower bound.
 */

/**
 * Identity of this process, for the sequence above. A fresh random value per
 * process, never derived from a host, a user or a deployment: it exists to
 * scope a counter and nothing else, and a writer id that meant something would
 * be a new identifier in a table whose whole contract is that it holds none.
 */
const WRITER_ID = randomUUID();
let writerSequence = 0;

const RETENTION_DAYS = 90;

let didWarnAboutMissingTable = false;

export const recordComparisonReviewRun = async (
    input: ComparisonReviewRunInput
): Promise<ComparisonReviewRunRecord> => {
    const record = buildComparisonReviewRunRecord(input);

    // Emitted before the write, and for every run. Log search is the second
    // copy: if the table is missing or the insert fails, the run is still
    // observable, and the gap between the two is what makes a silent
    // telemetry outage detectable at all.
    // Claimed before the write, so a failed insert consumes a number and
    // leaves the hole this exists to make visible.
    writerSequence += 1;
    const sequence = writerSequence;

    const logLine = {
        event: "comparison_review_run",
        traceId: record.traceId,
        writerId: WRITER_ID,
        writerSequence: sequence,
        subjectKind: record.subjectKind,
        outcome: record.outcome,
        errorCode: record.errorCode,
        reviewMode: record.reviewMode,
        language: record.language,
        responseCount: record.responseCount,
        promptVersion: record.promptVersion,
        durationMs: record.durationMs,
        dualReviewRequested: record.dualReviewRequested,
        dualReviewAvailable: record.dualReviewAvailable,
        dualReviewCompleted: record.dualReviewCompleted,
        crossProvider: record.crossProvider,
        primary: record.primary,
        secondary: record.secondary,
        attempts: record.attempts,
        groundingTotalQuotes: record.groundingTotalQuotes,
        groundingMatchedQuotes: record.groundingMatchedQuotes,
        sourceGroundingLevel: record.sourceGroundingLevel,
    };
    if (record.outcome === "failed") console.warn(JSON.stringify(logLine));
    else console.info(JSON.stringify(logLine));

    try {
        await prisma.comparisonReviewRun.create({
            data: {
                traceId: record.traceId,
                subjectKind: record.subjectKind,
                subjectKey: record.subjectKey,
                userId: record.userId,
                conversationId: record.conversationId,
                reviewMode: record.reviewMode,
                language: record.language,
                responseCount: record.responseCount,
                promptVersion: record.promptVersion,
                outcome: record.outcome,
                errorCode: record.errorCode,
                startedAt: record.startedAt,
                completedAt: record.completedAt,
                durationMs: record.durationMs,
                dualReviewRequested: record.dualReviewRequested,
                dualReviewAvailable: record.dualReviewAvailable,
                dualReviewCompleted: record.dualReviewCompleted,
                crossProvider: record.crossProvider,
                primaryModelId: record.primary.reviewerModelId,
                primaryProvider: record.primary.reviewerProvider,
                primaryStatus: record.primary.status,
                primaryDurationMs: record.primary.durationMs,
                primaryErrorCode: record.primary.errorCode,
                primaryErrorCategory: record.primary.errorCategory,
                primaryInputTokens: record.primary.inputTokens,
                primaryOutputTokens: record.primary.outputTokens,
                primaryReservedCredits: record.primary.reservedCredits,
                primarySettlementStatus: record.primary.settlementStatus,
                primaryRetryCount: record.primary.retryCount,
                secondaryModelId: record.secondary.reviewerModelId,
                secondaryProvider: record.secondary.reviewerProvider,
                secondaryStatus: record.secondary.status,
                secondaryDurationMs: record.secondary.durationMs,
                secondaryErrorCode: record.secondary.errorCode,
                secondaryErrorCategory: record.secondary.errorCategory,
                secondaryInputTokens: record.secondary.inputTokens,
                secondaryOutputTokens: record.secondary.outputTokens,
                secondaryReservedCredits: record.secondary.reservedCredits,
                secondarySettlementStatus: record.secondary.settlementStatus,
                secondaryRetryCount: record.secondary.retryCount,
                groundingTotalQuotes: record.groundingTotalQuotes,
                groundingMatchedQuotes: record.groundingMatchedQuotes,
                sourceGroundingLevel: record.sourceGroundingLevel,
                writerId: WRITER_ID,
                writerSequence: sequence,
                // Written with the run, in one statement, so a run can never
                // exist with its attempts missing -- which would read as a run
                // that dispatched nothing.
                attempts: {
                    create: record.attempts.map((attempt) => ({
                        ordinal: attempt.ordinal,
                        slot: attempt.slot,
                        reviewerModelId: attempt.reviewerModelId ?? "unknown",
                        reviewerProvider: attempt.reviewerProvider ?? "unknown",
                        status: attempt.status,
                        durationMs: attempt.durationMs,
                        errorCode: attempt.errorCode,
                        errorCategory: attempt.errorCategory,
                        inputTokens: attempt.inputTokens,
                        outputTokens: attempt.outputTokens,
                        reservedCredits: attempt.reservedCredits,
                        settledCredits: attempt.settledCredits,
                        settlementStatus: attempt.settlementStatus,
                        retryCount: attempt.retryCount,
                    })),
                },
            },
        });
    } catch (error) {
        if (isMissingDatabaseSchemaError(error)) {
            if (!didWarnAboutMissingTable) {
                didWarnAboutMissingTable = true;
                console.warn(
                    "ComparisonReviewRun is not migrated yet; AI Review runs are log-only."
                );
            }
        } else {
            // Its own event name, not a bare console.error: a health check has
            // to be able to count telemetry write failures without parsing
            // English.
            console.error(
                JSON.stringify({
                    event: "comparison_review_run_record_failed",
                    traceId: record.traceId,
                    outcome: record.outcome,
                    // The number the missing row would have carried, so a log
                    // search and the table's own gap agree on which write it
                    // was.
                    writerId: WRITER_ID,
                    writerSequence: sequence,
                })
            );
        }
    }

    return record;
};

/**
 * Accumulates one run's observations as the pipeline goes, so the service can
 * write exactly one row on every exit path -- including the ones that throw.
 *
 * A recorder rather than a pile of local variables because the service has
 * five terminal paths (dual success, primary-only, all-failed, no reviewer,
 * an unexpected throw) and the one that was easiest to forget is the one that
 * matters most for reliability.
 */
export class ComparisonReviewRunRecorder {
    private readonly startedAt = new Date();
    private primary: ComparisonReviewAttemptRecord = emptyAttemptRecord();
    private secondary: ComparisonReviewAttemptRecord = emptyAttemptRecord();
    /**
     * Every attempt, appended and never overwritten.
     *
     * The slots above are overwritten by design -- they hold the reviewer that
     * produced each result. This list is what stops that from losing the
     * failures a fallback stepped over, which is where reviewer failure rates
     * used to go missing.
     */
    private readonly attempts: ComparisonReviewAttemptEntry[] = [];
    private dualAvailable = false;
    private grounding = { total: 0, matched: 0, level: null as string | null };
    private written = false;

    constructor(
        private readonly base: {
            traceId: string;
            subjectKind: "guest" | "account";
            subjectKey: string;
            userId: string | null;
            conversationId: string | null;
            reviewMode: string;
            language: string;
            responseCount: number;
            promptVersion: string;
        }
    ) {}

    /** Whether a second distinct reviewer candidate existed at all. */
    noteDualAvailable(available: boolean) {
        this.dualAvailable = available;
    }

    /**
     * Records one attempt, and makes it the slot's result only if it produced
     * one. A failed candidate is kept in the attempt list and does not become
     * "the primary reviewer" -- the run's primary is whoever answered.
     */
    noteAttempt(slot: "primary" | "secondary", attempt: ComparisonReviewAttemptRecord) {
        this.attempts.push({
            ...attempt,
            ordinal: this.attempts.length + 1,
            slot,
        });
        if (attempt.status !== "completed") {
            // Keep the last attempt visible in the slot when nothing in that
            // slot ever succeeded, so a wholly failed run still names who was
            // asked; a later success overwrites it.
            if (slot === "primary" && this.primary.status !== "completed") {
                this.primary = attempt;
            }
            if (slot === "secondary" && this.secondary.status !== "completed") {
                this.secondary = attempt;
            }
            return;
        }
        if (slot === "primary") this.primary = attempt;
        else this.secondary = attempt;
    }

    noteGrounding(stats: {
        totalCitations: number;
        verifiedCitations: number;
        level: string | null;
    }) {
        this.grounding = {
            total: stats.totalCitations,
            matched: stats.verifiedCitations,
            level: stats.level,
        };
    }

    /**
     * Writes the row. Idempotent within one run: a service that both returns
     * normally and unwinds through a `finally` must not produce two rows for
     * one review.
     */
    async finish(outcome: ComparisonReviewRunOutcome, errorCode: string | null = null) {
        if (this.written) return;
        this.written = true;
        await recordComparisonReviewRun({
            ...this.base,
            outcome,
            errorCode,
            startedAt: this.startedAt,
            completedAt: new Date(),
            dualReviewRequested: true,
            dualReviewAvailable: this.dualAvailable,
            primary: this.primary,
            secondary: this.secondary,
            attempts: this.attempts,
            groundingTotalQuotes: this.grounding.total,
            groundingMatchedQuotes: this.grounding.matched,
            sourceGroundingLevel: this.grounding.level,
        });
    }
}

export const purgeExpiredComparisonReviewRuns = async (now = new Date()) => {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
    const result = await prisma.comparisonReviewRun.deleteMany({
        where: { createdAt: { lt: cutoff } },
    });
    return { deleted: result.count, cutoff };
};
