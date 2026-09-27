import "server-only";

import { prisma } from "@/lib/prisma";
import {
  JURISDICTION_IDENTITY_BLOCKS,
  UNIVERSAL_IDENTITY_BLOCKS,
  identityBlocksWithoutValue,
} from "@/lib/emailBusinessIdentity";
import { marketingSendingConfigured } from "@/lib/emailUnsubscribeReadiness";
import { sendableCountryProfiles } from "@/lib/emailSendableProfiles";
import { obligationsFor } from "@/lib/releaseNotesObligationCore";

/**
 * Whether the footer blocks a statute requires are on the rows that send, with
 * values.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md sections 7.7 and
 * 7.8; docs/ops/email-business-identity.md.
 *
 * ## Why this is not `emailBusinessIdentity`
 *
 * Korea's `body_disclosures` duty was recorded against the general business
 * identity check, and a review showed what that settled. 시행령 별표 6 names a
 * telephone number, which lives in `JURISDICTION_IDENTITY_BLOCKS.KR`, and
 * `businessIdentityProblems()` reports a missing jurisdiction block as a
 * **warning** -- deliberately, because whether a deployment has recipients in a
 * jurisdiction is not a fact an environment holds. So `businessIdentityReadiness()`
 * answered `ready: true` with no Korean telephone number, and the duty settled
 * against it.
 *
 * Two things had to change. The question is asked per country, so a country's
 * own blocks are errors for that country's duty rather than warnings about a
 * population nobody has counted. And it reads the stored profile's
 * `footerBlocks`, not only the environment: the renderer prints the blocks the
 * row names, so a value that exists in the environment and is not named by the
 * row is not in the message.
 *
 * ## Which versions
 *
 * The active one and every version a pending delivery is pinned to, for the same
 * reason as `subjectLabelReadiness()`: the lane composes a queued message under
 * the version that message carries (EM-04), so activating a corrected version
 * does not reach anything already enqueued. And the profile each of those names,
 * rather than one whose key happens to equal a country code --
 * `sendableCountryProfiles()` says why that is not the same question.
 */

/**
 * Which blocks each footer duty is about, per country.
 *
 * Written out rather than derived. The two duties here are not the same shape --
 * Korea's `body_disclosures` is the whole 별표 6 list, and CAN-SPAM's
 * `postal_address` is one line -- and a rule that produced both from one list
 * would have to be read backwards to find out what either duty actually claims.
 * The jurisdiction's own blocks are folded in from the renderer's table, so a
 * block added there for a country becomes part of that country's duty.
 */
export const FOOTER_BLOCK_DUTIES: Record<string, Record<string, readonly string[]>> = {
  KR: {
    body_disclosures: [
      ...UNIVERSAL_IDENTITY_BLOCKS,
      ...(JURISDICTION_IDENTITY_BLOCKS.KR ?? []),
    ],
  },
  US: {
    postal_address: ["postal_address"],
  },
};

/** The countries this check answers for. */
export const FOOTER_DISCLOSURE_COUNTRIES = Object.keys(FOOTER_BLOCK_DUTIES).sort();

/** The duties this check answers for, so a seed that names it can be traced. */
export const FOOTER_DISCLOSURE_OBLIGATIONS: Record<string, readonly string[]> =
  Object.fromEntries(
    FOOTER_DISCLOSURE_COUNTRIES.map((countryCode) => [
      countryCode,
      Object.keys(FOOTER_BLOCK_DUTIES[countryCode]).filter((key) =>
        obligationsFor(countryCode).includes(key)
      ),
    ])
  );

/** Every block a country's footer duties name, together. */
export const footerBlocksRequired = (countryCode: string): readonly string[] => [
  ...new Set(Object.values(FOOTER_BLOCK_DUTIES[countryCode] ?? {}).flat()),
];

export type FooterDisclosureProblem = {
  severity: "error";
  code: "EMAIL_FOOTER_DISCLOSURE_MISSING";
  message: string;
  /** The countries whose footer blocks are not all present. */
  countryCodes: string[];
};

