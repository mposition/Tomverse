/**
 * The fifteen-second revocation cache, and the three things that make its bound
 * real rather than nominal.
 *
 * Contract: .github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md
 * D12, approved 2026-08-31 with those three as requirements rather than
 * suggestions (decisions 6 and 18).
 *
 * `lib/mobileRevocationFreshnessCore.ts` decides whether one lookup's result may
 * be used and whether it may be stored. This is the machinery around that
 * decision: the cache it writes into, the generation counter it compares, and
 * the retry it earns. Kept apart from `lib/mobileSessionAuthorization.ts`, which
 * binds it to Prisma, so V29a and V29b can be driven by an injected slow lookup
 * rather than by a real database that would have to actually be slow.
 *
 * ## The three requirements, and where each one lives here
 *
 *   1. **The window runs from the query's start.** `expiresAtMs` comes back
 *      from the freshness judgement, which computed it as `queryStartedAtMs +
 *      ttl`. Stamping it on return -- which is what the web path does -- makes
 *      the real bound `ttl + latency`, and latency has a long tail.
 *
 *   2. **A revocation that lands mid-flight is caught.** The generation is read
 *      before the query and again after it. A change means whatever the query
 *      read predates the revocation, and the result is discarded rather than
 *      written over the invalidation that arrived while it was in flight.
 *
 *   3. **Refusing to cache is not enough.** A stale result must not authorize
 *      the request that was waiting for it either. Those are two separate
 *      answers from the judgement and both are read here.
 *
 * ## What the retry is for, and what it is not for
 *
 * Exactly one, and only for the two racing refusals. `raced_invalidation` and
 * `stale_on_arrival` both mean "this attempt straddled something"; the second
 * attempt starts after that something and simply reads the new truth. A
 * `lookup_failed` or a `subject_missing` would only be repeated, so those fail
 * closed immediately.
 *
 * ## The counter is in-process, and that is a bound rather than a hole
 *
 * A revocation performed by another instance is not seen by this counter; it is
 * caught by the fifteen-second window instead. The counter closes the race this
 * instance can actually see, which is the one where its own write and its own
 * in-flight read cross.
 */

import {
  cachedRevocationSnapshotUsable,
  judgeMobileRevocationFreshness,
  type MobileFreshnessRefusal,
} from "@/lib/mobileRevocationFreshnessCore";

/** Everything the authorization decision needs about one family. */
export type MobileSessionSnapshot = {
  userId: string;
  deviceId: string;
  familyId: string;
  accountStatus: string;
  sessionsRevokedAtMs: number | null;
  familyRevokedAtMs: number | null;
  deviceRevokedAtMs: number | null;
  absoluteExpiresAtMs: number;
  lastRotatedAtMs: number;
};

export type MobileSnapshotResult =
  | { snapshot: MobileSessionSnapshot }
  | { refusal: MobileFreshnessRefusal };

type CacheEntry = {
  snapshot: MobileSessionSnapshot;
  expiresAtMs: number;
  generation: number;
};

export type MobileSnapshotStorePorts = {
  /** Returns the family's state, or null when there is no such family. */
  loadSnapshot: (familyId: string) => Promise<MobileSessionSnapshot | null>;
  /** Injected so a test can make a lookup slower than the window without waiting. */
  now?: () => number;
  ttlMs: number;
};

export type MobileSnapshotStore = {
  /** The family's state, fresh enough to authorize with, or a refusal. */
  read: (familyId: string, userId: string) => Promise<MobileSnapshotResult>;
  /** Called by every path that revokes anything for this account. */
  invalidate: (userId: string) => void;
  /** Observability, and how a test starts clean. */
  reset: () => void;
  /** How many entries are held. Diagnostics only; never an input to a decision. */
  size: () => number;
};

export const createMobileSnapshotStore = (
  ports: MobileSnapshotStorePorts
): MobileSnapshotStore => {
  const now = ports.now ?? (() => Date.now());

  /**
   * Keyed by family, not by account.
   *
   * D11's whole point is that the revocation events have different reach:
   * losing one phone ends one family and leaves the other devices and the web
   * session alone. An account-keyed cache would make the narrow events behave
   * like the wide one.
   */
  const entries = new Map<string, CacheEntry>();
  /** Per account, because a global sign-out reaches every family at once. */
  const generations = new Map<string, number>();

  const generationFor = (userId: string) => generations.get(userId) ?? 0;

  const readOnce = async (
    familyId: string,
    userId: string
  ): Promise<MobileSnapshotResult> => {
    const generationAtStart = generationFor(userId);
    const queryStartedAtMs = now();

    let snapshot: MobileSessionSnapshot | null = null;
    let outcome: "ok" | "lookup_failed" | "subject_missing" = "ok";
    try {
      snapshot = await ports.loadSnapshot(familyId);
      if (!snapshot) outcome = "subject_missing";
    } catch {
      // Fail closed, as lib/sessionRevocationCore.ts does: a lookup that could
      // not be performed is not evidence that nothing was revoked.
      outcome = "lookup_failed";
    }

    const completedAtMs = now();
    const verdict = judgeMobileRevocationFreshness({
      queryStartedAtMs,
      completedAtMs,
      nowMs: completedAtMs,
      ttlMs: ports.ttlMs,
      generationAtStart,
      generationAtCompletion: generationFor(userId),
      outcome,
    });

    if (verdict.cacheable && verdict.expiresAtMs !== null && snapshot) {
      entries.set(familyId, {
        snapshot,
        expiresAtMs: verdict.expiresAtMs,
        // The generation the *query* saw, not the current one. Storing the
        // current one would let an entry outlive the invalidation it raced.
        generation: generationAtStart,
      });
    }
    if (!verdict.usable || !snapshot) {
      return { refusal: verdict.refusal ?? "lookup_failed" };
    }
    return { snapshot };
  };

  return {
    read: async (familyId, userId) => {
      const cached = entries.get(familyId);
      if (
        cached &&
        cached.snapshot.userId === userId &&
        cachedRevocationSnapshotUsable({
          expiresAtMs: cached.expiresAtMs,
          nowMs: now(),
          storedGeneration: cached.generation,
          currentGeneration: generationFor(userId),
        })
      ) {
        return { snapshot: cached.snapshot };
      }

      const first = await readOnce(familyId, userId);
      if ("snapshot" in first) return first;
      if (
        first.refusal !== "raced_invalidation" &&
        first.refusal !== "stale_on_arrival"
      ) {
        return first;
      }
      return readOnce(familyId, userId);
    },

    invalidate: (userId) => {
      generations.set(userId, generationFor(userId) + 1);
      for (const [familyId, entry] of entries) {
        if (entry.snapshot.userId === userId) entries.delete(familyId);
      }
    },

    reset: () => {
      entries.clear();
      generations.clear();
    },

    size: () => entries.size,
  };
};
