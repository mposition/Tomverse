import "server-only";

import { jsonSchema, tool, type ToolSet } from "ai";
import type { Prisma } from "@prisma/client";
import { consumeApiRateLimit } from "@/lib/apiSecurity";
import { definitionTokensOf, type ChatReadPart } from "@/lib/chatToolLoop";
import { conversationHandoffHref, conversationSurface } from "@/lib/continuationRoutes";
import { resolveConversationMemoryMode } from "@/lib/conversationMemoryMode";
import { searchConversationMessages } from "@/lib/conversationSearch";
import { getMemorySettings } from "@/lib/memoryService";
import { prisma } from "@/lib/prisma";
import { REVIEW_WORKSPACE_PATH } from "@/lib/productSurfaceRoutes";
import { frameHistoryText, HISTORY_REFERENCE_RULES, inertToolLabel } from "@/lib/untrustedToolText";
import { sanitizeWebSearchCitations, type WebSearchCitation } from "@/lib/webSearchCitations";

/**
 * search_past_chats: the model finds what the user said in earlier
 * conversations ("last time we talked about...").
 *
 * Off unless `CHAT_HISTORY_REFERENCE_ENABLED` is exactly "true".
 *
 * ## The boundary is code, not the prompt
 *
 * Which conversations the model may see is decided here, deterministically,
 * and pinned by tests (tests/server-contract/chat-history-reference.test.mjs):
 *
 *   * only the signed-in account's own conversations;
 *   * a password-locked conversation is excluded entirely, its title too. The
 *     search runs with a request that carries no unlock grant, so every locked
 *     conversation is denied inside the query, and the result is checked again
 *     against `referenceableConversationWhere`;
 *   * the current conversation is excluded (the model already has it);
 *   * the tool exists only while this conversation's memory is on, resolved
 *     the same way memory injection resolves it, and only without an assistant
 *     profile (a profile can switch memory off for its conversations);
 *   * a conversation whose own memory mode is off is not referenced either:
 *     the user said "do not use this one";
 *   * conversations inside a project stay inside it (project_search is the
 *     tool there), and imported transcripts are never searched;
 *   * counts and excerpt length are capped; the cap is the reserved allowance.
 *
 * Everything the tool returns is quoted history, framed as untrusted data
 * (`lib/untrustedToolText.ts`). The answer's source list links each
 * conversation that was used, so the user can open it.
 *
 * ## One place for "which conversations count"
 *
 * `referenceableConversationWhere` is the only place the eligibility of a
 * *target* conversation is written. A later rule (for example excluding
 * temporary chats) is one more line there.
 */

export const CHAT_HISTORY_REFERENCE_ENV = "CHAT_HISTORY_REFERENCE_ENABLED";

export const chatHistoryReferenceEnabled = (env: Record<string, string | undefined> = process.env) =>
    env[CHAT_HISTORY_REFERENCE_ENV] === "true";

export const CHAT_HISTORY_LIMITS = {
    /** search_past_chats calls in one turn. */
    calls: 3,
    queriesPerCall: 3,
    /** Conversations named in one answer. */
    conversations: 5,
    excerptsPerConversation: 2,
    excerptCharacters: 360,
    /** Characters of history one turn may return: the reserved allowance. */
    turnCharacters: 8_000,
    queryMaxLength: 80,
    perMinute: 10,
    perDay: 300,
} as const;

export const CHAT_HISTORY_MAX_STEPS = 4;

/** What a conversation must be to be referenced by the model. */
export const referenceableConversationWhere = (input: {
    userId: string;
    currentConversationId: string;
}): Prisma.ConversationWhereInput => ({
    userId: input.userId,
    id: { not: input.currentConversationId },
    // Locked conversations are never shown to the model, whatever the browser
    // has unlocked: the grant is a person's, the model is not that person.
    password: null,
    // Image conversations hold tool requests, not conversation history.
    kind: { not: "image" },
    // A project's conversations are reached through project_search.
    projectId: null,
});

