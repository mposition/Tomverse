/**
 * Which country's email rules apply to a person, and how sure we are.
 *
 * Contract: docs/policy/email-notifications.md §6.
 *
 * Pure and dependency-free. Storage and the signal reads live in
 * lib/emailJurisdiction.ts.
 *
 * ## IP is not a signal here
 *
 * The repository already resolves two other things by IP -- analytics consent
 * (`lib/analyticsConsentPolicy.ts`) and billing currency
 * (`lib/billingCurrency.ts`) -- and for those it is the right input: both are
 * about the browser session in front of you. Email is not. A Korean resident
 * reading mail from a hotel in Chicago has not left the reach of the Network
 * Act, and the message will be opened somewhere else again tomorrow. So the IP
 * country is recorded as an observation and never decides anything.
 *
 * ## Conflicts are held, not resolved
 *
 * v1 of the contract said to "apply the stricter jurisdiction" when signals
 * disagree. There is no such ordering: Korea requires a `(광고)` subject prefix
 * and Singapore requires `<ADV>`, and applying both produces a third string
 * that satisfies neither. Footer block sets are not nested either. So a
 * genuine conflict holds marketing back and asks the person, which is a
 * question with an answer rather than a comparison without one.
 *
 * The cost of asking is bounded because marketing opt-in collects the country
 * in the first place (§6.3 rule 2) -- a hold happens when a *later* signal
 * disagrees, not on the ordinary path.
 */

/** The eight profiles. Countries map onto these; the EEA is thirty to one. */
export const JURISDICTION_PROFILES = [
  "KR",
  "US",
  "CA",
  "AU",
  "GB",
  "SG",
  "EU",
  "ZZ",
] as const;

export type JurisdictionProfileKey = (typeof JURISDICTION_PROFILES)[number];

/**
 * EEA plus the two the contract treats identically.
 *
 * Switzerland because `analyticsConsentPolicy` already puts it in the strict
 * set and Swiss UWG art. 3(1)(o) is opt-in like the ePrivacy Directive; the
 * EEA non-EU three (IS, LI, NO) because the Directive applies there through
 * the EEA Agreement. Grouping them is a profile decision, not a claim that
 * their national implementations are identical -- §4.3 flags the differences as
 * open question Q1, and a member state that needs its own profile becomes one
 * row in the mapping table rather than a code change.
 */
const EU_PROFILE_COUNTRIES = new Set([
  "AT", "BE", "BG", "CH", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR",
  "GR", "HR", "HU", "IE", "IS", "IT", "LI", "LT", "LU", "LV", "MT", "NL",
  "NO", "PL", "PT", "RO", "SE", "SI", "SK",
]);

const DIRECT_PROFILE_COUNTRIES = new Set(["KR", "US", "CA", "AU", "GB", "SG"]);

export const normalizeCountry = (value: string | null | undefined) => {
  const candidate = value?.trim().toUpperCase();
  return candidate && /^[A-Z]{2}$/.test(candidate) ? candidate : null;
};

/**
 * The profile a country resolves to.
 *
 * A country we have no profile for returns `ZZ` rather than a guess. `ZZ` is
 * safe for transactional and legal mail -- it carries the business identity
 * footer and no advertising rule -- and marketing does not send on it at all.
 */
export const profileForCountry = (
  country: string | null | undefined
): JurisdictionProfileKey => {
  const normalized = normalizeCountry(country);
  if (!normalized) return "ZZ";
  if (DIRECT_PROFILE_COUNTRIES.has(normalized)) {
    return normalized as JurisdictionProfileKey;
  }
  if (EU_PROFILE_COUNTRIES.has(normalized)) return "EU";
  return "ZZ";
};

export type JurisdictionSignals = {
  /** Priority 2. What the payment method's country said. */
  billingCountry?: string | null;
  /** Priority 3. What the person told us themselves. */
  selfDeclaredCountry?: string | null;
  /** Priority 4. What was resolved when they last consented. */
  consentCountry?: string | null;
  /** Priority 5, together. Circumstantial, never decisive on its own. */
  language?: string | null;
  timeZone?: string | null;
  /** Priority 6. Recorded, never used to decide. */
  ipCountry?: string | null;
};

export type JurisdictionConfidence = "high" | "conflict" | "low" | "unknown";

