import "server-only";

import { verifyChatContextBundle } from "@/lib/chatContextBundleService";
import type { ContextBundlePayload } from "@/lib/chatContextBundleCore";
import { ChatAccessError } from "@/lib/chatSecurity";
import { hasConversationUnlockGrant } from "@/lib/conversationLock";
import { isChatConversationKind } from "@/lib/conversationKindGuard";
import { memoryRelevanceContextEnabled, type MemorySemanticContext } from "@/lib/memoryQueryPlan";
import {
    memoryCurrentQueryDigest,
    memoryHistoryContentDigest,
    type MemoryHistoryAnchor,
} from "@/lib/memoryHistorySnapshotCore";
import { prisma } from "@/lib/prisma";

type SourceAccess = { request: Request; userId: string; conversationId: string };

async function assertSourceAccess(input: SourceAccess) {
    const row = await prisma.conversation.findUnique({
        where: { id: input.conversationId },
        select: { userId: true, password: true, passwordVersion: true, kind: true },
    });
    if (!row || row.userId !== input.userId) {
        throw new ChatAccessError(403, "CONVERSATION_FORBIDDEN", "Conversation access denied.");
    }
    if (!hasConversationUnlockGrant(input.request, input.userId, input.conversationId,
        row.password == null ? null : row.passwordVersion)) {
        throw new ChatAccessError(423, "CONVERSATION_LOCKED", "This conversation is locked.");
    }
    if (!isChatConversationKind(row.kind)) {
        throw new ChatAccessError(409, "CONVERSATION_KIND_NOT_SUPPORTED", "This conversation does not support that operation.");
    }
}

async function readSources(input: SourceAccess, anchor?: MemoryHistoryAnchor) {
    await assertSourceAccess(input);
    const rows = await prisma.message.findMany({
        where: { conversationId: input.conversationId, conversation: { userId: input.userId },
            role: "user", content: { not: "" },
            ...(anchor ? { id: { in: anchor.sources.map(source => source.id) } } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 2,
        select: { id: true, content: true },
    });
    const history = rows.filter(row => row.content.trim()).reverse().map(row => ({
        ...row, digest: memoryHistoryContentDigest(row.content),
    }));
    if (!anchor) return history;
    // Preserve the signed order; never substitute a newer source after an edit.
    const byId = new Map(history.map(source => [source.id, source]));
    const ordered = anchor.sources.map(source => byId.get(source.id));
    if (ordered.some((source, index) => !source || source.digest !== anchor.sources[index].digest)) return null;
    return ordered as NonNullable<typeof ordered[number]>[];
}

/** Validate the old envelope before any source lookup, even when memory is off. */
export function prepareMemoryHistoryContext(input: {
    request: Request; userId: string; conversationId: string | null;
    query: string; modelIds: string[]; previousContextBundle?: string;
}): (() => Promise<MemorySemanticContext>) | undefined {
    let previous: ContextBundlePayload | undefined;
    let expired = false;
    if (input.previousContextBundle !== undefined) {
        for (const modelId of input.modelIds) {
            const verified = verifyChatContextBundle(input.previousContextBundle, {
                subjectKey: input.userId, conversationId: input.conversationId, modelId,
            });
            if (!verified.ok) {
                // Expiry is checked only after signature, subject, conversation and model.
                if (verified.reason === "expired") { expired = true; continue; }
                throw new ChatAccessError(400, "INVALID_CONTEXT_BUNDLE", "Invalid chat context.");
            }
            previous = verified.payload;
        }
        if (expired) previous = undefined;
    }
    if (!memoryRelevanceContextEnabled()) return undefined;
    return async () => {
        const currentOnly: MemorySemanticContext = { queryPolicy: "full", history: [] };
        if (!input.conversationId) return currentOnly;
        const access = { request: input.request, userId: input.userId, conversationId: input.conversationId };
        if (input.previousContextBundle !== undefined) {
            // Absent, legacy, empty or expired anchors explicitly recover current-only.
            const anchor = previous?.memoryHistory;
            if (!anchor || anchor.queryDigest !== memoryCurrentQueryDigest(input.query)) return currentOnly;
            return { queryPolicy: "full", history: await readSources(access, anchor) ?? [] };
        }
        return { queryPolicy: "full", history: await readSources(access) ?? [] };
    };
}

/** Called only with an envelope verified for this subject, conversation and model. */
export async function replayMemoryHistoryContext(input: SourceAccess & {
    query: string; payload: ContextBundlePayload;
}): Promise<MemorySemanticContext | null> {
    if (input.payload.memoryQueryPolicy !== "full") return { queryPolicy: "legacy", history: [] };
    if (!memoryRelevanceContextEnabled()) return null;
    const anchor = input.payload.memoryHistory;
    if (!anchor) return { queryPolicy: "full", history: [] };
    if (anchor.queryDigest !== memoryCurrentQueryDigest(input.query)) return null;
    const history = await readSources(input, anchor);
    return history === null ? null : { queryPolicy: "full", history };
}
