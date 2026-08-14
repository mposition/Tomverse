import {
    countImages,
    GeminiMarkupError,
    geminiHtmlToMarkdown,
} from "@/lib/externalImportAdapters/geminiHtml";
import {
    asIsoTimestamp,
    emptyWarnings,
    isRecord,
    type ExternalConversationAdapter,
    type ParsedExportExtras,
    type ParsedExternalConversation,
    type ParsedExternalMessage,
} from "@/lib/externalImportAdapters/types";

/**
 * Google Takeout (Gemini) adapter.
 *
 * docs/policy/external-import-gemini-a2.md — read §2.2 before changing how
 * identity is derived.
 *
 * This export is not shaped like the others. ChatGPT and Claude hand over one
 * document per conversation; Takeout hands over `My Activity`, a flat list of
 * turns, where each entry is one prompt (`title`, plain text) and one answer
 * (`safeHtmlItem[].html`, rendered HTML). The conversation an entry belongs to
 * is named by `details[].url` — `https://gemini.google.com/app/<16 hex>` — and
 * an entry can name **several**, because branching a chat leaves every turn
 * before the branch point in each branch. That is why this adapter implements
 * `parseAll` rather than `parseConversation`: grouping is the whole job, and it
 * cannot be done one entry at a time.
 *
 * Nothing here reads a translated string. The archive path, `header`,
 * `products`, `activityControls` and every subtitle are localised to the
 * account's language (§3.1), so recognition and every rule below key on
 * structure and on the one URL that is the same in every locale.
 */

const CHAT_URL = /^https:\/\/gemini\.google\.com\/app\/([0-9a-f]{6,})$/;

/** How much of the first prompt stands in for a title the export never had. */
const TITLE_CODE_POINTS = 80;

type Turn = {
    /** Conversations this turn belongs to; more than one means a branch. */
    chatIds: string[];
    time: string;
    prompt: string;
    answerHtml: string;
    attachments: string[];
};

/** Total string order, used to make timestamp ties deterministic. */
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const stringField = (entry: Record<string, unknown>, key: string): string =>
    typeof entry[key] === "string" ? (entry[key] as string) : "";

const chatIdsOf = (entry: Record<string, unknown>): string[] => {
    if (!Array.isArray(entry.details)) return [];
    const ids: string[] = [];
    for (const detail of entry.details) {
        if (!isRecord(detail) || typeof detail.url !== "string") continue;
        const match = CHAT_URL.exec(detail.url);
        if (match && !ids.includes(match[1])) ids.push(match[1]);
    }
    return ids;
};

const attachmentsOf = (entry: Record<string, unknown>): string[] => {
    const names: string[] = [];
    if (Array.isArray(entry.attachedFiles)) {
        for (const file of entry.attachedFiles) {
            if (typeof file === "string" && file) names.push(file);
            else if (isRecord(file) && typeof file.name === "string" && file.name) {
                names.push(file.name);
            }
        }
    }
    if (typeof entry.imageFile === "string" && entry.imageFile) names.push(entry.imageFile);
    return names;
};

const answerHtmlOf = (entry: Record<string, unknown>): string => {
    if (!Array.isArray(entry.safeHtmlItem)) return "";
    return entry.safeHtmlItem
        .map((item) => (isRecord(item) && typeof item.html === "string" ? item.html : ""))
        .filter(Boolean)
        .join("\n");
};

/** True when the entry has the shape of a Gemini Apps activity record. */
const looksLikeActivityEntry = (value: unknown): boolean =>
    isRecord(value) &&
    typeof value.title === "string" &&
    typeof value.time === "string" &&
    chatIdsOf(value).length > 0;

const truncateTitle = (prompt: string): string => {
    const collapsed = prompt.replace(/\s+/g, " ").trim();
    const points = Array.from(collapsed);
    if (points.length === 0) return "Untitled conversation";
    return points.length <= TITLE_CODE_POINTS
        ? collapsed
        : `${points.slice(0, TITLE_CODE_POINTS).join("")}…`;
};

export const geminiAdapter: ExternalConversationAdapter = {
    provider: "gemini",

    detect(value: unknown): boolean {
        if (!Array.isArray(value) || value.length === 0) return false;
        // Not every entry carries a chat link -- a real export had two that
        // carried none at all -- so a prefix is scanned rather than the first
        // entry alone. Bounded so detection stays cheap on a large export.
        return value.slice(0, 100).some(looksLikeActivityEntry);
    },

    /**
     * Present only to satisfy the shared contract. A single activity entry is
     * one turn, and a turn is not a conversation; grouping happens in
     * `parseAll`, which is what the pipeline calls when an adapter provides it.
     */
    parseConversation(): ParsedExternalConversation | null {
        return null;
    },

    parseAll(items: readonly unknown[]): {
        conversations: ParsedExternalConversation[];
        unparsableCount: number;
        extras: ParsedExportExtras;
    } {
        const turns: Turn[] = [];
        const attachmentReferences: string[] = [];
        let unparsableCount = 0;
        let unassignedTurns = 0;

        for (const item of items) {
            if (!isRecord(item)) {
                unparsableCount += 1;
                continue;
            }
            const prompt = stringField(item, "title").trim();
            const time = asIsoTimestamp(item.time);
            if (!prompt || !time) {
                unparsableCount += 1;
                continue;
            }
            const chatIds = chatIdsOf(item);
            if (chatIds.length === 0) {
                // §5: the export does not say which conversation this belongs
                // to, so it is reported rather than guessed at or dropped
                // quietly. Grouping by time proximity is forbidden (§2).
                unassignedTurns += 1;
                continue;
            }
            const attachments = attachmentsOf(item);
            attachmentReferences.push(...attachments);
            turns.push({
                chatIds,
                time,
                prompt,
                answerHtml: answerHtmlOf(item),
                attachments,
            });
        }

        const byChat = new Map<string, Turn[]>();
        for (const turn of turns) {
            for (const chatId of turn.chatIds) {
                const bucket = byChat.get(chatId);
                if (bucket) bucket.push(turn);
                else byChat.set(chatId, [turn]);
            }
        }

        const conversations: ParsedExternalConversation[] = [];
        for (const [chatId, chatTurns] of byChat) {
            const conversation = buildConversation(chatId, chatTurns);
            if (conversation) conversations.push(conversation);
        }

        return {
            conversations,
            unparsableCount,
            extras: { unassignedTurns, attachmentReferences },
        };
    },
};

