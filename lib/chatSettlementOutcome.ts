/**
 * The `RoutingAttempt` outcome a settled turn is recorded under.
 *
 * `settleSafely` in `app/api/chat/route.ts` is deliberately one funnel for
 * every terminal outcome, so that cancellation, stream failure and completion
 * all reach the attempt record by the same path the settlement takes. The
 * mapping it applied read the same, though, for a stream that failed after the
 * user had started reading and for one that ended cleanly having produced
 * nothing: both were filed as `failed_post_token`, which every other writer of
 * that value uses to mean the opposite -- `lib/routingStreamFailure.ts` picks
 * between the two names on `visibleTokenEmitted`.
 *
 * An empty answer is the pre-token case. The provider was reached, the stream
 * ended, and no user-visible token was ever emitted.
 *
 * **It stays a failure.** `lib/routerSignalCore.ts` counts the success rate
 * over whether the person got an answer, and they did not; both failure names
 * sit in `DISPATCH_OUTCOMES_COUNTED` and only `succeeded` counts as a success,
 * so the rate this feeds is unchanged. Only the name of the failure moves.
 *
 * **It changes no behaviour.** §7's automatic fallback is decided from
 * `classifyStreamFailure`'s result on the thrown-error path
 * (`app/api/chat/route.ts`, `decideFallback`), and a completion that returns
 * empty text throws nothing and never reaches it. `decideFallback` does not
 * read the persisted row.
 *
 * The failure *layer* is not decided here. An empty answer is currently filed
 * under `stream`, which `lib/routingStreamFailure.ts` documents as this
 * process or this connection rather than the provider's output, and correcting
 * that needs a value the `RoutingAttempt_failureLayer_check` constraint does
 * not yet allow. That is its own change, with its own migration.
 *
 * Pure: no database, no clock, no network.
 */

import type { RoutingAttemptOutcome } from "@/lib/routingAttemptStore";

/** What the chat route's settlement funnel calls a terminal turn. */
export type ChatSettlementOutcome =
    | "completed"
    | "cancelled"
    | "failed"
    | "empty";

export const routingOutcomeForSettlement = (
    outcome: ChatSettlementOutcome
): RoutingAttemptOutcome => {
    switch (outcome) {
        case "completed":
            return "succeeded";
        case "cancelled":
            return "cancelled";
        case "empty":
            return "failed_pre_token";
        case "failed":
            // The thrown-error path normally classifies itself and passes the
            // answer in, so this is what is recorded when the classifier did
            // not speak. It is left as it was: an error raised while a stream
            // was being read is the case `failed_post_token` was named for,
            // and narrowing it would need the same evidence this change had
            // for the empty one.
            return "failed_post_token";
    }
};
