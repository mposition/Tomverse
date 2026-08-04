/**
 * What a client does when `POST /api/chat` answers 409
 * CHAT_CONTEXT_BUNDLE_STALE (§10).
 *
 * docs/policy/external-conversation-import-and-memory.md §10.
 *
 * Pure, because the rules are easy to state and easy to get wrong in the
 * middle of a streaming handler:
 *
 *  - **Single model**: re-prepare the context and retry EXACTLY once, and only
 *    while nothing of the response has been shown. The user message keeps its
 *    id, so the retry is the same turn rather than a second one — the server
 *    sees one idempotency key, reserves once and stores one message.
 *  - **Comparison**: never retry one panel. Panels are comparable because they
 *    share a snapshot; a panel that quietly re-prepared its own context would
 *    be answering a different question from its siblings while looking like it
 *    answered the same one. The whole comparison re-preflights, or the user is
 *    told.
 *  - **After any output is visible**: no automatic retry at all. Re-sending
 *    would either duplicate what the user already read or replace it, and
 *    both are worse than an honest error.
 */

export type ContextBundleRetryContext = {
    /** True when this send is one panel of a multi-model comparison. */
    isComparison: boolean;
    /** How many times this turn has already been retried for staleness. */
    staleRetries: number;
    /** True once any part of the answer has reached the user. */
    outputVisible: boolean;
};

export type ContextBundleRetryDecision =
    /** Fetch a fresh bundle, then re-send this same turn once. */
    | { action: "reprepare_and_retry" }
    /** Hand the whole comparison back for a full re-preflight. */
    | { action: "repreflight_comparison" }
    /** Stop and tell the user. */
    | { action: "surface"; reason: "retry_exhausted" | "output_visible" };

/** §10 allows one automatic retry per turn, and no more. */
export const MAX_CONTEXT_BUNDLE_RETRIES = 1;

export function decideContextBundleRetry(
    context: ContextBundleRetryContext
): ContextBundleRetryDecision {
    if (context.outputVisible) {
        // Explicitly ahead of the retry count: a second stale after partial
        // output is still not retryable, even on the first attempt.
        return { action: "surface", reason: "output_visible" };
    }
    if (context.staleRetries >= MAX_CONTEXT_BUNDLE_RETRIES) {
        return { action: "surface", reason: "retry_exhausted" };
    }
    return context.isComparison
        ? { action: "repreflight_comparison" }
        : { action: "reprepare_and_retry" };
}

/** The §10 code, so client and server name the same thing. */
export const CHAT_CONTEXT_BUNDLE_STALE_CODE = "CHAT_CONTEXT_BUNDLE_STALE";

export const isContextBundleStale = (error: unknown): boolean =>
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === CHAT_CONTEXT_BUNDLE_STALE_CODE;
