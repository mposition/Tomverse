/**
 * The two server-side numbers behind the chat stream's first-token watch, and
 * the operator's ability to lower them.
 *
 * ## Why they are configurable at all
 *
 * A first-token deadline is an operational guardrail, and this repository
 * configures operational guardrails through the environment rather than
 * through a deploy -- concurrency ceilings, provider budgets and the image
 * executor's own duration budget all work this way
 * (`lib/chatConcurrencyCore.ts` is the shape this follows, down to taking
 * `env` as an argument). When a provider starts hanging, the useful lever is
 * "stop waiting nine minutes for it", and that should not require shipping
 * code.
 *
 * It is also what makes the guardrail testable. The route reads these through
 * a function rather than importing two constants, so a contract test sets an
 * environment variable and drives the real deadline in milliseconds. The
 * previous version of that test replaced the constants with `mock.module`,
 * which worked locally and silently did not apply on CI -- the route kept its
 * nine-minute budget and every case in the file failed on the guard that
 * noticed. A seam that depends on an experimental loader feature behaving the
 * same way on two machines is not a seam.
 *
 * ## Why the deadline may only be lowered
 *
 * `CHAT_LIVENESS_BUDGETS.firstResponseMs` -- the client's own absolute bound --
 * is derived as this deadline plus a grace, and it is compiled into the
 * browser bundle. Raising the server deadline past it would not buy a slow
 * provider more time: the client would abort first, and the classified
 * `stalled` notice this server writes on the way out would never arrive.
 * Raising it is therefore a code change, in both places at once. Lowering it
 * is the direction that is safe on its own, and the only one an incident
 * needs.
 */

import {
  CHAT_SERVER_FIRST_TOKEN_DEADLINE_MS,
  CHAT_STREAM_KEEPALIVE_INTERVAL_MS,
} from "@/lib/chatStreamLiveness";

/**
 * The most an operator may stretch the keepalive interval to.
 *
 * Cloudflare's Proxy Read Timeout is 125 seconds, so an interval anywhere near
 * it stops being a keepalive. A minute leaves the connection written to twice
 * inside every window even at the worst allowed setting.
 */
export const MAX_KEEPALIVE_INTERVAL_MS = 60_000;

export type ChatStreamKeepalivePlan = {
  /** How often to write while no visible token has gone out. */
  intervalMs: number;
  /** When to stop waiting for one. */
  firstTokenDeadlineMs: number;
};

const boundedMs = (
  value: string | undefined,
  fallback: number,
  max: number
): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
};

export const resolveChatStreamKeepalivePlan = (
  env: Record<string, string | undefined> = process.env
): ChatStreamKeepalivePlan => ({
  intervalMs: boundedMs(
    env.CHAT_STREAM_KEEPALIVE_INTERVAL_MS,
    CHAT_STREAM_KEEPALIVE_INTERVAL_MS,
    MAX_KEEPALIVE_INTERVAL_MS
  ),
  // Capped at the compiled default rather than at some larger ceiling: see the
  // module comment. An override above it is not refused loudly, because a
  // guardrail that fails closed on a typo is worse than one that quietly stays
  // at its default -- it is simply clamped to the value the client agrees to.
  firstTokenDeadlineMs: boundedMs(
    env.CHAT_FIRST_TOKEN_DEADLINE_MS,
    CHAT_SERVER_FIRST_TOKEN_DEADLINE_MS,
    CHAT_SERVER_FIRST_TOKEN_DEADLINE_MS
  ),
});
