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

const CANONICAL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Default off: with it unset the settings session carries no claim at all. */
export const desktopRecentAuthEnabled = (env: Record<string, string | undefined> = process.env) =>
  env.TOMVERSE_DESKTOP_RECENT_AUTH_ENABLED === "true";

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

/** What the session callback may expose: a canonical timestamp, and only while the switch is on. */
export function readDesktopAuthenticatedAt(
  claim: { authenticatedAt?: unknown } | null | undefined,
  enabled: boolean,
): string | undefined {
  if (!enabled || !claim) return undefined;
  const value = claim.authenticatedAt;
  if (typeof value !== "string" || !CANONICAL_ISO.test(value) || !Number.isFinite(Date.parse(value))) return undefined;
  return value;
}

/** The sign-in time an account-sensitive action checks: the web's, else a Desktop device's. */
export const resolveAccountAuthenticatedAt = (
  user: { authenticatedAt?: string | null; desktopAuthenticatedAt?: string | null } | null | undefined,
) => user?.authenticatedAt || user?.desktopAuthenticatedAt || undefined;

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
