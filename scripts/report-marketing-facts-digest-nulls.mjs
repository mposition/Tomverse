// How many marketing posts have no `factsDigest`, and what kind of rows they
// are.
//
// S2b3 adds `MarketingPost.factsDigest NOT NULL`, and the S2 plan says a
// non-zero count is a stop rather than an inferred decision: somebody has to
// choose what happens to those rows before the migration is run. This report
// exists so that choice is made against numbers rather than a guess, and so the
// same numbers can be read again afterwards. The migration's own failure
// message names it.
//
// **Why raw SQL and not the Prisma Client.** The client is generated from
// `prisma/schema.prisma`, where this column is now required -- so
// `where: { factsDigest: null }` is a filter it refuses before it opens a
// connection: "Argument factsDigest must not be null." That refusal is right
// about the schema and wrong about the database this report is for. The whole
// point of running it is to ask about a database that has *not* had the
// migration applied, where the column is still nullable and may still hold
// nulls. A report that can only run after the change it exists to inform is
// not a report.
//
// It writes nothing. Every statement below is a `SELECT`, there is no flag that
// makes it write, and it does not print a single row's contents -- not the
// rendered text, not the envelope, not the fact snapshot, not an account id.
// What it prints is counts and the categories those counts fall into, which is
// what the disposition turns on.
//
// Requires DATABASE_URL. Run it once against staging and once against
// production; the answer may differ, and the migration has to be safe for both.

import { Prisma } from "@prisma/client";

// The application's own client, not a bare `new PrismaClient()`: this project
// connects through a PrismaPg driver adapter.
import { prisma } from "../lib/prisma.ts";

/**
 * The statuses a post can still be acted on from.
 *
 * The disposition is different for these. A row that is still waiting on a
 * person, or still going out, is one whose `factsDigest` a backfill would be
 * writing *into a live decision*; a `deleted` or `rejected` row is history.
 */
const STILL_LIVE = [
  "drafted",
  "pending_approval",
  "approved",
  "scheduled",
  "publishing",
];

const pad = (value, width) => String(value).padStart(width);

const table = (title, rows) => {
  console.log(`\n${title}`);
  if (rows.length === 0) {
    console.log("  (none)");
    return;
  }
  const width = Math.max(...rows.map(([label]) => String(label).length));
  for (const [label, count] of rows) {
    console.log(`  ${String(label).padEnd(width)}  ${pad(count, 7)}`);
  }
};

/** `count(*)` comes back as a bigint, which does not survive `padStart`. */
const asNumber = (value) => Number(value ?? 0);

const main = async () => {
  if (!process.env.DATABASE_URL) {
    console.error(
      "DATABASE_URL is not set. This report reads a database and has nothing " +
        "to say without one."
    );
    process.exitCode = 1;
    return;
  }

  // Does the table exist at all? On 2026-09-23 production answered that it did
  // not, because both marketing migrations were still only on `develop`. That
  // is an answer, not an error, and saying so is more use than a stack trace.
  const present = await prisma.$queryRaw`
    SELECT to_regclass('public."MarketingPost"') IS NOT NULL AS "present"
  `;
  if (!present[0]?.present) {
    console.log("MarketingPost does not exist in this database.");
    console.log(
      "\nThe marketing tables have not reached here yet. When they do, the\n" +
        "table is created at whatever the schema says then -- so there is no\n" +
        "legacy population for the NOT NULL migration to refuse."
    );
    return;
  }

  const counts = await prisma.$queryRaw`
    SELECT
      count(*) AS "total",
      count(*) FILTER (WHERE "factsDigest" IS NULL) AS "missing"
    FROM "MarketingPost"
  `;
  const total = asNumber(counts[0]?.total);
  const missing = asNumber(counts[0]?.missing);

  console.log("MarketingPost.factsDigest");
  console.log(`  rows            ${pad(total, 7)}`);
  console.log(`  without digest  ${pad(missing, 7)}`);

  if (missing === 0) {
    console.log(
      "\nNothing to dispose of. The NOT NULL migration has no rows to refuse,\n" +
        "and this run is the evidence for that -- against this database, now."
    );
    return;
  }

  const byStatus = await prisma.$queryRaw`
    SELECT "status" AS "label", count(*) AS "count"
    FROM "MarketingPost"
    WHERE "factsDigest" IS NULL
    GROUP BY "status"
    ORDER BY count(*) DESC
  `;
  table(
    "by status",
    byStatus.map((row) => [row.label, asNumber(row.count)])
  );

  const byMode = await prisma.$queryRaw`
    SELECT "mode" AS "label", count(*) AS "count"
    FROM "MarketingPost"
    WHERE "factsDigest" IS NULL
    GROUP BY "mode"
    ORDER BY count(*) DESC
  `;
  table(
    "by mode",
    byMode.map((row) => [row.label, asNumber(row.count)])
  );

  // How many accounts, not which: the number is what the disposition turns on,
  // and the identities are a question for the console, where the operator is
  // already authorised to look.
  const accounts = await prisma.$queryRaw`
    SELECT count(DISTINCT "channelId") AS "count"
    FROM "MarketingPost"
    WHERE "factsDigest" IS NULL
  `;
  console.log(`\nspread across ${asNumber(accounts[0]?.count)} brand account(s)`);

  const categories = await prisma.$queryRaw`
    SELECT
      count(*) FILTER (WHERE "status" IN (${Prisma.join(STILL_LIVE)})) AS "live",
      count(*) FILTER (WHERE "legalHold") AS "held",
      min("createdAt") AS "oldest",
      max("createdAt") AS "newest"
    FROM "MarketingPost"
    WHERE "factsDigest" IS NULL
  `;
  const summary = categories[0] ?? {};

  console.log(
    `\nstill live      ${pad(asNumber(summary.live), 7)}  (${STILL_LIVE.join(", ")})`
  );
  console.log(`under legal hold${pad(asNumber(summary.held), 7)}`);
  console.log(`oldest          ${summary.oldest?.toISOString() ?? "-"}`);
  console.log(`newest          ${summary.newest?.toISOString() ?? "-"}`);

  console.log(
    [
      "",
      "What this does not decide.",
      "",
      "  Backfilling means recomputing a digest for a decision that was made",
      "  without one. For a row that is still live, that digest would then be",
      "  compared against facts resolved today -- which is not what the row was",
      "  judged on. For a row that is history, it is a value nobody will read.",
      "",
      "  Deleting cannot be undone, and a row under legal hold must not be",
      "  deleted at all.",
      "",
      "  Waiting leaves the column nullable and S2b3 where it is.",
      "",
      "  The choice is the operator's, and the NOT NULL migration refuses to",
      "  run until it has been carried out -- not before.",
    ].join("\n")
  );
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
