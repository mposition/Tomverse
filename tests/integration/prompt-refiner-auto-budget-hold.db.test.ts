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
const baseMigration = resolve(root,
  "prisma/migrations/20261009044000_prompt_refiner_auto_budget_hold/migration.sql");
const transitionMigration = resolve(root,
  "prisma/migrations/20261010110000_prompt_refiner_auto_budget_settlement/migration.sql");
const key = (ordinal: number) =>
  `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
const candidateDigest = "a".repeat(64);
const pricePinDigest = "b".repeat(64);
const adapterConfigDigest = "c".repeat(64);
const runtimeDeploymentId = "11111111-1111-4111-8111-111111111111";

test("product Auto budget transitions preserve exact audited Brisbane windows",
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
      await client.query(await readFile(baseMigration, "utf8"));
      await client.query(await readFile(transitionMigration, "utf8"));
      const settlementCap = await client.query(`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = '"PromptRefinerAutoBudgetHold"'::regclass
          AND conname = 'PromptRefinerAutoBudgetHold_amount_check'`);
      assert.equal(settlementCap.rowCount, 1);
      const settlementCapDefinition = settlementCap.rows[0].definition as string;
      assert.match(settlementCapDefinition, /"reservedMicroUsd" >= 1/);
      assert.match(settlementCapDefinition, /"reservedMicroUsd" <= 29918/);
      assert.match(settlementCapDefinition, /"settledMicroUsd" IS NULL/);
      assert.match(settlementCapDefinition, /"settledMicroUsd" >= 0/);
      assert.match(settlementCapDefinition,
        /"settledMicroUsd" <= "reservedMicroUsd"/);

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
        takeAuditChainLock: async (input: unknown) => assert.equal(input, tx),
        writeSystemAuditLog: async (input: {
          tx: typeof tx; systemActor: string; action: string;
        }) => {
          assert.equal(input.tx, tx);
          assert.equal(input.systemActor, "prompt-refiner-auto-budget");
          const id = `audit-${++auditSequence}-${input.action}`;
          await client.query(`INSERT INTO "AdminAuditLog"("id") VALUES ($1)`, [id]);
          return id;
        },
      } });

      const budget = await import(mod("lib/promptRefinerAutoBudgetHold.ts"));
      const reserve = (requestKey: string) => budget.reservePromptRefinerAutoBudget({
        requestKey, candidateDigest, pricePinDigest, runtimeDeploymentId,
      });
      const binding = (holdId: string, requestKey: string) => ({
        holdId, requestKey, candidateDigest, pricePinDigest, runtimeDeploymentId,
      });
      const capability = Object.freeze({ source: "synthetic-verified-adapter" });
      type Raw<T> = { capability: object; fact: T };
      const verify = <T>(raw: Raw<T>) => {
        if (raw.capability !== capability) throw new Error("untrusted_adapter_observation");
        return raw.fact;
      };
      const raw = <T>(fact: T): Raw<T> => ({ capability, fact });
      const authority = budget.createPromptRefinerAutoBudgetTransitionAuthority({
        verifyDispatchIntent: verify, verifyVerifiedBilling: verify,
        verifyBillingUnknown: verify, verifyUndispatched: verify,
      });

      const settledHold = await reserve(key(1));
      const settledBinding = binding(settledHold.id, key(1));
      await authority.recordDispatchIntent(raw({ binding: settledBinding,
        intentId: key(101), adapterConfigDigest }));
      await authority.settleVerifiedBilled(raw({ kind: "verified_billed" as const,
        binding: settledBinding, intentId: key(101), adapterConfigDigest,
        observationId: key(201), billedMicroUsd: BigInt(12_345) }));

      const unknownHold = await reserve(key(2));
      const unknownBinding = binding(unknownHold.id, key(2));
      await authority.recordDispatchIntent(raw({ binding: unknownBinding,
        intentId: key(102), adapterConfigDigest }));
      const unknown = await authority.retainUnknown(raw({ kind: "billing_unknown" as const,
        binding: unknownBinding, intentId: key(102), adapterConfigDigest,
        observationId: key(202) }));
      assert.equal(unknown.retryAuthorized, false);

      const releasedHold = await reserve(key(3));
      const releasedBinding = binding(releasedHold.id, key(3));
      await authority.releaseConfirmedUndispatched(raw({
        kind: "confirmed_undispatched" as const, binding: releasedBinding,
        proofId: key(203), intentId: null, adapterConfigDigest: null }));

      const windows = await client.query(`
        SELECT "period", "committedMicroUsd"::text AS cost
        FROM "PromptRefinerAutoBudgetWindow" ORDER BY "period"`);
      assert.deepEqual(windows.rows.map((row) => [row.period, row.cost]), [
        ["brisbane_day", "42263"], ["brisbane_month", "42263"],
      ], "verified actual cost plus the unknown worst-case hold remains committed");

      const rows = await client.query(`
        SELECT "status", "settledMicroUsd"::text AS settled,
               "dispatchIntentId", "unknownObservationId", "releaseProofId"
        FROM "PromptRefinerAutoBudgetHold" ORDER BY "requestKey"`);
      assert.deepEqual(rows.rows.map((row) => [row.status, row.settled]), [
        ["settled", "12345"], ["unknown", null], ["released", "0"],
      ]);
      assert.equal(rows.rows[1].unknownObservationId, key(202));
      assert.equal(rows.rows[2].releaseProofId, key(203));

      await assert.rejects(authority.settleVerifiedBilled(raw({
        kind: "verified_billed" as const, binding: unknownBinding,
        intentId: key(102), adapterConfigDigest, observationId: key(204),
        billedMicroUsd: BigInt(1) })), /transition_invalid/);
      await assert.rejects(authority.releaseConfirmedUndispatched(raw({
        kind: "confirmed_undispatched" as const, binding: unknownBinding,
        proofId: key(205), intentId: key(102), adapterConfigDigest })),
      /transition_invalid/);
      assert.equal((await client.query(`SELECT "committedMicroUsd"::text AS cost
        FROM "PromptRefinerAutoBudgetWindow" WHERE "period" = 'brisbane_day'`))
        .rows[0].cost, "42263");

      await assert.rejects(client.query(`UPDATE "PromptRefinerAutoBudgetWindow"
        SET "committedMicroUsd" = 0`),
      /prompt_refiner_auto_budget_window_direct_write_forbidden/);
      await assert.rejects(client.query(`UPDATE "PromptRefinerAutoBudgetHold"
        SET "status" = 'settled', "settledMicroUsd" = 0,
            "settlementObservationId" = $1, "settlementAuditLogId" = $2
        WHERE "id" = $3`, [key(206), "audit-forbidden", unknownHold.id]),
      /prompt_refiner_auto_budget_transition_invalid/);
      await assert.rejects(client.query(`DELETE FROM "PromptRefinerAutoBudgetHold"`),
        /prompt_refiner_auto_budget_delete_forbidden/);
      await assert.rejects(client.query(`TRUNCATE "PromptRefinerAutoBudgetWindow"`),
        /prompt_refiner_auto_budget_delete_forbidden/);

      // The immutable base migration already carries the settlement cap. A
      // direct transition writer must not bypass it, and the failed statement
      // must leave both the hold and its two aggregate windows unchanged.
      const cappedHold = await reserve(key(6));
      const cappedBinding = binding(cappedHold.id, key(6));
      await authority.recordDispatchIntent(raw({ binding: cappedBinding,
        intentId: key(106), adapterConfigDigest }));
      await client.query(`INSERT INTO "AdminAuditLog"("id") VALUES
        ('audit-over-cap'), ('audit-equal-cap')`);
      const beforeOverCap = await client.query(`SELECT "period",
        "committedMicroUsd"::text AS cost
        FROM "PromptRefinerAutoBudgetWindow" ORDER BY "period"`);
      await assert.rejects(client.query(`UPDATE "PromptRefinerAutoBudgetHold"
        SET "status" = 'settled', "settledMicroUsd" = "reservedMicroUsd" + 1,
            "settlementObservationId" = $1,
            "settlementAuditLogId" = 'audit-over-cap'
        WHERE "id" = $2 AND "status" = 'dispatching'`,
      [key(206), cappedHold.id]), (error: unknown) => {
        assert.ok(error instanceof pg.DatabaseError);
        assert.equal(error.code, "23514");
        assert.equal(error.constraint, "PromptRefinerAutoBudgetHold_amount_check");
        assert.match(error.message,
          /violates check constraint "PromptRefinerAutoBudgetHold_amount_check"/);
        return true;
      });
      const rejectedHold = await client.query(`SELECT "status",
        "settledMicroUsd"::text AS settled,
        "settlementObservationId", "settlementAuditLogId", "closedAt"
        FROM "PromptRefinerAutoBudgetHold" WHERE "id" = $1`, [cappedHold.id]);
      assert.deepEqual(rejectedHold.rows, [{ status: "dispatching", settled: null,
        settlementObservationId: null, settlementAuditLogId: null, closedAt: null }]);
      const afterOverCap = await client.query(`SELECT "period",
        "committedMicroUsd"::text AS cost
        FROM "PromptRefinerAutoBudgetWindow" ORDER BY "period"`);
      assert.deepEqual(afterOverCap.rows, beforeOverCap.rows);

      // Equality is valid. A full-cost settlement applies a zero aggregate
      // delta, while the prior unknown row remains NULL and fully held.
      assert.equal((await client.query(`UPDATE "PromptRefinerAutoBudgetHold"
        SET "status" = 'settled', "settledMicroUsd" = "reservedMicroUsd",
            "settlementObservationId" = $1,
            "settlementAuditLogId" = 'audit-equal-cap'
        WHERE "id" = $2 AND "status" = 'dispatching'`,
      [key(207), cappedHold.id])).rowCount, 1);
      const equalHold = await client.query(`SELECT "status",
        "reservedMicroUsd"::text AS reserved, "settledMicroUsd"::text AS settled
        FROM "PromptRefinerAutoBudgetHold" WHERE "id" = $1`, [cappedHold.id]);
      assert.deepEqual(equalHold.rows, [{ status: "settled",
        reserved: "29918", settled: "29918" }]);
      assert.equal((await client.query(`SELECT "settledMicroUsd" AS settled
        FROM "PromptRefinerAutoBudgetHold" WHERE "id" = $1`, [unknownHold.id]))
        .rows[0].settled, null);
      const afterEqualCap = await client.query(`SELECT "period",
        "committedMicroUsd"::text AS cost
        FROM "PromptRefinerAutoBudgetWindow" ORDER BY "period"`);
      assert.deepEqual(afterEqualCap.rows, beforeOverCap.rows);

      // Two terminal writers can race, but the row predicate permits one only.
      const concurrentHold = await reserve(key(4));
      const concurrentBinding = binding(concurrentHold.id, key(4));
      await authority.recordDispatchIntent(raw({ binding: concurrentBinding,
        intentId: key(104), adapterConfigDigest }));
      await client.query(`INSERT INTO "AdminAuditLog"("id") VALUES
        ('audit-race-1'), ('audit-race-2')`);
      const c1 = new pg.Client({ connectionString: rawUrl });
      const c2 = new pg.Client({ connectionString: rawUrl });
      await c1.connect(); await c2.connect();
      try {
        await c1.query(`SET search_path TO "${schema}"`);
        await c2.query(`SET search_path TO "${schema}"`);
        await c1.query("BEGIN"); await c2.query("BEGIN");
        const first = c1.query(`UPDATE "PromptRefinerAutoBudgetHold"
          SET "status" = 'settled', "settledMicroUsd" = 100,
              "settlementObservationId" = $1, "settlementAuditLogId" = 'audit-race-1'
          WHERE "id" = $2 AND "status" = 'dispatching'`, [key(401), concurrentHold.id]);
        const firstResult = await first;
        const second = c2.query(`UPDATE "PromptRefinerAutoBudgetHold"
          SET "status" = 'settled', "settledMicroUsd" = 200,
              "settlementObservationId" = $1, "settlementAuditLogId" = 'audit-race-2'
          WHERE "id" = $2 AND "status" = 'dispatching'`, [key(402), concurrentHold.id]);
        await c1.query("COMMIT");
        const secondResult = await second;
        await c2.query("COMMIT");
        assert.equal(firstResult.rowCount, 1);
        assert.equal(secondResult.rowCount, 0);
        const final = await client.query(`SELECT "settledMicroUsd"::text AS cost
          FROM "PromptRefinerAutoBudgetHold" WHERE "id" = $1`, [concurrentHold.id]);
        assert.equal(final.rows[0].cost, "100");
      } finally {
        await c1.end();
        await c2.end();
      }

      // Synthetic cap fixture: restore the production guard before invoking
      // the real reservation writer. The rejected transaction must roll back
      // its canonical audit and must not touch the month window.
      await client.query(`ALTER TABLE "PromptRefinerAutoBudgetWindow"
        DISABLE TRIGGER "PromptRefinerAutoBudgetWindow_exact_guard"`);
      await client.query(`UPDATE "PromptRefinerAutoBudgetWindow"
        SET "committedMicroUsd" = 100000000 WHERE "period" = 'brisbane_day'`);
      await client.query(`ALTER TABLE "PromptRefinerAutoBudgetWindow"
        ENABLE TRIGGER "PromptRefinerAutoBudgetWindow_exact_guard"`);
      const beforeCap = await client.query(`SELECT
        (SELECT count(*)::integer FROM "PromptRefinerAutoBudgetHold") AS holds,
        (SELECT count(*)::integer FROM "AdminAuditLog") AS audits,
        (SELECT "committedMicroUsd"::text FROM "PromptRefinerAutoBudgetWindow"
          WHERE "period" = 'brisbane_month') AS month_cost`);
      await assert.rejects(reserve(key(5)),
        (error: unknown) => error instanceof Error && "code" in error &&
          error.code === "budget_exhausted");
      const afterCap = await client.query(`SELECT
        (SELECT count(*)::integer FROM "PromptRefinerAutoBudgetHold") AS holds,
        (SELECT count(*)::integer FROM "AdminAuditLog") AS audits,
        (SELECT "committedMicroUsd"::text FROM "PromptRefinerAutoBudgetWindow"
          WHERE "period" = 'brisbane_day') AS day_cost,
        (SELECT "committedMicroUsd"::text FROM "PromptRefinerAutoBudgetWindow"
          WHERE "period" = 'brisbane_month') AS month_cost`);
      assert.equal(afterCap.rows[0].holds, beforeCap.rows[0].holds);
      assert.equal(afterCap.rows[0].audits, beforeCap.rows[0].audits);
      assert.equal(afterCap.rows[0].day_cost, "100000000");
      assert.equal(afterCap.rows[0].month_cost, beforeCap.rows[0].month_cost);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  });

test("concurrent reservations add to each window without snapshot lost updates",
  { skip: !rawUrl }, async () => {
    if (!rawUrl) return;
    const schema = `chat01_auto_budget_race_${randomUUID().replaceAll("-", "")}`;
    const setup = new pg.Client({ connectionString: rawUrl });
    const first = new pg.Client({ connectionString: rawUrl });
    const second = new pg.Client({ connectionString: rawUrl });
    await setup.connect(); await first.connect(); await second.connect();
    try {
      await setup.query(`CREATE SCHEMA "${schema}"`);
      await setup.query(`SET search_path TO "${schema}"`);
      await setup.query(`CREATE TABLE "AdminAuditLog" ("id" TEXT PRIMARY KEY)`);
      await setup.query(await readFile(baseMigration, "utf8"));
      await setup.query(await readFile(transitionMigration, "utf8"));
      await setup.query(`INSERT INTO "AdminAuditLog"("id") VALUES
        ('audit-concurrent-reserve-1'), ('audit-concurrent-reserve-2')`);
      await first.query(`SET search_path TO "${schema}"`);
      await second.query(`SET search_path TO "${schema}"`);
      await first.query("BEGIN"); await second.query("BEGIN");
      const insert = (client: pg.Client, ordinal: number, auditId: string) =>
        client.query(`INSERT INTO "PromptRefinerAutoBudgetHold" (
          "id", "requestKey", "dayStart", "monthStart", "reservedMicroUsd",
          "status", "candidateDigest", "pricePinDigest", "runtimeDeploymentId",
          "reservationAuditLogId") VALUES (
          $1, $2,
          date_trunc('day', transaction_timestamp() AT TIME ZONE 'Australia/Brisbane')
            AT TIME ZONE 'Australia/Brisbane',
          date_trunc('month', transaction_timestamp() AT TIME ZONE 'Australia/Brisbane')
            AT TIME ZONE 'Australia/Brisbane',
          29918, 'reserved', $3, $4, $5, $6)`,
        [key(500 + ordinal), key(600 + ordinal), candidateDigest, pricePinDigest,
          runtimeDeploymentId, auditId]);
      const firstResult = await insert(first, 1, "audit-concurrent-reserve-1");
      const secondPending = insert(second, 2, "audit-concurrent-reserve-2");
      await first.query("COMMIT");
      const secondResult = await secondPending;
      await second.query("COMMIT");
      assert.equal(firstResult.rowCount, 1); assert.equal(secondResult.rowCount, 1);
      const windows = await setup.query(`SELECT "period", "committedMicroUsd"::text AS cost
        FROM "PromptRefinerAutoBudgetWindow" ORDER BY "period"`);
      assert.deepEqual(windows.rows.map((row) => [row.period, row.cost]), [
        ["brisbane_day", "59836"], ["brisbane_month", "59836"],
      ]);
      assert.equal((await setup.query(`SELECT count(*)::integer AS count
        FROM "PromptRefinerAutoBudgetHold"`)).rows[0].count, 2);
    } finally {
      await first.end();
      await second.end();
      await setup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await setup.end();
    }
  });