/** The tool is offered only while this conversation's memory is on. */
export async function historyReferenceAllowed(input: {
    userId: string;
    conversationId: string;
}): Promise<boolean> {
    const [settings, conversation] = await Promise.all([
        getMemorySettings(input.userId),
        prisma.conversation.findFirst({
            // Not in a project: a project conversation is answered from its own scope, never from the account's other chats.
            where: { id: input.conversationId, userId: input.userId, password: null, projectId: null },
            select: { memoryMode: true, assistantProfileVersionId: true },
        }),
    ]);
    if (!conversation || !settings.masterEnabled || conversation.assistantProfileVersionId) return false;
    return resolveConversationMemoryMode(conversation.memoryMode, settings.defaultConversationMode) === "on";
}

const publicOrigin = () =>
    (process.env.PUBLIC_APP_URL || process.env.NEXT_PUBLIC_APP_URL || "https://tomverse.app").replace(/\/+$/u, "");

/** An absolute link to a conversation, in the form the source list can show. */
export function conversationSourceUrl(conversationId: string, productKey: string | null): string {
    const surface = conversationSurface({ hasContinuationBridge: false, productKey });
    return `${publicOrigin()}${conversationHandoffHref(surface, conversationId, REVIEW_WORKSPACE_PATH)}`;
}

export type ChatHistorySearch = (input: {
    userId: string;
    query: string;
    currentConversationId: string;
}) => Promise<{
    conversations: Array<{ id: string; title: string; productKey: string | null; excerpts: Array<{ role: string; excerpt: string }> }>;
    incomplete: boolean;
}>;

/** The production search: the user's own messages, filtered by `referenceableConversationWhere`. */
export const searchPastChats: ChatHistorySearch = async ({ userId, query, currentConversationId }) => {
    const settings = await getMemorySettings(userId);
    const answer = await searchConversationMessages({
        // No cookies: no unlock grant exists, so every locked conversation is denied in the query.
        request: new Request("https://tomverse.invalid/"),
        userId,
        query,
        displayTimeZone: "UTC",
        excludeConversationId: currentConversationId,
        // Eligibility is part of the candidate query (before the row limit); the checks below repeat it.
        modelReference: { accountMemoryDefaultOff: settings.defaultConversationMode === "off" },
    });
    const hits = answer.results.filter((result) => result.kind === "native");
    const ids = [...new Set(hits.map((hit) => hit.conversationId))];
    if (!ids.length) return { conversations: [], incomplete: answer.truncated };
    const [eligible] = await Promise.all([
        prisma.conversation.findMany({
            where: { AND: [referenceableConversationWhere({ userId, currentConversationId }), { id: { in: ids } }] },
            select: { id: true, title: true, productKey: true, memoryMode: true },
        }),
    ]);
    const usable = new Map(
        eligible
            .filter((row) => resolveConversationMemoryMode(row.memoryMode, settings.defaultConversationMode) === "on")
            .map((row) => [row.id, row])
    );
    const byConversation = new Map<string, Array<{ role: string; excerpt: string }>>();
    for (const hit of hits) {
        if (!usable.has(hit.conversationId)) continue;
        const list = byConversation.get(hit.conversationId) ?? [];
        list.push({ role: hit.role, excerpt: hit.snippet });
        byConversation.set(hit.conversationId, list);
    }
    return {
        conversations: [...byConversation].map(([id, excerpts]) => {
            const row = usable.get(id)!;
            return { id, title: row.title, productKey: row.productKey, excerpts };
        }),
        incomplete: answer.truncated,
    };
};

