// Who owns a chat request's concurrency slot, at every point in the request.
//
// The slot is held by a lease, and the policy (docs/policy/chat-concurrency-and-
// identity.md) is that the lease is released *deterministically* on completion,
// provider error, cancellation, disconnect, failure to build the stream and the
// deep-research handoff -- not left to a TTL. A slot that survives its request
// is not an abstract leak: the person who owns it is told "a response is
// already being generated" until it lapses.
//
// The hard part is not any single release. It is that ownership moves twice.
// The request holds the slot from the moment it is granted; the response stream
// takes it over when the source reader is created, because the stream can
// outlive the handler that built it; and the deep-research job takes over
// nothing at all -- the slot ends there, because the job outlives any lease.
//
// The gap this models is the third state, between those two owners. The stream
// takes the lease when its reader is created, but it cannot release anything
// until it is actually pulled, and it is only ever pulled once the Response has
// been returned. Anything that throws in between -- a rejected Set-Cookie
// value, a header the runtime refuses -- leaves a lease whose owner is a stream
// that will never run. Tracking "the request no longer holds it" as a single
// boolean cannot tell that apart from a healthy handoff, so the unwind path
// stepped over it and the slot waited out its TTL.
//
// Pure and separate from the route so the transitions can be stated once and
// tested, rather than being re-derived from a 2,600-line handler.

export type ChatLeaseHolder =
    /** No slot has been granted yet. */
    | "unheld"
    /** The request itself. Its unwind path must release it. */
    | "request"
    /**
     * The response stream, which has not been published yet. Nothing will ever
     * pull it unless the Response is returned, so the unwind path owns it too.
     */
    | "unstarted_stream"
    /** The published response stream, which releases on every one of its ends. */
    | "stream"
    /** Released, or handed to something that outlives leases. */
    | "gone";

export type ChatLeaseOwnership = {
    holder: ChatLeaseHolder;
    leaseId: string | null;
};

export const NO_CHAT_LEASE: ChatLeaseOwnership = {
    holder: "unheld",
    leaseId: null,
};

/** The slot has been granted and the request holds it. */
export const chatLeaseAcquired = (leaseId: string): ChatLeaseOwnership => ({
    holder: "request",
    leaseId,
});

/**
 * The stream's source reader exists, so the stream is the owner from here.
 *
 * Only meaningful while the request holds it; from any other state this is a
 * no-op, so an out-of-order call cannot resurrect a released lease.
 */
export const chatLeaseTakenByStream = (
    state: ChatLeaseOwnership
): ChatLeaseOwnership =>
    state.holder === "request"
        ? { holder: "unstarted_stream", leaseId: state.leaseId }
        : state;

/**
 * The Response has been returned, so the stream can now actually be pulled and
 * its own release paths are reachable.
 */
export const chatLeaseStreamPublished = (
    state: ChatLeaseOwnership
): ChatLeaseOwnership =>
    state.holder === "unstarted_stream"
        ? { holder: "stream", leaseId: state.leaseId }
        : state;

/**
 * The slot is gone -- released here, or handed to a job that outlives leases.
 */
export const chatLeaseReleased = (): ChatLeaseOwnership => ({
    holder: "gone",
    leaseId: null,
});

export type ChatLeaseUnwind = { leaseId: string; reason: string } | null;

/**
 * What the request's failure path still has to release, and why.
 *
 * The reason is part of the answer rather than a caller's choice: the two cases
 * are different incidents. "Never got as far as a stream" is the ordinary
 * rejection path; "built a stream that was never published" is a bug in the
 * lines between the two, and the release event is the only place it shows.
 */
export const chatLeaseToReleaseOnUnwind = (
    state: ChatLeaseOwnership
): ChatLeaseUnwind => {
    if (!state.leaseId) return null;
    if (state.holder === "request") {
        return {
            leaseId: state.leaseId,
            reason: "request_failed_before_stream",
        };
    }
    if (state.holder === "unstarted_stream") {
        return { leaseId: state.leaseId, reason: "stream_never_started" };
    }
    return null;
};
