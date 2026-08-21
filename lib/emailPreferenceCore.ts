/**
 * What a person can and cannot switch off, and what changing it records.
 *
 * Contract: .github/audits/email-notification-architecture-2026-08-21.md §11.2, §17.1.
 *
 * Pure and dependency-free. Storage lives in lib/emailPreferences.ts.
 *
 * Two purposes are locked, and the database holds the same rule as a CHECK.
 * Stating it twice is deliberate: the constraint stops a bad write, and this
 * stops the UI from offering a switch that would fail, which is a different
 * failure and a worse one to discover at the moment somebody flips it.
 */

export const EMAIL_PURPOSES = [
  "security",
  "billing",
  "service_status",
  "product_updates",
  "newsletter",
  "promotions",
] as const;

export type EmailPurpose = (typeof EMAIL_PURPOSES)[number];

/**
 * Purposes nobody may disable.
 *
 * `security` because an attacker who can turn off security mail turns off the
 * warning about themselves; `billing` because a receipt is contract
 * performance rather than a preference. Both are shown in the preference
 * centre rather than hidden -- "there is no setting for it" is a common reason
 * people reach for the spam button instead, and a spam complaint costs more
 * than the honest explanation does.
 */
export const LOCKED_EMAIL_PURPOSES: ReadonlySet<string> = new Set([
  "security",
  "billing",
]);

/**
 * Purposes that require consent before anything is sent.
 *
 * `service_status` is not among them: an outage notice is contract
 * performance, so it defaults on and stays switchable. Consent is what
 * separates "we owe you this" from "we would like to send you this".
 */
export const CONSENT_REQUIRED_PURPOSES: ReadonlySet<string> = new Set([
  "product_updates",
  "newsletter",
  "promotions",
]);

export const isEmailPurpose = (value: unknown): value is EmailPurpose =>
  typeof value === "string" &&
  (EMAIL_PURPOSES as readonly string[]).includes(value);

/**
 * The state a new account starts in.
 *
 * Everything consent-based starts off. Nobody has agreed to anything at signup,
 * and a default-on marketing preference is the opt-out model that §5.1 C1
 * declines to use even where the law would allow it.
 */
export const defaultPreferenceEnabled = (purpose: EmailPurpose) =>
  !CONSENT_REQUIRED_PURPOSES.has(purpose);

export type PreferenceChangeRefusal =
  | { allowed: false; reason: "unknown_purpose" }
  | { allowed: false; reason: "locked" }
  | { allowed: false; reason: "token_cannot_enable" };

export type PreferenceChangeDecision = { allowed: true } | PreferenceChangeRefusal;

/**
 * Whether one change may be applied, and by whom.
 *
 * `viaToken` is the unsubscribe link: it may only ever turn something off.
 * A leaked token then has a worst case of "this person receives less mail",
 * which is the property that lets the link work without a login at all (§11.4).
 */
export const preferenceChangeDecision = (input: {
  purpose: string;
  enabled: boolean;
  viaToken?: boolean;
}): PreferenceChangeDecision => {
  if (!isEmailPurpose(input.purpose)) {
    return { allowed: false, reason: "unknown_purpose" };
  }
  if (LOCKED_EMAIL_PURPOSES.has(input.purpose)) {
    return { allowed: false, reason: "locked" };
  }
  if (input.viaToken && input.enabled) {
    return { allowed: false, reason: "token_cannot_enable" };
  }
  return { allowed: true };
};

export type ConsentAction =
  | "granted"
  | "withdrawn"
  | "reconfirmed"
  | "confirmation_notice_sent"
  | "lapsed";

/**
 * What a change writes to the consent history.
 *
 * `reconfirmed` rather than `granted` when the state did not move: re-agreeing
 * to something you already agreed to is a different event, and a history that
 * records both as `granted` cannot answer when consent actually began.
 */
export const consentActionFor = (input: {
  wasEnabled: boolean | null;
  nowEnabled: boolean;
}): ConsentAction => {
  if (!input.nowEnabled) return "withdrawn";
  return input.wasEnabled ? "reconfirmed" : "granted";
};

/**
 * Whether this change belongs in the consent history at all.
 *
 * Only consent-based purposes do. Turning off outage notices is a preference,
 * not a withdrawal of consent, and recording it as one would put entries in an
 * evidence table for something no jurisdiction asked consent for.
 */
export const recordsConsent = (purpose: EmailPurpose) =>
  CONSENT_REQUIRED_PURPOSES.has(purpose);
