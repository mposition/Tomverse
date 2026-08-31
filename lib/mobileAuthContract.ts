// The approved N2 numbers, in one place.
//
// Source of truth: .github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md
// section 8.1.1, approved 2026-08-31 by @mposition against design SHA
// 190056fc2ee9ffc923a8f6e1331081e272762d2f.
//
// Every value here was decided by a person, not derived. Changing one is
// changing an approved contract, which means going back to that packet rather
// than editing this file -- so each carries the item number it answers.

/** 8.1.1 #1 -- access token lifetime. */
export const MOBILE_ACCESS_TOKEN_TTL_SECONDS = 10 * 60;

/**
 * 8.1.1 #1 -- clock skew tolerated on `exp`, `nbf` and `iat`.
 *
 * Applied symmetrically: a token is neither too new nor too old by more than
 * this. It is not a grace period on top of the lifetime; it is the allowance
 * for two clocks disagreeing.
 */
export const MOBILE_CLOCK_SKEW_SECONDS = 60;

/** 8.1.1 #2 -- refresh token idle window. */
export const MOBILE_REFRESH_IDLE_SECONDS = 30 * 24 * 60 * 60;

/** 8.1.1 #2 -- refresh token absolute lifetime, from family creation. */
export const MOBILE_REFRESH_ABSOLUTE_SECONDS = 180 * 24 * 60 * 60;

/** 8.1.1 #3 -- how long a retired *signing* key still verifies. */
export const MOBILE_PREVIOUS_SIGNING_KEY_SECONDS = 15 * 60;

/**
 * 8.1.1 #3 -- how long a retired *pepper* still verifies.
 *
 * Deliberately not the same number as the signing key above, and the asymmetry
 * is the point: a signing key only has to outlive the access tokens it signed,
 * which is minutes. A pepper is bound to every refresh token still alive, so
 * retiring it faster than the idle window would log everyone out. A successful
 * refresh mints its successor under the current pepper generation, so the old
 * one drains rather than being cut off.
 */
export const MOBILE_PREVIOUS_PEPPER_SECONDS =
  MOBILE_REFRESH_IDLE_SECONDS + MOBILE_CLOCK_SKEW_SECONDS;

/** 8.1.1 #6 -- the revocation bound the design promises. */
export const MOBILE_REVOCATION_OBSERVATION_BOUND_SECONDS = 15;

/** 8.1.1 #14 -- one-time login grant lifetime. */
export const MOBILE_LOGIN_GRANT_TTL_SECONDS = 60;

/** 8.1.1 #7 -- per-endpoint limits, consumed through `consumeApiRateLimit`. */
export const MOBILE_AUTH_RATE_LIMITS = {
  /** Per device. */
  refresh: { minute: 20, day: 500 },
  /** Per account. */
  exchange: { minute: 5, day: 20 },
  /** Per device. */
  logout: { minute: 10, day: 200 },
} as const;

/** 8.1.1 #9 -- `MobileAuthEvent` retention ceiling. */
export const MOBILE_AUTH_EVENT_RETENTION_DAYS = 90;

/**
 * JOSE header `typ`. RFC 8725 asks for explicit typing so a token minted for
 * one purpose cannot be replayed into a verifier expecting another.
 */
export const MOBILE_ACCESS_TOKEN_JOSE_TYPE = "at+jwt";

/**
 * Payload `tkn` -- what kind of token this is, inside the signed body.
 *
 * A separate name from the header's `typ` on purpose: section 5.2 of the packet
 * records that an earlier revision used one name for both and the two halves
 * drifted to different values without anyone noticing.
 */
export const MOBILE_ACCESS_TOKEN_KIND = "tomverse-mobile-access";

/** 8.1.1 #11 -- the only signature algorithm this deployment mints or accepts. */
export const MOBILE_ACCESS_TOKEN_ALGORITHM = "EdDSA";