export function buildChatHistoryReferencePart(input: {
    userId: string;
    conversationId: string;
    /** The chat request, for the per-account rate limit. */
    request: Request;
    signal: AbortSignal;
    onState?: (state: "history_searching" | "done") => void;
    search?: ChatHistorySearch;
    /** Re-checks the offer conditions at call time (memory can be switched off mid-turn). */
    stillAllowed?: () => Promise<boolean>;
    rateLimit?: () => Promise<void>;
}): ChatReadPart {
    const search = input.search ?? searchPastChats;
    const stillAllowed = input.stillAllowed ?? (() => historyReferenceAllowed(input));
    const rateLimit = input.rateLimit ?? (() =>
        consumeApiRateLimit(input.request, input.userId, "chat-history-reference", {
            minute: CHAT_HISTORY_LIMITS.perMinute,
            day: CHAT_HISTORY_LIMITS.perDay,
        }));
    const citations = new Map<string, WebSearchCitation>();
    let calls = 0;
    let returnedChars = 0;
    const limitReached = {
        status: "limit_reached",
        note: "The past-conversation allowance for this answer is used up. Answer from what you have and say what was not checked.",
    };

    const tools: ToolSet = {
        search_past_chats: tool({
            description: HISTORY_REFERENCE_RULES,
            inputSchema: jsonSchema<{ queries: string[] }>({
                type: "object",
                properties: {
                    queries: {
                        type: "array",
                        items: { type: "string", minLength: 2, maxLength: CHAT_HISTORY_LIMITS.queryMaxLength },
                        minItems: 1,
                        maxItems: CHAT_HISTORY_LIMITS.queriesPerCall,
                    },
                },
                required: ["queries"],
                additionalProperties: false,
            }),
            execute: async ({ queries }) => {
                input.signal.throwIfAborted();
                if (++calls > CHAT_HISTORY_LIMITS.calls) return limitReached;
                if (!(await stillAllowed())) {
                    return { status: "unavailable", reason: "memory_off", note: "Past conversations cannot be used in this conversation." };
                }
                try {
                    await rateLimit();
                } catch {
                    return { status: "unavailable", reason: "rate_limited", note: "Searching past conversations is busy. Say this could not be checked." };
                }
                input.onState?.("history_searching");
                const list = (Array.isArray(queries) ? queries : [])
                    .map((query) => String(query).trim())
                    .filter((query) => query.length >= 2 && query.length <= CHAT_HISTORY_LIMITS.queryMaxLength)
                    .slice(0, CHAT_HISTORY_LIMITS.queriesPerCall);
                if (!list.length) return { status: "unavailable", reason: "no_valid_query" };
                const answers: Awaited<ReturnType<ChatHistorySearch>>[] = [];
                try {
                    // One at a time: each search is its own database snapshot, and three at once would triple the load of a single call.
                    for (const query of list) {
                        answers.push(await search({ userId: input.userId, query, currentConversationId: input.conversationId }));
                    }
                } catch {
                    input.onState?.("done");
                    return { status: "unavailable", reason: "search_failed", note: "Say that past conversations could not be checked." };
                }
                const merged = new Map<string, { id: string; title: string; productKey: string | null; excerpts: Array<{ role: string; excerpt: string }> }>();
                for (const answer of answers) {
                    for (const conversation of answer.conversations) {
                        const existing = merged.get(conversation.id);
                        if (!existing) merged.set(conversation.id, { ...conversation, excerpts: [...conversation.excerpts] });
                        else existing.excerpts.push(...conversation.excerpts);
                    }
                }
                const conversations = [...merged.values()].slice(0, CHAT_HISTORY_LIMITS.conversations);
                const results = conversations.map((conversation) => ({
                    conversation: inertToolLabel(conversation.title, 120),
                    excerpts: conversation.excerpts.slice(0, CHAT_HISTORY_LIMITS.excerptsPerConversation).map((excerpt) => ({
                        role: excerpt.role,
                        text: inertToolLabel(excerpt.excerpt, CHAT_HISTORY_LIMITS.excerptCharacters),
                    })),
                }));
                const framed = frameHistoryText(JSON.stringify(results));
                if (returnedChars + framed.length > CHAT_HISTORY_LIMITS.turnCharacters) return limitReached;
                returnedChars += framed.length;
                for (const conversation of conversations) {
                    const [citation] = sanitizeWebSearchCitations([{
                        url: conversationSourceUrl(conversation.id, conversation.productKey),
                        title: inertToolLabel(conversation.title, 120),
                        sourceProvider: "past_chat",
                    }]);
                    if (citation) citations.set(citation.url, citation);
                }
                input.onState?.("done");
                return {
                    status: conversations.length ? (answers.some((answer) => answer.incomplete) ? "partial" : "ok") : "no_results",
                    data: framed,
                };
            },
        }),
    };

    return {
        tools,
        definitionTokens: definitionTokensOf(tools, HISTORY_REFERENCE_RULES),
        resultInputAllowance: CHAT_HISTORY_LIMITS.turnCharacters,
        maxSteps: CHAT_HISTORY_MAX_STEPS,
        citations: () => [...citations.values()],
    };
}
