import "server-only";

import { prisma } from "@/lib/prisma";
import { isMissingDatabaseSchemaError } from "@/lib/databaseError";
import {
    buildComparisonReviewRunRecord,
    emptyAttemptRecord,
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
 *     structured log line, and the scorecard reports a `missingTraceRate`
 *     computed from the runs that did land. A telemetry gap that nothing
 *     reports is worse than no telemetry, because the numbers still look
 *     complete.
 */

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
    const logLine = {
        event: "comparison_review_run",
        traceId: record.traceId,
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

    noteAttempt(slot: "primary" | "secondary", attempt: ComparisonReviewAttemptRecord) {
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