const blocksOf = (stored: unknown): string[] =>
  Array.isArray(stored)
    ? stored.filter((block): block is string => typeof block === "string")
    : [];

export async function footerDisclosureReadiness(
  env: Record<string, string | undefined> = process.env
): Promise<{
  /** Whether `/api/ready` should fail: only once marketing sending is set up. */
  ready: boolean;
  /** Whether this deployment is one the disclosures are mandatory for. */
  required: boolean;
  /** The substantive answer, which an obligation state rests on. */
  disclosuresPresent: boolean;
  /** The versions checked: the active one and any a pending delivery is pinned to. */
  policyVersionIds: string[];
  problems: FooterDisclosureProblem[];
}> {
  const required = marketingSendingConfigured(env);
  const answer = (
    disclosuresPresent: boolean,
    policyVersionIds: string[],
    problems: FooterDisclosureProblem[]
  ) => ({
    ready: disclosuresPresent || !required,
    required,
    disclosuresPresent,
    policyVersionIds,
    problems,
  });

  if (FOOTER_DISCLOSURE_COUNTRIES.length === 0) return answer(true, [], []);

  const active = await prisma.emailPolicyVersion.findFirst({
    where: { status: "active" },
    select: { id: true },
  });
  if (!active) {
    return answer(
      false,
      [],
      [
        {
          severity: "error",
          code: "EMAIL_FOOTER_DISCLOSURE_MISSING",
          message:
            "No email policy version is active, so no footer can be confirmed. Create and activate one (/admin/email-policy).",
          countryCodes: [...FOOTER_DISCLOSURE_COUNTRIES],
        },
      ]
    );
  }

  const { pairs, unmappedCountries } = await sendableCountryProfiles({
    countryCodes: FOOTER_DISCLOSURE_COUNTRIES,
    activePolicyVersionId: active.id,
  });

  const profiles = await prisma.jurisdictionProfile.findMany({
    where: {
      OR: pairs.map((pair) => ({
        policyVersionId: pair.policyVersionId,
        profileKey: pair.profileKey,
      })),
    },
    select: { profileKey: true, policyVersionId: true, footerBlocks: true },
  });
  const stored = new Map(
    profiles.map((row) => [
      `${row.policyVersionId}:${row.profileKey}`,
      blocksOf(row.footerBlocks),
    ])
  );

  const failures = pairs.flatMap((pair) => {
    const blocks = footerBlocksRequired(pair.countryCode);
    const named = stored.get(`${pair.policyVersionId}:${pair.profileKey}`);
    // An absent row prints no footer at all, which is every block missing.
    const notNamed =
      named === undefined ? [...blocks] : blocks.filter((block) => !named.includes(block));
    const withoutValue = identityBlocksWithoutValue(env, blocks);
    const missing = [...new Set([...notNamed, ...withoutValue])].sort();
    return missing.length > 0 ? [{ ...pair, missing }] : [];
  });

  const checked = [...new Set(pairs.map((pair) => pair.policyVersionId))].sort();
  if (failures.length === 0 && unmappedCountries.length === 0) return answer(true, checked, []);

  const queued = failures.filter((entry) => entry.queued);
  return answer(false, checked, [
    {
      severity: "error",
      code: "EMAIL_FOOTER_DISCLOSURE_MISSING",
      message:
        (failures.length > 0
          ? "The footer a statute requires is incomplete for " +
            `${failures
              .map(
                (entry) =>
                  `${entry.countryCode}/${entry.profileKey}@${entry.policyVersionId} ` +
                  `(${entry.missing.join(", ")})`
              )
              .join("; ")}. `
          : "") +
        (queued.length > 0
          ? "Some of those are carried by pending deliveries, which activating a corrected " +
            "version does not change. "
          : "") +
        (unmappedCountries.length > 0
          ? `The active version maps no profile for ${unmappedCountries.join(", ")}, so a ` +
            "message to those countries would be composed from no profile at all. "
          : "") +
        "Marketing to those countries is refused while that is true.",
      countryCodes: [
        ...new Set([...failures.map((entry) => entry.countryCode), ...unmappedCountries]),
      ].sort(),
    },
  ]);
}
