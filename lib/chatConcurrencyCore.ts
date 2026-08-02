/**
 * Concurrency scopes for chat requests.
 *
 * Concurrency is neither an entitlement nor a cost guardrail: it bounds how
 * many responses a caller may have *in flight at this instant*, and it says
 * nothing about credits, plans or spend. It therefore carries its own error
 * codes, its own `limitLayer` values and its own user-facing copy, exactly the
 * way `docs/policy/credit-and-cost-limits.md` separates entitlement from
 * operational guardrails.
 *
 * Two scopes exist, and they are deliberately different things:
 *
 *   * `subject` -- the individual caller. For a signed-in user that is their
 *     account; for a guest it is the *signed guest cookie*, not the IP. Two
 *     people behind one NAT are two subjects and must not consume each other's
 *     allowance. Scoping a guest's own limit to the IP is what made a
 *     three-model comparison from one phone reject the next request from an
 *     unrelated laptop on the same Wi-Fi.
 *
 *   * `ip` -- an aggregate abuse ceiling for anonymous traffic only. It exists
 *     because the guest subject is a cookie the client controls the *quantity*
 *     of: clearing it mints a new subject. Without a ceiling, one script can
 *     hold unbounded concurrent streams open. It is intentionally several times
 *     the per-guest limit so that ordinary shared networks never reach it, and
 *     it is clamped so it can never be configured below the per-guest limit --
 *     an IP ceiling under the subject limit would silently become the subject
 *     limit again.
 *
 * This module is pure so the arithmetic can be unit-tested without a database.
 */

export type ChatConcurrencyKind = "user" | "guest";

export type ChatConcurrencyScopeName = "subject" | "ip";

export type ChatConcurrencyScope = {
    scope: ChatConcurrencyScopeName;
    /** Hashed key the lease rows are counted by. Never a raw IP or user ID. */
    key: string;
    limit: number;
    errorCode: string;
    /** Recorded on ChatLimitDecisionEvent so a 429 is attributable to a layer. */
    limitLayer: string;
    /** Recorded as `limitScope`; also the `scope` detail on the error. */
    limitScope: string;
};

export type ChatConcurrencyPlan = {
    subject: ChatConcurrencyScope;
    /** Null for signed-in users: the account is already the accountable unit. */
    ip: ChatConcurrencyScope | null;
    /** True when the configured IP ceiling had to be raised to the floor. */
    ipCeilingClamped: boolean;
};

export const SUBJECT_CONCURRENCY_EXCEEDED = "CHAT_CONCURRENCY_EXCEEDED";
export const IP_CONCURRENCY_EXCEEDED = "CHAT_IP_CONCURRENCY_EXCEEDED";

/** Layer names. `entitlement` and `operational_guardrail` belong to credits. */
export const SUBJECT_CONCURRENCY_LAYER = "concurrency";
export const IP_CONCURRENCY_LAYER = "operational_admission";

export const DEFAULT_USER_CONCURRENCY = 3;
export const DEFAULT_GUEST_CONCURRENCY = 3;
/**
 * Eight times the per-guest limit. A shared office, campus or cafe NAT routinely
 * carries a handful of simultaneous visitors; the ceiling only has to stop a
 * single host from opening streams without bound, so it sits far above any
 * plausible honest burst rather than just above it.
 */
export const DEFAULT_IP_CONCURRENCY_CEILING = 24;

const positiveInteger = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const resolveChatConcurrencyPlan = (
    access: {
        kind: ChatConcurrencyKind;
        subjectKey: string;
        ipKey: string;
    },
    env: Record<string, string | undefined> = process.env
): ChatConcurrencyPlan => {
    const subjectLimit =
        access.kind === "user"
            ? positiveInteger(env.CHAT_USER_CONCURRENT, DEFAULT_USER_CONCURRENCY)
            : positiveInteger(
                  env.CHAT_GUEST_CONCURRENT,
                  DEFAULT_GUEST_CONCURRENCY
              );

    const subject: ChatConcurrencyScope = {
        scope: "subject",
        key: access.subjectKey,
        limit: subjectLimit,
        errorCode: SUBJECT_CONCURRENCY_EXCEEDED,
        limitLayer: SUBJECT_CONCURRENCY_LAYER,
        limitScope:
            access.kind === "user" ? "user_concurrency" : "guest_concurrency",
    };

    if (access.kind !== "guest") {
        return { subject, ip: null, ipCeilingClamped: false };
    }

    const configuredCeiling = positiveInteger(
        env.CHAT_IP_CONCURRENT,
        DEFAULT_IP_CONCURRENCY_CEILING
    );
    // Floor at the per-guest limit: a ceiling below it would reject a single
    // guest's own allowance in the aggregate scope, which is the exact defect
    // this split exists to remove.
    const ceiling = Math.max(configuredCeiling, subjectLimit);

    return {
        subject,
        ip: {
            scope: "ip",
            key: access.ipKey,
            limit: ceiling,
            errorCode: IP_CONCURRENCY_EXCEEDED,
            limitLayer: IP_CONCURRENCY_LAYER,
            limitScope: "ip_concurrency",
        },
        ipCeilingClamped: ceiling !== configuredCeiling,
    };
};

