import "server-only";

/**
 * Whether a verified mobile access token still authorizes anything.
 *
 * Contract: .github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md
 * D12 (the fifteen-second observation bound) and D11 (what each revocation
 * event reaches), approved 2026-08-31 with the hardened cache contract as a
 * requirement rather than an option (decision 6, and decision 18's "apply D12's
 * hardened contract to the N2 implementation from the start").
 *
 * ## Two layers, and the packet insists they stay two
 *
 * `lib/mobileAccessToken.ts` answers "is this token genuine". This answers "and
 * is the session behind it still alive". A token can be perfectly valid and
 * authorize nothing: the family was revoked, the device released, the account
 * suspended, everything signed out. The gate in proxy.ts never asks this
 * question -- it checks signature and expiry only -- so if this file did not
 * exist a revoked session would keep working until its token expired.
 *
 * ## Why the cache is written this way and not the way the web path is
 *
 * `lib/mobileRevocationFreshnessCore.ts` carries the reasoning in full. The
 * short version is that a fifteen-second TTL does not give a fifteen-second
 * bound: stamping the window from when the query *returned* makes the real
 * bound `TTL + latency`, and refusing to *cache* a stale answer still lets it
 * authorize the request that waited for it. So:
 *
 *   * the window is measured from the query's start;
 *   * an invalidation that lands mid-flight is detected by a generation counter
 *     read on both sides of the query;
 *   * `usable` and `cacheable` are read separately, and a result that is
 *     neither is retried once and then refused.
 *
 * This deliberately does not change `lib/sessionSecurity.ts`. The packet says
 * so, and says the web path is worth its own look; that is a separate follow-up
 * (approved decision 18) and not something to fix by making the two share code.
 */

import {
  MOBILE_REFRESH_IDLE_SECONDS,
  MOBILE_REVOCATION_OBSERVATION_BOUND_SECONDS,
} from "@/lib/mobileAuthContract";
import {
  cachedRevocationSnapshotUsable,
  judgeMobileRevocationFreshness,
  type MobileFreshnessRefusal,
} from "@/lib/mobileRevocationFreshnessCore";
import type { MobileAccessTokenIdentity } from "@/lib/mobileAccessTokenCore";
import { prisma } from "@/lib/prisma";

const TTL_MS = MOBILE_REVOCATION_OBSERVATION_BOUND_SECONDS * 1000;
const IDLE_WINDOW_MS = MOBILE_REFRESH_IDLE_SECONDS * 1000;

export type MobileSessionRefusal =
  | MobileFreshnessRefusal
  | "family_not_found"
  | "family_revoked"
  | "device_revoked"
  | "account_not_active"
  | "sessions_revoked"
  | "family_expired";

