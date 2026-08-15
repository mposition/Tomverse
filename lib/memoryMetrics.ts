import "server-only";

import { usageBucketCount } from "@/lib/chatUsageBucketCount";
import { isMissingDatabaseSchemaError } from "@/lib/databaseError";
import {
    MEMORY_COUNTER_KINDS,
    emptyMemoryCounters,
    summarizeMemoryMetrics,
    type MemoryCounterKind,
    type MemoryDayCounters,
    type MemoryMetricSample,
    type FollowupArmSample,
    type MemoryRunMetricSample,
} from "@/lib/memoryMetricsCore";
import { prisma } from "@/lib/prisma";

/**
 * Server half of the Release B memory observability (policy §22 B).
 *
 * The row queries select exactly the columns the metric samples carry —
 * status, sensitivity, pair identity, timestamps. `statement`,
 * `conflictKey`, `searchTerms`, evidence and every id stay out of this module
 * by construction, so a future change to the response shape cannot leak them
 * back in.
 *
 * Outcomes that leave no row to aggregate are day counters in
 * `ChatUsageBucket` under the `memory:` namespace: a validator rejection
 * never becomes a memory, a source-delete disposition removes or changes the
 * row it describes, and an expiry sweep is a transition rather than a record.
 */

const MAX_WINDOW_DAYS = 90;
const DEFAULT_WINDOW_DAYS = 7;
/** Row cap per query; a busier window is answered narrower, and said so. */
const MAX_ROWS = 5_000;

const MEMORY_COUNTER_PERIOD = "memory-day";

/** §22's "within 120 seconds" for the follow-up / repair proxy. */
const FOLLOWUP_WINDOW_SECONDS = 120;

const counterKey = (kind: MemoryCounterKind) =>
    `memory:${kind.replaceAll("_", "-")}`;

const clampWindowDays = (value: number | undefined) => {
    if (!Number.isFinite(value)) return DEFAULT_WINDOW_DAYS;
    return Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.round(value as number)));
};

const dayStartUtc = (date: Date) =>
    new Date(
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
    );

/**
 * Fire-and-forget day counter. Recording a metric must never turn into a
 * second user-visible failure, so every error is swallowed after one
 * structured log line — the same convention as the import counters.
 */
export async function recordMemoryCounter(
    kind: MemoryCounterKind,
    count = 1,
    now = new Date()
) {
    if (!Number.isSafeInteger(count) || count <= 0) return;
    try {
        await prisma.chatUsageBucket.upsert({
            where: {
                key_period_periodStart: {
                    key: counterKey(kind),
                    period: MEMORY_COUNTER_PERIOD,
                    periodStart: dayStartUtc(now),
                },
            },
            create: {
                key: counterKey(kind),
                period: MEMORY_COUNTER_PERIOD,
                periodStart: dayStartUtc(now),
                count,
            },
            update: { count: { increment: count } },
        });
    } catch (error) {
        console.warn(
            JSON.stringify({
                event: "memory_counter_failed",
                kind,
                errorName: error instanceof Error ? error.name : "UnknownError",
            })
        );
    }
}

const readCounters = async (since: Date): Promise<MemoryDayCounters> => {
    const counters = emptyMemoryCounters();
    try {
        const rows = await prisma.chatUsageBucket.findMany({
            where: {
                period: MEMORY_COUNTER_PERIOD,
                periodStart: { gte: dayStartUtc(since) },
                key: { in: MEMORY_COUNTER_KINDS.map(counterKey) },
            },
            select: { key: true, count: true },
        });
        for (const kind of MEMORY_COUNTER_KINDS) {
            counters[kind] = rows
                .filter((row) => row.key === counterKey(kind))
                .reduce((total, row) => total + usageBucketCount(row.count), 0);
        }
    } catch (error) {
        if (!isMissingDatabaseSchemaError(error)) throw error;
    }
    return counters;
};

export type MemoryReport = Awaited<ReturnType<typeof getMemoryReport>>;

/**
 * Operational view of account memory in a window.
 *
 * Never throws on a missing table: these tables can be migrated ahead of
 * traffic, and a monitoring page failing outright is worse than one saying
 * its source is not available yet.
 */
