// How many people could a marketing campaign reach today?
//
//   npm run report:marketing-reach
//   npm run report:marketing-reach -- --json
//
// The same counts the Admin Console serves at `GET /api/admin/marketing-reach`,
// through the same function -- this is the shell-shaped way in, for a host that
// has a DATABASE_URL and no browser session.
//
// Reports counts only. No query behind it selects an address, a user id or a
// name, so the output is safe to paste into a decision record.
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

import { formatMarketingReachRow } from "../lib/marketingReachCore.ts";

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
  const { marketingReachReport } = await import("../lib/marketingReach.ts");
  const { prisma } = await import("../lib/prisma.ts");
  const report = await marketingReachReport();
  await prisma.$disconnect().catch(() => undefined);
  payload = {
    source: "database",
    note: `Read ${report.accounts} account(s) at ${report.readAt}.`,
    ...report,
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
    "\n  Counts only. No address, user id or name is selected by any query behind this report."
  );
}
