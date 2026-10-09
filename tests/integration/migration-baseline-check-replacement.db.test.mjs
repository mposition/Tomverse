import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";

import pg from "pg";

const ROOT = resolve(import.meta.dirname, "../..");
const MIGRATION = "20261008130000_amux_v4_claim_owner_resolution";
const MIGRATIONS = join(ROOT, "prisma/migrations");
const sqlOf = (name) => readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8");
const testUrl = process.env.TEST_DATABASE_URL?.trim();
const url = testUrl ? new URL(testUrl) : null;

// This suite creates and removes its own random database, never the runner's
// database or any configured product target. CI's PostgreSQL role has CREATEDB.
if (!url || !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(url.pathname.slice(1)) ||
    url.search !== "" || url.hash !== "") {
  throw new Error("REFUSE: migration upgrade test requires a dedicated loopback test database");
}

const CHECK_QUERY = `SELECT t.relname AS "table", c.conname AS "constraint",
  pg_catalog.pg_get_constraintdef(c.oid, false) AS definition
  FROM pg_catalog.pg_constraint c
  JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND c.contype = 'c'
    AND ((t.relname = 'AmuxIdeaAnalysisBudgetHold' AND c.conname IN
      ('AmuxIdeaAnalysisBudgetHold_status_check', 'AmuxIdeaAnalysisBudgetHold_lifecycle_check'))
    OR (t.relname = 'AmuxIdeaTransferPreview' AND c.conname IN
      ('AmuxIdeaTransferPreview_state_check', 'AmuxIdeaTransferPreview_state_confirm_check')))
  ORDER BY t.relname, c.conname`;
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

