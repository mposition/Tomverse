// How many people could a marketing campaign reach today?
//
//   npm run report:marketing-reach
//   npm run report:marketing-reach -- --json
//
// Reads EmailPreference, ConsentRecord and SuppressionEntry and reports counts
// only. No address, no user id and no name is selected by any query here --
// the output is meant to be safe to paste into a decision record, and the way
// to keep that true is for the rows never to contain one.
//
// Writes nothing. Exits 0 whatever it finds: divergence between a switched-on
// preference and a missing consent record is a question for a person, not a
// defect a gate should fail on.
//
// Without a DATABASE_URL there is nothing to count, and the run says so rather
// than reporting zeros -- a zero and an unasked question look identical in a
// table, and this table exists to inform a decision.
//
// Decision this feeds: docs/ops/q2-marketing-reach-decision.md.

import {
  MARKETING_PURPOSES,
  formatMarketingReachRow,
  marketingReachFindings,
  marketingReachRows,
} from "./report-marketing-reach-core.mjs";

const json = process.argv.includes("--json");
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  const note =
    "No DATABASE_URL: nothing was counted. This run cannot tell you the reach is zero -- it can only tell you it did not look.";
  console.log(json ? JSON.stringify({ source: "none", note }, null, 2) : note);
  process.exit(0);
}

const redact = (error) =>
  String(error?.message || error).replaceAll(databaseUrl, "[redacted]").slice(0, 300);

let payload;
try {
  const { prisma } = await import("../lib/prisma.ts");

  const accounts = await prisma.user.count();

  const preferenceGroups = await prisma.emailPreference.groupBy({
    by: ["purpose", "enabled", "source"],
    where: { purpose: { in: MARKETING_PURPOSES } },
    _count: { _all: true },
  });
  const preferences = preferenceGroups.map((group) => ({
    purpose: group.purpose,
    enabled: group.enabled,
    source: group.source,
    count: group._count._all,
  }));

  // Distinct people whose latest consent action for the purpose is a grant.
  //
  // `ConsentRecord` is append-only, so a person who granted and then withdrew
  // has both rows and counting grants would count them as consenting. The
  // window function takes the newest row per (user, purpose) and only then
  // asks what it says.
  const provableRows = await prisma.$queryRaw`
    SELECT purpose, COUNT(*)::int AS count
    FROM (
      SELECT DISTINCT ON ("userId", purpose) "userId", purpose, action
      FROM "ConsentRecord"
      WHERE "userId" IS NOT NULL
        AND purpose = ANY(${MARKETING_PURPOSES}::text[])
      ORDER BY "userId", purpose, "occurredAt" DESC, "createdAt" DESC
    ) latest
    WHERE action IN ('granted', 'reconfirmed')
    GROUP BY purpose
  `;
  const provableByPurpose = Object.fromEntries(
    provableRows.map((row) => [row.purpose, Number(row.count)])
  );

  // Switched on and suppressed at the same time. Global suppression ('*')
  // counts for every purpose; a purpose-scoped one counts for its own.
  const suppressedRows = await prisma.$queryRaw`
    SELECT p.purpose, COUNT(DISTINCT p."userId")::int AS count
    FROM "EmailPreference" p
    JOIN "User" u ON u.id = p."userId"
    JOIN "SuppressionEntry" s
      ON lower(s."emailAddress") = lower(u.email)
     AND (s."purposeKey" = '*' OR s."purposeKey" = p.purpose)
    WHERE p.enabled = true
      AND p.purpose = ANY(${MARKETING_PURPOSES}::text[])
    GROUP BY p.purpose
  `;
  const suppressedEnabledByPurpose = Object.fromEntries(
    suppressedRows.map((row) => [row.purpose, Number(row.count)])
  );

  await prisma.$disconnect().catch(() => undefined);

  const rows = marketingReachRows({
    accounts,
    preferences,
    provableByPurpose,
    suppressedEnabledByPurpose,
  });
  payload = {
    source: "database",
    note: `Read ${accounts} account(s) and ${preferences.length} preference group(s).`,
    rows,
    findings: marketingReachFindings(rows),
  };
} catch (error) {
  const note = `DATABASE_URL was set but the counts could not be read, so nothing is reported: ${redact(error)}`;
  console.log(json ? JSON.stringify({ source: "error", note }, null, 2) : note);
  process.exit(0);
}

if (json) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log(`Marketing reach (${payload.source})\n  ${payload.note}\n`);
  console.log(
    `  ${"purpose".padEnd(17)}${"enabled".padEnd(10)}${"provable".padEnd(10)}${"unprovable".padEnd(12)}sendable`
  );
  for (const row of payload.rows) console.log(formatMarketingReachRow(row));
  if (payload.findings.length === 0) {
    console.log("\n  Nothing to flag.");
  }
  for (const finding of payload.findings) {
    console.log(`\n  ${finding.code}${finding.purpose ? ` (${finding.purpose})` : ""}\n    ${finding.message}`);
  }
  console.log(
    "\n  Counts only. No address, user id or name is selected by any query in this report."
  );
}
