/**
 * Per-minute request rate scopes for chat.
 *
 * A rate limit is a fourth layer, alongside the three
 * `docs/policy/chat-concurrency-and-identity.md` already separates. It is not
 * an entitlement (it says nothing about credits or plan), not a cost guardrail
 * (it counts requests, not micro-USD) and not concurrency (it counts requests
 * *per minute*, not requests in flight). Recording it as any of those makes a
 * user who has to wait six seconds indistinguishable in the decision log from
 * one who has run out of credits, which is how the wrong answer gets given to
 * the wrong person.
 *
 * Two scopes, deliberately different things -- the same split concurrency
 * makes:
 *
 *   * `subject` -- this caller's own allowance. For a signed-in user that is
 *     their account (`CHAT_USER_PER_MINUTE`); for a guest it is the *signed
 *     guest cookie* (`CHAT_GUEST_PER_MINUTE`), never the IP.
 *
 *   * `ip` -- the aggregate abuse ceiling for a public address
 *     (`CHAT_IP_PER_MINUTE`). It applies to every caller, because it is the
 *     protection that survives someone minting fresh guest cookies.
 *
 * The arithmetic that matters here is that a multi-model comparison costs one
 * unit *per model*: a three-model comparison needs three units in both scopes
 * before any of its panels may start. Checking one unit at a time is what let
 * two panels run and the third come back 429.
 *
 * Pure so the arithmetic can be unit-tested without a database.
 */

export type ChatRateKind = "user" | "guest";

export type ChatRateScopeName = "subject" | "ip";

export const CHAT_RATE_LIMITED = "CHAT_RATE_LIMITED";

/**
 * Layer names. `entitlement` and `operational_guardrail` belong to credits and
 * cost; `concurrency` and `operational_admission` belong to in-flight slots.
 * A subject rate limit is its own layer; the IP ceiling shares the aggregate
 * anonymous-admission layer with the IP concurrency ceiling, because it is the
 * same kind of decision about the same kind of scope.
 */
export const SUBJECT_RATE_LIMIT_LAYER = "rate_limit";
export const IP_RATE_LIMIT_LAYER = "operational_admission";

export const DEFAULT_IP_PER_MINUTE = 40;

export type ChatRateScope = {
    scope: ChatRateScopeName;
    /** Hashed bucket key. Never a raw IP, user ID or guest cookie. */
    key: string;
    limit: number;
    /** Recorded on ChatLimitDecisionEvent so a 429 is attributable. */
    limitLayer: string;
    /** Recorded as `limitScope`; also the `scope` detail on the error. */
    limitScope: string;
};

const positiveInteger = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const resolveIpPerMinuteLimit = (
    env: Record<string, string | undefined> = process.env
) => positiveInteger(env.CHAT_IP_PER_MINUTE, DEFAULT_IP_PER_MINUTE);

export const subjectRateScope = (
    kind: ChatRateKind,
    key: string,
    limit: number
): ChatRateScope => ({
    scope: "subject",
    key,
    limit,
    limitLayer: SUBJECT_RATE_LIMIT_LAYER,
    limitScope: kind === "user" ? "user_rate_minute" : "guest_rate_minute",
});

export const ipRateScope = (key: string, limit: number): ChatRateScope => ({
    scope: "ip",
    key,
    limit,
    limitLayer: IP_RATE_LIMIT_LAYER,
    limitScope: "ip_rate_minute",
});

/**
 * User-facing sentence for a rate rejection.
 *
 * Distinct per scope for the same reason the concurrency copy is: "you are
 * sending faster than your own allowance" and "this network is sending a lot
 * right now" have different answers, and neither is a credit problem. Carries
 * no hash, no IP and no internal USD.
 */
export const rateLimitRejectionMessage = (scope: ChatRateScopeName) =>
    scope === "ip"
        ? "This network is sending requests too quickly. Wait a moment and try again."
        : "Requests are being sent too quickly. Wait a moment and try again.";

export type RateLimitRejectionDetails = {
    scope: string;
    limitLayer: string;
    retryAfterSeconds: number;
    requestedRequests: number;
    availableRequests: number;
    rateLimit: number;
    resetAt: string;
};

/**
 * Public details for a rate rejection.
 *
 * `retryAfterSeconds` is the same number the `Retry-After` header carries, so
 * a client that reads either one counts down to the same instant, and `resetAt`
 * is that instant spelled out. Both are always at least one second in the
 * future: a countdown that starts at zero, or a reset that has already passed,
 * tells a blocked user nothing they can act on.
 */
/**
 * What a rejected client should count down from.
 *
 * The server sends the same number twice -- `Retry-After` for anything that
 * speaks HTTP, and `details.retryAfterSeconds` for the UI -- so this reads
 * either. `details` wins because a proxy may rewrite a header, and the body is
 * what the rest of the rejection was built from.
 *
 * Never returns zero: a countdown that opens at "try again in 0 seconds" reads
 * as a bug to the person looking at it.
 */
export const DEFAULT_RATE_RETRY_AFTER_SECONDS = 5;

export const retryAfterSecondsFromResponse = (
    headerValue: string | null | undefined,
    details: unknown,
    fallback = DEFAULT_RATE_RETRY_AFTER_SECONDS
) => {
    const fromDetails =
        details && typeof details === "object"
            ? (details as Record<string, unknown>).retryAfterSeconds
            : undefined;
    const candidates = [fromDetails, headerValue];
    for (const candidate of candidates) {
        if (candidate === null || candidate === undefined || candidate === "") {
            continue;
        }
        const parsed = Number(candidate);
        if (Number.isFinite(parsed) && parsed > 0) {
            return Math.max(1, Math.ceil(parsed));
        }
    }
    return Math.max(1, Math.ceil(fallback));
};

export const rateLimitRejectionDetails = (
    scope: ChatRateScope,
    input: {
        usedRequests: number;
        requestedRequests: number;
        retryAfterSeconds: number;
        resetAt: Date;
    }
): RateLimitRejectionDetails => ({
    scope: scope.limitScope,
    limitLayer: scope.limitLayer,
    retryAfterSeconds: Math.max(1, Math.ceil(input.retryAfterSeconds)),
    requestedRequests: input.requestedRequests,
    availableRequests: Math.max(0, scope.limit - input.usedRequests),
    rateLimit: scope.limit,
    resetAt: input.resetAt.toISOString(),
});
