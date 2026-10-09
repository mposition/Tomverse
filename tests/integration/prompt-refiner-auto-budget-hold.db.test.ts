import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import pg from "pg";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const rawUrl = process.env.TEST_DATABASE_URL?.trim();
const migration = resolve(root, "prisma/migrations/20261009044000_prompt_refiner_auto_budget_hold/migration.sql");

test("product Auto budget holds are atomic and use separate durable windows",
  { skip: !rawUrl }, async () => {
    if (!rawUrl) return;
    const url = new URL(rawUrl);
    assert.ok(url.protocol === "postgres:" || url.protocol === "postgresql:");
    const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
    const schemaName = url.searchParams.get("schema") || "";
    assert.match(`${databaseName}_${schemaName}`,
      /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i,
      "only a dedicated test database is accepted");
    const schema = `chat01_auto_budget_${randomUUID().replaceAll("-", "")}`;
    const client = new pg.Client({ connectionString: rawUrl });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`CREATE TABLE "AdminAuditLog" ("id" TEXT PRIMARY KEY)`);
      await client.query(await readFile(migration, "utf8"));
      await client.query(`TRUNCATE "AdminAuditLog" CASCADE`);
      await assert.rejects(client.query(`INSERT INTO "PromptRefinerAutoBudgetWindow"
        ("period", "periodStart", "committedMicroUsd", "updatedAt")
        VALUES ('brisbane_day', '2020-01-01T00:00:00Z', 100000001, now())`),
      /PromptRefinerAutoBudgetWindow_amount_check/);
      const query = async (strings: TemplateStringsArray, values: unknown[]) => {
        const sql = strings.reduce((result, part, index) => result + part +
          (index < values.length ? `$${index + 1}` : ""), "");
        return client.query(sql, values);
      };
      const tx = {
        $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
          (await query(strings, values)).rows,
        $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
          (await query(strings, values)).rowCount ?? 0,
      };
      mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
        $transaction: async (work: (transaction: typeof tx) => Promise<unknown>) => {
          await client.query("BEGIN");
          try {
            const result = await work(tx);
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        },
      } } });
      let auditSequence = 0;
      mock.module(mod("lib/adminAudit.ts"), { namedExports: {
        writeSystemAuditLog: async (input: { tx: typeof tx; systemActor: string }) => {
          assert.equal(input.tx, tx);
          assert.equal(input.systemActor, "prompt-refiner-auto-budget");
          const id = `audit-${++auditSequence}`;
          await client.query(`INSERT INTO "AdminAuditLog"("id") VALUES ($1)`, [id]);
          return id;
        },
      } });
      const budget = await import(mod("lib/promptRefinerAutoBudgetHold.ts"));
      const binding = (requestKey: string) => ({
        requestKey,
        candidateDigest: "a".repeat(64), pricePinDigest: "b".repeat(64),
        runtimeDeploymentId: "11111111-1111-4111-8111-111111111111",
      });
      const first = await budget.reservePromptRefinerAutoBudget(binding("00000000-0000-4000-8000-000000000001") as never);
      assert.equal(first.dispatchAuthorized, false);
      const windows = await client.query(`SELECT "period", "committedMicroUsd"::text AS cost
        FROM "PromptRefinerAutoBudgetWindow" ORDER BY "period"`);
      assert.deepEqual(windows.rows.map((row) => [row.period, row.cost]), [
        ["brisbane_day", "29918"], ["brisbane_month", "29918"],
      ]);
      assert.equal((await client.query(`SELECT count(*)::integer AS count
        FROM "PromptRefinerAutoBudgetHold"`)).rows[0].count, 1);
      await assert.rejects(client.query(`DELETE FROM "PromptRefinerAutoBudgetHold"`),
        /prompt_refiner_auto_budget_delete_forbidden/);
      await assert.rejects(client.query(`TRUNCATE "PromptRefinerAutoBudgetWindow"`),
        /prompt_refiner_auto_budget_delete_forbidden/);
      await assert.rejects(client.query(`UPDATE "PromptRefinerAutoBudgetHold"
        SET "status" = 'unknown'`), /prompt_refiner_auto_budget_hold_immutable/);
      await assert.rejects(client.query(`UPDATE "PromptRefinerAutoBudgetWindow"
        SET "committedMicroUsd" = 0`),
      /prompt_refiner_auto_budget_window_update_invalid/);
      await assert.rejects(budget.reservePromptRefinerAutoBudget(
        binding("00000000-0000-4000-8000-000000000001") as never), /duplicate key/);
      assert.equal((await client.query(`SELECT sum("committedMicroUsd")::text AS cost
        FROM "PromptRefinerAutoBudgetWindow"`)).rows[0].cost, "59836");

      // Synthetic cap fixture only: the production update guard is restored
      // before the function under test attempts a second reservation.
      await client.query(`ALTER TABLE "PromptRefinerAutoBudgetWindow"
        DISABLE TRIGGER "PromptRefinerAutoBudgetWindow_update_guard"`);
      await client.query(`UPDATE "PromptRefinerAutoBudgetWindow"
        SET "committedMicroUsd" = 3000000000
        WHERE "period" = 'brisbane_month'`);
      await client.query(`ALTER TABLE "PromptRefinerAutoBudgetWindow"
        ENABLE TRIGGER "PromptRefinerAutoBudgetWindow_update_guard"`);
      await assert.rejects(budget.reservePromptRefinerAutoBudget(
        binding("00000000-0000-4000-8000-000000000002") as never), /budget_exhausted/);
      const after = await client.query(`SELECT "period", "committedMicroUsd"::text AS cost
        FROM "PromptRefinerAutoBudgetWindow" ORDER BY "period"`);
      assert.deepEqual(after.rows.map((row) => [row.period, row.cost]), [
        ["brisbane_day", "29918"], ["brisbane_month", "3000000000"],
      ]);
      assert.equal((await client.query(`SELECT count(*)::integer AS count
        FROM "PromptRefinerAutoBudgetHold"`)).rows[0].count, 1);
      assert.equal((await client.query(`SELECT count(*)::integer AS count
        FROM "AdminAuditLog"`)).rows[0].count, 1);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  });
