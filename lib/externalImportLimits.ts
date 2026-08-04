/**
 * Central limits for external conversation import (Release A).
 *
 * Contract: docs/policy/external-conversation-import-and-memory.md §5.2–§5.5.
 *
 * Two families live here and must not be confused:
 *
 *   * `EXTERNAL_IMPORT_STORAGE_LIMITS` — the server-authoritative account
 *     quota. The client may mirror these numbers for preview display, but
 *     enforcement happens server-side, serialized under the per-account
 *     storage lock, and a finalize that would exceed them fails whole
 *     (409 EXTERNAL_IMPORT_QUOTA_EXCEEDED) — never by silently dropping
 *     conversations or messages.
 *
 *   * `EXTERNAL_IMPORT_CLIENT_ARCHIVE_LIMITS` — pure client-side safety
 *     bounds for the Web Worker that opens the raw archive. The archive
 *     itself never reaches the server, so nothing here is a security
 *     boundary for the API; the bounds exist so a hostile or merely huge
 *     archive fails predictably in the browser instead of exhausting it.
 *
 * Storage-limit semantics (§5.3):
 *
 *   * the account byte quota counts net-new UTF-8 bytes of content that is
 *     actually stored — after duplicate skips, after truncation;
 *   * the stored-message cap and the inbound cap are different numbers on
 *     purpose. Between them a message is imported truncated (with explicit
 *     user approval); beyond the inbound cap the whole conversation is
 *     excluded, because the server never drops individual messages.
 */

export const EXTERNAL_IMPORT_STORAGE_LIMITS = {
    /** Net-new UTF-8 bytes of stored normalized content per account. */
    maxNormalizedTextBytesPerAccount: 50 * 1024 * 1024,
    maxExternalConversationsPerAccount: 2_000,
    maxExternalMessagesPerAccount: 100_000,
    /** Stored content cap per message, in Unicode code points. */
    maxStoredMessageCodePoints: 100_000,
    /** Pre-truncation cap per message, in Unicode code points. */
    maxInboundMessageCodePoints: 1_000_000,
    /** Staging expiry: idle time since the last batch/inspect activity. */
    stagingIdleTtlMs: 24 * 60 * 60 * 1000,
    /** Staging expiry: absolute lifetime regardless of activity. */
    stagingAbsoluteMaxLifetimeMs: 72 * 60 * 60 * 1000,
} as const;

export const EXTERNAL_IMPORT_CLIENT_ARCHIVE_LIMITS = {
    /** The whole container may be large — media entries are skipped, not read. */
    maxArchiveContainerBytes: 1024 * 1024 * 1024,
    maxArchiveEntries: 50_000,
    /** Nested archives are rejected outright. */
    maxNestedArchiveDepth: 0,
    /** Largest single entry the worker will actually parse. */
    maxParsedEntryBytes: 250 * 1024 * 1024,
    /** Total text the worker will parse across all entries. */
    maxParsedTextTotalBytes: 300 * 1024 * 1024,
    /** Compression-ratio ceiling for entries that are actually inflated. */
    maxParsedEntryCompressionRatio: 100,
    /**
     * Entries at or below this size may use plain JSON.parse; anything larger
     * must go through the incremental/streaming parser (§5.1) so the worker
     * never holds a giant string and its object graph at once.
     */
    maxSyncJsonParseBytes: 16 * 1024 * 1024,
} as const;

/**
 * Request-body ceilings for the staging API. The batch ceiling leaves room
 * for one worst-case oversized message (1M code points, up to ~4MB UTF-8,
 * roughly doubled by JSON escaping) plus batch overhead, so a message never
 * has to span requests; the pre-truncation original is digested and discarded
 * within the one request that carried it (§5.4).
 */
export const EXTERNAL_IMPORT_MAX_BATCH_REQUEST_BYTES = 12 * 1024 * 1024;
export const EXTERNAL_IMPORT_MAX_CONTROL_REQUEST_BYTES = 256 * 1024;

/**
 * Locale-independent marker inserted between the retained head and tail of a
 * truncated message. ASCII on purpose: it must survive any provider content
 * and never collide with the surrounding text's language.
 */
export const EXTERNAL_IMPORT_TRUNCATION_MARKER =
    "\n\n[[tomverse:truncated]]\n\n";

/** Share of the retained budget kept from the head of an over-long message. */
export const EXTERNAL_IMPORT_TRUNCATION_HEAD_RATIO = 0.75;

export type ExternalImportExpiries = {
    idleExpiresAt: string;
    absoluteExpiresAt: string;
    /** Whichever of the two comes first — the deadline that actually bites. */
    effectiveExpiresAt: string;
};

/**
 * The two staging clocks of §5.5 as instants: 24h since the last activity and
 * 72h since creation. Pure, and shared by the API responses and the sweep so
 * a client never has to add hours to a timestamp and disagree about which
 * limit applied.
 *
 * `preview_ready` runs on exactly the same clocks as `staging`: sealing an
 * import declares its upload complete, it does not extend its life.
 */
