// The sre-ops run guard against real migrations (docs/policy/sre-ops.md §3
// rule 8, §6 item 5, §10): a row is born with the database clock and a
// claimed deadline, keyed by its owner date; it never changes, is deleted only
// after 90 days and never truncated; and a transaction whose deadline has
// passed by COMMIT rolls back whole -- the other writes in it included.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = [
  "20261003060000_ops_observer_transaction_arm",
  "20261003070000_ops_observer_genesis_state",
  "20261003090000_ops_observer_delivery",
  "20261004030000_ops_observer_transition",
  "20261005030000_ops_observer_retention_deadline",
  "20261008020000_ops_observer_run_guard",
].map((name) => path.resolve(here, `../../prisma/migrations/${name}/migration.sql`));
const rawUrl = process.env.TEST_DATABASE_URL?.trim();
const schema = `ops_observer_run_guard_${randomUUID().replaceAll("-", "")}`;

test("the ops-observer run guard", { skip: !rawUrl }, async (t) => {
  const url = new URL(rawUrl!);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  assert.match(`${databaseName}_${url.searchParams.get("schema") || ""}`, /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i,
    "only a dedicated test database is accepted");

  const admin = new pg.Client({ connectionString: rawUrl });
  await admin.connect();
  const q = (sql: string, params?: unknown[]) => (params ? admin.query(sql, params) : admin.query(sql));
  const code = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? "thrown";
    }
  };
  const insert = (runId: string, deadline = "clock_timestamp() + interval '60 seconds'", kind = "daily_digest") =>
    q(`INSERT INTO "OpsObserverRunGuard" ("runId", kind, "runDeadlineAt", "invariantVersion") VALUES ($1, $2, ${deadline}, 0)`,
      [runId, kind]);

  try {
    await q(`CREATE SCHEMA "${schema}"`);
    await q(`SET search_path TO "${schema}"`);
    await q(`CREATE TABLE "AdminAuditLog" (id TEXT PRIMARY KEY, "createdAt" TIMESTAMP(3) NOT NULL)`);
    await q(`CREATE TABLE "AgentDigestItem" (id UUID PRIMARY KEY)`);
    for (const file of migrations) await q(await readFile(file, "utf8"));

    await t.test("a row is born with the database clock and its invariant, under its owner date's id", async () => {
      await insert("sre-ops:daily:2026-10-05");
      const { rows } = await q(`SELECT "startedAt" > clock_timestamp() - interval '5 seconds' AS fresh, "invariantVersion"
        FROM "OpsObserverRunGuard" WHERE "runId" = 'sre-ops:daily:2026-10-05'`);
      assert.deepEqual(rows, [{ fresh: true, invariantVersion: 1 }]);
      assert.equal(await code(() => insert("sre-ops:daily:2026-10-05")), "23505");
      assert.equal(await code(() => insert("sre-ops:daily:yesterday")), "23514");
      assert.equal(await code(() => insert("sre-ops:daily:2026-10-06", undefined, "retention_batch")), "23514");
      assert.equal(await code(() => insert("sre-ops:daily:2026-10-06", "clock_timestamp() + interval '600 seconds'")), "OB011");
      // A missing deadline is the claim's own refusal, before NOT NULL is reached.
      assert.equal(await code(() => insert("sre-ops:daily:2026-10-06", "NULL")), "OB010");
    });

    await t.test("a row never changes, stays 90 days and is never truncated", async () => {
      assert.equal(await code(() => q(`UPDATE "OpsObserverRunGuard" SET kind = 'daily_digest'`)), "OB081");
      assert.equal(await code(() => q(`DELETE FROM "OpsObserverRunGuard"`)), "OB080");
      assert.equal(await code(() => q(`TRUNCATE "OpsObserverRunGuard"`)), "OB080");
      await q(`ALTER TABLE "OpsObserverRunGuard" DISABLE TRIGGER USER`);
      try {
        await q(`UPDATE "OpsObserverRunGuard" SET "startedAt" = "startedAt" - interval '91 days'`);
      } finally {
        await q(`ALTER TABLE "OpsObserverRunGuard" ENABLE TRIGGER USER`);
      }
      assert.equal(await code(() => q(`DELETE FROM "OpsObserverRunGuard"`)), null);
    });

    await t.test("a transaction past its deadline at COMMIT rolls back whole, the other writes too", async () => {
      await q(`CREATE TABLE shared_write (id INT)`);
      await q("BEGIN");
      await q(`INSERT INTO shared_write VALUES (1)`);
      await insert("sre-ops:daily:2026-10-07", "clock_timestamp() + interval '300 milliseconds'");
      await q("SELECT pg_sleep(0.5)");
      assert.equal(await code(() => q("COMMIT")), "OB012");
      const { rows } = await q(`SELECT (SELECT count(*)::int FROM shared_write) AS shared,
        (SELECT count(*)::int FROM "OpsObserverRunGuard") AS guards`);
      assert.deepEqual(rows, [{ shared: 0, guards: 0 }]);
      // In time, both commit.
      await q("BEGIN");
      await q(`INSERT INTO shared_write VALUES (2)`);
      await insert("sre-ops:daily:2026-10-07");
      assert.equal(await code(() => q("COMMIT")), null);
    });
  } finally {
    await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await admin.end();
  }
});
