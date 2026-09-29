/**
 * The sign-up screen's consent choice, and when it may be consumed. Pure.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md sections 5.1 to
 * 5.3 (S4).
 *
 * A choice is made before the account exists and consumed after sign-in, by
 * the account this flow just created. Everything that decides whether a given
 * account may consume a given attempt is here, so it can be exercised without a
 * database: the server half only reads the facts and applies the answer.
 */

export const SIGNUP_CONSENT_CHANNELS = ["oauth", "email_code"] as const;
export type SignupConsentChannel = (typeof SIGNUP_CONSENT_CHANNELS)[number];

/**
 * How long a choice waits for its account. Long enough for an OAuth round trip
 * or for somebody to fetch a code from their mailbox (the code itself lives ten
 * minutes); short, because a choice left in a tab is a choice somebody else
 * could sign up under in the same browser.
 */
export const SIGNUP_CONSENT_TTL_MS = 15 * 60 * 1_000;

export type SignupConsentAttemptState = "pending" | "consumed" | "superseded" | "expired";

export const signupConsentAttemptState = (
  attempt: { consumedAt: Date | null; supersededAt: Date | null; expiresAt: Date },
  now: Date
): SignupConsentAttemptState => {
  if (attempt.consumedAt) return "consumed";
  if (attempt.supersededAt) return "superseded";
  if (attempt.expiresAt.getTime() <= now.getTime()) return "expired";
  return "pending";
};

/** The providers an OAuth attempt may name. */
export const SIGNUP_CONSENT_OAUTH_PROVIDERS = ["google", "azure-ad"] as const;

export type SignupConsentRefusal =
  | "not_pending"
  | "not_created_by_this_sign_in"
  | "account_predates_attempt"
  | "account_age_unknown"
  | "binding_mismatch"
  | "account_already_consumed";

/**
 * Whether this account may consume this attempt: the section 5.2 proof that
 * the account was **just created by this flow**, and never an existing
 * account's sign-in.
 *
 * - The attempt is pending.
 * - The account was created at or after the attempt was issued. An account
 *   whose creation time is unknown is refused, not assumed new.
 * - The binding matches: OAuth -- the account's only sign-in provider is the
 *   one the attempt named; email code -- the account's address is the one the
 *   attempt named, and an email login for that address was consumed at or
 *   after the attempt was issued.
 * - The account has not consumed an attempt before (the database's unique
 *   `userId` holds this too; checked here so the refusal has a name).
 */
export const signupConsentRefusal = (input: {
  attempt: {
    channel: string;
    bindingProvider: string | null;
    bindingEmail: string | null;
    createdAt: Date;
    consumedAt: Date | null;
    supersededAt: Date | null;
    expiresAt: Date;
  };
  account: {
    createdAt: Date | null;
    /** Normalised. */
    email: string | null;
    /** Every sign-in provider the account has an `Account` row for. */
    providers: readonly string[];
    alreadyConsumed: boolean;
    /**
     * The asking session's sign-in created this account. The binding below
     * proves the account matches the channel; this proves it was this sign-in
     * that made it, not another tab's sign-up into which this tab then signed.
     */
    createdBySignIn: boolean;
  };
  /**
   * An email login for this address that was **requested** after the choice
   * was made and has been consumed, if any. Requested after, not merely
   * consumed after: a code asked for before the choice existed -- another
   * sign-in, a reactivation -- is not this flow.
   */
  emailLoginSince: { id: string } | null;
  now: Date;
}): SignupConsentRefusal | null => {
  if (signupConsentAttemptState(input.attempt, input.now) !== "pending") return "not_pending";
  if (input.account.alreadyConsumed) return "account_already_consumed";
  if (!input.account.createdBySignIn) return "not_created_by_this_sign_in";
  if (input.account.createdAt === null) return "account_age_unknown";
  if (input.account.createdAt.getTime() < input.attempt.createdAt.getTime()) {
    return "account_predates_attempt";
  }
  if (input.attempt.channel === "oauth") {
    const [only, ...rest] = input.account.providers;
    return rest.length === 0 && only !== undefined && only === input.attempt.bindingProvider
      ? null
      : "binding_mismatch";
  }
  if (input.attempt.channel === "email_code") {
    return input.account.email !== null &&
      input.account.email === input.attempt.bindingEmail &&
      input.emailLoginSince !== null &&
      // An email-code account has no OAuth sign-in yet; one that does was
      // created by the other channel.
      input.account.providers.length === 0
      ? null
      : "binding_mismatch";
  }
  return "binding_mismatch";
};

/** One country applied when the choice was made (section 5.3). */
export type SignupConsentCandidate = {
  country: string;
  signal: "ip_estimated";
  ruleVersion: number;
  copyHash: string;
};

/**
 * The country a request's IP estimates, or null. Cloudflare's `XX` (unknown)
 * and `T1` (Tor), and this system's `ZZ`, are not countries.
 */
export const estimatedCountryFromHeader = (value: string | null | undefined): string | null => {
  const candidate = value?.trim().toUpperCase();
  // Letters only: Cloudflare's `T1` has a digit, and was passing a two-letter
  // test it was never meant to.
  if (!candidate || !/^[A-Z]{2}$/.test(candidate)) return null;
  if (NOT_COUNTRIES.has(candidate)) return null;
  return candidate;
};

/** Codes a country header can carry that name no country. */
const NOT_COUNTRIES = new Set(["XX", "ZZ", "T1", "A1", "A2", "AP", "EU"]);
