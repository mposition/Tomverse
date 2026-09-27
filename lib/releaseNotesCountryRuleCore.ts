/**
 * Country rules for release-notes marketing, and the authority verdict over
 * them.
 *
 * Contract: docs/policy/email-notifications.md section 5.1.1 (C1), which is the
 * canonical table of starting values, and the redesign draft's sections 4.1,
 * 4.2 and 7.6 as that section pins them
 * (docs/policy/email-product-news-redesign-draft.md).
 *
 * ## Two authorities, both must allow
 *
 * The recipient's country rule is one authority. The Australian sender
 * authority is the other: Tomverse is an Australian sender, so the Spam Act
 * applies to every message whatever the recipient's country. A US recipient
 * is `opt_out` on their side and still needs Australian consent on ours.
 * `legalAllowed` is true only when every authority allows.
 *
 * ## What this does not decide
 *
 * Suppression, objection, obligations (section 7.8), the display contract and
 * the `risk_accepted` override are all section 7.6's other inputs. They are
 * blockers or overrides laid on top of this verdict, not parts of it -- and
 * section 5.6 rule 2 is exactly that an override leaves the authorities'
 * refusal standing. So this function answers "what does the law we apply say",
 * and S9's verdict decides what is sent.
 *
 * ## Australian inferred consent is not in effect
 *
 * Section 5.1.1 gives Australia `inferred_consent`, with approval C's
 * condition: it takes effect once the draft's section 4.4 relationship model
 * is built and the policy amendment (E) is in force. Neither exists, and the
 * model's dormancy threshold waits on the owner's R4. Until then the rule row
 * says what was approved and this verdict refuses to rely on it
 * (`inferred_consent_not_in_effect`); S5b adds the relationship input that
 * would let it. Express consent satisfies either authority regardless.
 *
 * Pure: no database, no clock. The rows come from `lib/releaseNotesCountryRules.ts`.
 */

import {
  JURISDICTION_MAPPED_COUNTRY_CODES,
  profileForCountry,
} from "@/lib/emailJurisdictionCore";
import type { EmailPermissionAuthority } from "@/lib/emailPermissionLedgerCore";

/**
 * What a recipient authority rests on. `opt_out` needs no consent on the
 * recipient's side; `express_consent` needs a confirmed consent;
 * `inferred_consent` needs the relationship model of the draft's section 4.4.
 */
export const RELEASE_NOTES_RULE_BASES = [
  "opt_out",
  "express_consent",
  "inferred_consent",
] as const;

export type ReleaseNotesRuleBasis = (typeof RELEASE_NOTES_RULE_BASES)[number];

/**
 * Whether marketing may reach this country at all. This is the allowlist:
 * section 4.1 makes it the rule's status rather than a separate constant, so
 * the two can no longer drift apart. `MARKETING_ALLOWED_COUNTRY_CODES` stays
 * the live gate until S9's verdict reads these rows, and a test holds the two
 * equal until then.
 */
export const RELEASE_NOTES_RULE_STATUSES = ["open", "closed"] as const;

export type ReleaseNotesRuleStatus = (typeof RELEASE_NOTES_RULE_STATUSES)[number];

/** Why an authority refused. Closed, so a verdict never carries prose. */
export const RELEASE_NOTES_AUTHORITY_REFUSALS = [
  "country_undetermined",
  "no_country_rule",
  "country_closed",
  "no_express_consent",
  "inferred_consent_not_in_effect",
  "no_au_sender_consent",
] as const;

export type ReleaseNotesAuthorityRefusal =
  (typeof RELEASE_NOTES_AUTHORITY_REFUSALS)[number];

/**
 * A rule's key. One per country; the version is what moves.
 *
 * The same shape `EmailSendApproval.ruleKey` scopes an obligation waiver to
 * (section 7.8), so a waiver names a rule the way this table does.
 */
