/**
 * How many people a marketing campaign could actually reach today, and how
 * many of those we could prove said yes.
 *
 * Pure: every function here takes counts and returns counts. The queries that
 * produce them are in `lib/marketingReach.ts`, and the reason for the split is
 * that the interesting part is the classification rather than the SQL -- and
 * that this half has to stay importable by a test with no database.
 *
 * Contract: docs/policy/email-notifications.md §5.1 C1, §5.6 C8, §10.2, §11.2.
 * Decision this feeds: docs/ops/q2-marketing-reach-decision.md.
 */

/**
 * The three purposes consent gates.
 *
 * `security` and `billing` are locked on and `service_status` is contract
 * performance, so none of the three is a marketing question
 * (`lib/emailPreferenceCore.ts`).
 */
export const MARKETING_PURPOSES = [
  "product_updates",
  "newsletter",
  "promotions",
] as const;

export type MarketingPurpose = (typeof MARKETING_PURPOSES)[number];

/**
 * Sources that mean a person acted, as opposed to a row being materialised.
 *
 * `system_default` is the row `ensureDefaultPreferences()` writes on the first
 * settings read. For a consent-based purpose it is always `enabled: false`, so
 * a `system_default` row is the absence of a decision rather than one -- and
 * counting it as reach is exactly the opt-out reading that C1 declines.
 */
export const DELIBERATE_PREFERENCE_SOURCES = [
  "signup",
  "preference_center",
  "unsubscribe_link",
  "admin",
] as const;

export type PreferenceGroup = {
  purpose: string;
  enabled: boolean;
  source: string;
  count: number;
};

export type MarketingReachRow = {
  purpose: string;
  accounts: number;
  noRow: number;
  enabled: number;
  disabled: number;
  enabledBySource: Record<string, number>;
  provable: number;
  unprovable: number;
  suppressed: number;
  sendable: number;
};

export type MarketingReachFinding = {
  code:
    | "NO_MARKETING_CONSENT_YET"
    | "ENABLED_WITHOUT_A_DELIBERATE_SOURCE"
    | "CONSENT_NOT_PROVABLE"
    | "SUPPRESSED_BUT_ENABLED";
  purpose?: string;
  message: string;
};

/**
 * One row per marketing purpose: who is switched on, and what we could show a
 * regulator about it.
 *
 * The two numbers that are not the same:
 *
 *   * `enabled` is what `EmailPreference` says now. It is the number a send
 *     would use.
 *   * `provable` is how many of those have an append-only `ConsentRecord`
 *     whose newest action is `granted` or `reconfirmed`. CASL and the
 *     Australian Spam Act put the burden of proving consent on the sender, and
 *     German case law is stricter still, so a switched-on preference with no
 *     record behind it is a send we could not defend.
 *
 * `unprovable` is the gap, and it is the population any double opt-in rollout
 * has to deal with -- and the one that cannot be dealt with by email, because
 * a message asking for consent is itself a commercial message to somebody
 * whose consent we cannot show (docs/policy/email-double-opt-in-draft.md §7).
 */
export const marketingReachRows = ({
  accounts = 0,
  preferences = [],
  provableByPurpose = {},
  suppressedEnabledByPurpose = {},
}: {
  accounts?: number;
  preferences?: PreferenceGroup[];
  provableByPurpose?: Record<string, number>;
  suppressedEnabledByPurpose?: Record<string, number>;
} = {}): MarketingReachRow[] =>
  MARKETING_PURPOSES.map((purpose) => {
    const rows = preferences.filter((row) => row.purpose === purpose);
    const count = (predicate: (row: PreferenceGroup) => boolean) =>
      rows.filter(predicate).reduce((total, row) => total + row.count, 0);

    const enabled = count((row) => row.enabled);
    const provable = provableByPurpose[purpose] ?? 0;
    const suppressed = suppressedEnabledByPurpose[purpose] ?? 0;
    const withRow = count(() => true);

    const enabledBySource = new Map<string, number>();
    for (const row of rows) {
      if (!row.enabled) continue;
      enabledBySource.set(row.source, (enabledBySource.get(row.source) ?? 0) + row.count);
    }

    return {
      purpose,
      accounts,
      // Accounts with no row at all. `ensureDefaultPreferences` runs on a
      // settings read, so this is "never opened the preference centre", and
      // for a consent-based purpose an absent row is a refusal
      // (`lib/emailPreferenceCore.ts`).
      noRow: Math.max(accounts - withRow, 0),
      enabled,
      disabled: count((row) => !row.enabled),
      enabledBySource: Object.fromEntries(enabledBySource),
      provable,
      unprovable: Math.max(enabled - provable, 0),
      suppressed,
      // What a campaign sent right now would actually deliver to: switched on
      // and not suppressed. Suppression wins over a preference in every case
      // (§11.2), so this is never larger than `enabled`.
      sendable: Math.max(enabled - suppressed, 0),
    };
  });

/**
 * What the numbers mean for the decision, in the cases where they mean
 * something specific.
 *
 * Deliberately not a score. Q2 asks whether a conservative consent model is
 * commercially bearable, and that is a business judgement -- what this can do
 * is stop it being made against a baseline that does not exist.
 */
export const marketingReachFindings = (
  rows: MarketingReachRow[]
): MarketingReachFinding[] => {
  const findings: MarketingReachFinding[] = [];
  const total = rows.reduce((sum, row) => sum + row.enabled, 0);
  const deliberate = rows.reduce(
    (sum, row) =>
      sum +
      DELIBERATE_PREFERENCE_SOURCES.reduce(
        (inner, source) => inner + (row.enabledBySource[source] ?? 0),
        0
      ),
    0
  );

  if (total === 0) {
    findings.push({
      code: "NO_MARKETING_CONSENT_YET",
      message:
        "Nobody has a marketing purpose switched on. The conservative model is not reducing an existing list -- there is no list, under any consent model, because consent has never been collected anywhere in the product. What C1 and C8 cost is the rate at which a list is built from here, not a set of people who would otherwise be reachable today.",
    });
  }

  if (total > 0 && deliberate === 0) {
    findings.push({
      code: "ENABLED_WITHOUT_A_DELIBERATE_SOURCE",
      message:
        "Every switched-on preference came from a source that is not a person deciding. For a consent-based purpose that should not be reachable: the default is off. Find out what wrote these before treating them as reach.",
    });
  }

  for (const row of rows) {
    if (row.unprovable > 0) {
      findings.push({
        code: "CONSENT_NOT_PROVABLE",
        purpose: row.purpose,
        message: `${row.unprovable} account(s) have ${row.purpose} switched on with no ConsentRecord behind it. Those cannot be defended where the burden of proof is on the sender, and they cannot be confirmed by email either -- asking is itself a commercial message. Re-consent has to happen in the product.`,
      });
    }
    if (row.suppressed > 0) {
      findings.push({
        code: "SUPPRESSED_BUT_ENABLED",
        purpose: row.purpose,
        message: `${row.suppressed} account(s) have ${row.purpose} switched on and are suppressed. Suppression wins; they are excluded from sendable.`,
      });
    }
  }

  return findings;
};

export const formatMarketingReachRow = (row: MarketingReachRow) =>
  `  ${row.purpose.padEnd(17)}${String(row.enabled).padEnd(10)}${String(row.provable).padEnd(10)}${String(row.unprovable).padEnd(12)}${String(row.sendable)}`;
