/**
 * What the stream's `catch` actually caught: §7's classification step.
 *
 * `decideFallback` takes a failure layer and an outcome and answers what to do
 * about them. Nothing produced those two values. The chat route's `pull()`
 * catch had one signal available -- `generatedText === ""` -- and the rollout
 * note used to treat it as proof of a fallback-eligible provider failure. It
 * is not. It says the server has not read a text chunk yet, which is
 * *necessary* and nowhere near sufficient: that same catch receives client
 * disconnects, user cancellations, controller-closed errors, and failures from
 * the completion handling that runs after the last chunk. §7 excludes
 * cancellation, client disconnect, policy rejection and insufficient credits
 * from automatic fallback by name, so something has to tell them apart before
 * the policy is consulted at all. This is that something.
 *
 * Pure, and deliberately so. It takes an error and three booleans about the
 * stream, and returns a verdict -- no Prisma, no provider client, no network.
 * The whole point of the first step of the fallback work is that the decision
 * can be driven off a test double before any real provider is involved.
 *
 * ## Why the layers come out the way they do
 *
 * `provider` is reserved for a failure of the provider's own text stream.
 * `stream` covers everything that is really about this process or this
 * connection: the client going away, the response controller being closed,
 * and the completion handling below the read. The distinction is what makes
 * the fallback safe, because `decideFallback` will substitute a model for a
 * `provider` failure and fails closed on a `stream` one. Filing our own
 * settlement bug as a provider failure would spend a second provider call to
 * re-run a request whose answer we already had.
 */

import {
  classifyProviderFailure,
  providerDiagnosticCode,
  safeErrorMessage,
  safeErrorMetadata,
} from "@/lib/providerErrorClassification";
import type { ProviderRefusal } from "@/lib/routingFallbackPolicy";
import type {
  RoutingAttemptOutcome,
  RoutingFailureLayer,
} from "@/lib/routingAttemptStore";

/** Where in the stream's lifecycle the error surfaced. */
export type StreamFailurePhase =
  /** `sourceReader.read()` rejected: the provider's stream failed. */
  | "read"
  /** The client's controller rejected an enqueue. */
  | "emit"
  /**
   * The completion handling that runs once the text stream is done -- usage,
   * finish reason, provider metadata, settlement.
   *
   * Never a fallback candidate whatever it looks like. The provider finished;
   * what failed is what Tomverse did afterwards, and no other model would fix
   * it.
   */
  | "completion";

export type StreamFailureObservation = {
  error: unknown;
  phase: StreamFailurePhase;
  /** Whether any chunk of this response has reached the client. */
  visibleTokenEmitted: boolean;
  /**
   * Whether the response the user is connected to is still open.
   *
   * Closed means the client is gone -- a navigation, a tab close, a dropped
   * connection. §7 excludes client disconnect from fallback, and this is the
   * only signal that says so.
   */
  downstreamOpen: boolean;
};

export type StreamFailureClassification = {
  outcome: Extract<
    RoutingAttemptOutcome,
    "failed_pre_token" | "failed_post_token" | "cancelled"
  >;
  failureLayer: Extract<RoutingFailureLayer, "provider" | "stream">;
  /**
   * A provider answer §7 refuses to route around, or null.
   *
   * Kept separate from the layer because it *is* a provider failure -- it
   * belongs in provider health and in the attempt record as one. What it is
   * not is a reason to try the same request on a different model.
   */
  providerRefusal: ProviderRefusal | null;
  /**
   * Operator-facing, and never provider text. A classification nobody can
   * explain is a classification nobody can argue with when it is wrong.
   */
  reason: string;
};

/**
 * The error the platform raises when a request is aborted.
 *
 * Matched on name and code rather than on `instanceof`, because the abort can
 * come from the runtime's `AbortSignal`, from undici, or from the AI SDK
 * wrapping one of those, and only one of those three is a `DOMException` here.
 */
const isAbortShaped = (error: unknown): boolean => {
  const metadata = safeErrorMetadata(error);
  if (
    metadata.name === "AbortError" ||
    metadata.name === "TimeoutError" ||
    metadata.code === "ABORT_ERR" ||
    metadata.code === "ECONNRESET"
  ) {
    // TimeoutError and ECONNRESET are deliberately in this list even though
    // they are not user cancellations: both mean the connection ended without
    // an answer about the model, and a stream that died mid-flight is not
    // evidence that a *different* model would have answered. They are
    // conservative members of the "do not substitute" set, not precise ones.
    return true;
  }
  return false;
};

