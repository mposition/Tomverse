import { encode } from "next-auth/jwt";
import type { BrowserContext } from "@playwright/test";
import {
  ADMIN_E2E_BASE_URL,
  ADMIN_E2E_IDENTITIES,
  adminE2eNextAuthSecret,
  type AdminE2EIdentity,
  type AdminE2EIdentityKey,
} from "./harness-config";

/**
 * NextAuth v4 names the session cookie `__Secure-next-auth.session-token` only
 * when `NEXTAUTH_URL` is https. The harness server is plain http on loopback,
 * so it is the unprefixed name.
 */
export const SESSION_COOKIE_NAME = "next-auth.session-token";

const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export type SignInOptions = {
  /**
   * Ages the `authenticatedAt` claim, which is what
   * `resolveAdminSessionAccessState` and `assertRecentAdminAuthentication`
   * read. 0 is a session that just signed in; 45 is past the 30-minute
   * step-up window but inside the 8-hour console window; 600 is past both.
   */
  authenticatedMinutesAgo?: number;
};

/**
 * Mints the same JWT `lib/auth.ts`'s `callbacks.jwt` would produce for this
 * user after a real sign-in, signed with the harness server's own secret.
 *
 * The claims mirror that callback exactly -- `id`, `plan`, `authenticatedAt`
 * and `sessionIssuedAt` -- because `callbacks.session` and every admin check
 * downstream read them. Nothing about the server is modified to accept it.
 */
export const mintSessionToken = async (
  user: AdminE2EIdentity,
  options: SignInOptions = {}
) => {
  const authenticatedAtMs =
    Date.now() - Math.max(0, options.authenticatedMinutesAgo ?? 0) * 60_000;
  return encode({
    secret: adminE2eNextAuthSecret(),
    maxAge: SESSION_MAX_AGE_SECONDS,
    token: {
      sub: user.id,
      id: user.id,
      name: user.name,
      email: user.email,
      plan: "Free",
      authenticatedAt: new Date(authenticatedAtMs).toISOString(),
      sessionIssuedAt: authenticatedAtMs,
    },
  });
};

/**
 * Signs the browser context in as one of the harness identities.
 *
 * Server components, client fetches and `page.request` calls all inherit the
 * context's cookie jar, so server rendering and `/api/admin/**` see one
 * identity -- which is the whole point of using a real session cookie instead
 * of intercepting `/api/auth/session` in the page.
 */
export const signIn = async (
  context: BrowserContext,
  key: AdminE2EIdentityKey,
  options: SignInOptions = {}
) => {
  const user = ADMIN_E2E_IDENTITIES[key];
  const token = await mintSessionToken(user, options);
  await context.clearCookies({ name: SESSION_COOKIE_NAME });
  await context.addCookies([
    {
      name: SESSION_COOKIE_NAME,
      value: token,
      url: ADMIN_E2E_BASE_URL,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return user;
};

/** Drops the session cookie, leaving the context signed out. */
export const signOut = async (context: BrowserContext) => {
  await context.clearCookies({ name: SESSION_COOKIE_NAME });
};
