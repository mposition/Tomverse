import {
    asIsoTimestamp,
    emptyWarnings,
    isRecord,
    type ExternalConversationAdapter,
    type ParsedExternalConversation,
    type ParsedExternalMessage,
} from "@/lib/externalImportAdapters/types";

/**
 * Claude official export adapter.
 *
 * A Claude export conversation is a flat `chat_messages` list. Each message
 * carries both a legacy `text` field and a structured `content` array; the
 * content array is authoritative when present (multipart answers put prose
 * in several `{type:"text"}` blocks), with `text` as the fallback for older
 * exports. Non-text blocks (tool use/results, attachments, thinking) are
 * dropped and counted — same rule as every adapter (§5.6).
 */

const messageText = (
    message: Record<string, unknown>,
    warnings: { skippedNonTextParts: number }
): string => {
    if (Array.isArray(message.content)) {
        const kept: string[] = [];
        for (const block of message.content) {
            if (isRecord(block) && block.type === "text") {
                if (typeof block.text === "string" && block.text) {
                    kept.push(block.text);
                }
            } else if (block !== null && block !== undefined) {
                warnings.skippedNonTextParts += 1;
            }
        }
        if (kept.length > 0) return kept.join("\n\n").trim();
    }
    return typeof message.text === "string" ? message.text.trim() : "";
};

export const claudeAdapter: ExternalConversationAdapter = {
    provider: "claude",

    detect(value: unknown): boolean {
        if (!Array.isArray(value) || value.length === 0) return false;
        const first = value[0];
        return (
            isRecord(first) &&
            Array.isArray(first.chat_messages) &&
            typeof first.uuid === "string"
        );
    },

    parseConversation(entry: unknown): ParsedExternalConversation | null {
        if (!isRecord(entry) || !Array.isArray(entry.chat_messages)) return null;
        const rawId = typeof entry.uuid === "string" && entry.uuid ? entry.uuid : null;
        if (!rawId) return null;

        const warnings = emptyWarnings();
        const messages: ParsedExternalMessage[] = [];

        for (const raw of entry.chat_messages) {
            if (!isRecord(raw)) continue;
            const sender = raw.sender;
            const role =
                sender === "human"
                    ? ("user" as const)
                    : sender === "assistant"
                      ? ("assistant" as const)
                      : null;
            if (!role) {
                warnings.skippedNonConversationMessages += 1;
                continue;
            }
            const content = messageText(raw, warnings);
            if (!content) {
                warnings.skippedEmptyMessages += 1;
                continue;
            }
            messages.push({
                rawExternalMessageId:
                    typeof raw.uuid === "string" && raw.uuid
                        ? raw.uuid
                        : `${rawId}-ordinal-${messages.length}`,
                role,
                ordinal: messages.length,
                content,
                // Claude exports carry no per-message model identifier.
                sourceModelLabel: null,
                sourceTimestamp: asIsoTimestamp(raw.created_at),
            });
        }
        if (messages.length === 0) return null;

        return {
            rawExternalConversationId: rawId,
            title:
                typeof entry.name === "string" && entry.name.trim()
                    ? entry.name.trim()
                    : "Untitled conversation",
            sourceModelLabels: [],
            sourceCreatedAt: asIsoTimestamp(entry.created_at),
            sourceUpdatedAt: asIsoTimestamp(entry.updated_at),
            messages,
            warnings,
        };
    },
};
