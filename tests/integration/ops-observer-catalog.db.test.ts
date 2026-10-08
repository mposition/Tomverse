// T3a against the real migrations (docs/policy/sre-ops.md §3-7, §6): the
// catalogue they produce is exactly the expected one, and dropping a guard,
// making a constraint deferrable or making a deadline check immediate is seen.
// The migrations are applied to a throwaway schema.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import pg from "pg";

import {
  OPS_OBSERVER_OWN_TABLES,
  OPS_OBSERVER_SHARED_TABLES,
  catalogProblems,
} from "../../scripts/ops-observer/catalog-core.mjs";

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
const schema = `ops_observer_catalog_${randomUUID().replaceAll("-", "")}`;

let client: pg.Client;
// Without parameters the text goes over the simple protocol, which is what
// runs a whole multi-statement migration file in one call.
const q = (sql: string, params?: unknown[]) => (params ? client.query(sql, params) : client.query(sql));

async function readCatalogue() {
  const tables = [...OPS_OBSERVER_OWN_TABLES, ...OPS_OBSERVER_SHARED_TABLES];
  const triggers = await q(
    `SELECT c.relname AS "table", n.nspname AS "tableSchema", t.tgname AS name, t.tgenabled AS enabled,
            p.proname AS "functionName", pn.nspname AS "functionSchema",
            t.tgdeferrable AS deferrable, t.tginitdeferred AS "initiallyDeferred"
       FROM pg_catalog.pg_trigger t
       JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
       JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
       JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = ANY($2) AND NOT t.tgisinternal`,
    [schema, tables],
  );
  const constraints = await q(
    `SELECT c.relname AS "table", k.conname AS name, k.contype AS type, k.condeferrable AS deferrable,
            k.condeferred AS "initiallyDeferred"
       FROM pg_catalog.pg_constraint k
       JOIN pg_catalog.pg_class c ON c.oid = k.conrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = ANY($2)`,
    [schema, tables],
  );
  const indexes = await q(
    `SELECT tablename AS "table", indexname AS name FROM pg_catalog.pg_indexes
      WHERE schemaname = $1 AND tablename = ANY($2::text[])`,
    [schema, OPS_OBSERVER_OWN_TABLES],
  );
  return { triggers: triggers.rows, constraints: constraints.rows, indexes: indexes.rows };
}

test("the ops-observer catalogue", { skip: !rawUrl }, async (t) => {
  const url = new URL(rawUrl!);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  assert.match(`${databaseName}_${url.searchParams.get("schema") || ""}`, /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i,
    "only a dedicated test database is accepted");
  client = new pg.Client({ connectionString: rawUrl });
  await client.connect();
  try {
    await q(`CREATE SCHEMA "${schema}"`);
    await q(`SET search_path TO "${schema}"`);
    await q(`CREATE TABLE "AdminAuditLog" (id TEXT PRIMARY KEY, action TEXT NOT NULL, "targetType" TEXT NOT NULL,
               "targetId" TEXT, "entryHash" TEXT UNIQUE)`);
    await q(`CREATE TABLE "AgentDigestItem" (id UUID PRIMARY KEY)`);
    for (const file of migrations) await q(await readFile(file, "utf8"));

    await t.test("the migrations produce exactly the expected catalogue", async () => {
      assert.deepEqual(catalogProblems(await readCatalogue()), []);
    });

    // Each change is made in a transaction that is rolled back, so the next starts clean.
    const seen = async (change: string, pattern: RegExp) => {
      await q("BEGIN");
      try {
        await q(change);
        const problems = catalogProblems(await readCatalogue());
        assert.ok(problems.some((p) => pattern.test(p)), `${change}: ${problems.join("; ")}`);
      } finally {
        await q("ROLLBACK");
      }
    };

    await t.test("a dropped guard, a deferred rule or an immediate deadline check is seen", async () => {
      await seen(`DROP TRIGGER "OpsObserverTransition_guard" ON "OpsObserverTransition"`, /missing OpsObserverTransition_guard/);
      await seen(`ALTER TABLE "OpsObserverState" DROP CONSTRAINT "OpsObserverState_checkpoint_check"`, /missing OpsObserverState_checkpoint_check/);
      await seen(`DROP INDEX "OpsObserverDelivery_genesisId_ownerDate_idx"`, /missing OpsObserverDelivery_genesisId_ownerDate_idx/);
      await seen(`ALTER TABLE "OpsObserverTransition" ALTER CONSTRAINT "OpsObserverTransition_genesisId_fkey" DEFERRABLE INITIALLY DEFERRED`,
        /OpsObserverTransition_genesisId_fkey deferral/);
      await seen(`DROP TRIGGER ops_observer_state_deadline_check ON "OpsObserverState";
                  CREATE CONSTRAINT TRIGGER ops_observer_state_deadline_check AFTER INSERT OR UPDATE ON "OpsObserverState"
                    NOT DEFERRABLE FOR EACH ROW EXECUTE FUNCTION ops_observer_deadline_check()`,
        /ops_observer_state_deadline_check deferral/);
      await seen(`ALTER TABLE "OpsObserverState" DISABLE TRIGGER "OpsObserverState_guard"`,
        /OpsObserverState_guard is not enabled/);
      await seen(`CREATE FUNCTION ops_observer_noop() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
                  DROP TRIGGER "OpsObserverTransition_guard" ON "OpsObserverTransition";
                  CREATE TRIGGER "OpsObserverTransition_guard" BEFORE INSERT OR UPDATE OR DELETE ON "OpsObserverTransition"
                    FOR EACH ROW EXECUTE FUNCTION ops_observer_noop()`,
        /OpsObserverTransition_guard runs ops_observer_noop/);
      // The same function name in another schema is a different function.
      await seen(`CREATE SCHEMA "${schema}_shadow";
                  CREATE FUNCTION "${schema}_shadow".ops_observer_transition_guard() RETURNS trigger LANGUAGE plpgsql
                    AS 'BEGIN RETURN NEW; END';
                  DROP TRIGGER "OpsObserverTransition_guard" ON "OpsObserverTransition";
                  CREATE TRIGGER "OpsObserverTransition_guard" BEFORE INSERT OR UPDATE OR DELETE ON "OpsObserverTransition"
                    FOR EACH ROW EXECUTE FUNCTION "${schema}_shadow".ops_observer_transition_guard()`,
        /OpsObserverTransition_guard runs a function outside its table's schema/);
      await seen(`CREATE TRIGGER late_addition BEFORE INSERT ON "OpsObserverGenesis" FOR EACH ROW EXECUTE FUNCTION ops_observer_genesis_guard()`,
        /unexpected late_addition/);
      await seen(`ALTER TABLE "AgentDigestItem" ADD CONSTRAINT digest_self_fkey FOREIGN KEY (id) REFERENCES "AgentDigestItem"(id) DEFERRABLE`,
        /deferrable on a shared table/);
    });
  } finally {
    await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await client.end();
  }
});
