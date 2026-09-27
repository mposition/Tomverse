import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  RELEASE_NOTES_RULE_BASES,
  RELEASE_NOTES_RULE_STATUSES,
  releaseNotesRuleKey,
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
      rule: { select: { basis: true, status: true } },
    },
    orderBy: { countryCode: "asc" },
  });

  // The CHECK constraints hold these to the lists already. Asserting again
  // here turns a schema that moved ahead of this build into an error rather
  // than a verdict over a value the build has no branch for.
  return rows.map((row) => {
    if (!(RELEASE_NOTES_RULE_BASES as readonly string[]).includes(row.rule.basis)) {
      throw new Error(
        `Rule ${row.ruleKey} has a basis this build does not know: ${row.rule.basis}.`
      );
    }
    if (!(RELEASE_NOTES_RULE_STATUSES as readonly string[]).includes(row.rule.status)) {
      throw new Error(
        `Rule ${row.ruleKey} has a status this build does not know: ${row.rule.status}.`
      );
    }
    return {
      countryCode: row.countryCode,
      ruleKey: row.ruleKey,
      ruleVersion: row.ruleVersion,
      basis: row.rule.basis,
      status: row.rule.status,
    } as ReleaseNotesRuleForVerdict;
  });
}

/**
 * Stored rule versions whose content is not the one the seed describes.
 *
 * A rule version's content never changes (its trigger refuses), and the seed is
 * written with `skipDuplicates`, so a seed edited without a new version number
 * would be accepted silently and the stored rule would go on saying the old
 * thing. This is how the draft writer finds that out and refuses instead.
 *
 * Compared field by field rather than by a digest: the answer has to name what
 * disagreed, and a digest would only say that something did.
 */
export async function releaseNotesRuleVersionConflicts(
  client: Prisma.TransactionClient | typeof prisma,
  seed: readonly {
    countryCode: string;
    ruleVersion: number;
    basis: string;
    status: string;
    releaseConditions: readonly string[];
    activationGates: readonly string[];
  }[]
): Promise<string[]> {
  const stored = await client.releaseNotesRuleVersion.findMany({
    where: { OR: seed.map((rule) => ({ ruleKey: releaseNotesRuleKey(rule.countryCode), ruleVersion: rule.ruleVersion })) },
    select: {
      ruleKey: true,
      ruleVersion: true,
      countryCode: true,
      basis: true,
      status: true,
      releaseConditions: true,
      activationGates: true,
    },
  });
  const byPair = new Map(stored.map((row) => [`${row.ruleKey}:${row.ruleVersion}`, row]));
  const problems: string[] = [];
  const sameStrings = (left: unknown, right: readonly string[]) =>
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index]);

  for (const rule of seed) {
    const key = releaseNotesRuleKey(rule.countryCode);
    const row = byPair.get(`${key}:${rule.ruleVersion}`);
    if (!row) continue;
    const differs: string[] = [];
    if (row.countryCode !== rule.countryCode) differs.push("countryCode");
    if (row.basis !== rule.basis) differs.push("basis");
    if (row.status !== rule.status) differs.push("status");
    if (!sameStrings(row.releaseConditions, rule.releaseConditions)) {
      differs.push("releaseConditions");
    }
    if (!sameStrings(row.activationGates, rule.activationGates)) {
      differs.push("activationGates");
    }
    if (differs.length > 0) {
      problems.push(`${key} v${rule.ruleVersion} (${differs.join(", ")})`);
    }
  }
  return problems;
}
