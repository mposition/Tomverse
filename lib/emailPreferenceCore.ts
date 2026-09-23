/**
 * What a person can and cannot switch off, and what changing it records.
 *
 * Contract: docs/policy/email-notifications.md §11.2, §17.1.
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

/**
 * Whether a queued message may go out, given what this account has actually
 * agreed to.
 *
 * Contract: docs/policy/email-notifications.md §5.1 C1, §11.2, §17.1.
 *
 * The rule that matters is what an **absent row** means, and it is not one
 * answer for every purpose:
 *
 *   * For a consent-based purpose it means *nobody has agreed to anything*,
 *     which is a refusal. `ensureDefaultPreferences` runs on a settings read,
 *     so an account that has never opened the preference centre has no rows at
 *     all -- and the previous `preference && !preference.enabled` treated that
 *     silence as a yes. Sending advertising on that basis is not recoverable
 *     once it has gone.
 *   * For `service_status` it means the default, which is on. An outage notice
 *     is contract performance and §5.1 does not ask consent for it, so refusing
 *     it because a row was never materialised would withhold mail we owe.
 *
 * Marketing to an address with no account is refused outright. Consent attaches
 * to a person and there is nobody here to have given it -- and no unsubscribe
 * token can be minted for a delivery with no `userId` either, so the message
 * could not carry the link its classification requires.
 */
export type ConsentGateInput = {
    classification: string;
    /** The preference this template is gated by, or null when it is not gated. */
    purpose: string | null;
    /** Whether this delivery is bound to an account at all. */
    hasAccount: boolean;
    /** The stored preference, or null when no row exists for it. */
    storedEnabled: boolean | null;
    /**
     * When the confirmation link was clicked, or null when it never was.
     *
     * docs/policy/email-double-opt-in.md §6. For a consent-based purpose an
     * enabled row with no confirmation is refused, in the same direction as an
     * absent row: "the switch is on" is not "the person agreed" until the
     * mailbox owner has said so. Ignored for purposes that need no consent.
     */
    storedConfirmedAt: Date | null;
};

export type ConsentGateVerdict =
    | { allowed: true }
    | { allowed: false; skipReason: "no_consent" };

const REFUSED: ConsentGateVerdict = { allowed: false, skipReason: "no_consent" };

export const consentGateVerdict = (input: ConsentGateInput): ConsentGateVerdict => {
    if (input.classification === "marketing" && !input.hasAccount) return REFUSED;
    if (!input.purpose || !isEmailPurpose(input.purpose)) return { allowed: true };
    if (input.storedEnabled !== null) {
        if (!input.storedEnabled) return REFUSED;
        // Unconfirmed consent is not consent (docs/policy/email-double-opt-in.md
        // §3 rule 5). This is also what handles rows switched on before the
        // confirmation step existed: they have no confirmedAt, so they are
        // refused here without a migration touching them.
        if (CONSENT_REQUIRED_PURPOSES.has(input.purpose) && !input.storedConfirmedAt) {
            return REFUSED;
        }
        return { allowed: true };
    }
    // No row. What that means depends on whether the purpose needed consent.
    return CONSENT_REQUIRED_PURPOSES.has(input.purpose) ? REFUSED : { allowed: true };
};

export type PreferenceChangeRefusal =
  | { allowed: false; reason: "unknown_purpose" }
  | { allowed: false; reason: "locked" }
  | { allowed: false; reason: "token_cannot_enable" }
  | { allowed: false; reason: "confirmation_required" };

export type PreferenceChangeDecision = { allowed: true } | PreferenceChangeRefusal;

/**
 * Whether one change may be applied, and by whom.
 *
 * `viaToken` is the unsubscribe link: it may only ever turn something off.
 * A leaked token then has a worst case of "this person receives less mail",
 * which is the property that lets the link work without a login at all (§11.4).
 *
 * `confirmed` is the double opt-in (docs/policy/email-double-opt-in.md §3 rule
 * 1): a consent-based purpose may be switched on only by the confirmation
 * path, which is the one caller that has checked a confirmation token. Every
 * other caller -- the preference centre included -- asks for a confirmation
 * instead. The unsubscribe rule above is unchanged and checked first, so a
 * token that could unsubscribe still cannot enable anything, confirmed or not.
 */
