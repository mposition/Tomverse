/**
 * Recent-authentication claim of the Desktop account-settings session.
 *
 * A Desktop device holds a token family that was created by a real sign-in
 * (the browser exchange or the email code). `MobileTokenFamily.createdAt` is
 * written once, at that sign-in; a refresh only moves `lastRotatedAt`. So the
 * family's creation time is the moment the person last proved who they are on
 * this device, and a refreshed-but-old device never looks recently signed in.
 *
 * The claim is kept inside `desktopSettings`, not in the top-level
 * `authenticatedAt` that web sign-ins stamp: the administrator console reads
 * `session.user.authenticatedAt`, and a Desktop device must not become an
 * administrator step-up proof by carrying one. Account-sensitive routes read
 * `desktopAuthenticatedAt` through `resolveAccountAuthenticatedAt`.
 */

// These three live in lib/adminAuthCore.ts: lib/auth.ts and lib/adminReauthentication.ts are inside the Prompt Refiner's
// pinned runtime source closure, and importing this file from them would add a file to that sealed list.
export { desktopRecentAuthEnabled, readDesktopAuthenticatedAt, resolveAccountAuthenticatedAt } from "./adminAuthCore";

export type DesktopSettingsClaim = {
  family: string;
  device: string;
  id: string;
  /** ISO time of the sign-in that created the device's token family. */
  authenticatedAt?: string;
};

export function buildDesktopSettingsClaim(input: {
  familyId: string;
  deviceId: string;
  tokenId: string;
  /** The family's `createdAt`, read for exactly this user, device and live family. */
  familyCreatedAt: Date | null;
  enabled: boolean;
}): DesktopSettingsClaim {
  const claim: DesktopSettingsClaim = { family: input.familyId, device: input.deviceId, id: input.tokenId };
  if (input.enabled && input.familyCreatedAt && Number.isFinite(input.familyCreatedAt.getTime())) {
    claim.authenticatedAt = input.familyCreatedAt.toISOString();
  }
  return claim;
}

type FamilyReader = {
  mobileTokenFamily: {
    findFirst(args: {
      where: {
        id: string; userId: string; deviceId: string; revokedAt: null; absoluteExpiresAt: { gt: Date };
      };
      select: { createdAt: true };
    }): Promise<{ createdAt: Date } | null>;
  };
};

/**
 * The creation time of the device's live token family, or null when the family
 * is not this user's and this device's, is revoked, or has passed its absolute
 * expiry. A null here means no settings session is issued.
 */
export async function readLiveDesktopFamilyCreatedAt(
  db: FamilyReader,
  identity: { familyId: string; userId: string; deviceId: string },
  now: Date,
): Promise<Date | null> {
  const family = await db.mobileTokenFamily.findFirst({
    where: {
      id: identity.familyId, userId: identity.userId, deviceId: identity.deviceId,
      revokedAt: null, absoluteExpiresAt: { gt: now },
    },
    select: { createdAt: true },
  });
  return family?.createdAt ?? null;
}
