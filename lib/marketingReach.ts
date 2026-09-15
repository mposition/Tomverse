import "server-only";

import { prisma } from "@/lib/prisma";
import {
  MARKETING_PURPOSES,
  marketingReachFindings,
  marketingReachRows,
  type MarketingReachFinding,
  type MarketingReachRow,
  type PreferenceGroup,
} from "@/lib/marketingReachCore";

/**
 * The counts behind the Q2 decision, read from the live tables.
 *
 * Contract: docs/policy/email-notifications.md §5.1 C1, §5.6 C8, §11.2.
 * Decision this feeds: docs/ops/q2-marketing-reach-decision.md.
 *
 * ## Counts only
 *
 * No query here selects an address, a user id or a name, and that is a
 * property of the queries rather than of a filter applied afterwards. The
 * result is meant to be safe to paste into a decision record, and the way to
 * keep that true is for the rows never to contain one in the first place.
 *
 * Callers are the admin endpoint and `scripts/report-marketing-reach.mjs`.
 * They share this function rather than each writing the same three queries:
 * a second copy is how the CLI and the console start disagreeing about what
 * "reachable" means.
 */

export type MarketingReachReport = {
  accounts: number;
  rows: MarketingReachRow[];
  findings: MarketingReachFinding[];
  /** When the counts were read. Three queries at three instants, so this is the last of them. */
  readAt: string;
};

export async function marketingReachReport(): Promise<MarketingReachReport> {
  const accounts = await prisma.user.count();

  const preferenceGroups = await prisma.emailPreference.groupBy({
    by: ["purpose", "enabled", "source"],
    where: { purpose: { in: [...MARKETING_PURPOSES] } },
    _count: { _all: true },
  });
  const preferences: PreferenceGroup[] = preferenceGroups.map((group) => ({
    purpose: group.purpose,
    enabled: group.enabled,
    source: group.source,
    count: group._count._all,
  }));

  // Distinct people whose latest consent action for the purpose is a grant.
  //
  // `ConsentRecord` is append-only, so a person who granted and then withdrew
  // has both rows and counting grants would count them as consenting. The
  // window takes the newest row per (user, purpose) and only then asks what it
  // says.
  const provableRows = await prisma.$queryRaw<{ purpose: string; count: number }[]>`
    SELECT purpose, COUNT(*)::int AS count
    FROM (
      SELECT DISTINCT ON ("userId", purpose) "userId", purpose, action
      FROM "ConsentRecord"
      WHERE "userId" IS NOT NULL
        AND purpose = ANY(${[...MARKETING_PURPOSES]}::text[])
      ORDER BY "userId", purpose, "occurredAt" DESC, "createdAt" DESC
    ) latest
    WHERE action IN ('granted', 'reconfirmed')
    GROUP BY purpose
  `;
  const provableByPurpose = Object.fromEntries(
    provableRows.map((row) => [row.purpose, Number(row.count)])
  );

  // Switched on and suppressed at the same time. A global suppression ('*')
  // counts for every purpose; a purpose-scoped one counts for its own.
  const suppressedRows = await prisma.$queryRaw<{ purpose: string; count: number }[]>`
    SELECT p.purpose, COUNT(DISTINCT p."userId")::int AS count
    FROM "EmailPreference" p
    JOIN "User" u ON u.id = p."userId"
    JOIN "SuppressionEntry" s
      ON lower(s."emailAddress") = lower(u.email)
     AND (s."purposeKey" = '*' OR s."purposeKey" = p.purpose)
    WHERE p.enabled = true
      AND p.purpose = ANY(${[...MARKETING_PURPOSES]}::text[])
    GROUP BY p.purpose
  `;
  const suppressedEnabledByPurpose = Object.fromEntries(
    suppressedRows.map((row) => [row.purpose, Number(row.count)])
  );

  const rows = marketingReachRows({
    accounts,
    preferences,
    provableByPurpose,
    suppressedEnabledByPurpose,
  });

  return {
    accounts,
    rows,
    findings: marketingReachFindings(rows),
    readAt: new Date().toISOString(),
  };
}
