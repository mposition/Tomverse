import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * Which jurisdiction profile a country's messages are composed under, per policy
 * version a message can still be sent under.
 *
 * Contract: docs/policy/email-notifications.md section 10.2 (the profile is
 * keyed by profile, not by country); docs/policy/email-product-news-redesign-draft.md
 * section 7.6 (a queued message is composed under the version it carries).
 *
 * ## Why this is not `profileKey === countryCode`
 *
 * It is today, for KR, SG and US. It is not in general: the EEA is thirty
 * countries and one profile, and a member state that later needs its own rules
 * becomes a new profile plus a remapped row rather than a deploy. Two readiness
 * checks assumed the identity and a review named what that costs -- a pending
 * message carrying `jurisdictionCountry: "SG"` and `jurisdictionProfileKey:
 * "SG-v2"` is not in `profileKey IN ('SG')`, so the check passed on the `SG`
 * row while the message was composed from `SG-v2`.
 *
 * So the active version's mapping is read from `JurisdictionCountryMap`, and a
 * queued message's is read from the message: it carries the pair it was pinned
 * to, and that pair is what the lane will use.
 */

export type CountryProfilePair = {
  policyVersionId: string;
  countryCode: string;
  profileKey: string;
  /** True for a pair a pending delivery carries, rather than one about to be used. */
  queued: boolean;
};

/**
 * Every (policy version, country, profile) a message could still be composed
 * under, for the countries asked about.
 *
 * The active version's pairs come from its country map; a country the active
 * version does not map is reported with a null profile key by the caller's own
 * absent-row rule, so nothing here has to guess one.
 */
export async function sendableCountryProfiles(input: {
  countryCodes: readonly string[];
  activePolicyVersionId: string;
}): Promise<{ pairs: CountryProfilePair[]; unmappedCountries: string[] }> {
  if (input.countryCodes.length === 0) return { pairs: [], unmappedCountries: [] };

  const active = await prisma.jurisdictionCountryMap.findMany({
    where: {
      policyVersionId: input.activePolicyVersionId,
      countryCode: { in: [...input.countryCodes] },
    },
    select: { countryCode: true, profileKey: true },
  });

  // Filtered by country, not by profile key: the profile key is what the
  // delivery carries and what has to be checked, so it cannot also be the
  // filter.
  const queued = await prisma.emailDelivery.findMany({
    where: {
      status: "pending",
      jurisdictionCountry: { in: [...input.countryCodes] },
    },
    select: {
      policyVersionId: true,
      jurisdictionCountry: true,
      jurisdictionProfileKey: true,
    },
    distinct: ["policyVersionId", "jurisdictionCountry", "jurisdictionProfileKey"],
  });

  const pairs = new Map<string, CountryProfilePair>();
  const add = (pair: CountryProfilePair) => {
    const key = `${pair.policyVersionId}:${pair.countryCode}:${pair.profileKey}`;
    // A pair that is both active and queued is reported once, as queued: the
    // queued reading is the stricter claim about what has already been decided.
    const seen = pairs.get(key);
    if (seen === undefined || (pair.queued && !seen.queued)) pairs.set(key, pair);
  };
  for (const row of active) {
    add({
      policyVersionId: input.activePolicyVersionId,
      countryCode: row.countryCode,
      profileKey: row.profileKey,
      queued: false,
    });
  }
  for (const row of queued) {
    add({
      policyVersionId: row.policyVersionId,
      countryCode: row.jurisdictionCountry,
      profileKey: row.jurisdictionProfileKey,
      queued: true,
    });
  }

  // A country the active version does not map at all: no profile, so no row to
  // check, and a message to that country would be composed from nothing. The
  // caller reports it, because what it means depends on whether that country has
  // a duty.
  const mapped = new Set(active.map((row) => row.countryCode));
  return {
    pairs: [...pairs.values()].sort(
      (a, b) =>
        a.policyVersionId.localeCompare(b.policyVersionId) ||
        a.countryCode.localeCompare(b.countryCode) ||
        a.profileKey.localeCompare(b.profileKey)
    ),
    unmappedCountries: input.countryCodes.filter((countryCode) => !mapped.has(countryCode)).sort(),
  };
}

/** Every policy version a message could still be composed under. */
export async function sendablePolicyVersionIds(activePolicyVersionId: string): Promise<string[]> {
  const queued = await prisma.emailDelivery.findMany({
    where: { status: "pending" },
    select: { policyVersionId: true },
    distinct: ["policyVersionId"],
  });
  return [...new Set([activePolicyVersionId, ...queued.map((row) => row.policyVersionId)])].sort();
}
