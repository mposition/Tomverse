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
import type { MobileFreshnessRefusal } from "@/lib/mobileRevocationFreshnessCore";
import {
  createMobileSnapshotStore,
  type MobileSessionSnapshot,
} from "@/lib/mobileSessionSnapshotCache";
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

/**
 * The Prisma half of the read the cache performs.
 *
 * One query, and every column it selects is one the authorization decision
 * below actually reads. `include` is deliberately absent: a new column on
 * `MobileTokenFamily` must not silently join a hot path.
 */
const loadSnapshot = async (
  familyId: string
): Promise<MobileSessionSnapshot | null> => {
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
 * One store for the process, holding the D12 contract.
 *
 * The contract itself is in `lib/mobileSessionSnapshotCache.ts`, with its
 * lookup injected, so V29a and V29b are ordinary unit tests rather than timing
 * experiments against a database that would have to actually be slow.
 */
const store = createMobileSnapshotStore({ loadSnapshot, ttlMs: TTL_MS });

/** Called by every path that revokes anything for this account. */
export const invalidateMobileSessionSnapshots = (userId: string) =>
  store.invalidate(userId);

/** Test seam: the cache is process state, and a test must be able to start clean. */
export const resetMobileSessionSnapshotsForTesting = () => store.reset();

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
  const result = await store.read(identity.family, identity.subject);
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