export const preferenceChangeDecision = (input: {
  purpose: string;
  enabled: boolean;
  viaToken?: boolean;
  confirmed?: boolean;
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
  if (input.enabled && CONSENT_REQUIRED_PURPOSES.has(input.purpose) && !input.confirmed) {
    return { allowed: false, reason: "confirmation_required" };
  }
  return { allowed: true };
};

/**
 * Where a consent-based preference stands, derived and never stored.
 *
 * docs/policy/email-double-opt-in.md §4.1. `unconfirmed` is the fourth state
 * that table does not list: a row switched on before the confirmation step
 * existed. It is recorded as what happened -- the person did switch it on --
 * and the send gate refuses it; the preference centre asks them to confirm.
 */
export type ConsentConfirmationState = "off" | "pending" | "on" | "unconfirmed";

export const consentConfirmationState = (row: {
  enabled: boolean;
  confirmationRequestedAt: Date | null;
  confirmedAt: Date | null;
}): ConsentConfirmationState => {
  if (row.enabled) return row.confirmedAt ? "on" : "unconfirmed";
  return row.confirmationRequestedAt ? "pending" : "off";
};

export type ConsentAction =
  | "granted"
  | "withdrawn"
  | "reconfirmed"
  | "confirmation_notice_sent"
  | "confirmation_requested"
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

/* ------------------------------------------------------------------ *
 * Classification: what class of mail a purpose is.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md, section 3 and
 * section 7.1 (invariants 5 and 7).
 *
 * A separate axis from consent, and conflating the two is the defect this
 * table removes. `classification === "marketing"` alone switches the sending
 * stream, the kill switch, Korea's `(광고)`, Singapore's `<ADV>`, forced
 * unsubscribe and the jurisdiction fail-closed; whether consent is required is
 * a different question the country rule answers. `product_updates` is the case
 * that proves they differ.
 *
 * It lives in this module rather than beside the permission ledger because
 * lib/emailPreferences.ts reads it, and that file is inside the Prompt Refiner
 * runtime source closure (lib/promptRefinerStageAdmissionCore.ts). A new
 * module imported from there would grow a sealed 188-file contract, so the
 * table goes where the purposes already are.
 * ------------------------------------------------------------------ */

/**
 * The three classes, in the order the draft's section 3 names them.
 *
 * `transactional` is something the account asked for or the contract owes;
 * `service` is an operational fact about a service they use; `marketing`
 * is anything whose recipient set we choose rather than they do.
 */
export const EMAIL_CLASSIFICATIONS = [
  "transactional",
  "service",
  "marketing",
] as const;

export type EmailClassification = (typeof EMAIL_CLASSIFICATIONS)[number];

/**
 * One purpose's entry.
 *
 * `solicitsResubscription` is typed as the literal `false` on purpose.
 * Invariant 7 forbids asking a withdrawn address to come back, and a boolean
 * field would let somebody add such a purpose and only then discover the rule.
 * Widening this type is the change a reviewer has to see.
 */
export type EmailPurposeEntry = {
  readonly purpose: EmailPurpose;
  readonly classification: EmailClassification;
  /** Nobody may switch it off (lib/emailPreferenceCore.ts, DB CHECK). */
  readonly locked: boolean;
  /** Consent is required before anything is sent under it. */
  readonly consentRequired: boolean;
  /**
   * Whether "unsubscribe from everything" turns this one off.
   *
   * Every `marketing` purpose is included and no other purpose is: a bulk
   * withdrawal that left one marketing purpose on would not be the single
   * action the Australian rule against extra steps asks for, and one that
   * silenced an outage notice would take away something the account is owed.
   */
  readonly withdrawnByBulkUnsubscribe: boolean;
  /** Invariant 7. Always false; see the type. */
  readonly solicitsResubscription: false;
  /**
   * What the product news redesign draft calls this purpose, when it uses a
   * different name. Written down rather than left to a reader to notice.
   */
  readonly draftPurposeName?: string;
};

/**
 * The table.
 *
 * Adding a purpose means adding it here and to EMAIL_PURPOSES, and the tests
 * fail until both agree.
 */
export const EMAIL_PURPOSE_CLASSIFICATION: readonly EmailPurposeEntry[] = [
  {
    purpose: "security",
    classification: "transactional",
    locked: true,
    consentRequired: false,
    withdrawnByBulkUnsubscribe: false,
    solicitsResubscription: false,
  },
  {
    purpose: "billing",
    classification: "transactional",
    locked: true,
    consentRequired: false,
    withdrawnByBulkUnsubscribe: false,
    solicitsResubscription: false,
  },
  {
    purpose: "service_status",
    classification: "service",
    locked: false,
    consentRequired: false,
    withdrawnByBulkUnsubscribe: false,
    solicitsResubscription: false,
  },
  {
    purpose: "product_updates",
    classification: "marketing",
    locked: false,
    consentRequired: true,
    withdrawnByBulkUnsubscribe: true,
    solicitsResubscription: false,
    draftPurposeName: "release_notes",
  },
  {
    purpose: "newsletter",
    classification: "marketing",
    locked: false,
    consentRequired: true,
    withdrawnByBulkUnsubscribe: true,
    solicitsResubscription: false,
  },
  {
    purpose: "promotions",
    classification: "marketing",
    locked: false,
    consentRequired: true,
    withdrawnByBulkUnsubscribe: true,
    solicitsResubscription: false,
  },
] as const;

const BY_PURPOSE = new Map<string, EmailPurposeEntry>(
  EMAIL_PURPOSE_CLASSIFICATION.map((entry) => [entry.purpose, entry])
);

export const emailPurposeEntry = (purpose: string): EmailPurposeEntry | null =>
  BY_PURPOSE.get(purpose) ?? null;

/**
 * The purpose the product news redesign draft means by a given name.
 *
 * Draft section 3 says to create a `release_notes` purpose classified
 * `marketing`. That purpose already exists here under the name
 * `product_updates` -- same mail, same switch, live rows, locale strings in
 * seven languages and a database CHECK. Creating a second one would give one
 * kind of mail two switches and, worse, would not carry anybody's existing
 * choice across: a person who had turned product news off would start
 * receiving it again under the new name, which is precisely the failure
 * invariant 5 is about.
 *
 * So the draft's name resolves to the purpose that already does its job, and
 * the mapping is written here rather than left for the next reader to work out
 * (docs/policy/email-notifications.md section 10.2.1).
 */
export const purposeForDraftName = (name: string): EmailPurpose | null =>
  EMAIL_PURPOSE_CLASSIFICATION.find(
    (entry) => entry.purpose === name || entry.draftPurposeName === name
  )?.purpose ?? null;

/**
 * The classification of a purpose, or null when we do not recognise it.
 *
 * Null rather than a default: a purpose this table does not know is not
 * "probably transactional", and a caller that treats it as such would send
 * unclassified mail without the marketing switches.
 */
export const emailPurposeClassification = (
  purpose: string
): EmailClassification | null => emailPurposeEntry(purpose)?.classification ?? null;

export const isMarketingPurpose = (purpose: string): boolean =>
  emailPurposeClassification(purpose) === "marketing";

/** Every purpose "unsubscribe from everything" turns off (invariant 5). */
export const BULK_UNSUBSCRIBE_PURPOSES: readonly EmailPurpose[] =
  EMAIL_PURPOSE_CLASSIFICATION.filter(
    (entry) => entry.withdrawnByBulkUnsubscribe
  ).map((entry) => entry.purpose);

export const MARKETING_PURPOSES: readonly EmailPurpose[] =
  EMAIL_PURPOSE_CLASSIFICATION.filter(
    (entry) => entry.classification === "marketing"
  ).map((entry) => entry.purpose);

/**
 * Where this table disagrees with the two sets that predate it.
 *
 * Returned rather than thrown so a test can name the row; the sets remain the
 * authority for what a preference write may do, and this is the check that
 * they and the classification have not drifted apart.
 */
export const classificationDisagreements = (): string[] => {
  const problems: string[] = [];
  const listed = new Set(EMAIL_PURPOSE_CLASSIFICATION.map((e) => e.purpose));
  for (const purpose of EMAIL_PURPOSES) {
    if (!listed.has(purpose)) problems.push(`${purpose}: not in the table`);
  }
  for (const entry of EMAIL_PURPOSE_CLASSIFICATION) {
    if (!(EMAIL_PURPOSES as readonly string[]).includes(entry.purpose)) {
      problems.push(`${entry.purpose}: not an email purpose`);
    }
    if (entry.locked !== LOCKED_EMAIL_PURPOSES.has(entry.purpose)) {
      problems.push(`${entry.purpose}: locked disagrees with LOCKED_EMAIL_PURPOSES`);
    }
    if (entry.consentRequired !== CONSENT_REQUIRED_PURPOSES.has(entry.purpose)) {
      problems.push(
        `${entry.purpose}: consentRequired disagrees with CONSENT_REQUIRED_PURPOSES`
      );
    }
    if (entry.locked && entry.classification === "marketing") {
      problems.push(`${entry.purpose}: a marketing purpose cannot be locked`);
    }
    if (entry.withdrawnByBulkUnsubscribe !== (entry.classification === "marketing")) {
      problems.push(
        `${entry.purpose}: bulk unsubscribe must cover exactly the marketing purposes`
      );
    }
  }
  return problems;
};