export function computeExternalImportExpiries(
    row: { createdAt: Date; updatedAt: Date },
    limits: Pick<
        typeof EXTERNAL_IMPORT_STORAGE_LIMITS,
        "stagingIdleTtlMs" | "stagingAbsoluteMaxLifetimeMs"
    > = EXTERNAL_IMPORT_STORAGE_LIMITS
): ExternalImportExpiries {
    const idle = new Date(row.updatedAt.getTime() + limits.stagingIdleTtlMs);
    const absolute = new Date(
        row.createdAt.getTime() + limits.stagingAbsoluteMaxLifetimeMs
    );
    return {
        idleExpiresAt: idle.toISOString(),
        absoluteExpiresAt: absolute.toISOString(),
        effectiveExpiresAt: (idle <= absolute ? idle : absolute).toISOString(),
    };
}

export type ExternalImportUsage = {
    conversations: number;
    messages: number;
    bytes: number;
};

/**
 * The all-or-nothing quota decision (§5.3), pure so the arithmetic is
 * testable without 50MB of fixture data. Callers are responsible for reading
 * `usage` under the per-account advisory lock — this function only decides.
 */
export function externalImportQuotaExceeded(
    usage: ExternalImportUsage,
    addition: ExternalImportUsage,
    limits: Pick<
        typeof EXTERNAL_IMPORT_STORAGE_LIMITS,
        | "maxNormalizedTextBytesPerAccount"
        | "maxExternalConversationsPerAccount"
        | "maxExternalMessagesPerAccount"
    > = EXTERNAL_IMPORT_STORAGE_LIMITS
): boolean {
    return (
        usage.conversations + addition.conversations >
            limits.maxExternalConversationsPerAccount ||
        usage.messages + addition.messages >
            limits.maxExternalMessagesPerAccount ||
        usage.bytes + addition.bytes > limits.maxNormalizedTextBytesPerAccount
    );
}

export type ExternalMessageTruncationPlan =
    | { kind: "store_verbatim" }
    | {
          kind: "requires_truncation";
          headCodePoints: number;
          tailCodePoints: number;
      }
    | { kind: "exceeds_inbound_limit" };

export function countCodePoints(content: string): number {
    // Iterating by code point, not UTF-16 unit: a surrogate pair is one
    // character for every limit in this contract.
    let count = 0;
    const iterator = content[Symbol.iterator]();
    while (!iterator.next().done) count += 1;
    return count;
}

// Isomorphic on purpose: the Web Worker (A2) must compute the same byte
// estimates the server enforces. Buffer is the cheap path where it exists.
const textEncoder = new TextEncoder();

export function utf8ByteLength(content: string): number {
    if (typeof Buffer !== "undefined") {
        return Buffer.byteLength(content, "utf8");
    }
    return textEncoder.encode(content).length;
}

/**
 * Decides how a message of `codePointCount` characters is handled (§5.3/§5.4).
 * The head/tail split leaves room for the truncation marker inside the stored
 * cap, so a truncated message never exceeds `maxStoredMessageCodePoints`.
 */
export function planExternalMessageTruncation(
    codePointCount: number,
    limits: Pick<
        typeof EXTERNAL_IMPORT_STORAGE_LIMITS,
        "maxStoredMessageCodePoints" | "maxInboundMessageCodePoints"
    > = EXTERNAL_IMPORT_STORAGE_LIMITS
): ExternalMessageTruncationPlan {
    if (!Number.isInteger(codePointCount) || codePointCount < 0) {
        throw new Error("codePointCount must be a non-negative integer");
    }
    if (codePointCount > limits.maxInboundMessageCodePoints) {
        return { kind: "exceeds_inbound_limit" };
    }
    if (codePointCount <= limits.maxStoredMessageCodePoints) {
        return { kind: "store_verbatim" };
    }
    const markerCodePoints = countCodePoints(EXTERNAL_IMPORT_TRUNCATION_MARKER);
    const retainedBudget = limits.maxStoredMessageCodePoints - markerCodePoints;
    if (retainedBudget <= 0) {
        throw new Error(
            "maxStoredMessageCodePoints must exceed the truncation marker length"
        );
    }
    const headCodePoints = Math.floor(
        retainedBudget * EXTERNAL_IMPORT_TRUNCATION_HEAD_RATIO
    );
    return {
        kind: "requires_truncation",
        headCodePoints,
        tailCodePoints: retainedBudget - headCodePoints,
    };
}

/**
 * Applies a `requires_truncation` plan. Pure string work on code-point
 * boundaries — a surrogate pair is never split. Both the worker preview and
 * the server-side re-validation call this, so what the user approved in the
 * preview is byte-for-byte what gets stored.
 */
export function truncateExternalMessageContent(
    content: string,
    plan: Extract<ExternalMessageTruncationPlan, { kind: "requires_truncation" }>
): { content: string; retainedCharacterCount: number } {
    const codePoints = Array.from(content);
    const head = codePoints.slice(0, plan.headCodePoints).join("");
    const tail = codePoints
        .slice(codePoints.length - plan.tailCodePoints)
        .join("");
    const truncatedContent = `${head}${EXTERNAL_IMPORT_TRUNCATION_MARKER}${tail}`;
    return {
        content: truncatedContent,
        retainedCharacterCount: countCodePoints(truncatedContent),
    };
}
