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

/* ------------------------------------------------ sign-up intent (v25) */

/**
 * Whether an OAuth sign-in may create an account, and where it goes if not.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 5.2a (v25).
 *
 * Kept in this module rather than one of its own: `lib/auth.ts` is in the
 * Prompt Refiner sealed runtime source closure, whose file count is part of a
 * database-bound contract, and this module is already inside it. A new module
 * imported from `lib/auth.ts` would grow that closure.
 *
 * Sign-in and sign-up are separate screens. An OAuth provider the person has
 * never used here would otherwise become a new account inside NextAuth's
 * callback, whichever screen the click came from. So the `signIn` callback asks
 * this first: a provider account with no `Account` row, no `User` at the
 * provider's address and no session is a sign-up, and it is let through only
 * when the sign-up screen set its intent for that provider. Otherwise the
 * person is sent to sign-up, after the provider has proved who they are --
 * never before, so "no account" is only ever told to its owner.
 *
 * The intent is a product signal, not a security boundary. Forging it makes an
 * account without the consent devices, which has no `notice_shown` and is
 * asked later by the in-product notice (section 5.4).
 */

/** Set by the sign-up screen, read by the OAuth callback. */
export const SIGNUP_INTENT_COOKIE = "tomverse.signup-intent";

/** Long enough for a provider round trip, short enough to be about this click. */
export const SIGNUP_INTENT_MAX_AGE_SECONDS = 10 * 60;

/** The providers the sign-up screen offers. Anything else is not an intent. */
export const SIGNUP_INTENT_PROVIDERS = ["google", "azure-ad"] as const;
export type SignupIntentProvider = (typeof SIGNUP_INTENT_PROVIDERS)[number];

export const isSignupIntentProvider = (value: unknown): value is SignupIntentProvider =>
  typeof value === "string" && (SIGNUP_INTENT_PROVIDERS as readonly string[]).includes(value);

export type OAuthSignupGateInput = {
  provider: string;
  /** An `Account` row exists for this provider account. */
  accountExists: boolean;
  /** A `User` exists at the provider's address (the adapter's own lookup). */
  addressHasUser: boolean;
  /** The request carries a NextAuth session cookie. */
  hasSession: boolean;
  /** The provider named by the sign-up intent cookie, if any. */
  intentProvider: string | null;
};

export type OAuthSignupGate =
  /** Not a new account, or a sign-up that meant to be one: NextAuth decides. */
  | { allow: true; reason: "existing_account" | "address_has_user" | "session_link" | "signup_intent" }
  /** A new account from the sign-in screen: send it to sign-up instead. */
  | { allow: false; reason: "no_account" };

export const oauthSignupGate = (input: OAuthSignupGateInput): OAuthSignupGate => {
  if (input.accountExists) return { allow: true, reason: "existing_account" };
  // NextAuth refuses this as OAuthAccountNotLinked, as it did before the split;
  // the sign-up screen would only meet the same refusal.
  if (input.addressHasUser) return { allow: true, reason: "address_has_user" };
  // With a session NextAuth links the provider to it rather than creating an
  // account, so there is nothing to send to sign-up.
  if (input.hasSession) return { allow: true, reason: "session_link" };
  if (input.intentProvider !== null && input.intentProvider === input.provider) {
    return { allow: true, reason: "signup_intent" };
  }
  return { allow: false, reason: "no_account" };
};

/** The fixed sign-up URL a refused sign-in is sent to. */
export const signupRedirectPath = (provider: string) => {
  const params = new URLSearchParams({ notice: "no_account" });
  if (isSignupIntentProvider(provider)) params.set("provider", provider);
  return `/auth/signup?${params.toString()}`;
};

/** NextAuth's session cookie names, secure prefix first; a large token is chunked as `.0`, `.1`, ... */
export const SESSION_COOKIE_NAMES = [
  "__Secure-next-auth.session-token",
  "next-auth.session-token",
] as const;

/** NextAuth's session cookie, possibly chunked, with or without the secure prefix. */
export const isSessionCookieName = (name: string) =>
  /^(__Secure-)?next-auth\.session-token(\.\d+)?$/.test(name);
