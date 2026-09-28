import "server-only";

import { prisma } from "@/lib/prisma";
import {
  RELEASE_NOTES_OBLIGATIONS,
  obligationsFor,
  type StoredObligation,
} from "@/lib/releaseNotesObligationCore";
import type { CountryDisplayRequirement } from "@/lib/releaseNotesDisplayContractCore";

/**
 * What each candidate country requires the message to show.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 7.6.
 *
 * ## Why a partition rather than a filter
 *
 * Section 7.6 names three displays -- footer block, subject prefix, unsubscribe
 * notice -- and says the contract carries one entry per display obligation key.
 * It does not enumerate which duties those are, and `RELEASE_NOTES_OBLIGATIONS`
 * holds every duty a country carries, display or not.
 *
 * So the two lists below are a **partition**, not a filter, and
 * `tests/releaseNotesDisplayRequirements.test.mjs` fails when a duty appears in
 * neither or in both. A filter would let a duty added to
 * `RELEASE_NOTES_OBLIGATIONS` fall out of the contract without anybody deciding
 * that it should: the hash would stop moving when that duty's waiver was
 * withdrawn, and the message already in the queue would go out under an
 * authority that no longer exists. Being asked to classify a new duty is the
 * cost, and it is the smaller one.
 *
 * Over-inclusion is the safe direction of the two. A duty in the contract that
 * does not change what is printed makes the hash move for a reason the reader
 * cannot see in the message, which costs a re-render of something identical. A
 * duty left out makes the hash stand still while the thing it stood for changed.
 */

/** The duties whose state decides what the message shows. */
export const DISPLAY_OBLIGATIONS: Record<string, readonly string[]> = {
  KR: [
    // The identity list of the enforcement decree's table 6, printed in the footer.
    "body_disclosures",
    // The unsubscribe notice itself, in both languages.
    "bilingual_unsubscribe_notice",
    // About the unsubscribe the footer promises: a link that demands a login is
    // a different offer from the one the notice makes, so what the notice means
    // depends on this being settled.
    "no_login_for_unsubscribe",
    // The advertising prefix, which is the subject's front.
    "advertising_subject_label",
  ],
  SG: ["adv_subject_label"],
  US: ["postal_address"],
};

/**
 * The duties this message does not display, and why each one does not.
 *
 * Both of these are duties to send *another* message. Their state says nothing
 * about what this one prints, and folding them in would move this message's
 * hash when a separate product's readiness changed.
 */
export const NON_DISPLAY_OBLIGATIONS: Record<string, Readonly<Record<string, string>>> = {
  KR: {
    consent_result_notice_14_days:
      "A separate message, sent within 14 days of a consent change (Act article 50(7)).",
    biennial_consent_notice: "A separate message, sent every two years (Act article 50(8)).",
  },
};

/**
 * The unsubscribe notice languages each country's rule requires.
 *
 * Only Korea names languages: table 6 asks for the notice in Korean and English
 * whatever the rest of the message is in. Elsewhere the notice is in the
 * message's own language, which is a property of the delivery rather than of the
 * country, so the country requires nothing extra and contributes nothing to the
 * union.
 */
export const UNSUBSCRIBE_NOTICE_LANGUAGES: Record<string, readonly string[]> = {
  KR: ["ko", "en"],
};

/** A country rule as the requirement assembler reads it. */
export type RuleForRequirements = {
  countryCode: string;
  ruleKey: string;
  ruleVersion: number;
};

/** A jurisdiction profile as the requirement assembler reads it. */
export type ProfileForRequirements = {
  subjectPrefix: string | null;
  footerBlocks: readonly string[];
  unsubscribeSlaBusinessDays: number;
};

/**
 * Why a country's requirement could not be assembled.
 *
 * Not thrown: a missing profile is a seed that has not reached this policy
 * version, which the verdict refuses as `display_unsatisfiable` rather than as a
 * database failure. Distinguishing those two is what `VerdictUnavailableError`
 * is for.
 */
export type RequirementGap = { countryCode: string; reason: "no_profile" };

