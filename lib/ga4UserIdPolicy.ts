/**
 * When a GA4 User-ID may leave the browser
 * (docs/policy/marketing-automation.md §10.2, §12.2, §14 S6).
 *
 * The User-ID lets GA4 join one account's visits across devices. It is an
 * analytics-only random value stored for the account (lib/ga4UserId.ts),
 * never the account id or an email, and it is created and sent only when
 * every one of these holds:
 *
 * 1. **Notice.** The privacy notice that tells people about it is published.
 *    That is this constant, flipped in the same pull request that ships the
 *    revised notice in every locale -- so no environment variable can turn
 *    the feature on ahead of the text that discloses it. The notice (locales
 *    `privacyPolicy.analyticsUserId1` to `analyticsUserId6`) describes the
 *    identifier, so this is true. It is the notice only: with the switch below
 *    off, nothing is created or sent.
 * 2. **Switch.** `NEXT_PUBLIC_GA4_USER_ID_ENABLED=true`, default off. Public
 *    because the browser decides whether to ask for an id at all; a build-time
 *    value, so changing it takes a redeploy.
 * 3. **Consent.** The visitor explicitly accepted analytics. Stricter than the
 *    rest of analytics, which in a notice region also runs when no choice was
 *    made: a cross-device identifier is not something a visitor should get by
 *    not answering. The request that creates the id states this consent, and
 *    the server creates nothing without it.
 * 4. **A signed-in session and a configured measurement id.** Signing out
 *    clears it (`applyGa4UserId(null)`). Declining analytics clears it too,
 *    and while signed in also withdraws it: the server asks GA4 to delete
 *    what it holds under the id and then deletes the id, so a later consent
 *    gets a new one.
 */

export const GA4_USER_ID_PRIVACY_NOTICE_PUBLISHED = true as boolean;

export const GA4_USER_ID_SWITCH_ENV = "NEXT_PUBLIC_GA4_USER_ID_ENABLED";

export const isGa4UserIdSwitchOn = (value: unknown) =>
  typeof value === "string" && value.trim().toLowerCase() === "true";

/** 128 bits as lowercase hex: what `newAnalyticsUserId` produces. */
export const isAnalyticsUserId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{32}$/.test(value);

export const ga4UserIdTransmissionAllowed = (input: {
  noticePublished: boolean;
  switchValue: unknown;
  consent: string | null;
  signedIn: boolean;
  measurementId: string | null;
}) =>
  input.noticePublished === true &&
  isGa4UserIdSwitchOn(input.switchValue) &&
  input.consent === "accepted" &&
  input.signedIn &&
  Boolean(input.measurementId);

/**
 * Whether declining analytics while signed in should withdraw the account's
 * stored id. Only the notice gates it, not the switch: an id created while
 * the switch was on must still be withdrawable after it is turned off.
 */
export const ga4UserIdWithdrawalApplies = (input: {
  noticePublished: boolean;
  signedIn: boolean;
}) => input.noticePublished === true && input.signedIn;
