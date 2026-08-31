// Whether a revocation snapshot is fresh enough to act on.
//
// Contract: .github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md
// D12, approved 2026-08-31 with a fifteen-second bound (8.1.1 #6).
//
// ## The bound this exists to make true
//
// "A revocation is observed on the authorization path within N seconds, and a
// slow lookup does not push past that value."
//
// The existing web path cannot promise the second half, and the packet records
// why. `lib/sessionSecurity.ts` stamps `expiresAt` when the query *returns*:
//
//     const user = await prisma.user.findUnique(...)   // the fact at t=start
//     snapshotCache.set(userId, {
//       expiresAt: Date.now() + SNAPSHOT_TTL_MS,       // the window from t=end
//       snapshot,
//     });
//     return snapshot;                                 // and the waiter gets it
//
// Two failures, not one:
//
//   1. the window is measured from completion, so the real bound is
//      `TTL + lookup latency` and the tail is unbounded;
//   2. an invalidation that happened while the query was in flight is
//      overwritten by that write, so it is simply lost.
//
// And a third, which is the one most easily missed: refusing to *cache* a stale
// result does not stop it *authorizing the request that was waiting for it*.
// Query starts at 0, revocation at 1, return at 20 -- nothing is written and
// that request still passes on a nineteen-second-old fact.
//
// So this module answers two questions separately, and a caller has to read
// both. `usable` is about the request in hand. `cacheable` is about everyone
// after it. They are not the same boolean and are never collapsed into one.
//
// Pure: every input is passed in, including the clock, so the delayed-lookup
// vectors (V29a, V29b) are ordinary unit tests rather than timing experiments.

export type MobileFreshnessRefusal =
  /** The lookup itself failed. Fail closed, exactly as the web path does. */
  | "lookup_failed"
  /** The subject is gone. Fail closed rather than treating absence as absence of revocation. */
  | "subject_missing"
  /** The result aged past its window before it arrived. */
  | "stale_on_arrival"
  /** A revocation landed while this lookup was in flight. */
  | "raced_invalidation";

export type MobileFreshnessVerdict = {
  /** May the request that waited for this lookup be authorized by it? */
  usable: boolean;
  /** May this result be stored for later requests? */
  cacheable: boolean;
  /** When cacheable, the instant it stops being usable -- measured from the query *start*. */
  expiresAtMs: number | null;
  refusal: MobileFreshnessRefusal | null;
};

export type MobileFreshnessInputs = {
  /** When the query was issued. The window is measured from here, not from completion. */
  queryStartedAtMs: number;
  /** When the query returned. */
  completedAtMs: number;
  /** Now, at the moment the decision is made. */
  nowMs: number;
  /** The approved bound, in milliseconds. */
  ttlMs: number;
  /**
   * The invalidation generation observed when the query was issued, and the one
   * observed when it returned. A change means a revocation happened in between,
   * so whatever this lookup read predates it.
   */
  generationAtStart: number;
  generationAtCompletion: number;
  /** Did the lookup itself succeed, and did it find the subject? */
  outcome: "ok" | "lookup_failed" | "subject_missing";
};

const refuse = (refusal: MobileFreshnessRefusal): MobileFreshnessVerdict => ({
  usable: false,
  cacheable: false,
  expiresAtMs: null,
  refusal,
});

export const judgeMobileRevocationFreshness = (
  input: MobileFreshnessInputs
): MobileFreshnessVerdict => {
  // Fail closed on both failure shapes, matching `lib/sessionRevocationCore.ts`:
  // a lookup that could not be performed is not evidence that nothing was
  // revoked.
  if (input.outcome === "lookup_failed") return refuse("lookup_failed");
  if (input.outcome === "subject_missing") return refuse("subject_missing");

  // A revocation that landed mid-flight. Checked before the clock, because this
  // one is fatal regardless of how quick the query was -- a lookup that took a
  // millisecond can still straddle a revocation.
  if (input.generationAtCompletion !== input.generationAtStart) {
    return refuse("raced_invalidation");
  }

  // The window runs from when the query was issued. A lookup slower than the
  // whole window produces a result that was already stale when it arrived, and
  // that result authorizes nothing -- not the waiting request, not anyone.
  const expiresAtMs = input.queryStartedAtMs + input.ttlMs;
  if (input.nowMs >= expiresAtMs) return refuse("stale_on_arrival");

  return { usable: true, cacheable: true, expiresAtMs, refusal: null };
};

/**
 * Whether an already-cached entry may still be used.
 *
 * Separate from the judgement above because a cache hit has no query to date
 * from: it carries the `expiresAtMs` that judgement computed, which is already
 * anchored to that query's start.
 */
export const cachedRevocationSnapshotUsable = (input: {
  expiresAtMs: number;
  nowMs: number;
  /** The generation the entry was stored under, and the current one. */
  storedGeneration: number;
  currentGeneration: number;
}) =>
  input.nowMs < input.expiresAtMs &&
  input.storedGeneration === input.currentGeneration;
