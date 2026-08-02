import { encode } from "next-auth/jwt";
import type { BrowserContext } from "@playwright/test";
import {
  ADMIN_E2E_BASE_URL,
  ADMIN_E2E_IDENTITIES,
  ADMIN_E2E_LEGACY_SESSION_COOKIE_NAME,
  ADMIN_E2E_SERVER_MODE,
  ADMIN_E2E_SESSION_COOKIE_NAME,
  adminE2eNextAuthSecret,
  type AdminE2EIdentity,
  type AdminE2EIdentityKey,
} from "./harness-config";

/**
 * The cookie the harness server actually reads.
 *
 * `lib/auth.ts` sets `useSecureCookies` from `NODE_ENV`, not from the shape of
 * `NEXTAUTH_URL`, so a `next start` server names the session cookie
 * `__Secure-next-auth.session-token`. Writing the unprefixed name here left
 * every signed-in spec anonymous -- the sign-in page in the failure
 * screenshots. The harness serves https so this name can be honoured; see
 * `harness-config.ts`.
 */
export const SESSION_COOKIE_NAME = ADMIN_E2E_SESSION_COOKIE_NAME;

/** The development-mode name, cleared but never written. */
export const LEGACY_SESSION_COOKIE_NAME =
  ADMIN_E2E_LEGACY_SESSION_COOKIE_NAME;

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
 * Drops both spellings of the session cookie.
 *
 * Both, always: a jar that still held the unprefixed name while the prefixed
 * one changed identity would let a signed-out assertion pass against a server
 * that had simply ignored the leftover, and would hide a sign-out that never
 * happened.
 */
const clearSessionCookies = async (context: BrowserContext) => {
  await context.clearCookies({ name: SESSION_COOKIE_NAME });
  await context.clearCookies({ name: LEGACY_SESSION_COOKIE_NAME });
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
  await clearSessionCookies(context);
  await context.addCookies([
    {
      name: SESSION_COOKIE_NAME,
      value: token,
      url: ADMIN_E2E_BASE_URL,
      // The attributes NextAuth's own `defaultCookies()` gives this cookie in
      // production. `secure` is not decoration: the `__Secure-` prefix is only
      // valid with it, and asserting it here is how the harness proves the
      // production cookie contract is what the server is being handed.
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return user;
};

/** Drops the session cookie, leaving the context signed out. */
export const signOut = async (context: BrowserContext) => {
  await clearSessionCookies(context);
};

export type SessionContractReport = {
  cookiePresent: boolean;
  cookieSecure: boolean;
  cookieHttpOnly: boolean;
  cookieSameSite: string | null;
  legacyCookiePresent: boolean;
  sessionStatus: number;
  sessionEmail: string | null;
  emailMatches: boolean;
};

/**
 * Asks the server who it thinks the context is.
 *
 * Reads the cookie jar *and* `/api/auth/session`, because they answer
 * different questions: a jar entry proves the browser accepted the cookie, and
 * only the round trip proves it was replayed and the server decoded it. A
 * `Secure` cookie that is stored but never sent -- exactly what happens when
 * the harness origin is not https -- would look identical to a working one
 * from the jar alone.
 */
export const readSessionContract = async (
  context: BrowserContext,
  expected: AdminE2EIdentity
): Promise<SessionContractReport> => {
  const cookies = await context.cookies(ADMIN_E2E_BASE_URL);
  const cookie = cookies.find((entry) => entry.name === SESSION_COOKIE_NAME);
  const response = await context.request.get(
    `${ADMIN_E2E_BASE_URL}/api/auth/session`
  );
  let sessionEmail: string | null = null;
  try {
    const body = (await response.json()) as { user?: { email?: unknown } };
    if (typeof body?.user?.email === "string") sessionEmail = body.user.email;
  } catch {
    sessionEmail = null;
  }
  return {
    cookiePresent: Boolean(cookie),
    cookieSecure: cookie?.secure === true,
    cookieHttpOnly: cookie?.httpOnly === true,
    cookieSameSite: cookie?.sameSite ?? null,
    legacyCookiePresent: cookies.some(
      (entry) => entry.name === LEGACY_SESSION_COOKIE_NAME
    ),
    sessionStatus: response.status(),
    sessionEmail,
    emailMatches: sessionEmail === expected.email,
  };
};

export class AdminE2ESessionContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminE2ESessionContractError";
  }
}

/**
 * Fails the moment the session contract breaks, instead of letting every
 * signed-in spec discover it as a sign-in page 30 seconds later.
 *
 * The message names the cookie the server expects and the mode that chose it,
 * because getting that pair wrong is the entire failure mode. It never prints
 * the token, the secret or any cookie value -- only names, attributes and the
 * identity the assertion was made about, all of which are harness constants.
 */
export const assertSessionContract = async (
  context: BrowserContext,
  expected: AdminE2EIdentity
) => {
  const report = await readSessionContract(context, expected);
  if (report.cookiePresent && report.emailMatches) return report;

  throw new AdminE2ESessionContractError(
    [
      "The admin E2E session was not recognised by the harness server.",
      `  expected cookie name: ${SESSION_COOKIE_NAME}`,
      `  cookie present in the browser context: ${report.cookiePresent}`,
      `  legacy ${LEGACY_SESSION_COOKIE_NAME} present: ${report.legacyCookiePresent}`,
      `  server mode: ${ADMIN_E2E_SERVER_MODE} (next start)`,
      `  requested origin: ${ADMIN_E2E_BASE_URL}`,
      `  GET /api/auth/session status: ${report.sessionStatus}`,
      `  session user email matches: ${report.emailMatches}`,
      `  expected identity: ${expected.email}`,
      `  session reported identity: ${report.sessionEmail ?? "(none)"}`,
      "",
      "`lib/auth.ts` derives the cookie name from NODE_ENV, so a production",
      "server reads the `__Secure-` prefixed name, and that name only travels",
      "over an https origin. If the cookie is present but the session is",
      "anonymous, the browser stored it and did not send it.",
    ].join("\n")
  );
};
