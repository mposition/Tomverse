// How many marketing posts have no `factsDigest`, and what kind of rows they
// are.
//
// S2b3 adds `MarketingPost.factsDigest NOT NULL`, and the S2 plan says a
// non-zero count is a stop rather than an inferred decision: somebody has to
// choose what happens to those rows before the migration is written. This
// report exists so that choice is made against numbers rather than a guess,
// and so the same numbers can be read again afterwards.
//
// It writes nothing. There is no flag that makes it write, and it does not
// print a single row's contents -- not the rendered text, not the envelope,
// not the fact snapshot. What it prints is counts and the categories those
// counts fall into, which is what the disposition turns on.
//
// Requires DATABASE_URL. Run it once against staging and once against
// production; the answer may differ, and the migration has to be safe for
// both.

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

const main = async () => {
  if (!process.env.DATABASE_URL) {
    console.error(
      "DATABASE_URL is not set. This report reads a database and has nothing " +
        "to say without one."
    );
    process.exitCode = 1;
    return;
  }

  const total = await prisma.marketingPost.count();
  const missing = await prisma.marketingPost.count({
    where: { factsDigest: null },
  });

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

  const byStatus = await prisma.marketingPost.groupBy({
    by: ["status"],
    where: { factsDigest: null },
    _count: { _all: true },
  });
  table(
    "by status",
    byStatus
      .map((row) => [row.status, row._count._all])
      .sort((left, right) => right[1] - left[1])
  );

  const byMode = await prisma.marketingPost.groupBy({
    by: ["mode"],
    where: { factsDigest: null },
    _count: { _all: true },
  });
  table(
    "by mode",
    byMode
      .map((row) => [row.mode, row._count._all])
      .sort((left, right) => right[1] - left[1])
  );

  const byChannel = await prisma.marketingPost.groupBy({
    by: ["channelId"],
    where: { factsDigest: null },
    _count: { _all: true },
  });
  console.log(`\nspread across ${byChannel.length} brand account(s)`);

  const live = await prisma.marketingPost.count({
    where: { factsDigest: null, status: { in: STILL_LIVE } },
  });
  const held = await prisma.marketingPost.count({
    where: { factsDigest: null, legalHold: true },
  });
  const oldest = await prisma.marketingPost.findFirst({
    where: { factsDigest: null },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  const newest = await prisma.marketingPost.findFirst({
    where: { factsDigest: null },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });

  console.log(`\nstill live      ${pad(live, 7)}  (${STILL_LIVE.join(", ")})`);
  console.log(`under legal hold${pad(held, 7)}`);
  console.log(`oldest          ${oldest?.createdAt.toISOString() ?? "-"}`);
  console.log(`newest          ${newest?.createdAt.toISOString() ?? "-"}`);

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
      "  The choice is the operator's, and the NOT NULL migration is written",
      "  after it has been carried out -- not before.",
    ].join("\n")
  );
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
