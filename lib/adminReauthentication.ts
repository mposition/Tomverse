import "server-only";

import type { Session } from "next-auth";
import {
  isRecentAdminAuthentication,
  resolveRecentAuthMinutes,
} from "@/lib/adminReauthenticationCore";

export class AdminReauthenticationRequiredError extends Error {
  constructor() {
    super("Sign in again before performing this high-risk administrator action.");
    this.name = "AdminReauthenticationRequiredError";
  }
}

// Reads session.user.authenticatedAt (a JWT-derived timestamp stamped fresh on
// every real sign-in, see callbacks.jwt/session in lib/auth.ts) rather than
// looking up a Prisma Session row: this app uses session.strategy "jwt", under
// which NextAuth never writes to the Session table, so a DB-session lookup
// here would always fail to find a match and always throw.
//
// The decision itself lives in lib/adminReauthenticationCore.ts so it can be
// unit-tested without a session or an environment, and so the clock-skew rule
// (a claim dated far in the future buys no step-up window) has one home.
export async function assertRecentAdminAuthentication(session: Session) {
  const userId = session.user?.id;
  if (!userId) throw new AdminReauthenticationRequiredError();
  if (
    !isRecentAdminAuthentication({
      authenticatedAt: session.user?.authenticatedAt,
      recentAuthMinutes: resolveRecentAuthMinutes(
        process.env.ADMIN_RECENT_AUTH_MINUTES
      ),
      now: new Date(),
    })
  ) {
    throw new AdminReauthenticationRequiredError();
  }
}

export const isAdminReauthenticationError = (error: unknown) =>
  error instanceof AdminReauthenticationRequiredError;
