/**
 * What a stale context bundle means for the request in flight (policy §10).
 *
 * Split out of `lib/chatContextBundleCore.ts` for one reason: that module
 * signs and verifies, so it imports `node:crypto` and can never be part of a
 * browser bundle. This decision has to be made *by the client* — it is the
 * client that holds the request, knows whether anything has been shown yet,
 * and would perform the retry — so it cannot live behind a Node-only import.
 *
 * The core re-exports this, so server callers still reach it in one place and
 * there is exactly one implementation of the rule.
 */

export type BundleStaleRecovery =
    | { action: "retry_after_preflight" }
    | { action: "repreflight_all" }
    | { action: "surface_to_user"; reason: "already_retried" | "stream_started" };

/**
 * A single-model request may re-prepare and retry **once**, and only while
 * nothing has been shown: the assistant message id is kept, so the retry
 * cannot double-reserve or write a second Message. Once any bytes have
 * reached the user, an automatic retry would replace an answer they are
 * already reading, so it becomes theirs to decide.
 *
 * A comparison never retries one panel. The panels share a bundle lineage
 * precisely so they see one snapshot; re-preparing a single panel would put
 * it on a different context from its siblings, and the admission is
 * all-or-nothing anyway.
 */
export function decideBundleStaleRecovery(input: {
    layout: "single" | "comparison";
    /** How many automatic retries this request has already used. */
    priorAutomaticRetries: number;
    /** True once any part of a response has been exposed to the user. */
    streamStarted: boolean;
}): BundleStaleRecovery {
    if (input.streamStarted) {
        return { action: "surface_to_user", reason: "stream_started" };
    }
    if (input.priorAutomaticRetries >= 1) {
        return { action: "surface_to_user", reason: "already_retried" };
    }
    return input.layout === "comparison"
        ? { action: "repreflight_all" }
        : { action: "retry_after_preflight" };
}
