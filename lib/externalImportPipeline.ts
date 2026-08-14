import {
    getExternalImportAdapter,
    type ExternalAdapterProvider,
} from "@/lib/externalImportAdapters";
import type { ParsedExternalConversation } from "@/lib/externalImportAdapters/types";
import {
    EXTERNAL_IMPORT_MAX_BATCH_REQUEST_BYTES,
    EXTERNAL_IMPORT_STORAGE_LIMITS,
    countCodePoints,
    planExternalMessageTruncation,
    utf8ByteLength,
} from "@/lib/externalImportLimits";

/**
 * Turns adapter output into what the preview shows and what the batch API
 * receives.
 *
 * docs/policy/external-conversation-import-and-memory.md §5.3–§5.5.
 *
 * Two jobs, both pure so the worker and the tests run the same code:
 *
 *   * classify each conversation for the preview — importable as-is, needs
 *     explicit truncation approval, or not importable at all because one of
 *     its messages is past the inbound hard limit. A conversation is never
 *     imported with messages missing, so the third case excludes the whole
 *     conversation (§5.3) rather than dropping the offending message.
 *   * assemble batches that fit the transport. Sizes are estimated from the
 *     same serialization the request will use, and a conversation is never
 *     split across batches: batch boundaries are conversation boundaries, so
 *     a retry of the last batch is a whole unit.
 *
 * Nothing decided here is trusted by the server, which re-digests,
 * re-truncates and re-checks the account quota under its own lock.
 */

export type ConversationImportability =
    | { kind: "importable"; truncatedMessageCount: 0 }
    | { kind: "requires_truncation_approval"; truncatedMessageCount: number }
    | { kind: "not_importable"; oversizedMessageCount: number };

export type PreviewConversation = {
    conversation: ParsedExternalConversation;
    importability: ConversationImportability;
    /** Bytes this conversation would add to the account quota if imported. */
    estimatedStoredBytes: number;
};

export type ImportPreview = {
    provider: ExternalAdapterProvider;
    conversations: PreviewConversation[];
    totals: {
        conversations: number;
        importableConversations: number;
        requiresTruncationApproval: number;
        notImportable: number;
        messages: number;
        estimatedStoredBytes: number;
        skippedNonConversationMessages: number;
        skippedNonTextParts: number;
        additionalBranches: number;
        /**
         * Attachments that are themselves archives (§5.2). Counted apart from
         * every other skip: a user who attached a `.zip` to a chat needs to be
         * told that file is not coming, and "unsupported file type" does not
         * say it.
         */
        skippedNestedArchives: number;
    };
};

const LIMITS = EXTERNAL_IMPORT_STORAGE_LIMITS;

/** Route-level shape limits the batch payload must respect. */
export const BATCH_SHAPE_LIMITS = {
    maxConversationsPerBatch: 50,
    maxMessagesPerConversation: 2_000,
} as const;

export function classifyConversation(
    conversation: ParsedExternalConversation
): ConversationImportability {
    let truncated = 0;
    let oversized = 0;
    for (const message of conversation.messages) {
        const plan = planExternalMessageTruncation(
            countCodePoints(message.content)
        );
        if (plan.kind === "requires_truncation") truncated += 1;
        else if (plan.kind === "exceeds_inbound_limit") oversized += 1;
    }
    if (oversized > 0) {
        return { kind: "not_importable", oversizedMessageCount: oversized };
    }
    if (truncated > 0) {
        return {
            kind: "requires_truncation_approval",
            truncatedMessageCount: truncated,
        };
    }
    return { kind: "importable", truncatedMessageCount: 0 };
}

/**
 * Bytes the conversation would occupy once stored: truncated messages count
 * only what survives truncation, matching how the server bills the quota.
 */
export function estimateStoredBytes(
    conversation: ParsedExternalConversation
): number {
    let bytes = 0;
    for (const message of conversation.messages) {
        const codePoints = countCodePoints(message.content);
        const plan = planExternalMessageTruncation(codePoints);
        if (plan.kind === "store_verbatim") {
            bytes += utf8ByteLength(message.content);
            continue;
        }
        if (plan.kind === "exceeds_inbound_limit") continue;
        // Truncated: estimate from the retained share of the message.
        const retained =
            (plan.headCodePoints + plan.tailCodePoints) / codePoints;
        bytes += Math.ceil(utf8ByteLength(message.content) * retained);
    }
    return bytes;
}

export function buildImportPreview(
    provider: ExternalAdapterProvider,
    conversations: readonly ParsedExternalConversation[],
    /**
     * Counts the archive scan produced, which no conversation can carry: a
     * skipped entry never became one.
     */
    archiveSkips: { nestedArchives: number } = { nestedArchives: 0 }
): ImportPreview {
    const rows: PreviewConversation[] = conversations.map((conversation) => ({
        conversation,
        importability: classifyConversation(conversation),
        estimatedStoredBytes: estimateStoredBytes(conversation),
    }));

    const totals = {
        conversations: rows.length,
        importableConversations: 0,
        requiresTruncationApproval: 0,
        notImportable: 0,
        messages: 0,
        estimatedStoredBytes: 0,
        skippedNonConversationMessages: 0,
        skippedNonTextParts: 0,
        additionalBranches: 0,
        skippedNestedArchives: archiveSkips.nestedArchives,
    };
    for (const row of rows) {
        if (row.importability.kind === "importable") {
            totals.importableConversations += 1;
        } else if (row.importability.kind === "requires_truncation_approval") {
            totals.requiresTruncationApproval += 1;
        } else {
            totals.notImportable += 1;
        }
        if (row.importability.kind !== "not_importable") {
            totals.messages += row.conversation.messages.length;
            totals.estimatedStoredBytes += row.estimatedStoredBytes;
        }
        const warnings = row.conversation.warnings;
        totals.skippedNonConversationMessages +=
            warnings.skippedNonConversationMessages;
        totals.skippedNonTextParts += warnings.skippedNonTextParts;
        totals.additionalBranches += warnings.additionalBranchCount;
    }

    return { provider, conversations: rows, totals };
}

