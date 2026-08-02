import { encode } from "next-auth/jwt";
import type { BrowserContext } from "@playwright/test";
import {
  ADMIN_E2E_BASE_URL,
  ADMIN_E2E_IDENTITIES,
  adminE2eNextAuthSecret,
  type AdminE2EIdentity,
  type AdminE2EIdentityKey,
} from "./harness-config";
import {
  ALL_SESSION_COOKIE_NAMES,
  sessionCookieName,
  sessionCookiesAreSecure,
} from "@/lib/sessionCookiePolicy";

/**
 * The name NextAuth will look for in *this* harness.
 *
 * The previous comment here said the prefixed name appears "only when
 * NEXTAUTH_URL is https", and minted the unprefixed one because the harness
 * serves plain http on loopback. That was true while `lib/auth.ts` let NextAuth
 * infer the flag from the URL. SEC-010 states it from the environment instead,
 * and this harness starts the app with `next start` (see
 * `playwright.admin.config.ts`), which sets `NODE_ENV=production` -- so the
 * server is on the secure-cookie branch and was ignoring every session this
 * file seeded.
 *
 * Derived rather than hard-coded, and derived through the same module the
 * server uses, so the two cannot drift apart again.
 */
export const SESSION_COOKIE_NAME = sessionCookieName(
  sessionCookiesAreSecure("production")
);

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
  // Both spellings, so a context seeded before this change cannot leave the
  // other name behind for NextAuth to find.
  for (const name of ALL_SESSION_COOKIE_NAMES) {
    await context.clearCookies({ name });
  }
  // `domain` + `path` rather than `url`. CDP rejects a Secure cookie whose
  // `url` is http outright ("Invalid cookie fields"), while Chromium is happy
  // to store and send one scoped to a loopback host -- 127.0.0.1 is a
  // trustworthy origin, which is the whole reason the harness can serve plain
  // http and still exercise the production cookie name.
  const harnessOrigin = new URL(ADMIN_E2E_BASE_URL);
  await context.addCookies([
    {
      name: SESSION_COOKIE_NAME,
      value: token,
      domain: harnessOrigin.hostname,
      path: "/",
      httpOnly: true,
      // The `__Secure-` prefix is only honoured on a Secure cookie.
      secure: true,
      sameSite: "Lax",
    },
  ]);
  return user;
};

/** Drops the session cookie, leaving the context signed out. */
export const signOut = async (context: BrowserContext) => {
  for (const name of ALL_SESSION_COOKIE_NAMES) {
    await context.clearCookies({ name });
  }
};
