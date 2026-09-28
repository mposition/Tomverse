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
 * **It changes no behaviour.** The automatic fallback of
 * docs/policy/tomverse-chat-routing.md §7 is decided from
 * `classifyStreamFailure`'s result on the thrown-error path
 * (`app/api/chat/route.ts`, `decideFallback`), and a completion that returns
 * empty text throws nothing and never reaches it. `decideFallback` does not
 * read the persisted row.
 *
 * Pure: no database, no clock, no network.
 */

import type {
    RoutingAttemptOutcome,
    RoutingFailureLayer,
} from "@/lib/routingAttemptStore";

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

/**
 * The layer a settled turn's failure is attributed to.
 *
 * `stream` is documented as this process or this connection
 * (`lib/routingStreamFailure.ts`), and an empty answer is neither: the call
 * reached the provider and succeeded, and what came back was nothing. That is
 * `model_output` -- the provider answered, and the answer was not usable.
 *
 * Keeping the two apart is what stops a quality problem being counted as an
 * outage, and it is a line the codebase already draws for this exact case
 * under another name: `AI_EMPTY_RESPONSE` classifies as `MODEL_TRANSIENT` with
 * `scope: "model"` and is excluded from `PROVIDER_SCOPED`, so an empty answer
 * has never reached `ProviderHealthState`.
 *
 * No routing behaviour follows from the name. `lib/routingFallbackPolicy.ts`
 * falls back only on `adapter` and `provider`, so an empty answer moves nobody
 * to another model, exactly as before.
 *
 * The `succeeded`/`cancelled` cases must stay `none`: the database enforces
 * that agreement (`RoutingAttempt_outcome_failure_layer_check`).
 */
export const routingFailureLayerForSettlement = (
    outcome: ChatSettlementOutcome
): RoutingFailureLayer => {
    switch (outcome) {
        case "completed":
        case "cancelled":
            return "none";
        case "empty":
            return "model_output";
        case "failed":
            return "stream";
    }
};