/**
 * The duty that puts a label at the front of the subject, per country.
 *
 * Named separately from `DISPLAY_OBLIGATIONS` because the composition needs to
 * ask one question the contract does not answer: whether *this* duty is waived,
 * and therefore whether the profile's `subjectPrefix` should be printed at all.
 *
 * Section 7.7 is explicit that an exemption is recorded rather than seeded away:
 * the profile keeps its value and the send omits the label because a waiver
 * says so. A build that cleared the profile instead would have no way to tell
 * an exemption from a country whose rule never asked for one, and reinstating
 * the label would mean editing a seed rather than withdrawing an approval.
 */
export const SUBJECT_LABEL_OBLIGATIONS: Record<string, string> = {
  KR: "advertising_subject_label",
  SG: "adv_subject_label",
};

export const displayRequirementsFor = (input: {
  countries: readonly string[];
  rules: readonly RuleForRequirements[];
  obligations: Readonly<Record<string, readonly StoredObligation[]>>;
  profiles: Readonly<Record<string, ProfileForRequirements>>;
}): { requirements: CountryDisplayRequirement[]; gaps: RequirementGap[] } => {
  const byCountry = new Map(input.rules.map((rule) => [rule.countryCode, rule]));
  const requirements: CountryDisplayRequirement[] = [];
  const gaps: RequirementGap[] = [];

  for (const countryCode of [...new Set(input.countries)].sort()) {
    const rule = byCountry.get(countryCode);
    // Already refused as `no_country_rule` by the authority verdict, and adding
    // a second name for it here would report one absence twice.
    if (!rule) continue;

    const profile = input.profiles[countryCode];
    if (!profile) {
      gaps.push({ countryCode, reason: "no_profile" });
      continue;
    }

    const stored = input.obligations[countryCode] ?? [];

    // A waived subject label is not a label this country requires, so it is not
    // in the contract either. Section 7.7 records the exemption rather than
    // clearing the seed, which is why the profile still holds the prefix; a
    // contract that copied it anyway would say the message must carry a label
    // an approval says it must not, and the composition -- which does read the
    // waiver -- would print something the hash did not describe.
    //
    // It is also what stops an exemption becoming a refusal. Two candidates each
    // needing a different prefix is `conflicting_subject_prefix`, and counting a
    // waived one towards that conflict would refuse a recipient over a label
    // nobody is asking to print.
    const labelKey = SUBJECT_LABEL_OBLIGATIONS[countryCode];
    const labelWaived =
      labelKey !== undefined &&
      stored.some((entry) => entry.obligationKey === labelKey && entry.state === "waived");

    requirements.push({
      countryCode,
      ruleKey: rule.ruleKey,
      ruleVersion: rule.ruleVersion,
      subjectPrefix: labelWaived ? null : profile.subjectPrefix,
      footerBlocks: [...profile.footerBlocks],
      unsubscribeSlaBusinessDays: profile.unsubscribeSlaBusinessDays,
      unsubscribeLanguages: UNSUBSCRIBE_NOTICE_LANGUAGES[countryCode] ?? [],
      // The rows for the display duties this build knows, in the order the duty
      // list declares them, so two reads of the same rows compose the same
      // contract however the rows came back. A row for a duty this build does
      // not know is left out here and reported by `obligationsVerdict()` --
      // honouring it would mean printing something nothing can describe. A duty
      // with no row at all is left out too, and blocks as `obligation_undecided`
      // rather than composing into a contract that claims it was settled.
      displayObligations: (DISPLAY_OBLIGATIONS[countryCode] ?? [])
        .map((obligationKey) => {
          const row = stored.find((entry) => entry.obligationKey === obligationKey);
          return row === undefined
            ? null
            : {
                obligationKey,
                state: row.state,
                waiverApprovalId: row.waiverApprovalId,
              };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null),
    });
  }

  return { requirements, gaps };
};

/**
 * The profiles the candidate countries map to, under one policy version.
 *
 * Through `JurisdictionCountryMap` rather than by treating a country code as a
 * profile key: `sendableCountryProfiles()` says why those are not the same
 * question, and a key that happens to equal a country code is a coincidence this
 * build has already been caught relying on.
 */
export async function profilesForCountries(input: {
  countries: readonly string[];
  policyVersionId: string;
}): Promise<Record<string, ProfileForRequirements>> {
  if (input.countries.length === 0) return {};

  const map = await prisma.jurisdictionCountryMap.findMany({
    where: {
      policyVersionId: input.policyVersionId,
      countryCode: { in: [...input.countries] },
    },
    select: { countryCode: true, profileKey: true },
  });
  if (map.length === 0) return {};

  const profiles = await prisma.jurisdictionProfile.findMany({
    where: {
      policyVersionId: input.policyVersionId,
      profileKey: { in: [...new Set(map.map((row) => row.profileKey))] },
    },
    select: {
      profileKey: true,
      subjectPrefix: true,
      footerBlocks: true,
      unsubscribeSlaBusinessDays: true,
    },
  });
  const byKey = new Map(profiles.map((row) => [row.profileKey, row]));

  const result: Record<string, ProfileForRequirements> = {};
  for (const row of map) {
    const profile = byKey.get(row.profileKey);
    if (!profile) continue;
    result[row.countryCode] = {
      subjectPrefix: profile.subjectPrefix,
      // Stored as JSON, so a row written by hand can hold anything. A shape this
      // build cannot read is no footer blocks rather than a crash: the composed
      // contract then fails to hold what the duties ask for, which is a refusal
      // an operator can act on.
      footerBlocks: Array.isArray(profile.footerBlocks)
        ? profile.footerBlocks.filter((block): block is string => typeof block === "string")
        : [],
      unsubscribeSlaBusinessDays: profile.unsubscribeSlaBusinessDays,
    };
  }
  return result;
}

/** Every country any of the three tables names, for the partition check. */
export const ALL_OBLIGATION_COUNTRIES = [
  ...new Set([
    ...Object.keys(RELEASE_NOTES_OBLIGATIONS),
    ...Object.keys(DISPLAY_OBLIGATIONS),
    ...Object.keys(NON_DISPLAY_OBLIGATIONS),
  ]),
].sort();

/** The duties of one country that are unclassified, double-classified or undeclared. */
export const obligationPartitionProblems = (countryCode: string): string[] => {
  const declared = obligationsFor(countryCode);
  const display = DISPLAY_OBLIGATIONS[countryCode] ?? [];
  const nonDisplay = Object.keys(NON_DISPLAY_OBLIGATIONS[countryCode] ?? {});
  const problems: string[] = [];

  for (const key of declared) {
    const inDisplay = display.includes(key);
    const inNonDisplay = nonDisplay.includes(key);
    if (!inDisplay && !inNonDisplay) {
      problems.push(`${countryCode}/${key} is declared and classified neither way`);
    }
    if (inDisplay && inNonDisplay) {
      problems.push(`${countryCode}/${key} is classified both ways`);
    }
  }
  for (const key of [...display, ...nonDisplay]) {
    if (!declared.includes(key)) {
      problems.push(`${countryCode}/${key} is classified but no country rule declares it`);
    }
  }
  return problems;
};


/**
 * Whether every candidate country that asks for a subject label has waived it.
 *
 * Every, not any. Two candidates and one waiver is still a subject that has to
 * carry the other country's label, and a message that dropped it because one
 * approval existed would be unlabelled advertising in the country that did not
 * approve anything.
 *
 * False where no country asks for one: there is nothing to waive, and reporting
 * a waiver would put an exemption in the record for a duty nobody has.
 */
export const subjectLabelWaived = (
  obligations: Readonly<Record<string, { obligations: ReadonlyArray<{ obligationKey: string; state: string | null }> }>>
): boolean => {
  const asking = Object.entries(obligations).filter(([countryCode]) =>
    Boolean(SUBJECT_LABEL_OBLIGATIONS[countryCode])
  );
  if (asking.length === 0) return false;
  return asking.every(([countryCode, verdict]) => {
    const key = SUBJECT_LABEL_OBLIGATIONS[countryCode];
    const duty = verdict.obligations.find((entry) => entry.obligationKey === key);
    return duty !== undefined && duty.state === "waived";
  });
};