export const releaseNotesRuleKey = (countryCode: string) => `release_notes.${countryCode}`;

export type ReleaseNotesCountryRuleSeed = {
  countryCode: string;
  ruleVersion: number;
  basis: ReleaseNotesRuleBasis;
  status: ReleaseNotesRuleStatus;
  /** What would change the value, from section 5.1.1's third column. */
  conditions: readonly string[];
  /** Where the value comes from. Shown beside the row, like a profile's notes. */
  notes: string;
};

const CONTRACT = "docs/policy/email-notifications.md section 5.1.1";

/**
 * The countries marketing may reach, as the rule rows will say it.
 *
 * Written out rather than imported from `MARKETING_ALLOWED_COUNTRY_CODES`:
 * the point of the rule's status is to become the one place this is decided,
 * and a seed that copied the old constant would only move the drift. The test
 * holds the two equal while both exist.
 */
const OPEN_COUNTRIES: ReadonlySet<string> = new Set([
  "KR", "US", "CA", "AU", "GB", "SG", "DE", "FR", "AT", "CH",
]);

const seedFor = (countryCode: string): ReleaseNotesCountryRuleSeed => {
  const status: ReleaseNotesRuleStatus = OPEN_COUNTRIES.has(countryCode) ? "open" : "closed";
  const base = { countryCode, ruleVersion: 1, status };

  if (countryCode === "US") {
    return {
      ...base,
      basis: "opt_out",
      conditions: [],
      notes: `${CONTRACT}: opt_out is enough on the recipient's side; whether a message may be sent is the Australian sender authority's question.`,
    };
  }
  if (countryCode === "AU") {
    return {
      ...base,
      basis: "inferred_consent",
      conditions: ["relationship_model_built", "policy_amendment_e_in_force"],
      notes: `${CONTRACT}: inferred_consent once the draft's section 4.4 relationship model is built and amendment E is in force (approval C). Not in effect until both.`,
    };
  }
  if (countryCode === "SG") {
    return {
      ...base,
      basis: "express_consent",
      conditions: [],
      notes: `${CONTRACT}: the PDPA requires opt-in for direct marketing. The SCA's <ADV> label and unsubscribe requirements are display obligations, recorded separately.`,
    };
  }
  if (countryCode === "KR") {
    return {
      ...base,
      basis: "express_consent",
      conditions: [],
      notes: `${CONTRACT}: signup consent plus double opt-in. Statutory duties are per-obligation states (draft section 7.7).`,
    };
  }
  if (countryCode === "AT") {
    return {
      ...base,
      basis: "express_consent",
      conditions: [],
      notes: `${CONTRACT}: no release without an ECG-Liste check; not a soft opt-in candidate in this scope.`,
    };
  }
  if (countryCode === "IE") {
    return {
      ...base,
      basis: "express_consent",
      conditions: [],
      notes: `${CONTRACT}: twelve-month window and criminal liability; not a soft opt-in candidate in this scope.`,
    };
  }
  if (countryCode === "CH" || countryCode === "CA") {
    return {
      ...base,
      basis: "express_consent",
      conditions: [],
      notes: `${CONTRACT}: ${countryCode === "CH" ? "FDPIC" : "CASL"}. No release.`,
    };
  }
  if (countryCode === "GB" || profileForCountry(countryCode) === "EU") {
    return {
      ...base,
      basis: "express_consent",
      // AT and IE returned above: section 5.1.1 excludes both from soft opt-in.
      conditions: ["soft_opt_in_confirmed_by_counsel_g"],
      notes: `${CONTRACT}: express_consent; soft opt-in only if outside counsel (G, draft R1) confirms it for this country.`,
    };
  }
  throw new Error(`No section 5.1.1 row covers ${countryCode}.`);
};

/**
 * One rule per country that resolves to a real profile. A country with no
 * rule is refused (`no_country_rule`), which is the same answer as `ZZ`: the
 * table never has to claim to enumerate every country there is.
 */
