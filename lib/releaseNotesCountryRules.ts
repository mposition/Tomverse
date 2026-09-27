import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  RELEASE_NOTES_RULE_BASES,
  RELEASE_NOTES_RULE_STATUSES,
  type ReleaseNotesRuleForVerdict,
} from "@/lib/releaseNotesCountryRuleCore";

/**
 * The country rules of one policy version, for the countries a send names.
 *
 * Contract: docs/policy/email-notifications.md section 5.1.1; the verdict over
 * these rows is `releaseNotesAuthorityVerdict()` in
 * `lib/releaseNotesCountryRuleCore.ts`.
 *
 * Read by policy version, never "the latest rule for AU": a verdict is decided
 * under one version, and mixing rows from two would record a basis nobody
 * approved together. A country with no row is simply absent from the result,
 * and the verdict refuses it (`no_country_rule`).
 *
 * `client` is the caller's transaction when there is one, so a verdict and the
 * rows it rests on are read in one snapshot.
 */
export async function releaseNotesRulesForVersion(input: {
  policyVersionId: string;
  countries: readonly string[];
  client?: Prisma.TransactionClient;
}): Promise<ReleaseNotesRuleForVerdict[]> {
  const db = input.client ?? prisma;
  if (input.countries.length === 0) return [];
  const rows = await db.releaseNotesCountryRule.findMany({
    where: {
      policyVersionId: input.policyVersionId,
      countryCode: { in: [...new Set(input.countries)] },
    },
    select: {
      countryCode: true,
      ruleKey: true,
      ruleVersion: true,
      basis: true,
      status: true,
    },
    orderBy: { countryCode: "asc" },
  });

  // The CHECK constraints hold these to the lists already. Asserting again
  // here turns a schema that moved ahead of this build into an error rather
  // than a verdict over a value the build has no branch for.
  return rows.map((row) => {
    if (!(RELEASE_NOTES_RULE_BASES as readonly string[]).includes(row.basis)) {
      throw new Error(`Rule ${row.ruleKey} has a basis this build does not know: ${row.basis}.`);
    }
    if (!(RELEASE_NOTES_RULE_STATUSES as readonly string[]).includes(row.status)) {
      throw new Error(`Rule ${row.ruleKey} has a status this build does not know: ${row.status}.`);
    }
    return row as ReleaseNotesRuleForVerdict;
  });
}