export const getMemoryReport = async ({
    windowDays,
    now = new Date(),
}: { windowDays?: number; now?: Date } = {}) => {
    const days = clampWindowDays(windowDays);
    const since = new Date(now.getTime() - days * 86_400_000);

    let memories: MemoryMetricSample[] = [];
    let memoriesUnavailable = false;
    let memoriesTruncated = false;
    try {
        const rows = await prisma.memoryItem.findMany({
            where: { createdAt: { gte: since } },
            orderBy: { createdAt: "desc" },
            take: MAX_ROWS,
            select: {
                status: true,
                sensitivity: true,
                extractionModelId: true,
                promptVersion: true,
                userEdited: true,
                createdAt: true,
                approvedAt: true,
            },
        });
        memoriesTruncated = rows.length === MAX_ROWS;
        memories = rows.map((row) => ({
            status: row.status,
            sensitivity: row.sensitivity,
            extractionModelId: row.extractionModelId,
            promptVersion: row.promptVersion,
            userEdited: row.userEdited,
            createdAtMs: row.createdAt.getTime(),
            approvedAtMs: row.approvedAt?.getTime() ?? null,
        }));
    } catch (error) {
        if (!isMissingDatabaseSchemaError(error)) throw error;
        memoriesUnavailable = true;
    }

    let runs: MemoryRunMetricSample[] = [];
    let runsUnavailable = false;
    let runsTruncated = false;
    try {
        const rows = await prisma.memoryExtractionRun.findMany({
            where: { createdAt: { gte: since } },
            orderBy: { createdAt: "desc" },
            take: MAX_ROWS,
            select: {
                status: true,
                extractionModelId: true,
                promptVersion: true,
                chunkTotal: true,
                chunkCompleted: true,
            },
        });
        runsTruncated = rows.length === MAX_ROWS;
        runs = rows;
    } catch (error) {
        if (!isMissingDatabaseSchemaError(error)) throw error;
        runsUnavailable = true;
    }

    // Settled reservations, for the §22 credit-per-chunk distribution. Only
    // the two numbers the percentile needs: no cost, no snapshot, no ids.
    let settlements: Array<{ chunksCharged: number; settledCredits: number }> =
        [];
    try {
        settlements = await prisma.memoryExtractionCreditReservation.findMany({
            where: { status: "settled", settledAt: { gte: since } },
            orderBy: { settledAt: "desc" },
            take: MAX_ROWS,
            select: { chunksCharged: true, settledCredits: true },
        });
    } catch (error) {
        // Same posture as the two queries above: a schema that predates this
        // table reports the section as absent rather than failing the report.
        if (!isMissingDatabaseSchemaError(error)) throw error;
    }

    // §22's follow-up / repair proxy, aggregated entirely in SQL.
    //
    // The relation it needs — "what came next in this conversation" — is a
    // per-conversation ordering, and computing it here would mean loading
    // conversation ids into this module. §22 keeps ids out of the select, not
    // merely out of the response, so the grouping stays in the database and
    // only two rows of counts come back.
    let followupArms: FollowupArmSample[] = [];
    let followupUnavailable = false;
    try {
        const rows = await prisma.$queryRaw<
            Array<{
                arm: string;
                answers: bigint;
                followups: bigint;
                regenerates: bigint;
            }>
        >`
            WITH ordered AS (
                SELECT
                    "role",
                    "createdAt",
                    "memoryUsedCount",
                    LEAD("role") OVER w AS next_role,
                    LEAD("createdAt") OVER w AS next_at
                FROM "Message"
                WHERE "createdAt" >= ${since}
                WINDOW w AS (
                    PARTITION BY "conversationId"
                    ORDER BY "createdAt" ASC, "id" ASC
                )
            )
            SELECT
                CASE
                    WHEN COALESCE("memoryUsedCount", 0) > 0 THEN 'memory'
                    ELSE 'plain'
                END AS arm,
                COUNT(*) AS answers,
                COUNT(*) FILTER (
                    WHERE next_role = 'user'
                      AND next_at <= "createdAt" + ${`${FOLLOWUP_WINDOW_SECONDS} seconds`}::interval
                ) AS followups,
                COUNT(*) FILTER (
                    WHERE next_role = 'assistant'
                      AND next_at <= "createdAt" + ${`${FOLLOWUP_WINDOW_SECONDS} seconds`}::interval
                ) AS regenerates
            FROM ordered
            WHERE "role" = 'assistant'
            GROUP BY 1
        `;
        followupArms = rows
            .filter((row) => row.arm === "memory" || row.arm === "plain")
            .map((row) => ({
                arm: row.arm as "memory" | "plain",
                answers: Number(row.answers),
                followups: Number(row.followups),
                regenerates: Number(row.regenerates),
            }));
    } catch (error) {
        if (!isMissingDatabaseSchemaError(error)) throw error;
        followupUnavailable = true;
    }

    const counters = await readCounters(since);
    return {
        windowDays: days,
        generatedAt: now.toISOString(),
        memoriesUnavailable,
        runsUnavailable,
        followupUnavailable,
        truncated: memoriesTruncated || runsTruncated,
        ...summarizeMemoryMetrics({
            memories,
            runs,
            counters,
            settlements,
            followupArms,
        }),
    };
};