function buildConversation(
    chatId: string,
    chatTurns: readonly Turn[]
): ParsedExternalConversation | null {
    // File order is not conversation order: a real export was not globally
    // sorted, and per-chat order there was newest-first. Time decides.
    //
    // Ties are broken by content, never by file position. Two turns can share
    // a millisecond, and ordering them by where they happened to sit in the
    // file made the ordinals -- and the IDs derived from them -- depend on the
    // file's ordering: the same ID named a different message when the same
    // export was read back to front. Comparing the text itself is total,
    // deterministic and independent of how the export was written out.
    const ordered = [...chatTurns].sort(
        (a, b) =>
            compare(a.time, b.time) ||
            compare(a.prompt, b.prompt) ||
            compare(a.answerHtml, b.answerHtml)
    );

    const warnings = emptyWarnings();
    const messages: ParsedExternalMessage[] = [];
    const usedIds = new Map<string, number>();

    /**
     * §2.2: identity comes from the provider's own chat ID and the turn's own
     * timestamp. Never the array index and never the branch's length -- both
     * move between exports, and an ID that moves makes a re-import a different
     * lineage. Scoping to `chatId` is what lets the same shared turn live in
     * four branches as four messages instead of collapsing into one.
     *
     * The occurrence suffix disambiguates turns sharing a millisecond. It is
     * safe only because `ordered` above sorts ties by content: a suffix handed
     * out in file order would name a different message in a differently
     * ordered export of the same account. With a content-ordered tie, two
     * turns that still collide are identical, so either assignment maps the
     * ID to the same text.
     */
    const messageId = (time: string, role: "u" | "a"): string => {
        const base = `${chatId}:${time}:${role}`;
        const seen = usedIds.get(base) ?? 0;
        usedIds.set(base, seen + 1);
        return seen === 0 ? base : `${base}:${seen}`;
    };

    for (const turn of ordered) {
        const shared = turn.chatIds.length > 1;
        if (turn.attachments.length > 0) {
            // Attachments are never copied (§4); the count is what the preview
            // shows so the user knows what a re-import cannot recover.
            warnings.skippedNonTextParts += turn.attachments.length;
        }

        messages.push({
            rawExternalMessageId: messageId(turn.time, "u"),
            role: "user",
            ordinal: messages.length,
            content: turn.prompt,
            // Takeout records no model identifier per turn.
            sourceModelLabel: null,
            sourceTimestamp: turn.time,
        });
        if (shared) warnings.duplicatedPrefixMessages += 1;

        if (!turn.answerHtml) {
            warnings.skippedEmptyMessages += 1;
            continue;
        }
        warnings.skippedNonTextParts += countImages(turn.answerHtml);
        let answer: string;
        try {
            answer = geminiHtmlToMarkdown(turn.answerHtml);
        } catch (error) {
            if (!(error instanceof GeminiMarkupError)) throw error;
            // §5: an answer we cannot render exactly is dropped and counted,
            // never stored half-converted. The prompt is plain text and is
            // understood, so it stays.
            warnings.skippedUnrecognizedContent += 1;
            continue;
        }
        if (!answer) {
            warnings.skippedEmptyMessages += 1;
            continue;
        }
        messages.push({
            rawExternalMessageId: messageId(turn.time, "a"),
            role: "assistant",
            ordinal: messages.length,
            content: answer,
            sourceModelLabel: null,
            sourceTimestamp: turn.time,
        });
        if (shared) warnings.duplicatedPrefixMessages += 1;
    }

    if (messages.length === 0) return null;

    const firstPrompt = ordered.find((turn) => turn.prompt)?.prompt ?? "";
    return {
        rawExternalConversationId: chatId,
        // Takeout gives conversations no title. The opening prompt, shortened,
        // is what Gemini itself shows in its own list, and it is derived rather
        // than invented -- but it is only a label: the prompt is stored once,
        // as the first user message, and this does not add to what is stored.
        title: truncateTitle(firstPrompt),
        sourceModelLabels: [],
        sourceCreatedAt: ordered[0]?.time ?? null,
        sourceUpdatedAt: ordered[ordered.length - 1]?.time ?? null,
        messages,
        warnings,
    };
}
