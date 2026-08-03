// Content-free observability for external conversation import (Release A).
//
// docs/policy/external-conversation-import-and-memory.md §22: what operators
// may see is provider/status/version dimensions, counts, byte buckets and
// latencies — never a filename, a title, message content, an external ID, a
// digest or a client fingerprint. The sample type below is the enforcement
// surface: it simply has no field where such a value could travel, and the
// server module selects only these columns.
//
// Pure functions over already-selected rows: no Prisma, no `server-only`, so
// the arithmetic is unit-testable. See lib/externalImportMetrics.ts for the
// queries and the admin route for the exposure.

export type ExternalImportMetricSample = {
    provider: string;
    status: string;
    parserVersion: string;
    digestVersion: number;
    conversationCount: number;
    messageCount: number;
    normalizedBytes: number;
    truncationCount: number;
    duplicateCount: number;
    failureCode: string | null;
    createdAt: Date;
    completedAt: Date | null;
};

/**
 * Bucket upper bounds in bytes for one import's stored normalized text.
 * Derived from the 50MB account cap (EXTERNAL_IMPORT_STORAGE_LIMITS) rather
 * than invented magnitudes: the top finite bucket is the cap itself.
 */
export const EXTERNAL_IMPORT_BYTE_BUCKETS = [
    { label: "le-64kb", maxBytes: 64 * 1024 },
    { label: "le-1mb", maxBytes: 1024 * 1024 },
    { label: "le-8mb", maxBytes: 8 * 1024 * 1024 },
    { label: "le-25mb", maxBytes: 25 * 1024 * 1024 },
    { label: "le-50mb", maxBytes: 50 * 1024 * 1024 },
    { label: "gt-50mb", maxBytes: Number.POSITIVE_INFINITY },
] as const;

/** Bucket upper bounds for conversations finalized by one import. */
export const EXTERNAL_IMPORT_CONVERSATION_BUCKETS = [
    { label: "le-9", max: 9 },
    { label: "le-49", max: 49 },
    { label: "le-199", max: 199 },
    { label: "le-999", max: 999 },
    { label: "le-2000", max: 2_000 },
    { label: "gt-2000", max: Number.POSITIVE_INFINITY },
] as const;

/** Bucket upper bounds in milliseconds for created→finalized latency. */
export const EXTERNAL_IMPORT_FINALIZE_LATENCY_BUCKETS = [
    { label: "le-10s", maxMs: 10_000 },
    { label: "le-1m", maxMs: 60_000 },
    { label: "le-10m", maxMs: 600_000 },
    { label: "le-1h", maxMs: 3_600_000 },
    { label: "gt-1h", maxMs: Number.POSITIVE_INFINITY },
] as const;

const bucketLabel = <T extends { label: string }>(
    buckets: readonly (T & { max?: number; maxBytes?: number; maxMs?: number })[],
    value: number
): string => {
    for (const bucket of buckets) {
        const bound = bucket.max ?? bucket.maxBytes ?? bucket.maxMs ?? 0;
        if (value <= bound) return bucket.label;
    }
    return buckets[buckets.length - 1].label;
};

export type ExternalImportProviderBreakdown = {
    provider: string;
    imports: number;
    completed: number;
    failed: number;
    cancelled: number;
    /** Non-terminal rows still inside the staging TTL window. */
    active: number;
    finalizedConversations: number;
    finalizedMessages: number;
    finalizedBytes: number;
    truncatedMessages: number;
    duplicatesSkipped: number;
};

export type ExternalImportParserVersionBreakdown = {
    parserVersion: string;
    imports: number;
    failed: number;
    /** `failed / imports`, or `null` when the version saw no imports. */
    failureRate: number | null;
};

export type ExternalImportSummary = {
    imports: number;
    completed: number;
    failed: number;
    cancelled: number;
    active: number;
    byProvider: ExternalImportProviderBreakdown[];
    byParserVersion: ExternalImportParserVersionBreakdown[];
    /** Failure codes of failed rows; `unknown` when a row carries none. */
    failureCodes: Record<string, number>;
    /**
     * Share of conversations the server skipped as exact duplicates, over all
     * conversations it examined (stored + skipped). `null` with no data.
     */
    duplicateShare: number | null;
    /** Share of finalized messages stored truncated. `null` with no data. */
    truncationShare: number | null;
    /** Completed imports by finalized conversation count. */
    conversationBuckets: Record<string, number>;
    /** Completed imports by stored normalized bytes. */
    byteBuckets: Record<string, number>;
    /** Completed imports by created→finalized latency. */
    finalizeLatencyBuckets: Record<string, number>;
};

