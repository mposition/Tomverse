// Every baseline-check sidecar's prior CHECK digest, against a real database.
//
// `previousDefinitionSha256` is the SHA-256 of what `pg_get_constraintdef`
// returns for the constraint **before** its replacement migration runs. That
// string is PostgreSQL's own deparse of the expression, not the SQL anybody
// wrote, so it cannot be derived by reading the migration -- and a digest taken
// from a different PostgreSQL than the one that will answer is a digest that
// may not match.
//
// A mismatch is fail-closed: `checkReplacementAnswer` reports anything but the
// exact prior definition as not-present, and the baseline guard stays blocked.
// So the cost of a wrong value is a refused deploy during a restore, which is
// precisely the moment nobody wants to be debugging a digest. This asks the
// database instead.
//
// Every sidecar in the tree, not one: the next person to add one should not
// have to remember to add its verification too.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import pg from "pg";

const ROOT = resolve(import.meta.dirname, "../..");
const MIGRATIONS = join(ROOT, "prisma/migrations");

const testUrl = process.env.TEST_DATABASE_URL?.trim();
const url = testUrl ? new URL(testUrl) : null;

// Creates and drops its own random database, never the runner's and never any
// configured product target.
if (
  !url ||
  !["postgres:", "postgresql:"].includes(url.protocol) ||
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
  !/(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(url.pathname.slice(1)) ||
  url.search !== "" ||
  url.hash !== ""
) {
  throw new Error("REFUSE: this test requires a dedicated loopback test database");
}

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

const migrationNames = () =>
  readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

/** Every migration carrying a sidecar, with it parsed. */
const sidecars = () =>
  migrationNames()
    .map((name) => ({ name, path: join(MIGRATIONS, name, "baseline-check.json") }))
    .filter((entry) => existsSync(entry.path))
    .map((entry) => ({ ...entry, declared: JSON.parse(readFileSync(entry.path, "utf8")) }));

const DEFINITION_QUERY = `SELECT pg_catalog.pg_get_constraintdef(c.oid, false) AS definition
  FROM pg_catalog.pg_constraint c
  JOIN pg_catalog.pg_class r ON r.oid = c.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
  WHERE n.nspname = 'public' AND r.relname = $1 AND c.conname = $2 AND c.contype = 'c'`;

test("every sidecar pins the prior CHECK definition this database actually renders", async (t) => {
  const entries = sidecars();
  assert.ok(entries.length > 0, "no baseline-check.json in the tree, so nothing was verified");

  const admin = new pg.Client({ connectionString: testUrl });
  await admin.connect();
  const scratch = `baseline_sidecar_test_${Date.now().toString(36)}`;
  await admin.query(`CREATE DATABASE "${scratch}"`);
  const scratchUrl = new URL(testUrl);
  scratchUrl.pathname = `/${scratch}`;
  const client = new pg.Client({ connectionString: scratchUrl.toString() });

  try {
    await client.connect();
    // One pass in migration order. Each sidecar is verified immediately
    // before its own migration runs, which is the only moment the definition
    // it pins is the one in the database.
    const bySidecar = new Map(entries.map((entry) => [entry.name, entry]));
    for (const name of migrationNames()) {
      const entry = bySidecar.get(name);
      if (entry) {
        for (const check of entry.declared.replacedChecks) {
          const { rows } = await client.query(DEFINITION_QUERY, [check.table, check.constraint]);
          assert.equal(
            rows.length,
            1,
            `${name}: ${check.table}.${check.constraint} is not in the database before its replacement`,
          );
          assert.equal(
            sha256(rows[0].definition),
            check.previousDefinitionSha256,
            `${name}: ${check.table}.${check.constraint} renders here as ${JSON.stringify(rows[0].definition)}`,
          );
        }
      }
      await client.query(readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8"));
    }
    t.diagnostic(`verified ${entries.length} sidecar(s)`);
  } finally {
    await client.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
});