export type BatchPayloadConversation = {
    rawExternalConversationId: string;
    title: string;
    sourceModelLabels?: string[];
    sourceCreatedAt?: string;
    sourceUpdatedAt?: string;
    messages: Array<{
        rawExternalMessageId: string;
        role: "user" | "assistant";
        ordinal: number;
        content: string;
        sourceModelLabel?: string;
        sourceTimestamp?: string;
    }>;
};

export type BatchPayload = {
    sequence: number;
    conversations: BatchPayloadConversation[];
};

export class ExternalImportPipelineError extends Error {
    constructor(
        message: string,
        public readonly reason:
            | "conversation_not_importable"
            | "conversation_too_large_for_batch"
            | "too_many_messages"
    ) {
        super(message);
        this.name = "ExternalImportPipelineError";
    }
}

const toPayload = (
    conversation: ParsedExternalConversation
): BatchPayloadConversation => ({
    rawExternalConversationId: conversation.rawExternalConversationId,
    title: conversation.title,
    ...(conversation.sourceModelLabels.length > 0
        ? { sourceModelLabels: conversation.sourceModelLabels }
        : {}),
    ...(conversation.sourceCreatedAt
        ? { sourceCreatedAt: conversation.sourceCreatedAt }
        : {}),
    ...(conversation.sourceUpdatedAt
        ? { sourceUpdatedAt: conversation.sourceUpdatedAt }
        : {}),
    messages: conversation.messages.map((message) => ({
        rawExternalMessageId: message.rawExternalMessageId,
        role: message.role,
        ordinal: message.ordinal,
        content: message.content,
        ...(message.sourceModelLabel
            ? { sourceModelLabel: message.sourceModelLabel }
            : {}),
        ...(message.sourceTimestamp
            ? { sourceTimestamp: message.sourceTimestamp }
            : {}),
    })),
});

/**
 * Groups the user's selection into batches. Conversations are never split,
 * so each batch is a whole number of them and the batch ledger's "resend the
 * last batch" retry stays meaningful.
 */
export function buildBatchPayloads(
    selected: readonly ParsedExternalConversation[],
    options: { maxRequestBytes?: number } = {}
): BatchPayload[] {
    const maxRequestBytes =
        options.maxRequestBytes ?? EXTERNAL_IMPORT_MAX_BATCH_REQUEST_BYTES;
    // Envelope allowance for the sequence field and array punctuation.
    const overheadBytes = 256;

    const batches: BatchPayload[] = [];
    let current: BatchPayloadConversation[] = [];
    let currentBytes = 0;

    const flush = () => {
        if (current.length === 0) return;
        batches.push({ sequence: batches.length, conversations: current });
        current = [];
        currentBytes = 0;
    };

    for (const conversation of selected) {
        if (classifyConversation(conversation).kind === "not_importable") {
            throw new ExternalImportPipelineError(
                "A selected conversation contains a message past the inbound limit.",
                "conversation_not_importable"
            );
        }
        if (
            conversation.messages.length >
            BATCH_SHAPE_LIMITS.maxMessagesPerConversation
        ) {
            throw new ExternalImportPipelineError(
                "A selected conversation has more messages than one request allows.",
                "too_many_messages"
            );
        }

        const payload = toPayload(conversation);
        const bytes = utf8ByteLength(JSON.stringify(payload));
        if (bytes + overheadBytes > maxRequestBytes) {
            // Splitting would put half a conversation on the server, which the
            // all-or-nothing contract does not allow.
            throw new ExternalImportPipelineError(
                "A single conversation is larger than one request allows.",
                "conversation_too_large_for_batch"
            );
        }
        if (
            current.length >= BATCH_SHAPE_LIMITS.maxConversationsPerBatch ||
            currentBytes + bytes + overheadBytes > maxRequestBytes
        ) {
            flush();
        }
        current.push(payload);
        currentBytes += bytes;
    }
    flush();
    return batches;
}

/**
 * Parses already-extracted entry values with the detected provider adapter.
 * Malformed entries are counted, never thrown on: one broken conversation
 * must not fail a whole archive (§5.6).
 */
export function parseConversationItems(
    provider: ExternalAdapterProvider,
    items: readonly unknown[]
): { conversations: ParsedExternalConversation[]; unparsableCount: number } {
    const adapter = getExternalImportAdapter(provider);
    const conversations: ParsedExternalConversation[] = [];
    let unparsableCount = 0;
    for (const item of items) {
        let parsed: ParsedExternalConversation | null = null;
        try {
            parsed = adapter.parseConversation(item);
        } catch {
            parsed = null;
        }
        if (parsed) conversations.push(parsed);
        else unparsableCount += 1;
    }
    return { conversations, unparsableCount };
}

/** Deduplicates across multi-part exports, keeping the richer snapshot. */
export function mergeConversationSets(
    sets: ReadonlyArray<readonly ParsedExternalConversation[]>
): ParsedExternalConversation[] {
    const byId = new Map<string, ParsedExternalConversation>();
    for (const set of sets) {
        for (const conversation of set) {
            const existing = byId.get(conversation.rawExternalConversationId);
            if (
                !existing ||
                conversation.messages.length > existing.messages.length
            ) {
                byId.set(conversation.rawExternalConversationId, conversation);
            }
        }
    }
    return [...byId.values()];
}

export const PIPELINE_ACCOUNT_LIMITS = LIMITS;