const TERMINAL_FAILED = "failed";
const TERMINAL_CANCELLED = "cancelled";
const TERMINAL_COMPLETED = "completed";

const zeroBuckets = (labels: readonly { label: string }[]) =>
    Object.fromEntries(labels.map((bucket) => [bucket.label, 0]));

export const summarizeExternalImports = (
    rows: readonly ExternalImportMetricSample[]
): ExternalImportSummary => {
    const byProvider = new Map<string, ExternalImportProviderBreakdown>();
    const byParserVersion = new Map<
        string,
        { parserVersion: string; imports: number; failed: number }
    >();
    const failureCodes: Record<string, number> = {};
    const conversationBuckets = zeroBuckets(
        EXTERNAL_IMPORT_CONVERSATION_BUCKETS
    );
    const byteBuckets = zeroBuckets(EXTERNAL_IMPORT_BYTE_BUCKETS);
    const finalizeLatencyBuckets = zeroBuckets(
        EXTERNAL_IMPORT_FINALIZE_LATENCY_BUCKETS
    );

    let completed = 0;
    let failed = 0;
    let cancelled = 0;
    let active = 0;
    let storedConversations = 0;
    let skippedDuplicates = 0;
    let finalizedMessages = 0;
    let truncatedMessages = 0;

    for (const row of rows) {
        const provider = byProvider.get(row.provider) ?? {
            provider: row.provider,
            imports: 0,
            completed: 0,
            failed: 0,
            cancelled: 0,
            active: 0,
            finalizedConversations: 0,
            finalizedMessages: 0,
            finalizedBytes: 0,
            truncatedMessages: 0,
            duplicatesSkipped: 0,
        };
        provider.imports += 1;
        provider.duplicatesSkipped += row.duplicateCount;
        skippedDuplicates += row.duplicateCount;

        const parser = byParserVersion.get(row.parserVersion) ?? {
            parserVersion: row.parserVersion,
            imports: 0,
            failed: 0,
        };
        parser.imports += 1;

        if (row.status === TERMINAL_COMPLETED) {
            completed += 1;
            provider.completed += 1;
            provider.finalizedConversations += row.conversationCount;
            provider.finalizedMessages += row.messageCount;
            provider.finalizedBytes += row.normalizedBytes;
            provider.truncatedMessages += row.truncationCount;
            storedConversations += row.conversationCount;
            finalizedMessages += row.messageCount;
            truncatedMessages += row.truncationCount;
            conversationBuckets[
                bucketLabel(
                    EXTERNAL_IMPORT_CONVERSATION_BUCKETS,
                    row.conversationCount
                )
            ] += 1;
            byteBuckets[
                bucketLabel(EXTERNAL_IMPORT_BYTE_BUCKETS, row.normalizedBytes)
            ] += 1;
            if (row.completedAt) {
                const latencyMs =
                    row.completedAt.getTime() - row.createdAt.getTime();
                if (latencyMs >= 0) {
                    finalizeLatencyBuckets[
                        bucketLabel(
                            EXTERNAL_IMPORT_FINALIZE_LATENCY_BUCKETS,
                            latencyMs
                        )
                    ] += 1;
                }
            }
        } else if (row.status === TERMINAL_FAILED) {
            failed += 1;
            provider.failed += 1;
            parser.failed += 1;
            const code = row.failureCode ?? "unknown";
            failureCodes[code] = (failureCodes[code] ?? 0) + 1;
        } else if (row.status === TERMINAL_CANCELLED) {
            cancelled += 1;
            provider.cancelled += 1;
        } else {
            active += 1;
            provider.active += 1;
        }

        byProvider.set(row.provider, provider);
        byParserVersion.set(row.parserVersion, parser);
    }

    const examinedConversations = storedConversations + skippedDuplicates;

    return {
        imports: rows.length,
        completed,
        failed,
        cancelled,
        active,
        byProvider: [...byProvider.values()].sort(
            (left, right) =>
                right.imports - left.imports ||
                left.provider.localeCompare(right.provider)
        ),
        byParserVersion: [...byParserVersion.values()]
            .map((entry) => ({
                ...entry,
                failureRate:
                    entry.imports === 0 ? null : entry.failed / entry.imports,
            }))
            .sort(
                (left, right) =>
                    right.imports - left.imports ||
                    left.parserVersion.localeCompare(right.parserVersion)
            ),
        failureCodes,
        duplicateShare:
            examinedConversations === 0
                ? null
                : skippedDuplicates / examinedConversations,
        truncationShare:
            finalizedMessages === 0
                ? null
                : truncatedMessages / finalizedMessages,
        conversationBuckets,
        byteBuckets,
        finalizeLatencyBuckets,
    };
};
