/**
 * The dead-man ping, and the only request this agent sends outside the app
 * (docs/policy/trust-safety-compliance-agent.md §8, §5.6 item 4, §13-9).
 *
 * §5.6 bans the name `fetch` throughout E1's own files and makes exactly one
 * exception: this call, in this module. So nothing else here may grow a second
 * request, and a request anywhere else in the closure is a failure.
 *
 * What the ping is: a notification, not a record. The record is the run row
 * (§5.3). A ping that arrives late therefore produces a false negative in the
 * monitor, not a false success -- which is why the freshness devices below are
 * a budget and this module claims no arrival inside the window.
 *
 * Three devices bound the send, and only the first is enforced by anything
 * other than this module:
 *
 *   1. the round window, judged by the database inside the run row's COMMIT --
 *      a late round has no row, and this module is not called;
 *   2. the monotonic pre-check below, over the gap between that COMMIT's
 *      response and the request. A monotonic clock is used because it is
 *      unaffected by wall-clock jumps and keeps running while the process is
 *      suspended; `setTimeout` cannot fire during a suspension and so cannot
 *      detect one;
 *   3. the request's own `AbortSignal`.
 *
 * The URL carries the whole message. §8 item 4: no body, no query, no custom
 * header, and the URL comes only from the main app's variable. It is a secret,
 * so it is never logged, never put in a manifest and never in a response.
 */

import "server-only";

import { MONOTONIC_PRECHECK_MS, PING_ABORT_MS } from "@/lib/trustSafetyBoundsCore";

/**
 * What the round reports about the ping. A closed set, and none of these
 * values name the URL or carry a response body.
 */
export type TrustSafetyPingOutcome = "sent" | "stale" | "failed";

/**
 * Sends the ping for a round that already committed its run row.
 *
 * `committedAtMonotonicMs` is read from the same monotonic clock as `now`,
 * at the moment the COMMIT's response arrived. The elapsed time is measured
 * here rather than passed in, because the check has to cover the gap right up
 * to the request -- measuring it earlier would leave the scheduling delay
 * before this call outside the check.
 */
export const sendTrustSafetyPing = async ({
  url,
  committedAtMonotonicMs,
  now = () => performance.now(),
}: {
  readonly url: string;
  readonly committedAtMonotonicMs: number;
  readonly now?: () => number;
}): Promise<TrustSafetyPingOutcome> => {
  const elapsedMs = now() - committedAtMonotonicMs;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > MONOTONIC_PRECHECK_MS) {
    return "stale";
  }

  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      // A redirect would send the request to a host the main app variable does
      // not name, so it is an error rather than something to follow.
      redirect: "error",
      signal: AbortSignal.timeout(PING_ABORT_MS),
    });
    // The response body is never read. The monitor's answer is that the
    // request arrived; anything it sends back is not this agent's input.
    return response.ok ? "sent" : "failed";
  } catch {
    // Including the abort. The error is swallowed rather than logged, because
    // a failure carrying the request would carry the URL -- and the round
    // already succeeded, so there is nothing for the app to do about it. The
    // monitor notices the missing ping after `W` (§8).
    return "failed";
  }
};
