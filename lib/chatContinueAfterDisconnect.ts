/**
 * Whether a saved Chat turn keeps generating after its connection goes away,
 * and the bounds on a turn that does.
 *
 * ## What changes when the switch is on
 *
 * Off -- the default, and every deployment that sets nothing -- a request
 * abort cancels the turn: the provider call is aborted and the turn settles
 * `cancelled`, prorated on what was generated. A locked phone or an app
 * switch therefore threw away an answer the user was waiting for.
 *
 * On (`CHAT_CONTINUE_AFTER_DISCONNECT=on`), a durable Chat turn -- an account
 * turn with a response-attempt row, not Research Preview -- whose connection
 * closes *without an explicit stop* keeps its provider call, finishes, and
 * saves and settles exactly as a turn whose reader stayed: `completed` is
 * charged as completed. The browser gets the answer by polling the attempt
 * (lib/chatStreamReattach.ts). Review panels and guests have no attempt row
 * and keep the old path.
 *
 * ## Why a disconnect is never made free
 *
 * Cancelling stays prorated, and continuing is charged in full, so there is
 * no way to read a stream and drop the connection to pay less than for the
 * answer: the turn either goes on and is charged as completed, or the user
 * stopped it and pays for what was generated, as before.
 *
 * ## How a stop is told apart from a disconnect
 *
 * Both reach the server as the same request abort. So the browser, as it
 * aborts its fetch on a stop, also asks the attempt endpoint to stop the
 * turn, which records it in the attempt row the stream checkpoints: a
 * conditional transition of an active row to `cancelled`
 * (lib/chatResponseAttemptPersistence.ts). The two requests race; the grace
 * below is what makes the order not matter.
 * That row is shared by every process, which an in-memory flag would not be.
 * A detached turn reads its row -- for `stopGraceMs` right after the
 * disconnect, then every `stopPollMs` -- and a stop it finds cancels it with
 * the ordinary prorated settlement. A stop that arrives after the provider
 * finished is too late, exactly as an abort after completion always was.
 *
 * ## Why it cannot run forever
 *
 * Everything that bounded a connected turn still applies: the concurrency
 * lease heartbeat, the first-token deadline, the output-token ceiling and the
 * tool step caps. The one bound a connected turn had and a detached one would
 * lose is the browser's silence watchdog, which ended a turn whose provider
 * stopped producing anything after the first token. A detached turn applies
 * the same rule itself: no provider part for `providerIdleMs` after the
 * first visible token cancels it, prorated, as the browser's abort would have.
 */

import { CHAT_LIVENESS_BUDGETS } from "@/lib/chatStreamLiveness";

/** Sent on a durable stream whose server has the switch on. */
export const CHAT_CONTINUE_AFTER_DISCONNECT_HEADER =
  "X-Chat-Continue-After-Disconnect";

export const chatContinueAfterDisconnectEnabled = (
  env: Record<string, string | undefined> = process.env
): boolean => env.CHAT_CONTINUE_AFTER_DISCONNECT === "on";

export type DetachedChatTurnPlan = {
  /** How long a disconnect waits for a stop request before carrying on. */
  stopGraceMs: number;
  /** How often a detached turn reads its attempt row for a stop. */
  stopPollMs: number;
  /** After the first visible token: the longest a detached provider may produce nothing. */
  providerIdleMs: number;
};

export const DETACHED_CHAT_TURN_DEFAULTS: DetachedChatTurnPlan = {
  stopGraceMs: 2_000,
  stopPollMs: 1_000,
  // The browser's own silence floor, so a detached turn is not given longer
  // than a connected one would have been.
  providerIdleMs: CHAT_LIVENESS_BUDGETS.idleMs,
};

const lowered = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, fallback)
    : fallback;
};

/**
 * Operator overrides may only shorten these, the same rule as the keepalive
 * plan (lib/chatStreamKeepalivePlan.ts): a longer grace or idle bound is a
 * code change, a shorter one is what an incident needs.
 */
export const resolveDetachedChatTurnPlan = (
  env: Record<string, string | undefined> = process.env
): DetachedChatTurnPlan => ({
  stopGraceMs: lowered(
    env.CHAT_DETACHED_STOP_GRACE_MS,
    DETACHED_CHAT_TURN_DEFAULTS.stopGraceMs
  ),
  stopPollMs: lowered(
    env.CHAT_DETACHED_STOP_POLL_MS,
    DETACHED_CHAT_TURN_DEFAULTS.stopPollMs
  ),
  providerIdleMs: lowered(
    env.CHAT_DETACHED_PROVIDER_IDLE_MS,
    DETACHED_CHAT_TURN_DEFAULTS.providerIdleMs
  ),
});

/**
 * An attempt row the user stopped. The stream owner writes `cancelled` too,
 * but only on its own cancellation, which it already knows about -- so a
 * running stream that reads this was stopped by someone else, the user.
 */
export const isStoppedChatAttempt = (
  attempt: { status: string; finishReason: string | null } | null | undefined
): boolean =>
  attempt?.status === "cancelled" && attempt.finishReason === "cancelled";