export type ResolvedJurisdiction = {
  countryCode: string;
  profileKey: JurisdictionProfileKey;
  confidence: JurisdictionConfidence;
  source:
    | "billing"
    | "self_declared"
    | "consent"
    | "inferred"
    | "conflict"
    | "unresolved";
  /** Every high-confidence value seen, when they disagree. */
  conflicts: string[];
  /** Observed and set aside. Present so a mismatch can be measured. */
  observedIpCountry: string | null;
};

/**
 * A country guessed from the language and time zone together.
 *
 * Both or nothing: `ko` alone is spoken outside Korea and `Asia/Seoul` alone is
 * a setting people carry with them, but the pair is a reasonable circumstantial
 * reading. Marked `low` regardless -- it never authorises marketing, it only
 * gives transactional mail a better footer than `ZZ`.
 */
const inferCountry = (
  language: string | null | undefined,
  timeZone: string | null | undefined
): string | null => {
  if (!language || !timeZone) return null;
  const pairs: Array<[string, string, string]> = [
    ["ko", "Asia/Seoul", "KR"],
    ["ja", "Asia/Tokyo", "JP"],
    ["zh", "Asia/Shanghai", "CN"],
    ["de", "Europe/Berlin", "DE"],
    ["fr", "Europe/Paris", "FR"],
    ["es", "Europe/Madrid", "ES"],
    ["pt", "Europe/Lisbon", "PT"],
  ];
  for (const [lang, zone, country] of pairs) {
    if (language === lang && timeZone === zone) return country;
  }
  return null;
};

export const resolveEmailJurisdiction = (
  signals: JurisdictionSignals
): ResolvedJurisdiction => {
  const billing = normalizeCountry(signals.billingCountry);
  const declared = normalizeCountry(signals.selfDeclaredCountry);
  const consent = normalizeCountry(signals.consentCountry);
  const observedIpCountry = normalizeCountry(signals.ipCountry);

  // Both high-confidence signals present and disagreeing. Neither is adopted:
  // picking one would be the ordering this contract says does not exist.
  if (billing && declared && billing !== declared) {
    return {
      countryCode: "ZZ",
      profileKey: "ZZ",
      confidence: "conflict",
      source: "conflict",
      conflicts: [billing, declared],
      observedIpCountry,
    };
  }

  if (billing || declared) {
    const country = (billing ?? declared)!;
    return {
      countryCode: country,
      profileKey: profileForCountry(country),
      confidence: "high",
      // Billing outranks the declaration when both agree, because it is the
      // one that went through a payment method's own verification.
      source: billing ? "billing" : "self_declared",
      conflicts: [],
      observedIpCountry,
    };
  }

  if (consent) {
    // What was true when they agreed. High enough to render with and to keep
    // sending the marketing they already consented to under it.
    return {
      countryCode: consent,
      profileKey: profileForCountry(consent),
      confidence: "high",
      source: "consent",
      conflicts: [],
      observedIpCountry,
    };
  }

  const inferred = inferCountry(signals.language, signals.timeZone);
  if (inferred) {
    return {
      countryCode: inferred,
      profileKey: profileForCountry(inferred),
      confidence: "low",
      source: "inferred",
      conflicts: [],
      observedIpCountry,
    };
  }

  return {
    countryCode: "ZZ",
    profileKey: "ZZ",
    confidence: "unknown",
    source: "unresolved",
    conflicts: [],
    observedIpCountry,
  };
};

export type MarketingJurisdictionVerdict =
  | { allowed: true }
  | { allowed: false; skipReason: "jurisdiction_conflict" | "jurisdiction_unconfirmed" };

/**
 * Whether marketing may go out under this resolution.
 *
 * Only `high` passes. `low` is deliberately refused even though it produces a
 * country: an inferred jurisdiction is a guess, and sending advertising under a
 * guessed set of labelling rules is exactly the thing §6.3 rule 1 declines to
 * do. Transactional and legal mail never consult this at all.
 */
export const marketingJurisdictionVerdict = (
  resolved: ResolvedJurisdiction
): MarketingJurisdictionVerdict => {
  if (resolved.confidence === "high") return { allowed: true };
  return {
    allowed: false,
    skipReason:
      resolved.confidence === "conflict"
        ? "jurisdiction_conflict"
        : "jurisdiction_unconfirmed",
  };
};

/** Whether the preference centre should ask the person to confirm a country. */
export const needsCountryConfirmation = (resolved: ResolvedJurisdiction) =>
  resolved.confidence !== "high";