const isClosedController = (error: unknown): boolean => {
  const metadata = safeErrorMetadata(error);
  return (
    metadata.code === "ERR_INVALID_STATE" &&
    (safeErrorMessage(error) ?? "").toLowerCase().includes("controller is already closed")
  );
};

/**
 * Whether a provider refused on safety grounds.
 *
 * Broad on purpose, and matched against the error's code, name and message.
 * The cost of a false positive is one fallback that does not happen; the cost
 * of a false negative is Tomverse quietly asking a second model to do the
 * thing the first one refused, which is the shape of shopping for a compliant
 * provider. Those are not comparable, so the match leans the safe way.
 *
 * The message is read here and never returned or logged: the reason strings
 * this module produces are written by hand, because a provider error can echo
 * the request that caused it.
 */
const isPolicyRefusal = (error: unknown): boolean => {
  const metadata = safeErrorMetadata(error);
  // Separators are stripped rather than enumerated. The same refusal arrives
  // as `content_filter` in a code, `content policy` in a message and
  // `ContentPolicyViolationError` in a class name, and a list of spellings is
  // a list that is always one provider behind.
  const compact = [metadata.code, metadata.name, safeErrorMessage(error)]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return [
    "contentfilter",
    "contentpolicy",
    "moderation",
    "safety",
    "prohibitedcontent",
    "blocklist",
  ].some((marker) => compact.includes(marker));
};

/**
 * What happened, in the vocabulary `decideFallback` reads.
 *
 * Order matters and it is the order of §7's own sentence. The connection and
 * the user come first: whatever the provider did, if the client is gone or the
 * turn was cancelled there is nobody to show a second attempt to. Then the
 * phase, because a completion failure is ours. Only what survives all of that
 * is examined as a provider failure.
 */
export const classifyStreamFailure = (
  observation: StreamFailureObservation
): StreamFailureClassification => {
  const { error, phase, visibleTokenEmitted, downstreamOpen } = observation;

  if (!downstreamOpen) {
    return {
      outcome: "cancelled",
      failureLayer: "stream",
      providerRefusal: null,
      reason: "The response the user was connected to is no longer open.",
    };
  }

  if (isAbortShaped(error) || isClosedController(error)) {
    return {
      outcome: "cancelled",
      failureLayer: "stream",
      providerRefusal: null,
      reason: "The turn was aborted or its response controller was already closed.",
    };
  }

  // An enqueue that fails on an open-looking stream means the client stopped
  // reading between the check and the write. Same conclusion as a disconnect,
  // reached one step later.
  if (phase === "emit") {
    return {
      outcome: visibleTokenEmitted ? "failed_post_token" : "cancelled",
      failureLayer: "stream",
      providerRefusal: null,
      reason: "The client stopped accepting the response.",
    };
  }

  if (phase === "completion") {
    return {
      // Truthful about what the user saw, which is what §7's rule turns on.
      // A model that streamed nothing and then failed in completion handling
      // still emitted no visible token -- the layer, not the outcome, is what
      // keeps it from being substituted.
      outcome: visibleTokenEmitted ? "failed_post_token" : "failed_pre_token",
      failureLayer: "stream",
      providerRefusal: null,
      reason:
        "The provider's stream finished; the failure came from Tomverse's completion handling.",
    };
  }

  const outcome = visibleTokenEmitted ? "failed_post_token" : "failed_pre_token";

  if (isPolicyRefusal(error)) {
    return {
      outcome,
      failureLayer: "provider",
      providerRefusal: "policy",
      reason: "The provider refused the request on content-policy grounds.",
    };
  }

  const category = classifyProviderFailure({
    diagnosticCode: providerDiagnosticCode("AI_STREAM_FAILED", error),
    httpStatus: safeErrorMetadata(error).statusCode ?? null,
  }).category;

  if (category === "PAYMENT_REQUIRED") {
    return {
      outcome,
      failureLayer: "provider",
      providerRefusal: "insufficient_credits",
      reason: "The provider account cannot fund the request.",
    };
  }

  return {
    outcome,
    failureLayer: "provider",
    providerRefusal: null,
    reason: "The provider's stream failed.",
  };
};
