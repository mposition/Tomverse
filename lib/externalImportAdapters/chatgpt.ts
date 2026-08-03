import {
    asIsoTimestamp,
    emptyWarnings,
    isRecord,
    type ExternalConversationAdapter,
    type ParsedExternalConversation,
    type ParsedExternalMessage,
} from "@/lib/externalImportAdapters/types";

/**
 * ChatGPT official export adapter.
 *
 * A ChatGPT conversation is not a list but a tree: `mapping` holds nodes
 * keyed by ID, each with `parent`/`children`, and `current_node` names the
 * leaf of the branch the user last had selected. Regenerated answers and
 * edited questions live on abandoned siblings.
 *
 * Policy §5.6: the current branch is what gets imported — walk from
 * `current_node` to the root and reverse. Branch points that hold more than
 * one child are *counted* (`additionalBranchCount`) so the preview can say
 * "this conversation has N alternate branches that will not be imported",
 * never silently interleaved.
 *
 * Unknown fields are ignored; unknown content types and non-string parts are
 * dropped and counted. This parser has no business guessing — a shape it
 * does not recognise is a warning count, not an import failure.
 */

const textFromParts = (
    parts: unknown,
    warnings: { skippedNonTextParts: number }
): string => {
    if (!Array.isArray(parts)) return "";
    const kept: string[] = [];
    for (const part of parts) {
        if (typeof part === "string") {
            kept.push(part);
        } else if (part !== null && part !== undefined) {
            warnings.skippedNonTextParts += 1;
        }
    }
    return kept.join("\n\n").trim();
};

const messageText = (
    content: unknown,
    warnings: { skippedNonTextParts: number }
): string => {
    if (!isRecord(content)) return "";
    const contentType = content.content_type;
    if (contentType === "text" || contentType === "multimodal_text") {
        return textFromParts(content.parts, warnings);
    }
    if (contentType === "code" && typeof content.text === "string") {
        return content.text.trim();
    }
    // Anything else (tool payloads, thoughts, images…) is not conversation
    // text and must not be smuggled in as one.
    warnings.skippedNonTextParts += 1;
    return "";
};

export const chatgptAdapter: ExternalConversationAdapter = {
    provider: "chatgpt",

    detect(value: unknown): boolean {
        if (!Array.isArray(value) || value.length === 0) return false;
        const first = value[0];
        return (
            isRecord(first) &&
            isRecord(first.mapping) &&
            "current_node" in first
        );
    },

    parseConversation(entry: unknown): ParsedExternalConversation | null {
        if (!isRecord(entry) || !isRecord(entry.mapping)) return null;
        const mapping = entry.mapping;
        const rawId =
            typeof entry.conversation_id === "string" && entry.conversation_id
                ? entry.conversation_id
                : typeof entry.id === "string" && entry.id
                  ? entry.id
                  : null;
        if (!rawId) return null;

        const warnings = emptyWarnings();

        // Current branch: leaf -> root via parent pointers, then reverse.
        const chain: Record<string, unknown>[] = [];
        const seen = new Set<string>();
        let cursor =
            typeof entry.current_node === "string" ? entry.current_node : null;
        while (cursor && !seen.has(cursor)) {
            seen.add(cursor);
            const node = mapping[cursor];
            if (!isRecord(node)) break;
            chain.push(node);
            cursor = typeof node.parent === "string" ? node.parent : null;
        }
        chain.reverse();

        for (const node of Object.values(mapping)) {
            if (
                isRecord(node) &&
                Array.isArray(node.children) &&
                node.children.length > 1
            ) {
                warnings.additionalBranchCount += node.children.length - 1;
            }
        }

        const messages: ParsedExternalMessage[] = [];
        const modelLabels = new Set<string>();
        for (const node of chain) {
            const message = node.message;
            if (!isRecord(message)) continue;
            const author = isRecord(message.author) ? message.author : null;
            const role = author?.role;
            if (role !== "user" && role !== "assistant") {
                if (role !== undefined) {
                    warnings.skippedNonConversationMessages += 1;
                }
                continue;
            }
            const content = messageText(message.content, warnings);
            if (!content) {
                warnings.skippedEmptyMessages += 1;
                continue;
            }
            const metadata = isRecord(message.metadata) ? message.metadata : null;
            const modelSlug =
                typeof metadata?.model_slug === "string" && metadata.model_slug
                    ? metadata.model_slug
                    : null;
            if (modelSlug && role === "assistant") modelLabels.add(modelSlug);
            messages.push({
                rawExternalMessageId:
                    typeof message.id === "string" && message.id
                        ? message.id
                        : `${rawId}-ordinal-${messages.length}`,
                role,
                ordinal: messages.length,
                content,
                sourceModelLabel: role === "assistant" ? modelSlug : null,
                sourceTimestamp: asIsoTimestamp(message.create_time),
            });
        }
        if (messages.length === 0) return null;

        return {
            rawExternalConversationId: rawId,
            title:
                typeof entry.title === "string" && entry.title.trim()
                    ? entry.title.trim()
                    : "Untitled conversation",
            sourceModelLabels: [...modelLabels],
            sourceCreatedAt: asIsoTimestamp(entry.create_time),
            sourceUpdatedAt: asIsoTimestamp(entry.update_time),
            messages,
            warnings,
        };
    },
};
