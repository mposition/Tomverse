import assert from "node:assert/strict";
import test from "node:test";
import {
  collectPartialUniqueIndexes,
  findPartialUniqueIndexes,
} from "../scripts/apply-test-db-partial-indexes.mjs";

// The DB integration suite builds its database with `prisma db push`, which
// only reproduces what schema.prisma can express. Constraints that live in
// migration SQL are invisible to it, so a test asserting one exists would pass
// against a database that never had it. This is the extraction that closes that
// gap; if it stops finding a partial unique index, the guarantee stops being
// tested without anything going red.

test("the migrations' partial unique indexes are found", () => {
  const statements = collectPartialUniqueIndexes("prisma/migrations");
  assert.ok(
    statements.length >= 1,
    "no partial unique index was found in the migrations"
  );
  // The one that matters today: one in-flight plan change per account. Two
  // racing confirms would otherwise each book a competing change against the
  // same subscription.
  assert.ok(
    statements.some(
      (statement) =>
        /PlanChangeRequest_userId_active_key/.test(statement) &&
        /WHERE\s+"status"\s*=\s*'pending'/.test(statement)
    ),
    `PlanChangeRequest's partial unique index is missing from:\n${statements.join("\n")}`
  );
  for (const statement of statements) {
    assert.match(statement, /^CREATE UNIQUE INDEX IF NOT EXISTS /);
  }
});

test("a multi-line partial index is captured whole", () => {
  const statements = findPartialUniqueIndexes(`
    CREATE TABLE "Thing" ("id" TEXT NOT NULL);
    CREATE UNIQUE INDEX "Thing_owner_active_key"
        ON "Thing"("ownerId")
        WHERE "status" = 'pending';
  `);
  assert.equal(statements.length, 1);
  assert.match(statements[0], /ON "Thing"\("ownerId"\)/);
  assert.match(statements[0], /WHERE "status" = 'pending';$/);
});

test("full indexes and ordinary indexes are left to db push", () => {
  // schema.prisma already expresses these, so re-applying them would only
  // create a second copy under a different name.
  assert.deepEqual(
    findPartialUniqueIndexes(`
      CREATE UNIQUE INDEX "Thing_slug_key" ON "Thing"("slug");
      CREATE INDEX "Thing_owner_idx" ON "Thing"("ownerId") WHERE "status" = 'x';
    `),
    []
  );
});

test("an existing IF NOT EXISTS is not doubled", () => {
  const statements = findPartialUniqueIndexes(
    `CREATE UNIQUE INDEX IF NOT EXISTS "Thing_key" ON "Thing"("a") WHERE "b" = 'c';`
  );
  assert.equal(statements.length, 1);
  assert.equal(
    statements[0].match(/IF NOT EXISTS/g).length,
    1,
    "IF NOT EXISTS was inserted twice"
  );
});

test("a migrations directory with nothing partial yields nothing", () => {
  assert.deepEqual(findPartialUniqueIndexes("ALTER TABLE \"Thing\" ADD COLUMN \"x\" TEXT;"), []);
});