test("CHECK-only upgrade uses the real db:migrate path and refuses ambiguous existing state", {
  timeout: 180_000,
}, async (t) => {
  const databaseName = `baseline_${randomUUID().replaceAll("-", "")}_test`;
  assert.match(databaseName, /^baseline_[a-f0-9]{32}_test$/);
  const ownUrl = new URL(url);
  ownUrl.pathname = `/${databaseName}`;
  const fixture = mkdtempSync(join(tmpdir(), "tomverse-check-baseline-test-"));
  const admin = new pg.Client({ connectionString: testUrl });
  let client;
  let created = false;
  const run = (args) => spawnSync(process.execPath, args, {
    cwd: fixture,
    env: { ...process.env, DATABASE_URL: ownUrl.href, DIRECT_DATABASE_URL: ownUrl.href },
    encoding: "utf8", timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
  });
  const output = (result) => `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const assertOk = (result) => assert.equal(result.status, 0,
    result.error?.message ?? output(result));
  const readChecks = async () => (await client.query(CHECK_QUERY)).rows;
  const readHistory = async () => (await client.query(
    "SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name",
  )).rows;
  const npmCli = process.env.npm_execpath ??
    join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  const migrate = () => run([npmCli, "run", "db:migrate"]);
  const expectRefusedWithoutWrites = async () => {
    const history = await readHistory();
    const checks = await readChecks();
    const result = migrate();
    assert.equal(result.status, 1, output(result));
    assert.match(output(result), /notProvenAbsent/);
    assert.deepEqual(await readHistory(), history, "refusal must not poison migration history");
    assert.deepEqual(await readChecks(), checks, "refusal must not alter constraints");
  };
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    for (const name of ["package.json", "prisma.config.ts", "prisma", "scripts"]) {
      cpSync(join(ROOT, name), join(fixture, name), {
        recursive: true,
        filter: (path) => basename(path) !== MIGRATION,
      });
    }
    symlinkSync(join(ROOT, "node_modules"), join(fixture, "node_modules"),
      process.platform === "win32" ? "junction" : "dir");
    // Build the exact existing prefix, not a fresh final schema plus edited
    // history. The target is the only omitted migration; Prisma records all
    // other migration checksums from their original SQL bytes.
    assertOk(run(["node_modules/prisma/build/index.js", "migrate", "deploy"]));
    client = new pg.Client({ connectionString: ownUrl.href });
    await client.connect();
    const originalHistory = await readHistory();
    const migrationCount = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).length;
    assert.equal(originalHistory.length, migrationCount - 1);
    assert.equal(originalHistory.some((row) => row.migration_name === MIGRATION), false);
    const priorChecks = await readChecks();
    assert.equal(priorChecks.length, 4);
    const declaration = JSON.parse(readFileSync(join(MIGRATIONS, MIGRATION, "baseline-check.json"), "utf8"));
    assert.deepEqual(priorChecks.map(({ table, constraint, definition }) => ({
      table, constraint, previousDefinitionSha256: sha256(definition),
    })), [...declaration.replacedChecks].sort((a, b) =>
      a.table.localeCompare(b.table) || a.constraint.localeCompare(b.constraint)));
    cpSync(join(MIGRATIONS, MIGRATION), join(fixture, "prisma/migrations", MIGRATION), { recursive: true });
    // Prove the production guard's ambiguous branch is exercised: all visible
    // schema objects already match before the pending CHECK migration runs.
    assertOk(run(["node_modules/prisma/build/index.js", "migrate", "diff",
      "--from-schema", "prisma/schema.prisma", "--to-config-datasource", "prisma.config.ts", "--exit-code"]));

    await t.test("exact prior CHECK definitions allow the pending migration, then a second deploy is a no-op", async () => {
      assertOk(migrate());
      const history = await readHistory();
      assert.equal(history.length, migrationCount);
      const target = history.filter((row) => row.migration_name === MIGRATION);
      assert.equal(target.length, 1);
      assert.ok(target[0].finished_at);
      assert.equal(target[0].rolled_back_at, null);
      assert.equal(target[0].checksum, sha256(sqlOf(MIGRATION)));
      assert.deepEqual(history.filter((row) => row.migration_name !== MIGRATION), originalHistory);
      const updated = await readChecks();
      assert.equal(updated.length, 4);
      assert.notDeepEqual(updated, priorChecks);
      assert.ok(updated.find((row) => row.constraint.endsWith("_status_check"))
        .definition.includes("owner_released_unstarted"));
      assert.ok(updated.find((row) => row.constraint === "AmuxIdeaTransferPreview_state_check")
        .definition.includes("owner_resolved"));
      assertOk(migrate());
      assert.deepEqual(await readHistory(), history);
      assert.deepEqual(await readChecks(), updated);
    });

    // Restore the real prior constraints and remove only the row this test
    // inserted, modeling the ambiguous catalog states on an isolated DB.
    const restorePrior = async () => {
      for (const row of priorChecks) {
        assert.match(row.table, /^AmuxIdea[A-Za-z]+$/);
        assert.match(row.constraint, /^AmuxIdea[A-Za-z]+_[a-z_]+_check$/);
        await client.query(`ALTER TABLE "${row.table}" DROP CONSTRAINT IF EXISTS "${row.constraint}",
          ADD CONSTRAINT "${row.constraint}" ${row.definition}`);
      }
      await client.query("DELETE FROM _prisma_migrations WHERE migration_name = $1", [MIGRATION]);
    };
    await t.test("already-new constraints with missing history are refused rather than marked applied", async () => {
      await client.query("DELETE FROM _prisma_migrations WHERE migration_name = $1", [MIGRATION]);
      await expectRefusedWithoutWrites();
    });
    await t.test("a partially updated set is refused", async () => {
      await restorePrior();
      await client.query(`ALTER TABLE "AmuxIdeaTransferPreview"
        DROP CONSTRAINT "AmuxIdeaTransferPreview_state_check",
        ADD CONSTRAINT "AmuxIdeaTransferPreview_state_check" CHECK (true)`);
      await expectRefusedWithoutWrites();
    });
    await t.test("an absent CHECK is refused", async () => {
      await restorePrior();
      await client.query(`ALTER TABLE "AmuxIdeaTransferPreview"
        DROP CONSTRAINT "AmuxIdeaTransferPreview_state_check"`);
      await expectRefusedWithoutWrites();
    });
  } finally {
    await client?.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin.end();
    rmSync(fixture, { recursive: true, force: true });
  }
});
