/**
 * Session-revocation rules for JWT sessions.
 *
 * Sessions use `session.strategy = "jwt"`, so there is no server-side session
 * row to delete and `prisma.session.deleteMany` can never revoke anything. Two
 * server-side signals are checked instead, on every session resolution:
 *
 *  - `sessionsRevokedAt` - the invalidation epoch bumped by
 *    revokeAllUserSessions() (suspend, forced sign-out, OAuth unlink, scheduled
 *    account deletion). Tokens issued at or before it are rejected.
 *  - `accountStatus` - anything other than "active" loses its session, so a
 *    suspended or pending-deletion account cannot keep using the API.
 *
 * Kept free of Prisma and next-auth imports so it is directly unit-testable.
 */

export type SessionSecuritySnapshot = {
  accountStatus: string | null;
  sessionsRevokedAt: Date | string | null;
};

export type SessionSecuritySnapshotResult =
  | SessionSecuritySnapshot
  | { lookupStatus: "user-not-found" | "lookup-error" }
  | null;

export type SessionRevocationReason =
  | "missing-issued-at"
  | "revoked"
  | "account-not-active"
  | "user-not-found"
  | "lookup-error";

const toMillis = (value: Date | string | null | undefined) => {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Returns the reason a session must be rejected, or null when it stays valid.
 *
 * Fails closed: a token with no usable issue time cannot be proven to postdate a
 * revocation, so it is rejected rather than trusted.
 */
export const sessionRevocationReason = ({
  issuedAt,
  snapshot,
}: {
  issuedAt: string | number | null | undefined;
  snapshot: SessionSecuritySnapshotResult;
}): SessionRevocationReason | null => {
  // Null is reserved for the isolated E2E database bypass. Real lookup
  // failures and missing users are explicit states and fail closed below.
  if (!snapshot) return null;

  if ("lookupStatus" in snapshot) return snapshot.lookupStatus;

  if (snapshot.accountStatus && snapshot.accountStatus !== "active") {
    return "account-not-active";
  }

  const revokedAtMs = toMillis(snapshot.sessionsRevokedAt);
  if (revokedAtMs === null) return null;

  const issuedAtMs =
    typeof issuedAt === "number"
      ? issuedAt
      : toMillis(typeof issuedAt === "string" ? issuedAt : null);
  if (issuedAtMs === null) return "missing-issued-at";

  return issuedAtMs <= revokedAtMs ? "revoked" : null;
};

export const isSessionRevoked = (input: {
  issuedAt: string | number | null | undefined;
  snapshot: SessionSecuritySnapshotResult;
}) => sessionRevocationReason(input) !== null;
