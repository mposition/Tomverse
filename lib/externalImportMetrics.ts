import "server-only";

import { prisma } from "@/lib/prisma";
import { usageBucketCount } from "@/lib/chatUsageBucketCount";
import { isMissingDatabaseSchemaError } from "@/lib/databaseError";
import {
    summarizeExternalImports,
    type ExternalImportMetricSample,
} from "@/lib/externalImportMetricsCore";

/**
 * Server half of the Release A import observability (policy §22).
 *
 * The row query selects exactly the columns `ExternalImportMetricSample`
 * carries — provider, status, versions, counts, timestamps — and nothing
 * else. `importDigest`, `clientFingerprint` and every content column stay out
 * of this module by construction.
 *
 * Two outcomes leave no row to aggregate: a finalize/batch refused for quota
 * (the import stays in staging and may later succeed or expire) and a staging
 * sweep (whose rows the owner may delete). Those are day counters in
 * `ChatUsageBucket` under the `external-import:` namespace.
 */

const MAX_WINDOW_DAYS = 90;
const DEFAULT_WINDOW_DAYS = 7;
/** Row cap per query; a busier window is answered narrower, and truncation is reported. */
const MAX_ROWS = 5_000;

const clampWindowDays = (value: number | undefined) => {
    if (!Number.isFinite(value)) return DEFAULT_WINDOW_DAYS;
    return Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.round(value as number)));
};

const EXTERNAL_IMPORT_COUNTER_PERIOD = "external-import-day";

export type ExternalImportCounterKind = "quota_rejected" | "staging_expired";

const counterKey = (kind: ExternalImportCounterKind) =>
    `external-import:${kind.replaceAll("_", "-")}`;

const dayStartUtc = (date: Date) =>
    new Date(
        Date.UTC(
            date.getUTCFullYear(),
            date.getUTCMonth(),
            date.getUTCDate()
        )
    );

/**
 * Fire-and-forget day counter. Recording a metric must never turn into a
 * second user-visible failure (the chatLimitDecisions convention), so every
 * error is swallowed after one structured log line.
 */
export async function recordExternalImportCounter(
    kind: ExternalImportCounterKind,
    count = 1,
    now = new Date()
) {
    if (!Number.isSafeInteger(count) || count <= 0) return;
    try {
        await prisma.chatUsageBucket.upsert({
            where: {
                key_period_periodStart: {
                    key: counterKey(kind),
                    period: EXTERNAL_IMPORT_COUNTER_PERIOD,
                    periodStart: dayStartUtc(now),
                },
            },
            create: {
                key: counterKey(kind),
                period: EXTERNAL_IMPORT_COUNTER_PERIOD,
                periodStart: dayStartUtc(now),
                count,
            },
            update: { count: { increment: count } },
        });
        console.info(
            JSON.stringify({ event: "external_import_counter", kind, count })
        );
    } catch (error) {
        console.warn(
            JSON.stringify({
                event: "external_import_counter_failed",
                kind,
                errorName: error instanceof Error ? error.name : "UnknownError",
            })
        );
    }
}

export type ExternalImportReport = Awaited<
    ReturnType<typeof getExternalImportReport>
>;

/**
 * Operational view of external imports in a window: provider/parserVersion
 * success and failure, size and latency buckets, duplicate/truncation shares,
 * and the counter-backed quota rejections and staging sweeps.
 *
 * Never throws on a missing table — the feature's tables can be migrated
 * ahead of traffic, and a monitoring page failing outright is worse than one
 * reporting that its source is not available yet.
 */
export const getExternalImportReport = async ({
    windowDays,
    now = new Date(),
}: { windowDays?: number; now?: Date } = {}) => {
    const days = clampWindowDays(windowDays);
    const since = new Date(now.getTime() - days * 86_400_000);

    let importRows: ExternalImportMetricSample[] = [];
    let importsUnavailable = false;
    try {
        const rows = await prisma.externalImport.findMany({
            where: { createdAt: { gte: since } },
            orderBy: { createdAt: "desc" },
            take: MAX_ROWS,
            select: {
                provider: true,
                status: true,
                parserVersion: true,
                digestVersion: true,
                conversationCount: true,
                messageCount: true,
                normalizedBytes: true,
                truncationCount: true,
                duplicateCount: true,
                failureCode: true,
                createdAt: true,
                completedAt: true,
            },
        });
        importRows = rows.map((row) => ({
            provider: row.provider,
            status: row.status,
            parserVersion: row.parserVersion,
            digestVersion: row.digestVersion,
            conversationCount: row.conversationCount,
            messageCount: row.messageCount,
            normalizedBytes: usageBucketCount(row.normalizedBytes),
            truncationCount: row.truncationCount,
            duplicateCount: row.duplicateCount,
            failureCode: row.failureCode,
            createdAt: row.createdAt,
            completedAt: row.completedAt,
        }));
    } catch (error) {
        if (!isMissingDatabaseSchemaError(error)) throw error;
        importsUnavailable = true;
    }

    const counters: Record<ExternalImportCounterKind, number> = {
        quota_rejected: 0,
        staging_expired: 0,
    };
    let countersUnavailable = false;
    try {
        const rows = await prisma.chatUsageBucket.findMany({
            where: {
                period: EXTERNAL_IMPORT_COUNTER_PERIOD,
                periodStart: { gte: dayStartUtc(since) },
            },
            select: { key: true, count: true },
        });
        for (const row of rows) {
            for (const kind of Object.keys(
                counters
            ) as ExternalImportCounterKind[]) {
                if (row.key === counterKey(kind)) {
                    counters[kind] += usageBucketCount(row.count);
                }
            }
        }
    } catch (error) {
        if (!isMissingDatabaseSchemaError(error)) throw error;
        countersUnavailable = true;
    }

    return {
        generatedAt: now.toISOString(),
        windowDays: days,
        since: since.toISOString(),
        imports: {
            ...summarizeExternalImports(importRows),
            unavailable: importsUnavailable,
            truncated: importRows.length >= MAX_ROWS,
        },
        counters: {
            ...counters,
            unavailable: countersUnavailable,
        },
    };
};
