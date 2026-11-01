/**
 * When a GA4 User-ID may leave the browser
 * (docs/policy/marketing-automation.md §10.2, §12.2, §14 S6).
 *
 * The User-ID lets GA4 join one account's visits across devices. It is an
 * analytics-only pseudonym (lib/ga4UserId.ts), never the account id or an
 * email, and it is sent only when every one of these holds:
 *
 * 1. **Notice.** The privacy notice that tells people about it is published.
 *    That is this constant, flipped in the same pull request that ships the
 *    revised notice in every locale -- so no environment variable can turn
 *    the feature on ahead of the text that discloses it. Today's notice
 *    (locales `privacy.sections.analytics`) does not describe a cross-device
 *    identifier, so this is false.
 * 2. **Switch.** `NEXT_PUBLIC_GA4_USER_ID_ENABLED=true`, default off. Public
 *    because the browser decides whether to ask for an id at all; a build-time
 *    value, so changing it takes a redeploy.
 * 3. **Consent.** The visitor explicitly accepted analytics. Stricter than the
 *    rest of analytics, which in a notice region also runs when no choice was
 *    made: a cross-device identifier is not something a visitor should get by
 *    not answering.
 * 4. **A signed-in session and a configured measurement id.** Signing out
 *    clears it (`applyGa4UserId(null)`), as does declining analytics.
 *
 * The server adds its own fifth condition -- the derivation key exists
 * (`GA4_USER_ID_KEY`) -- before it will hand an id out at all.
 */

export const GA4_USER_ID_PRIVACY_NOTICE_PUBLISHED = false as boolean;

export const GA4_USER_ID_SWITCH_ENV = "NEXT_PUBLIC_GA4_USER_ID_ENABLED";

export const isGa4UserIdSwitchOn = (value: unknown) =>
  typeof value === "string" && value.trim().toLowerCase() === "true";

/** 128 bits as lowercase hex: what `analyticsUserIdFor` produces. */
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
