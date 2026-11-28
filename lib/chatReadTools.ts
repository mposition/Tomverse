import "server-only";

import { buildChatHistoryReferencePart, chatHistoryReferenceEnabled, historyReferenceAllowed } from "@/lib/chatHistoryReference";
import { buildChatMemoryToolPart, chatMemoryToolEnabled, memoryToolAllowed } from "@/lib/chatMemoryTool";
import { composeChatToolLoop, type ChatReadPart, type ChatToolSlot } from "@/lib/chatToolLoop";
import { buildChatUrlReadPart, chatUrlReadingEnabled, userLinksFromMessages } from "@/lib/chatUrlReadTool";
import { getArtifactToolSupport, type ArtifactToolModel } from "@/lib/generatedArtifactToolPolicy";
import type { ProjectChatTools } from "@/lib/projectChatTools";
import type { WebSearchCitation } from "@/lib/webSearchCitations";

/**
 * The chat read tools of one turn (`read_url`, `search_past_chats`), the
 * `save_memory` tool, and the rule for when a turn gets them. The chat route calls `withChatReadTools`
 * once; everything else it needs (the reservation, the step cap, the budget
 * guard) is the existing project-tool slot, which these tools share.
 *
 * Each tool is a default-off switch (`CHAT_URL_READING_ENABLED`,
 * `CHAT_HISTORY_REFERENCE_ENABLED`, `CHAT_MEMORY_TOOL_ENABLED`). None costs a credit of its own: the
 * tokens a turn reads and writes are priced as always, and the definitions and
 * result allowance are reserved per pass like every application tool.
 */

/** The text of a user message whether its content is a string or a list of parts. */
export const messageText = (content: unknown): string =>
    typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("\n")
          : "";

export type ChatReadProgress = "page_reading" | "page_unavailable" | "history_searching" | "done";

export type ChatReadToolContext = {
    userId: string | null | undefined;
    conversationId: string | null | undefined;
    /** The stored product of this conversation; read tools are Chat-only. */
    productKey: string | null | undefined;
    model: ArtifactToolModel;
    /** A provider-native search tool is on the request: application tools do not share it. */
    nativeSearch: boolean;
    /** Plugin tools own the loop of this turn. */
    otherToolOwner: boolean;
    /** Research and Deep Research turns have their own read paths. */
    researchTurn: boolean;
    /** An assistant profile is running (it may switch memory off for its conversations). */
    profileActive: boolean;
    /** What the user wrote in this conversation, oldest first: text, or content parts with text in them. */
    userMessages: readonly unknown[];
    request: Request;
    signal: AbortSignal;
    /** The project tools when the conversation is in a project, else null. */
    base: ProjectChatTools | null;
    onProgress?: (state: ChatReadProgress) => void;
    env?: Record<string, string | undefined>;
};

/** The turn-level gate both read tools share. */
const chatReadToolsEligible = (context: Pick<ChatReadToolContext, "userId" | "conversationId" | "productKey" | "researchTurn" | "nativeSearch" | "otherToolOwner" | "model">) =>
    Boolean(context.userId) && Boolean(context.conversationId) &&
    context.productKey === "chat" &&
    !context.researchTurn && !context.nativeSearch && !context.otherToolOwner &&
    getArtifactToolSupport(context.model) === "verified";

/**
 * Whether this turn will carry `read_url`. Pure and synchronous so the chat route can ask it
 * before the system blocks are built: a turn that can read a pasted link must not be told, in
 * the same request, that nothing on the web is reachable (`lib/webSearchCapabilityPrompt.ts`).
 * It decides from the same gate and the same link scan as `withChatReadTools`.
 */
export const chatUrlReadOffered = (
    context: Pick<ChatReadToolContext, "userId" | "conversationId" | "productKey" | "researchTurn" | "nativeSearch" | "otherToolOwner" | "model" | "userMessages" | "env">
): boolean =>
    chatUrlReadingEnabled(context.env ?? process.env) &&
    chatReadToolsEligible(context) &&
    userLinksFromMessages(context.userMessages.map(messageText)).length > 0;

export async function withChatReadTools(context: ChatReadToolContext): Promise<{
    tools: ChatToolSlot | null;
    citations: () => WebSearchCitation[];
}> {
    const none = { tools: context.base, citations: () => [] as WebSearchCitation[] };
    const env = context.env ?? process.env;
    const urlOn = chatUrlReadingEnabled(env);
    const historyOn = chatHistoryReferenceEnabled(env);
    const memoryOn = chatMemoryToolEnabled(env);
    // The id checks repeat the gate so TypeScript keeps both narrowed below.
    if ((!urlOn && !historyOn && !memoryOn) || !chatReadToolsEligible(context) || !context.userId || !context.conversationId) return none;
    const parts: ChatReadPart[] = [];
    if (urlOn) {
        // Offered only when the user pasted a link: a turn with no link pays no definition tokens.
        const allowedUrls = userLinksFromMessages(context.userMessages.map(messageText));
        if (allowedUrls.length) {
            parts.push(buildChatUrlReadPart({ allowedUrls, signal: context.signal, onState: context.onProgress }));
        }
    }
    if (
        historyOn &&
        !context.base &&
        !context.profileActive &&
        (await historyReferenceAllowed({ userId: context.userId, conversationId: context.conversationId }))
    ) {
        parts.push(buildChatHistoryReferencePart({
            userId: context.userId,
            conversationId: context.conversationId,
            request: context.request,
            signal: context.signal,
            onState: context.onProgress,
        }));
    }
    // save_memory: an ordinary Chat conversation only (a project keeps its own memory scope), and only
    // while memoryToolAllowed holds; the tool checks again at every call.
    if (
        memoryOn &&
        !context.base &&
        (await memoryToolAllowed({ userId: context.userId, conversationId: context.conversationId }))
    ) {
        parts.push(buildChatMemoryToolPart({
            userId: context.userId,
            conversationId: context.conversationId,
            userMessages: context.userMessages.map(messageText),
            request: context.request,
            signal: context.signal,
        }));
    }
    if (!parts.length) return none;
    // One part, or several merged into a single read part.
    const read: ChatReadPart = parts.length === 1 ? parts[0]! : {
        tools: Object.assign({}, ...parts.map((part) => part.tools)),
        definitionTokens: parts.reduce((sum, part) => sum + part.definitionTokens, 0),
        resultInputAllowance: parts.reduce((sum, part) => sum + part.resultInputAllowance, 0),
        maxSteps: Math.max(...parts.map((part) => part.maxSteps)),
        citations: () => parts.flatMap((part) => part.citations()),
    };
    const loop = composeChatToolLoop({ signal: context.signal, base: context.base, read });
    return { tools: loop, citations: () => loop?.readCitations() ?? [] };
}