/**
 * User-facing sentence for a concurrency rejection.
 *
 * Deliberately distinct per scope: "your own answer is still running" and "this
 * network is busy" are different situations with different ways out, and
 * neither is a credit, plan or provider-budget problem. Carries no IP, no hash,
 * no lease key and no internal USD.
 */
export const concurrencyRejectionMessage = (
    scope: ChatConcurrencyScopeName
) =>
    scope === "ip"
        ? "This network is sending a lot of requests right now. Try again in a moment."
        : "A response is already being generated. Try again once it finishes or is stopped.";

export type ConcurrencyRejectionDetails = {
    scope: string;
    limitLayer: string;
    activeRequests: number;
    requestedSlots: number;
    concurrentLimit: number;
};

export const concurrencyRejectionDetails = (
    scope: ChatConcurrencyScope,
    activeRequests: number,
    requestedSlots: number
): ConcurrencyRejectionDetails => ({
    scope: scope.limitScope,
    limitLayer: scope.limitLayer,
    activeRequests,
    requestedSlots,
    concurrentLimit: scope.limit,
});

/**
 * Seconds a caller should wait before retrying a concurrency rejection.
 *
 * Always positive, so the `Retry-After` header and any derived reset instant
 * are in the future at the moment the response is built.
 */
export const CONCURRENCY_RETRY_AFTER_SECONDS = 5;

/* ------------------------------------------------------------------------- */
/* Lease lifetime                                                            */
/* ------------------------------------------------------------------------- */

/**
 * How long a claimed lease survives without a heartbeat.
 *
 * The old value was a flat 120s, chosen to be "long enough" for a stream. It
 * was not: production observed a healthy response still writing at 125s, at
 * which point its lease had already expired and a *different* request could
 * take the slot while the first was still consuming provider capacity. The
 * answer is not a bigger constant -- a stream that legitimately runs for ten
 * minutes would break any constant -- but a short lifetime that a running
 * stream keeps renewing. A dead process stops renewing and the slot frees on
 * its own within one TTL.
 */
export const DEFAULT_LEASE_TTL_SECONDS = 180;
export const MIN_LEASE_TTL_SECONDS = 60;
export const MAX_LEASE_TTL_SECONDS = 1_800;

export const resolveLeaseTtlSeconds = (
    env: Record<string, string | undefined> = process.env
) =>
    Math.min(
        MAX_LEASE_TTL_SECONDS,
        Math.max(
            MIN_LEASE_TTL_SECONDS,
            positiveInteger(
                env.CHAT_LEASE_TTL_SECONDS,
                DEFAULT_LEASE_TTL_SECONDS
            )
        )
    );

/**
 * How often a running stream renews its lease.
 *
 * A third of the TTL: two consecutive heartbeats may be lost (a slow event
 * loop, a database blip) before the lease is at risk, and the write rate stays
 * at one row update per minute per stream at the default TTL.
 */
export const leaseHeartbeatIntervalMs = (ttlSeconds: number) =>
    Math.max(10_000, Math.floor((ttlSeconds * 1000) / 3));

/**
 * How long an *unclaimed* admission slot is held.
 *
 * An admission is issued by the aggregate preflight and consumed moments later
 * by the per-model requests. If the browser never sends them (the tab closed,
 * the network dropped), the reserved slots must not sit on the subject's
 * allowance for a full stream TTL. Short enough to self-heal, long enough to
 * survive a slow first byte on a bad connection.
 */
export const DEFAULT_ADMISSION_TTL_SECONDS = 60;

export const resolveAdmissionTtlSeconds = (
    env: Record<string, string | undefined> = process.env
) =>
    Math.min(
        300,
        Math.max(
            15,
            positiveInteger(
                env.CHAT_ADMISSION_TTL_SECONDS,
                DEFAULT_ADMISSION_TTL_SECONDS
            )
        )
    );