export const releaseNotesCountryRuleSeed = (): ReleaseNotesCountryRuleSeed[] =>
  JURISDICTION_MAPPED_COUNTRY_CODES.map((country) => seedFor(country));

/** What is wrong with the seed, in the terms the migration's CHECKs use. */
export const releaseNotesRuleSeedProblems = (): string[] => {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const rule of releaseNotesCountryRuleSeed()) {
    if (seen.has(rule.countryCode)) problems.push(`${rule.countryCode}: declared twice`);
    seen.add(rule.countryCode);
    if (!/^[A-Z]{2}$/.test(rule.countryCode) || rule.countryCode === "ZZ") {
      problems.push(`${rule.countryCode}: not a country code a rule may carry`);
    }
    if (!RELEASE_NOTES_RULE_BASES.includes(rule.basis)) {
      problems.push(`${rule.countryCode}: unknown basis ${rule.basis}`);
    }
    if (!RELEASE_NOTES_RULE_STATUSES.includes(rule.status)) {
      problems.push(`${rule.countryCode}: unknown status ${rule.status}`);
    }
    if (!Number.isInteger(rule.ruleVersion) || rule.ruleVersion < 1) {
      problems.push(`${rule.countryCode}: rule version must be a positive integer`);
    }
    if (!rule.notes.trim()) problems.push(`${rule.countryCode}: has no source`);
  }
  for (const country of OPEN_COUNTRIES) {
    if (!seen.has(country)) problems.push(`${country}: open but has no rule`);
  }
  return problems;
};

/** A stored rule, as much of it as the verdict reads. */
export type ReleaseNotesRuleForVerdict = {
  countryCode: string;
  ruleKey: string;
  ruleVersion: number;
  basis: ReleaseNotesRuleBasis;
  status: ReleaseNotesRuleStatus;
};

/**
 * The consent evidence the verdict may cite. `express` is whether the send's
 * own consent gate passes for this purpose (`consentGateVerdict()`), and
 * `evidenceIds` the `ConsentRecord` ids behind it.
 */
export type ReleaseNotesConsentInput = {
  express: boolean;
  evidenceIds: readonly string[];
};

export type ReleaseNotesAuthorityVerdict = {
  authority: EmailPermissionAuthority;
  /** The recipient country this entry is for; null for the sender authority. */
  country: string | null;
  /** The basis the verdict rests on when it allows; the rule's basis when it refuses. */
  basis: ReleaseNotesRuleBasis | null;
  ruleKey: string | null;
  ruleVersion: number | null;
  verdict: "allow" | "deny";
  reason: ReleaseNotesAuthorityRefusal | null;
  evidenceIds: string[];
};

const allow = (
  entry: Omit<ReleaseNotesAuthorityVerdict, "verdict" | "reason">
): ReleaseNotesAuthorityVerdict => ({ ...entry, verdict: "allow", reason: null });

const deny = (
  entry: Omit<ReleaseNotesAuthorityVerdict, "verdict" | "reason" | "evidenceIds">,
  reason: ReleaseNotesAuthorityRefusal
): ReleaseNotesAuthorityVerdict => ({ ...entry, verdict: "deny", reason, evidenceIds: [] });

