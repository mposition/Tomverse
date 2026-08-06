import "server-only";

import { isMissingDatabaseSchemaError } from "@/lib/databaseError";
import {
    summarizeMemoryExtraction,
    type ExtractionMetricsSummary,
} from "@/lib/memoryExtractionMetricsCore";
import { prisma } from "@/lib/prisma";

/**
 * Server half of memory extraction observability (policy §22, the B list).
 *
 * Every query below selects exactly the columns the summary shapes -- status,
 * pair identifiers, counts, timestamps, failure codes -- and nothing else.
 * `sourceSelection`, `conversationIds`, statements, titles and digests are
 * excluded here, at the query, rather than dropped later from a response: a
 * field that is never read cannot be leaked by a future change to the shape.
 *
 * The pair identifiers are the one thing that looks like content and is not:
 * a model id and a prompt version are catalogue values this repository ships,
 * not anything a user wrote.
 */

const MAX_WINDOW_DAYS = 90;
const DEFAULT_WINDOW_DAYS = 7;
/** Row cap per query; a busier window is answered narrower, and said so. */
const MAX_ROWS = 5_000;

const clampWindowDays = (value: number | undefined) => {
    if (!Number.isFinite(value)) return DEFAULT_WINDOW_DAYS;
    return Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.round(value as number)));
};

const EMPTY = (windowDays: number): ExtractionMetricsSummary => ({
    windowDays,
    runs: {
        total: 0,
        byStatus: {},
        completionSecondsP50: null,
        completionSecondsP95: null,
    },
    pairs: [],
    chunks: {
        total: 0,
        completed: 0,
        failed: 0,
        failureCodes: {},
        retryRate: null,
    },
    queue: {
        pendingRuns: 0,
        runningRuns: 0,
        oldestPendingAgeSeconds: null,
        expiredLeases: 0,
    },
    review: {
        proposed: 0,
        approved: 0,
        rejected: 0,
        awaitingReview: 0,
        approvalRate: null,
        editRate: null,
        byPair: [],
    },
    credits: {
        reservations: 0,
        reservedCredits: 0,
        settledCredits: 0,
        refundedCredits: 0,
        partiallySettled: 0,
        overSettled: 0,
    },
    truncated: false,
});

export async function getMemoryExtractionReport(
    options: { windowDays?: number; now?: Date } = {}
): Promise<ExtractionMetricsSummary> {
    const windowDays = clampWindowDays(options.windowDays);
    const now = options.now ?? new Date();
    const since = new Date(now.getTime() - windowDays * 86_400_000);

    try {
        const runs = await prisma.memoryExtractionRun.findMany({
            where: { createdAt: { gte: since } },
            orderBy: { createdAt: "desc" },
            take: MAX_ROWS,
            select: {
                status: true,
                extractionModelId: true,
                promptVersion: true,
                chunkTotal: true,
                chunkCompleted: true,
                createdAt: true,
                completedAt: true,
                leaseExpiresAt: true,
            },
        });
        const chunks = await prisma.memoryExtractionChunk.findMany({
            where: { run: { createdAt: { gte: since } } },
            take: MAX_ROWS,
            select: {
                status: true,
                attemptCount: true,
                failureCode: true,
            },
        });
        const reservations =
            await prisma.memoryExtractionCreditReservation.findMany({
                where: { createdAt: { gte: since } },
                take: MAX_ROWS,
                select: {
                    status: true,
                    outcome: true,
                    chunkTotal: true,
                    chunksCharged: true,
                    reservedCredits: true,
                    settledCredits: true,
                },
            });

        // What humans did with what the pairs proposed (§22, §12.3), which is
        // the input to the approval decision that currently keeps extraction
        // closed. Windowed by when the item was proposed, and selecting only
        // the four columns that decide the rates -- never the statement.
        const reviewItems = await prisma.memoryItem.findMany({
            where: {
                createdAt: { gte: since },
                extractionRunId: { not: null },
                extractionModelId: { not: null },
                promptVersion: { not: null },
                // Deleted items are the user removing memory, not judging a
                // proposal, so they are neither an approval nor a rejection.
                status: { not: "deleted" },
            },
            take: MAX_ROWS,
            select: {
                extractionModelId: true,
                promptVersion: true,
                status: true,
                sensitivity: true,
                userEdited: true,
            },
        });

        // Queue health is deliberately *not* windowed. A run stuck since
        // before the window would otherwise disappear from the one number an
        // operator would use to notice it.
        const [pendingRuns, runningRuns, expiredLeases, oldestPending] =
            await Promise.all([
                prisma.memoryExtractionRun.count({ where: { status: "pending" } }),
                prisma.memoryExtractionRun.count({ where: { status: "running" } }),
                prisma.memoryExtractionRun.count({
                    where: { status: "running", leaseExpiresAt: { lte: now } },
                }),
                prisma.memoryExtractionRun.findFirst({
                    where: { status: "pending" },
                    orderBy: { createdAt: "asc" },
                    select: { createdAt: true },
                }),
            ]);

        return summarizeMemoryExtraction({
            windowDays,
            runs,
            chunks,
            reservations,
            reviewItems: reviewItems.map((item) => ({
                // Non-null by the query's own filter; narrowed here rather
                // than asserted so a change to that filter is a type error.
                extractionModelId: item.extractionModelId ?? "unknown",
                promptVersion: item.promptVersion ?? "unknown",
                status: item.status,
                sensitivity: item.sensitivity,
                userEdited: item.userEdited,
            })),
            queue: {
                pendingRuns,
                runningRuns,
                expiredLeases,
                oldestPendingAgeSeconds: oldestPending
                    ? Math.max(
                          0,
                          Math.round(
                              (now.getTime() - oldestPending.createdAt.getTime()) /
                                  1_000
                          )
                      )
                    : null,
            },
            truncated:
                runs.length >= MAX_ROWS ||
                chunks.length >= MAX_ROWS ||
                reservations.length >= MAX_ROWS ||
                reviewItems.length >= MAX_ROWS,
        });
    } catch (error) {
        // A deployment whose migrations have not landed yet answers "nothing
        // recorded" rather than failing the admin console outright, the same
        // way the import report does.
        if (isMissingDatabaseSchemaError(error)) return EMPTY(windowDays);
        throw error;
    }
}
