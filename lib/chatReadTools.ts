import "server-only";

import { buildChatHistoryReferencePart, chatHistoryReferenceEnabled, historyReferenceAllowed } from "@/lib/chatHistoryReference";
import { composeChatToolLoop, type ChatReadPart, type ChatToolSlot } from "@/lib/chatToolLoop";
import { buildChatUrlReadPart, chatUrlReadingEnabled, userLinksFromMessages } from "@/lib/chatUrlReadTool";
import { getArtifactToolSupport, type ArtifactToolModel } from "@/lib/generatedArtifactToolPolicy";
import type { ProjectChatTools } from "@/lib/projectChatTools";
import type { WebSearchCitation } from "@/lib/webSearchCitations";

/**
 * The chat read tools of one turn (`read_url`, `search_past_chats`) and the
 * rule for when a turn gets them. The chat route calls `withChatReadTools`
 * once; everything else it needs (the reservation, the step cap, the budget
 * guard) is the existing project-tool slot, which these tools share.
 *
 * Both tools are default-off switches (`CHAT_URL_READING_ENABLED`,
 * `CHAT_HISTORY_REFERENCE_ENABLED`). Neither costs a credit of its own: the
 * tokens a turn reads and writes are priced as always, and the definitions and
 * result allowance are reserved per pass like every application tool.
 */

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
    /** What the user wrote in this conversation, oldest first. */
    userMessages: readonly string[];
    request: Request;
    signal: AbortSignal;
    /** The project tools when the conversation is in a project, else null. */
    base: ProjectChatTools | null;
    onProgress?: (state: ChatReadProgress) => void;
    env?: Record<string, string | undefined>;
};

export async function withChatReadTools(context: ChatReadToolContext): Promise<{
    tools: ChatToolSlot | null;
    citations: () => WebSearchCitation[];
}> {
    const none = { tools: context.base, citations: () => [] as WebSearchCitation[] };
    const env = context.env ?? process.env;
    const urlOn = chatUrlReadingEnabled(env);
    const historyOn = chatHistoryReferenceEnabled(env);
    if (
        (!urlOn && !historyOn) ||
        !context.userId || !context.conversationId ||
        context.productKey !== "chat" ||
        context.researchTurn || context.nativeSearch || context.otherToolOwner ||
        getArtifactToolSupport(context.model) !== "verified"
    ) {
        return none;
    }
    const parts: ChatReadPart[] = [];
    if (urlOn) {
        // Offered only when the user pasted a link: a turn with no link pays no definition tokens.
        const allowedUrls = userLinksFromMessages(context.userMessages);
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
    if (!parts.length) return none;
    // One part, or the two merged into a single read part.
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