/** One recipient country's authority. */
export const recipientAuthority = (input: {
  country: string | null;
  rule: ReleaseNotesRuleForVerdict | null;
  consent: ReleaseNotesConsentInput;
}): ReleaseNotesAuthorityVerdict => {
  const { country, rule, consent } = input;
  const none = { authority: "recipient" as const, country, basis: null, ruleKey: null, ruleVersion: null };
  if (country === null || country === "ZZ") return deny(none, "country_undetermined");
  if (rule === null) return deny(none, "no_country_rule");
  if (rule.countryCode !== country) {
    throw new Error(`Rule ${rule.ruleKey} was passed for country ${country}.`);
  }

  const cited = {
    authority: "recipient" as const,
    country,
    ruleKey: rule.ruleKey,
    ruleVersion: rule.ruleVersion,
  };
  if (rule.status !== "open") return deny({ ...cited, basis: rule.basis }, "country_closed");
  if (rule.basis === "opt_out") return allow({ ...cited, basis: "opt_out", evidenceIds: [] });
  // Express consent satisfies an inferred-consent rule too: it is the stronger
  // basis, and the verdict records the one it actually rested on.
  if (consent.express) {
    return allow({ ...cited, basis: "express_consent", evidenceIds: [...consent.evidenceIds] });
  }
  if (rule.basis === "inferred_consent") {
    return deny({ ...cited, basis: rule.basis }, "inferred_consent_not_in_effect");
  }
  return deny({ ...cited, basis: rule.basis }, "no_express_consent");
};

/**
 * The Australian sender authority. It applies to every message, whatever the
 * recipient's country, and it rests on express or inferred consent. Inferred
 * consent is not in effect (see the header), so today it is express consent or
 * nothing.
 */
export const auSenderAuthority = (input: {
  consent: ReleaseNotesConsentInput;
}): ReleaseNotesAuthorityVerdict => {
  const entry = { authority: "au_sender" as const, country: null, ruleKey: null, ruleVersion: null };
  if (input.consent.express) {
    return allow({ ...entry, basis: "express_consent", evidenceIds: [...input.consent.evidenceIds] });
  }
  return deny({ ...entry, basis: null }, "no_au_sender_consent");
};

/**
 * Every authority for one send, and whether all of them allow.
 *
 * `countries` is the persisted candidate list (draft section 5.3): each
 * candidate is a recipient authority of its own, and all of them must allow --
 * two candidates must both pass, not agree. An empty list is `ZZ`.
 *
 * `rules` are the rows of the policy version the send is decided under. A
 * candidate with no row there is refused; two rows for one country is a caller
 * that read two versions, and it throws rather than choosing.
 */
export const releaseNotesAuthorityVerdict = (input: {
  countries: readonly string[];
  rules: readonly ReleaseNotesRuleForVerdict[];
  consent: ReleaseNotesConsentInput;
}): {
  authorities: ReleaseNotesAuthorityVerdict[];
  legalAllowed: boolean;
  /** One basis satisfied both sides (section 4.2 asks for that to be recorded). */
  sharedBasis: ReleaseNotesRuleBasis | null;
  ruleVersions: { ruleKey: string; ruleVersion: number }[];
} => {
  const byCountry = new Map<string, ReleaseNotesRuleForVerdict>();
  for (const rule of input.rules) {
    if (byCountry.has(rule.countryCode)) {
      throw new Error(`Two rules for ${rule.countryCode}: read them from one policy version.`);
    }
    byCountry.set(rule.countryCode, rule);
  }

  const countries = input.countries.length === 0 ? ["ZZ"] : [...new Set(input.countries)].sort();
  const recipient = countries.map((country) =>
    recipientAuthority({ country, rule: byCountry.get(country) ?? null, consent: input.consent })
  );
  const sender = auSenderAuthority({ consent: input.consent });
  const authorities = [...recipient, sender];
  const legalAllowed = authorities.every((entry) => entry.verdict === "allow");

  const sharedBasis =
    legalAllowed &&
    sender.basis === "express_consent" &&
    recipient.some((entry) => entry.basis === "express_consent")
      ? "express_consent"
      : null;

  const ruleVersions = recipient
    .filter((entry) => entry.ruleKey !== null && entry.ruleVersion !== null)
    .map((entry) => ({ ruleKey: entry.ruleKey!, ruleVersion: entry.ruleVersion! }))
    .sort((a, b) => a.ruleKey.localeCompare(b.ruleKey));

  return { authorities, legalAllowed, sharedBasis, ruleVersions };
};
