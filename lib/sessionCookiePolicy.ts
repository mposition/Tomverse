/**
 * SEC-010. One statement of when the session cookie is a `Secure` cookie, and
 * of what NextAuth therefore names it.
 *
 * `lib/auth.ts` used to leave `useSecureCookies` unset, so NextAuth derived it
 * from whether `NEXTAUTH_URL` started with `https` -- a string nothing
 * validated. Stating it from the environment fixed that, and immediately broke
 * the admin E2E harness, which minted the unprefixed cookie name on the old
 * assumption. The harness was not wrong to assume it; it was wrong that the
 * rule lived in two places at all.
 *
 * Both sides read this module now, so the rule cannot be changed on one side
 * only. Deliberately free of `server-only` and of any import: the Playwright
 * harness runs in its own process and has to be able to ask the same question.
 */

/** RFC 6265bis: the prefix is only honoured on a cookie that is also `Secure`. */
export const SECURE_COOKIE_PREFIX = "__Secure-";

const SESSION_COOKIE_BASE_NAME = "next-auth.session-token";

/**
 * Production gets `Secure`; nothing else does, because no other environment is
 * reliably served over https and a `Secure` cookie on plain http is simply
 * dropped.
 */
export const sessionCookiesAreSecure = (nodeEnv: string | undefined) =>
  nodeEnv === "production";

export const sessionCookieName = (secure: boolean) =>
  secure
    ? `${SECURE_COOKIE_PREFIX}${SESSION_COOKIE_BASE_NAME}`
    : SESSION_COOKIE_BASE_NAME;

/** Both spellings, for clearing a cookie whose environment may have changed. */
export const ALL_SESSION_COOKIE_NAMES = [
  sessionCookieName(false),
  sessionCookieName(true),
] as const;
