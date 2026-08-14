/**
 * Asking the server to price this request's memory context (policy §10).
 *
 * A comparison gets its bundle from the aggregate preflight, which it already
 * calls. A single-model send has no such step, so this is it — and the panel
 * that has to re-prepare after a stale refusal uses the same function, so
 * "prepare" means one thing on both paths.
 *
 * Failure degrades open, and safely: the token is what tells the server this
 * request was priced *with* a memory block, so a request that arrives without
 * one is sent without memory. The user is never charged for context they did
 * not get, and never shown context they were not charged for — which is the
 * whole point of §10. Blocking the send instead would turn a memory feature
 * that is switched off for almost everyone into a hard dependency of chat.
 */

import { discardResponseBody } from "./discardResponseBody";
export async function prepareChatContextBundle(input: {
    /** Null for a guest, or for a conversation that does not exist yet. */
    conversationId: string | null;
    modelIds: string[];
    prompt: string;
}): Promise<string | null> {
    try {
        const response = await fetch("/api/chat/context", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                conversationId: input.conversationId,
                modelIds: input.modelIds,
                prompt: input.prompt,
            }),
        });
        if (!response.ok) {
            await discardResponseBody(response);
            return null;
        }
        const body = (await response.json().catch(() => null)) as {
            contextBundle?: unknown;
        } | null;
        return typeof body?.contextBundle === "string"
            ? body.contextBundle
            : null;
    } catch {
        return null;
    }
}
