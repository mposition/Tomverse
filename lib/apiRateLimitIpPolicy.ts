/**
 * Which per-IP leg `consumeApiRateLimit` applies on top of the per-subject
 * bucket, and how large it is.
 *
 * The per-subject bucket is the accountable limit: a signed-in user is one
 * account, so their own minute/day allowance is what bounds them. The IP leg
 * is only an aggregate abuse ceiling, and it follows the same principle as the
 * chat concurrency plan (`docs/policy/chat-concurrency-and-identity.md` §2):
 *
 *   * Anonymous subjects (guest cookie, anonymous client key, pre-auth
 *     routes) keep the original ceiling of 3x the subject limit for both the
 *     minute and the day bucket. A guest can mint a new subject by clearing a
 *     cookie, so the IP leg is the only thing that bounds them.
 *   * A signed-in subject gets a generous per-minute ceiling (8x, the same
 *     multiple as the chat IP concurrency ceiling) and no per-day IP bucket
 *     at all. Several people behind one NAT or office network are separate
 *     accounts with separate allowances; a 3x ceiling made them throttle each
 *     other (ten conversation creations per account per minute is a ceiling
 *     of thirty per network). A day-long shared bucket only ever punished the
 *     last colleague to arrive.
 *
 * Subject classification is positive on purpose: only a value that has the
 * shape of a real user id (or the `user:` chat usage key) is treated as
 * signed in. Anything else -- a raw IP, `guest:...`, `anonymous:...`,
 * `signup-intent:...` -- keeps the stricter anonymous ceiling, so a caller
 * that forgets to be classified fails closed.
 *
 * Pure module: no database or framework imports, so it is unit-testable.
 */

export type ApiRatePeriod = "minute" | "day";

/** Ceiling multiple of the subject limit for anonymous subjects (both periods). */
export const ANONYMOUS_IP_LIMIT_MULTIPLIER = 3;

/** Per-minute ceiling multiple for signed-in subjects. Day has no IP bucket. */
export const SIGNED_IN_IP_MINUTE_LIMIT_MULTIPLIER = 8;

// Prisma `@default(cuid())` user ids: `c` + 24 lowercase alphanumerics.
const USER_ID_PATTERN = /^c[a-z0-9]{24}$/;
// `userChatUsageKey`: `user:` + sha256 hex.
const USER_USAGE_KEY_PATTERN = /^user:[0-9a-f]{64}$/;

export const isSignedInRateLimitSubject = (subject: string): boolean =>
  USER_ID_PATTERN.test(subject) || USER_USAGE_KEY_PATTERN.test(subject);

/**
 * The limit of the per-IP bucket for one period, or `null` when this subject
 * has no IP bucket for that period.
 */
export const ipBucketLimit = (
  subject: string,
  period: ApiRatePeriod,
  subjectLimit: number
): number | null => {
  if (!isSignedInRateLimitSubject(subject)) {
    return subjectLimit * ANONYMOUS_IP_LIMIT_MULTIPLIER;
  }
  return period === "minute"
    ? subjectLimit * SIGNED_IN_IP_MINUTE_LIMIT_MULTIPLIER
    : null;
};
