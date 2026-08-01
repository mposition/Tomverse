import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// scripts/run-db-integration-tests.mjs builds the test database with
// `prisma db push`, which materialises schema.prisma and nothing else. Objects
// Prisma's schema language cannot express therefore never reach the test
// database unless prisma/test-database-extras.sql mirrors them.
//
// That gap is not theoretical: PlanChangeRequest's partial unique index
// ("one in-flight change per account") existed only in migration SQL, so the
// integration test asserting the database refuses a second pending
// reservation failed against a database that had no such constraint. This
// keeps the mirror honest -- a new partial unique index in a migration fails
// here until it is added to the extras file.

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "prisma", "migrations");
const EXTRAS_PATH = join(
  import.meta.dirname,
  "..",
  "prisma",
  "test-database-extras.sql"
);

const extras = readFileSync(EXTRAS_PATH, "utf8");

const migrationSql = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(MIGRATIONS_DIR, entry.name, "migration.sql"))
  .flatMap((path) => {
    try {
      return [{ path, sql: readFileSync(path, "utf8") }];
    } catch {
      return [];
    }
  });

/**
 * Partial indexes -- `CREATE ... INDEX ... WHERE ...` -- are the class Prisma
 * cannot declare.
 *
 * Parsed one statement at a time. A regex spanning `[\s\S]*?` across the whole
 * file matches from a plain `CREATE INDEX` into the `WHERE` of a *later*
 * statement, which reported two ordinary indexes as partial. Comments are
 * stripped first so prose in a `--` line cannot look like SQL.
 */
const partialIndexNames = (sql) =>
  sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .filter((statement) => /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(statement))
    .filter((statement) => /\bWHERE\b/i.test(statement))
    .flatMap((statement) => {
      const name = /\bINDEX\b\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/i.exec(
        statement
      );
      return name ? [name[1]] : [];
    });

test("the migrations directory is actually being read", () => {
  assert.ok(
    migrationSql.length > 0,
    "no migration.sql files found -- this suite would pass vacuously"
  );
});

test("every partial index in a migration is mirrored for the test database", () => {
  const missing = [];
  for (const { path, sql } of migrationSql) {
    for (const indexName of partialIndexNames(sql)) {
      if (!extras.includes(`"${indexName}"`)) {
        missing.push(`${indexName} (${path})`);
      }
    }
  }

  assert.deepEqual(
    missing,
    [],
    `prisma db push cannot create these, so prisma/test-database-extras.sql must declare them:\n  ${missing.join("\n  ")}`
  );
});

test("the extras file stays idempotent, so a re-run cannot fail on a warm database", () => {
  const creates = [...extras.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX([\s\S]*?);/gi)];
  assert.ok(creates.length > 0, "expected at least one object to be declared");
  for (const [, body] of creates) {
    assert.match(
      body,
      /IF NOT EXISTS/i,
      "every statement must tolerate being applied twice"
    );
  }
});

test("the plan-change reservation constraint specifically is covered", () => {
  // The one this file was written for: the integration suite asserts the
  // database itself refuses a second pending reservation.
  assert.match(extras, /"PlanChangeRequest_userId_active_key"/);
  assert.match(extras, /WHERE\s+"status"\s*=\s*'pending'/i);
});
