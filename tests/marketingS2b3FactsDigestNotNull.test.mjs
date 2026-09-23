// The migration that stops a marketing post existing without its facts digest.
//
// Contract: the S2 plan's "S2b3 — factsDigest migration". The column arrived
// nullable because an expand migration cannot write a value for rows that are
// already there. Every writer since sets it from the sealed decision, so the
// nullability is for rows that predate the column and for nothing else.
//
// What is checked here is what can be read from the tree: that the migration
// counts before it alters, that the count's failure is a stop rather than a
// warning, that the schema and the migration agree, and that the report the
// plan names is reachable and writes nothing. Whether the count is zero in a
// given database is not a property of this repository, which is exactly why
// the migration asks again at apply time.

import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";

const MIGRATION = readFileSync(
  new URL(
    "../prisma/migrations/20260923140000_marketing_post_facts_digest_not_null/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

const SCHEMA = readFileSync(
  new URL("../prisma/schema.prisma", import.meta.url),
  "utf8",
);

const REPORT = readFileSync(
  new URL("../scripts/report-marketing-facts-digest-nulls.mjs", import.meta.url),
  "utf8",
);

const PACKAGE = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

test("the migration counts the rows it would break before it breaks them", () => {
  const count = MIGRATION.indexOf('FROM "MarketingPost"');
  const alter = MIGRATION.indexOf("ALTER COLUMN \"factsDigest\" SET NOT NULL");
  assert.ok(count > 0, "the migration does not count anything");
  assert.ok(alter > 0, "the migration does not set the column NOT NULL");
  assert.ok(
    count < alter,
    "the count has to happen first, or it is a post-mortem rather than a guard",
  );
  assert.match(MIGRATION, /WHERE "factsDigest" IS NULL/);
});

test("a non-zero count raises rather than warns", () => {
  // `RAISE NOTICE` would let the migration go on to alter a column it has just
  // established it cannot alter, and the `ALTER` would fail with a message
  // about a constraint rather than about the rows. The plan calls a non-zero
  // count a stop; this is the line that makes it one.
  assert.match(MIGRATION, /IF missing > 0 THEN/);
  assert.match(MIGRATION, /RAISE EXCEPTION/);
  assert.doesNotMatch(
    MIGRATION,
    /RAISE (NOTICE|WARNING)/,
    "a warning is not a stop",
  );
  // The number is in the message, because "some rows" sends an operator back
  // to the database to ask the question the migration just asked.
  assert.match(MIGRATION, /% row\(s\) with no factsDigest/);
  // And it names the report rather than leaving the next step to be guessed.
  assert.match(MIGRATION, /npm run report:marketing-facts-digest/);
});

test("the migration does not decide the disposition for anybody", () => {
  // No backfill, no delete, no default. A row with no digest is a Guard
  // decision nobody can reconstruct, and inventing one here would be writing a
  // decision rather than recording one.
  assert.doesNotMatch(MIGRATION, /\bUPDATE\s+"MarketingPost"/i);
  assert.doesNotMatch(MIGRATION, /\bDELETE\s+FROM/i);
  assert.doesNotMatch(MIGRATION, /SET DEFAULT/i);
});

test("the schema says the same thing as the migration", () => {
  const field = SCHEMA.split("\n").find((line) =>
    line.trim().startsWith("factsDigest"),
  );
  assert.ok(field, "factsDigest is not in the schema");
  assert.doesNotMatch(
    field,
    /String\?/,
    "the schema still has it nullable, so `db:compare-schema` would report drift",
  );
  assert.match(field, /String\b/);
});

test("the report is reachable by the name the plan and the migration use", () => {
  assert.equal(
    PACKAGE.scripts["report:marketing-facts-digest"],
    "node --conditions=react-server --import tsx scripts/report-marketing-facts-digest-nulls.mjs",
  );
});

test("the report reads and never writes", () => {
  // The plan says to present the counts to the operator and not to backfill,
  // delete or waive anything. A report with a flag that writes is a report
  // somebody will run with the flag.
  for (const verb of [
    "prisma.marketingPost.update",
    "prisma.marketingPost.delete",
    "prisma.marketingPost.create",
    "updateMany",
    "deleteMany",
    "$executeRaw",
  ]) {
    assert.ok(
      !REPORT.includes(verb),
      `the report must not be able to ${verb}`,
    );
  }
  // And it prints categories, not contents: no envelope, no rendered text, no
  // fact snapshot reaches the terminal.
  for (const column of ["renderedText", "envelope", "factSnapshot"]) {
    assert.ok(
      !REPORT.includes(`console.log(${column}`),
      `the report must not print ${column}`,
    );
  }
});
