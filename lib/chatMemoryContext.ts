import "server-only";

import {
    buildMemoryContext,
    contextBundlePayloadFor,
    type BuiltMemoryContext,
} from "@/lib/memoryContextBuilder";
import {
    issueContextBundle,
    verifyContextBundle,
    type ContextBundleVerification,
    type MemoryMode,
} from "@/lib/memoryContextBundleCore";
import { prisma } from "@/lib/prisma";

/**
 * Where account memory meets a chat request (Release B, slice B4c).
 *
 * docs/policy/external-conversation-import-and-memory.md §10.
 *
 * One invariant governs everything here:
 *
 *   **Memory is injected only under a valid context bundle.**
 *
 * Not "injected, and also checked". A turn whose memory context is active but
 * whose bundle is missing, expired or stale is refused with the §10 409 rather
 * than sent — because a reservation was taken against a prompt of a certain
 * size, and sending a different one silently charges for something that never
 * happened. The direction matters: the failure mode this rules out is sending
 * *unquoted* memory, so the check has to sit between building the context and
 * spending on it.
 *
 * Nothing changes for a request with no memory to carry. A guest, an account
 * with the flag off, a conversation with memory turned off, and a request that
 * retrieved nothing all take the same path they always did — no bundle
 * required, because there is nothing to quote.
 */

export type ChatMemoryResolution =
    | {
          outcome: "none";
          reason: BuiltMemoryContext["inactiveReason"] | "lookup_failed";
      }
    | {
          outcome: "inject";
          promptText: string;
          tokens: number;
          factualCount: number;
          styleCount: number;
      }
    /** §10: the client must re-preflight and retry. */
    | { outcome: "stale"; reason: string }
    /** Forged, borrowed, or bound to another conversation: retrying is not the fix. */
    | { outcome: "rejected"; reason: string };

const REPREFLIGHTABLE: ReadonlySet<string> = new Set([
    "expired",
    "snapshot_changed",
    "bundle_missing",
]);

/**
 * Reads the conversation's memory mode.
 *
 * Ownership is not re-checked here — every caller has already established it,
 * and a second check with a different answer would be worse than none. A
 * conversation that does not exist yet (the first turn) inherits the account
 * default, which is what "inherit" means.
 */
async function conversationMemoryMode(
    userId: string,
    conversationId: string | null
): Promise<MemoryMode> {
    if (!conversationId) return "inherit";
    const row = await prisma.conversation.findFirst({
        where: { id: conversationId, userId },
        select: { memoryMode: true },
    });
    const mode = row?.memoryMode;
    return mode === "on" || mode === "off" || mode === "inherit"
        ? mode
        : "inherit";
}

/**
 * Decides what memory, if any, this request may carry.
 *
 * Returns the prompt text and its token cost so the caller can add both to the
 * same estimate it reserves against — the §10 requirement that memory tokens
 * are part of the input estimate, the context-window check, the credit
 * reservation and the operational guardrail rather than an untracked extra.
 */
export async function resolveChatMemoryContext(input: {
    /** Null for guests, who have no account memory at all. */
    userId: string | null;
    subjectKey: string;
    conversationId: string | null;
    /**
     * This request's model. A comparison panel shares one bundle with its
     * siblings, so the bundle is checked for membership rather than equality.
     */
    modelId: string;
    /** The user's request text, used as the retrieval query. */
    query: string;
    contextBundle?: string;
    secret: string;
    now?: Date;
}): Promise<ChatMemoryResolution> {
    if (!input.userId) return { outcome: "none", reason: null };

    let context: BuiltMemoryContext;
    try {
        const memoryMode = await conversationMemoryMode(
            input.userId,
            input.conversationId
        );
        context = await buildMemoryContext({
            userId: input.userId,
            query: input.query,
            memoryMode,
            now: input.now,
        });
    } catch (error) {
        // Memory is an enhancement to a chat turn, not a precondition for it,
        // so a store that is briefly unreadable degrades the turn instead of
        // failing it. The direction is still closed: without a built context
        // there is nothing to quote, so nothing is injected and no bundle is
        // demanded — a hiccup can lose memory from a turn, never smuggle
        // unquoted memory into one.
        console.warn(
            JSON.stringify({
                event: "chat_memory_context_unavailable",
                reason:
                    error instanceof Error ? error.name : "unknown",
            })
        );
        return { outcome: "none", reason: "lookup_failed" };
    }

    if (!context.active || !context.promptText) {
        // Nothing to quote, so nothing to verify. A bundle may well have been
        // issued and gone unused; that is fine, it binds a snapshot rather
        // than granting anything.
        return { outcome: "none", reason: context.inactiveReason };
    }

    if (!input.contextBundle) {
        return { outcome: "stale", reason: "bundle_missing" };
    }

    const verification: ContextBundleVerification = verifyContextBundle(
        input.contextBundle,
        {
            secret: input.secret,
            subjectKey: input.subjectKey,
            conversationId: input.conversationId,
            modelId: input.modelId,
            now: input.now,
            current: context.binding,
        }
    );
    if (!verification.ok) {
        return REPREFLIGHTABLE.has(verification.reason)
            ? { outcome: "stale", reason: verification.reason }
            : { outcome: "rejected", reason: verification.reason };
    }

    return {
        outcome: "inject",
        promptText: context.promptText,
        tokens: context.totalTokens,
        factualCount: context.factual.itemCount,
        styleCount: context.style.itemCount,
    };
}

export type IssuedContextBundle = {
    /** Null when this turn carries no memory, so no bundle is needed. */
    token: string | null;
    expiresAt: string | null;
    memoryTokens: number;
    factualCount: number;
    styleCount: number;
    inactiveReason: BuiltMemoryContext["inactiveReason"];
};

/**
 * Issues the bundle a later chat request presents (§10 preflight side).
 *
 * Uses the same builder the chat request will use, so the snapshot the client
 * is handed is the snapshot the server will rebuild. A `null` token is not a
 * failure: it means this account currently contributes no memory, and the
 * chat request will find the same thing and proceed without one.
 */
export async function issueChatContextBundle(input: {
    userId: string | null;
    subjectKey: string;
    conversationId: string | null;
    modelIds: readonly string[];
    query: string;
    secret: string;
    now?: Date;
}): Promise<IssuedContextBundle> {
    const empty: IssuedContextBundle = {
        token: null,
        expiresAt: null,
        memoryTokens: 0,
        factualCount: 0,
        styleCount: 0,
        inactiveReason: null,
    };
    if (!input.userId) return empty;

    const memoryMode = await conversationMemoryMode(
        input.userId,
        input.conversationId
    );
    const context = await buildMemoryContext({
        userId: input.userId,
        query: input.query,
        memoryMode,
        now: input.now,
    });
    if (!context.active || !context.promptText) {
        return { ...empty, inactiveReason: context.inactiveReason };
    }

    const payload = contextBundlePayloadFor({
        context,
        subjectKey: input.subjectKey,
        conversationId: input.conversationId,
        modelIds: input.modelIds,
        now: input.now,
    });
    return {
        token: issueContextBundle(payload, input.secret),
        expiresAt: new Date(payload.expiresAtMs).toISOString(),
        memoryTokens: context.totalTokens,
        factualCount: context.factual.itemCount,
        styleCount: context.style.itemCount,
        inactiveReason: null,
    };
}
