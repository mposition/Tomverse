import "server-only";

import { prisma } from "@/lib/prisma";
import {
    summariseAdoption,
    summariseReliability,
    telemetryCoverage,
    type AdoptionScorecard,
    type ReliabilityScorecard,
    type ScorecardEventRow,
    type ScorecardRunRow,
} from "@/lib/aiReviewScorecardCore";
import {
    AI_REVIEW_EVAL_REGISTER,
    approvedAiReviewPairs,
    registerDrift,
    type AiReviewRegisterDrift,
} from "@/lib/aiReviewEvalRegister";
import {
    COMPARISON_REVIEW_DEFAULT_MODEL_IDS,
    COMPARISON_REVIEW_PROMPT_VERSION,
} from "@/lib/comparisonReview";

/**
 * Reads the AI Review M5 scorecard from the database.
 *
 * The aggregation itself lives in `lib/aiReviewScorecardCore.ts`; this module
 * only fetches rows and hands them over, so the CLI report and any screen
 * that renders the card compute the same numbers from the same code. A second
 * aggregation written against the same tables is how two surfaces come to
 * disagree about what a rate means.
 */

export const AI_REVIEW_SCORECARD_WINDOWS = [7, 30, 90] as const;
export type AiReviewScorecardWindow = (typeof AI_REVIEW_SCORECARD_WINDOWS)[number];

/**
 * The reviewer pairs production would serve, read from the configuration the
 * product actually uses rather than from the register.
 *
 * `COMPARISON_REVIEW_MODEL_IDS` overrides the default panel per environment,
 * so the answer differs between staging and production and cannot be a
 * constant. Nothing here filters by runtime availability: a pair that is
 * configured but currently disabled is still the pair this deployment would
 * serve the moment it comes back.
 */
export const servedReviewerPairs = () => {
    const configured = process.env.COMPARISON_REVIEW_MODEL_IDS?.split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    const ids = configured?.length
        ? configured
        : [...COMPARISON_REVIEW_DEFAULT_MODEL_IDS];
    return ids.map((reviewerModelId) => ({
        reviewerModelId,
        promptVersion: COMPARISON_REVIEW_PROMPT_VERSION,
    }));
};

export type AiReviewQualityScorecard = {
    approvedPairCount: number;
    candidatePairCount: number;
    /** null until a pair is approved; never a placeholder date. */
    datasetVersion: string | null;
    evaluatedAt: string | null;
    independentRunOrdinals: readonly number[];
    zeroToleranceViolations: number | null;
    drift: AiReviewRegisterDrift;
};

export const readQualityScorecard = (): AiReviewQualityScorecard => {
    const approved = approvedAiReviewPairs();
    const evaluation = approved[0]?.evaluation ?? null;
    return {
        approvedPairCount: approved.length,
        candidatePairCount: AI_REVIEW_EVAL_REGISTER.filter(
            (entry) => entry.status === "candidate"
        ).length,
        datasetVersion: evaluation?.datasetVersion ?? null,
        evaluatedAt: evaluation?.approvedAt ?? null,
        independentRunOrdinals: (evaluation?.runs ?? []).map((run) => run.runOrdinal),
        // The worst of the runs, not a sum and not the first.
        //
        // A summed total would grow with the number of runs and read as a
        // worse pair; the first run's figure would hide a second run that
        // produced a violation. The question a scorecard answers here is "did
        // any run produce one", so the maximum is what it shows.
        zeroToleranceViolations:
            evaluation && evaluation.runs.length > 0
                ? Math.max(...evaluation.runs.map((run) => run.zeroToleranceViolations))
                : null,
        drift: registerDrift(servedReviewerPairs()),
    };
};

const windowStart = (windowDays: number, now: Date) =>
    new Date(now.getTime() - windowDays * 86_400_000);