type Snapshot = {
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

type CacheEntry = { snapshot: Snapshot; expiresAtMs: number; generation: number };

/**
 * Keyed by family, not by account.
 *
 * D11's whole point is that the events have different reach: losing one phone
 * ends one family and leaves the other devices and the web session alone. An
 * account-keyed cache would make the narrow events look like the wide one.
 */
const snapshotCache = new Map<string, CacheEntry>();

/**
 * The in-process invalidation generation, per account.
 *
 * Bumped by every revocation this process performs, and read on both sides of a
 * lookup so a revocation that lands mid-query is detected rather than
 * overwritten. Per account rather than per family because a global sign-out and
 * an account suspension reach every family at once.
 *
 * It is in-process, and that is a bound rather than a hole: a revocation on
 * another instance is caught by the fifteen-second window instead. The counter
 * closes the race this instance can actually see.
 */
const generations = new Map<string, number>();

const generationFor = (userId: string) => generations.get(userId) ?? 0;

/** Called by every path that revokes anything. */
export const invalidateMobileSessionSnapshots = (userId: string) => {
  generations.set(userId, generationFor(userId) + 1);
  for (const [familyId, entry] of snapshotCache) {
    if (entry.snapshot.userId === userId) snapshotCache.delete(familyId);
  }
};

/** Test seam: the cache is module state, and a test must be able to start clean. */
export const resetMobileSessionSnapshotsForTesting = () => {
  snapshotCache.clear();
  generations.clear();
};

const loadSnapshot = async (familyId: string): Promise<Snapshot | null> => {
  const family = await prisma.mobileTokenFamily.findUnique({
    where: { id: familyId },
    select: {
      id: true,
      userId: true,
      deviceId: true,
      revokedAt: true,
      absoluteExpiresAt: true,
      lastRotatedAt: true,
      device: { select: { revokedAt: true } },
      user: { select: { accountStatus: true, sessionsRevokedAt: true } },
    },
  });
  if (!family) return null;

  return {
    userId: family.userId,
    deviceId: family.deviceId,
    familyId: family.id,
    accountStatus: family.user.accountStatus,
    sessionsRevokedAtMs: family.user.sessionsRevokedAt?.getTime() ?? null,
    familyRevokedAtMs: family.revokedAt?.getTime() ?? null,
    deviceRevokedAtMs: family.device.revokedAt?.getTime() ?? null,
    absoluteExpiresAtMs: family.absoluteExpiresAt.getTime(),
    lastRotatedAtMs: family.lastRotatedAt.getTime(),
  };
};

/**
 * One lookup, judged by the D12 contract.
 *
 * Returns the snapshot only when the freshness verdict says the *waiting
 * request* may be authorized by it -- which is a different question from
 * whether it may be stored, and both are asked.
 */
const readFreshSnapshot = async (
  familyId: string,
  userId: string
): Promise<{ snapshot: Snapshot } | { refusal: MobileFreshnessRefusal }> => {
  const generationAtStart = generationFor(userId);
  const queryStartedAtMs = Date.now();

  let snapshot: Snapshot | null = null;
  let outcome: "ok" | "lookup_failed" | "subject_missing" = "ok";
  try {
    snapshot = await loadSnapshot(familyId);
    if (!snapshot) outcome = "subject_missing";
  } catch {
    // Fail closed, exactly as lib/sessionRevocationCore.ts does: a lookup that
    // could not be performed is not evidence that nothing was revoked.
    outcome = "lookup_failed";
  }

  const completedAtMs = Date.now();
  const verdict = judgeMobileRevocationFreshness({
    queryStartedAtMs,
    completedAtMs,
    nowMs: completedAtMs,
    ttlMs: TTL_MS,
    generationAtStart,
    generationAtCompletion: generationFor(userId),
    outcome,
  });

  if (verdict.cacheable && verdict.expiresAtMs !== null && snapshot) {
    snapshotCache.set(familyId, {
      snapshot,
      expiresAtMs: verdict.expiresAtMs,
      generation: generationAtStart,
    });
  }
  if (!verdict.usable || !snapshot) {
    return { refusal: verdict.refusal ?? "lookup_failed" };
  }
  return { snapshot };
};

/**
 * The state of one family, fresh enough to act on.
 *
 * One retry, then refuse. A retry is right for the two racing refusals -- a
 * revocation that landed mid-query, or a query slower than the window -- because
 * the second attempt starts after the event and simply reads the new truth. It
 * is not right for `lookup_failed` or `subject_missing`, which a retry would
 * only repeat.
 */
const currentSnapshot = async (
  familyId: string,
  userId: string
): Promise<{ snapshot: Snapshot } | { refusal: MobileSessionRefusal }> => {
  const cached = snapshotCache.get(familyId);
  if (
    cached &&
    cached.snapshot.userId === userId &&
    cachedRevocationSnapshotUsable({
      expiresAtMs: cached.expiresAtMs,
      nowMs: Date.now(),
      storedGeneration: cached.generation,
      currentGeneration: generationFor(userId),
    })
  ) {
    return { snapshot: cached.snapshot };
  }

  const first = await readFreshSnapshot(familyId, userId);
  if ("snapshot" in first) return first;
  if (first.refusal !== "raced_invalidation" && first.refusal !== "stale_on_arrival") {
    return { refusal: first.refusal };
  }

  const second = await readFreshSnapshot(familyId, userId);
  return "snapshot" in second ? second : { refusal: second.refusal };
};

/**
 * Whether a verified token still authorizes its holder.
 *
 * The refusals are ordered by reach, widest first: an account that is gone or
 * suspended is a bigger fact than one family being revoked, and reporting the
 * narrow reason for a wide event would send an operator looking at the wrong
 * table.
 */
export const authorizeMobileSession = async (
  identity: MobileAccessTokenIdentity,
  now: Date = new Date()
): Promise<
  | { ok: true; userId: string; deviceId: string; familyId: string }
  | { ok: false; refusal: MobileSessionRefusal }
> => {
  const result = await currentSnapshot(identity.family, identity.subject);
  if ("refusal" in result) {
    return {
      ok: false,
      refusal: result.refusal === "subject_missing" ? "family_not_found" : result.refusal,
    };
  }
  const snapshot = result.snapshot;

  // The token names a family; the family names an account. A token whose `sub`
  // is not that account is not a token for this family, whatever it says.
  if (snapshot.userId !== identity.subject || snapshot.deviceId !== identity.device) {
    return { ok: false, refusal: "family_not_found" };
  }

  if (snapshot.accountStatus !== "active") {
    return { ok: false, refusal: "account_not_active" };
  }
  if (
    snapshot.sessionsRevokedAtMs !== null &&
    identity.issuedAtSeconds * 1000 <= snapshot.sessionsRevokedAtMs
  ) {
    // A global sign-out. Tokens minted at or before the stamp lose; ones minted
    // after it are from a session that started later and are unaffected.
    return { ok: false, refusal: "sessions_revoked" };
  }
  if (snapshot.familyRevokedAtMs !== null) {
    return { ok: false, refusal: "family_revoked" };
  }
  if (snapshot.deviceRevokedAtMs !== null) {
    return { ok: false, refusal: "device_revoked" };
  }

  const nowMs = now.getTime();
  if (
    nowMs >= snapshot.absoluteExpiresAtMs ||
    nowMs - snapshot.lastRotatedAtMs >= IDLE_WINDOW_MS
  ) {
    // The family aged out. The access token may still be inside its ten
    // minutes; the session it belongs to is not.
    return { ok: false, refusal: "family_expired" };
  }

  return {
    ok: true,
    userId: snapshot.userId,
    deviceId: snapshot.deviceId,
    familyId: snapshot.familyId,
  };
};
