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

  // Switched on and suppressed at the same time.
  //
  // Read from `SuppressionCause`, because that is what the send gate reads
  // (`suppressionCheck()`) and nothing has written `SuppressionEntry` since
  // deploy C. Counting entries here would report as `sendable` everybody
  // suppressed since those writes stopped -- a report whose entire purpose is
  // answering "how many can we actually reach" quietly overstating it.
  //
  // Three scopes count, and they are the gate's own three: `global`, the
  // `marketing` classification stop a deletion intake writes, and a cause
  // scoped to this purpose. The reason is not filtered because every reason
  // blocks a marketing send -- a hard bounce, a complaint, a hold, a privacy
  // request, an unsubscribe, and a soft bounce, marketing not being must-reach.
  // What is filtered is whether the cause is still in force: causes are
  // append-only, so a lifted one is released rather than deleted, and a soft
  // bounce expires.
  const suppressedRows = await prisma.$queryRaw<{ purpose: string; count: number }[]>`
    SELECT p.purpose, COUNT(DISTINCT p."userId")::int AS count
    FROM "EmailPreference" p
    JOIN "User" u ON u.id = p."userId"
    JOIN "SuppressionCause" c
      ON lower(c."emailAddress") = lower(u.email)
     AND c."releasedAt" IS NULL
     AND (c."expiresAt" IS NULL OR c."expiresAt" > now())
     AND (
       c.scope = 'global'
       OR (c.scope = 'classification' AND c."purposeKey" = 'marketing')
       OR (c.scope = 'purpose' AND c."purposeKey" = p.purpose)
     )
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
