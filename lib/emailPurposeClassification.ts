/**
 * One table naming every email purpose, what class of mail it is, and what
 * follows from that.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md, sections 3 and
 * 7.1 (invariants 5 and 7).
 *
 * The classification is a **separate axis from consent**, and conflating them
 * is the defect this table exists to remove. `classification === "marketing"`
 * alone switches the sending stream, the kill switch, Korea's `(광고)`,
 * Singapore's `<ADV>`, forced unsubscribe and the jurisdiction fail-closed;
 * whether consent is required is a different question with a different answer
 * per country. `product_updates` is the case that proves they differ: it is
 * classified `marketing` and always has been in substance, while the country
 * rule decides whether an explicit consent is needed to send it.
 *
 * Pure and dependency-free. Nothing here reads the database or the
 * environment, so the same table answers for the preference centre, the send
 * gate and the static checks.
 */

import {
  CONSENT_REQUIRED_PURPOSES,
  EMAIL_PURPOSES,
  LOCKED_EMAIL_PURPOSES,
  type EmailPurpose,
} from "./emailPreferenceCore";

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
