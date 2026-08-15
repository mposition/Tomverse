/**
 * Provider adapter contract for external conversation import (Release A, A2).
 *
 * docs/policy/external-conversation-import-and-memory.md §5.6 and the
 * adapter contract of the approved implementation program.
 *
 * Adapters are pure and isomorphic — they run inside the browser Web Worker
 * against parsed JSON values, never against the archive itself, and never
 * import Node APIs. They normalize; they do not decide. Everything they emit
 * is re-validated, re-digested and re-truncated by the server (§4.1, §5.4).
 *
 * Only user/assistant text survives normalization. system / developer / tool
 * / reasoning content and non-text parts are dropped and *counted*, never
 * silently converted into conversation text — the counts surface in the
 * preview so the user knows what a re-import cannot recover.
 */

export type ExternalAdapterProvider = "chatgpt" | "claude" | "gemini";

export type ParsedExternalMessage = {
    rawExternalMessageId: string;
    role: "user" | "assistant";
    /** Sequential over kept messages, 0-based — the storage ordinal. */
    ordinal: number;
    content: string;
    sourceModelLabel: string | null;
    /** ISO 8601, or null when the export carries no usable timestamp. */
    sourceTimestamp: string | null;
};

export type ParsedConversationWarnings = {
    /** system/developer/tool/other non-conversation messages dropped. */
    skippedNonConversationMessages: number;
    /** Non-text content parts (images, audio, tool payloads) dropped. */
    skippedNonTextParts: number;
    /** Messages that were empty after normalization. */
    skippedEmptyMessages: number;
    /** ChatGPT only: branch points not on the current branch (§5.6). */
    additionalBranchCount: number;
    /**
     * Messages this conversation shares with another one because the user
     * branched the chat (A2 §2.2). Each branch is imported whole, so a shared
     * turn really is stored once per branch and really does cost quota once
     * per branch; the preview says so rather than letting the total surprise
     * the user.
     */
    duplicatedPrefixMessages: number;
    /**
     * Content dropped because normalizing it exactly was not possible — an
     * answer whose markup is outside the vocabulary the adapter renders. A
     * half-converted answer is worse than a counted absence (A2 §5).
     */
    skippedUnrecognizedContent: number;
};

/**
 * Counts that belong to the export rather than to any one conversation, so
 * there is nowhere in `ParsedExternalConversation` to put them.
 */
export type ParsedExportExtras = {
    /**
     * Turns the export did not assign to any conversation. Reported, never
     * guessed at: grouping by time proximity is forbidden (A2 §2).
     */
    unassignedTurns: number;
    /**
     * Filenames the export's turns reference. Attachments are never copied,
     * and only the caller holding the archive listing can tell which of these
     * the archive actually contains (A2 §4.1).
     */
    attachmentReferences: string[];
};

export const emptyExportExtras = (): ParsedExportExtras => ({
    unassignedTurns: 0,
    attachmentReferences: [],
});

export type ParsedExternalConversation = {
    rawExternalConversationId: string;
    title: string;
    sourceModelLabels: string[];
    sourceCreatedAt: string | null;
    sourceUpdatedAt: string | null;
    messages: ParsedExternalMessage[];
    warnings: ParsedConversationWarnings;
};

export type ExternalConversationAdapter = {
    provider: ExternalAdapterProvider;
    /** Does this parsed top-level export value belong to this provider? */
    detect(value: unknown): boolean;
    /**
     * Normalizes one top-level conversation entry. Returns null when the
     * entry is too malformed to import — the caller counts it and moves on;
     * one broken entry never fails the whole archive.
     */
    parseConversation(entry: unknown): ParsedExternalConversation | null;
    /**
     * Optional whole-export parse, for a provider whose export is not one
     * conversation per top-level entry. Google Takeout is a flat list of
     * turns, and which conversations a turn belongs to — plural, when the
     * chat was branched — is only knowable with the whole list in hand.
     *
     * When present the pipeline calls this instead of `parseConversation`.
     */
    parseAll?(items: readonly unknown[]): {
        conversations: ParsedExternalConversation[];
        unparsableCount: number;
        extras: ParsedExportExtras;
    };
};

export const emptyWarnings = (): ParsedConversationWarnings => ({
    skippedNonConversationMessages: 0,
    skippedNonTextParts: 0,
    skippedEmptyMessages: 0,
    additionalBranchCount: 0,
    duplicatedPrefixMessages: 0,
    skippedUnrecognizedContent: 0,
});

export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

export const asIsoTimestamp = (value: unknown): string | null => {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        // ChatGPT exports unix seconds (fractional); Claude exports ISO.
        return new Date(value * 1000).toISOString();
    }
    if (typeof value === "string" && value) {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }
    return null;
};
