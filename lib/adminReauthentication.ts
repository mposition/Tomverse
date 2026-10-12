import "server-only";

import type { Session } from "next-auth";
import {
  isRecentAdminAuthentication,
  resolveAccountRecentAuthMinutes,
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
//
// The admin page cannot use the assertion below -- it has to
// *render* something when the window is spent, and catching a control-flow
// exception to choose a view is easy to get backwards -- so it reads this
// predicate instead. Both go through the same environment lookup, so the
// reauthentication page and `/api/admin/**` cannot reach different conclusions
// about the same session, which is what a surface re-implementing the window
// would eventually produce. Account-sensitive operations share the same
// override and timestamp rules but keep their original 30-minute default.
const hasRecentAuthentication = (
  session: Session | null | undefined,
  recentAuthMinutes: number
) =>
  Boolean(session?.user?.id) &&
  isRecentAdminAuthentication({
    authenticatedAt: session?.user?.authenticatedAt,
    recentAuthMinutes,
    now: new Date(),
  });

export const hasRecentAdminAuthentication = (
  session: Session | null | undefined
) =>
  hasRecentAuthentication(
    session,
    resolveRecentAuthMinutes(process.env.ADMIN_RECENT_AUTH_MINUTES)
  );

export const hasRecentAccountAuthentication = (
  session: Session | null | undefined
) =>
  hasRecentAuthentication(
    session,
    resolveAccountRecentAuthMinutes(process.env.ADMIN_RECENT_AUTH_MINUTES)
  );

export async function assertRecentAdminAuthentication(session: Session) {
  if (!hasRecentAdminAuthentication(session)) {
    throw new AdminReauthenticationRequiredError();
  }
}

export async function assertRecentAccountAuthentication(session: Session) {
  if (!hasRecentAccountAuthentication(session)) {
    throw new AdminReauthenticationRequiredError();
  }
}

export const isAdminReauthenticationError = (error: unknown) =>
  error instanceof AdminReauthenticationRequiredError;

export const isAccountReauthenticationError = isAdminReauthenticationError;
