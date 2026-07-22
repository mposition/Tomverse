import "server-only";

import type { Session } from "next-auth";

export class AdminReauthenticationRequiredError extends Error {
  constructor() {
    super("Sign in again before performing this high-risk administrator action.");
    this.name = "AdminReauthenticationRequiredError";
  }
}

const recentAuthMinutes = () => {
  const parsed = Number(process.env.ADMIN_RECENT_AUTH_MINUTES || 30);
  return Number.isFinite(parsed)
    ? Math.min(240, Math.max(5, Math.trunc(parsed)))
    : 30;
};

// Reads session.user.authenticatedAt (a JWT-derived timestamp stamped fresh on
// every real sign-in, see callbacks.jwt/session in lib/auth.ts) rather than
// looking up a Prisma Session row: this app uses session.strategy "jwt", under
// which NextAuth never writes to the Session table, so a DB-session lookup
// here would always fail to find a match and always throw.
export async function assertRecentAdminAuthentication(session: Session) {
  const userId = session.user?.id;
  const authenticatedAt = session.user?.authenticatedAt;
  if (!userId || !authenticatedAt) throw new AdminReauthenticationRequiredError();
  const authenticatedAtMs = new Date(authenticatedAt).getTime();
  const cutoff = Date.now() - recentAuthMinutes() * 60_000;
  if (!Number.isFinite(authenticatedAtMs) || authenticatedAtMs < cutoff) {
    throw new AdminReauthenticationRequiredError();
  }
}

export const isAdminReauthenticationError = (error: unknown) =>
  error instanceof AdminReauthenticationRequiredError;