/**
 * Client-facing error codes (packet D15).
 *
 * `MOBILE_REFRESH_REJECTED` is deliberately one code for every refusal --
 * expired, forged, replayed, wrong secret. The client's action is the same in
 * all four cases, and telling them apart tells an attacker which one they hit.
 * The precise reason goes to the audit trail instead.
 */
export const MOBILE_AUTH_ERROR_CODES = {
  tokenInvalid: "MOBILE_TOKEN_INVALID",
  tokenExpired: "MOBILE_TOKEN_EXPIRED",
  refreshRejected: "MOBILE_REFRESH_REJECTED",
  rateLimited: "MOBILE_RATE_LIMITED",
} as const;

export type MobileAuthErrorCode =
  (typeof MOBILE_AUTH_ERROR_CODES)[keyof typeof MOBILE_AUTH_ERROR_CODES];

/**
 * 8.1.1 #13 -- routes N1b may replace the mutation-origin check for.
 *
 * **Approved initial value: empty.** A route joins only once its identity and
 * ownership checks read the bearer rather than the cookie session, and a test
 * says so (packet D18, and the fourth N1b precondition in section 8.2).
 *
 * Empty is not a placeholder. While this list is empty N1b changes nothing:
 * every native mutation still meets the mutation-origin check and is refused,
 * which is the intended state until routes are converted one at a time.
 */
export const N1B_BEARER_ROUTES: readonly string[] = [];

// --- the closed lists the database also enforces ---------------------------
//
// Each of these is mirrored by a CHECK constraint, registered in
// scripts/check-enum-constraints.mjs so the two cannot drift. The arrays are
// the application's copy; the constraint is the database's, and
// `npm run check:enum-constraints` fails when they stop agreeing.

/**
 * D16 -- the platform labels a device row may carry.
 *
 * Coarse on purpose, and the coarseness is the decision rather than an
 * omission: a device list rich enough to be useful is also a location and
 * hardware history for anyone who takes over the account, and this product has
 * no password, so the takeover path is email. Model name, OS build, IDFV and
 * ANDROID_ID are all deliberately absent.
 */
export const MOBILE_DEVICE_PLATFORMS = ["ios", "android"] as const;

export type MobileDevicePlatform = (typeof MOBILE_DEVICE_PLATFORMS)[number];

/**
 * Why a device stopped being usable.
 *
 * One value, because there is only one event that leaves a revoked device row
 * behind: the person removed it from their own list. Account deletion is
 * deliberately absent -- it takes the row with it through the cascade, so a
 * value for it would be one nothing could ever write and a state nobody could
 * ever query for.
 */
export const MOBILE_DEVICE_REVOKED_REASONS = ["user_revoked"] as const;

export type MobileDeviceRevokedReason =
  (typeof MOBILE_DEVICE_REVOKED_REASONS)[number];

/**
 * D11 -- why a token family stopped being usable. Section 6.2's list verbatim.
 *
 * `account_deleted` is here and not on the device list above because a family
 * can be revoked in the transaction that begins a deletion, before the cascade
 * reaches it.
 */
export const MOBILE_FAMILY_REVOKED_REASONS = [
  "logout",
  "device_revoked",
  "reuse_detected",
  "account_deleted",
] as const;

export type MobileFamilyRevokedReason =
  (typeof MOBILE_FAMILY_REVOKED_REASONS)[number];

/**
 * D15 -- the audit events this subsystem writes.
 *
 * The refusal codes above are deliberately coarser than this list: every
 * refusal reason answers the client with one message, and the reason it was
 * really refused is recorded here instead. That asymmetry is the design, so
 * the two lists are not derived from each other.
 */
export const MOBILE_AUTH_EVENT_NAMES = [
  "mobile_auth.exchanged",
  "mobile_auth.refreshed",
  "mobile_auth.refresh_rejected",
  "mobile_auth.reuse_detected",
  "mobile_auth.family_revoked",
  "mobile_auth.device_revoked",
  "mobile_auth.logged_out",
  "mobile_auth.revoked_on_account_deletion",
] as const;

export type MobileAuthEventName = (typeof MOBILE_AUTH_EVENT_NAMES)[number];