export const readReliabilityScorecard = async (
    windowDays: number,
    now = new Date(),
    evidence: {
        attemptedWrites?: number | null;
        attemptedWritesSource?: string | null;
    } = {}
): Promise<ReliabilityScorecard> => {
    const rows = (await prisma.comparisonReviewRun.findMany({
        where: { createdAt: { gte: windowStart(windowDays, now) } },
        select: {
            outcome: true,
            durationMs: true,
            writerId: true,
            writerSequence: true,
            dualReviewRequested: true,
            dualReviewAvailable: true,
            dualReviewCompleted: true,
            primaryModelId: true,
            primaryProvider: true,
            primaryStatus: true,
            primaryRetryCount: true,
            primaryReservedCredits: true,
            primarySettlementStatus: true,
            secondaryModelId: true,
            secondaryProvider: true,
            secondaryStatus: true,
            secondaryRetryCount: true,
            secondaryReservedCredits: true,
            secondarySettlementStatus: true,
            subjectKind: true,
            createdAt: true,
            // Reviewer health, the retry rate and reconciliation are all
            // computed from these rather than from the two slots above.
            attempts: {
                select: {
                    reviewerModelId: true,
                    reviewerProvider: true,
                    status: true,
                    retryCount: true,
                    reservedCredits: true,
                    settledCredits: true,
                    settlementStatus: true,
                },
            },
        },
    })) as ScorecardRunRow[];
    return summariseReliability(rows, windowDays, {}, evidence);
};

export const readAdoptionScorecard = async (
    windowDays: number,
    now = new Date()
): Promise<AdoptionScorecard> => {
    const rows = await prisma.productAnalyticsEvent.findMany({
        where: {
            occurredAt: { gte: windowStart(windowDays, now) },
            eventName: {
                in: [
                    "multi_model_compare_completed",
                    "comparison_review_started",
                    "comparison_review_completed",
                    "comparison_review_item_verified",
                    "followup_sent",
                    "conversation_saved",
                    "share_created",
                    "return_day_1",
                    "return_day_7",
                    "return_day_30",
                ],
            },
        },
        select: {
            eventName: true,
            userId: true,
            anonymousIdHash: true,
            occurredAt: true,
        },
    });
    const events: ScorecardEventRow[] = rows.map((row) => ({
        eventName: row.eventName,
        // The same actor key the product analytics dashboard uses, so a
        // signed-in user is one actor and not two.
        actorKey: row.userId ? `user:${row.userId}` : `anonymous:${row.anonymousIdHash}`,
        occurredAt: row.occurredAt,
    }));
    return summariseAdoption(events, windowDays, { now });
};

export const readTelemetryCoverage = async (
    windowDays: number,
    now = new Date()
) => {
    const since = windowStart(windowDays, now);
    const [serverRuns, clientStarted] = await Promise.all([
        prisma.comparisonReviewRun.count({ where: { createdAt: { gte: since } } }),
        prisma.productAnalyticsEvent.count({
            where: {
                eventName: "comparison_review_started",
                occurredAt: { gte: since },
            },
        }),
    ]);
    return telemetryCoverage(serverRuns, clientStarted);
};

export type AiReviewScorecard = {
    generatedAt: string;
    windowDays: number;
    reliability: ReliabilityScorecard;
    quality: AiReviewQualityScorecard;
    adoption: AdoptionScorecard;
    coverage: Awaited<ReturnType<typeof readTelemetryCoverage>>;
};

export const readAiReviewScorecard = async (
    windowDays: number,
    now = new Date(),
    /**
     * An attempted-write total counted outside the run table, when an operator
     * has one. Without it `traceCompleteness` stays null, which is the honest
     * answer: the run table cannot supply its own denominator.
     */
    evidence: {
        attemptedWrites?: number | null;
        attemptedWritesSource?: string | null;
    } = {}
): Promise<AiReviewScorecard> => {
    const [reliability, adoption, coverage] = await Promise.all([
        readReliabilityScorecard(windowDays, now, evidence),
        readAdoptionScorecard(windowDays, now),
        readTelemetryCoverage(windowDays, now),
    ]);
    return {
        generatedAt: now.toISOString(),
        windowDays,
        reliability,
        quality: readQualityScorecard(),
        adoption,
        coverage,
    };
};
