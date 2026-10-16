import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import pg from "pg";

// The ledger's database rules, exercised with plain SQL in a throwaway schema
// so no writer module stands between the statement and the triggers.

const root = resolve(import.meta.dirname, "..", "..");
const rawUrl = process.env.TEST_DATABASE_URL?.trim();
const migration = resolve(root, "prisma/migrations/20261016120000_marketing_llm_call_ledger/migration.sql");

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hex = (c: string) => c.repeat(64);
const cuid = (n: number) => `c${String(n).padStart(24, "0")}`;

test("MarketingLlmCall holds its state machine, clock, pairing and deletion rules for any writer", { skip: !rawUrl }, async () => {
  if (!rawUrl) return;
  const url = new URL(rawUrl);
  assert.match(
    `${decodeURIComponent(url.pathname.replace(/^\//, ""))}_${url.searchParams.get("schema") ?? ""}`,
    /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i,
    "only a dedicated test database is accepted",
  );
  const schema = `mkt_llm_ledger_${randomUUID().replaceAll("-", "")}`;
  const client = new pg.Client({ connectionString: rawUrl });
  await client.connect();
  let audit = 0;
  const auditId = async () => {
    audit += 1;
    const id = `audit_${audit}`;
    await client.query(`INSERT INTO "AdminAuditLog" ("id") VALUES ($1)`, [id]);
    return id;
  };
  const rejects = (sql: string, params: unknown[], pattern: RegExp) =>
    assert.rejects(client.query(sql, params), pattern, sql);

  // A reserved row stamped from this clock, the way the writer stamps it.
  let ordinal = 0;
  const reserve = async (overrides: Record<string, unknown> = {}) => {
    ordinal += 1;
    const row = {
      id: cuid(ordinal),
      requestKey: uuid(ordinal),
      purpose: "draft",
      reservationAuditLogId: await auditId(),
      ...overrides,
    };
    await client.query(
      `WITH t AS (SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS at)
       INSERT INTO "MarketingLlmCall" ("id", "state", "requestKey", "reservePayloadDigest",
         "requestDigest", "configSnapshot", "generatorRunId", "purpose", "provider", "model",
         "reservedInputTokens", "reservedOutputTokens", "reservedMicroUsd", "monthStart",
         "reservationAuditLogId", "createdAt")
       SELECT $1, 'reserved', $2, $3, $4, '{"adapterProfile":"text-only-v1"}'::jsonb, 'run-1', $5,
         'openai', 'fixture-model-2026-10-01', 128000, 4096, 115508, date_trunc('month', t.at), $6, t.at
       FROM t`,
      [row.id, row.requestKey, hex("a"), hex("b"), row.purpose, row.reservationAuditLogId],
    );
    return row.id as string;
  };
  const dispatch = async (id: string) => {
    await client.query(
      `UPDATE "MarketingLlmCall" SET "state" = 'dispatched', "dispatchIntentId" = $2,
         "adapterConfigDigest" = $3, "dispatchDigest" = $4, "dispatchAuditLogId" = $5,
         "dispatchedAt" = TIMESTAMP '2000-01-01'
       WHERE "id" = $1`,
      [id, uuid(1000 + ordinal), hex("c"), hex("d"), await auditId()],
    );
  };
  const observed = `"observationId" = $3, "reportedModel" = 'fixture-model-2026-10-01',
    "reportedServiceTier" = 'default', "reportedInputTokens" = 10, "reportedOutputTokens" = 5`;
  const close = async (id: string, state: string, reason: string, withObservation: boolean) => {
    await client.query(
      `UPDATE "MarketingLlmCall" SET "state" = $4, "closeReason" = $5, "closeDigest" = '${hex("e")}',
         "closeAuditLogId" = $2, "closedAt" = TIMESTAMP '2000-01-01'
         ${withObservation ? `, ${observed}` : ", \"observationId\" = $3::text"}
       WHERE "id" = $1`,
      [id, await auditId(), withObservation ? uuid(2000 + ordinal + Math.floor(Math.random() * 1000)) : null, state, reason],
    );
  };
  const backdate = async (id: string, column: string, interval: string) => {
    await client.query(`ALTER TABLE "MarketingLlmCall" DISABLE TRIGGER "MarketingLlmCall_update_guard"`);
    await client.query(`UPDATE "MarketingLlmCall" SET "${column}" = "${column}" - $2::interval WHERE "id" = $1`, [id, interval]);
    await client.query(`ALTER TABLE "MarketingLlmCall" ENABLE TRIGGER "MarketingLlmCall_update_guard"`);
  };

  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(`CREATE TABLE "AdminAuditLog" ("id" TEXT PRIMARY KEY)`);
    await client.query(await readFile(migration, "utf8"));

    // An empty ledger can be truncated, so AdminAuditLog resets keep working.
    await client.query(`TRUNCATE "MarketingLlmCall"`);

    // --- insert ----------------------------------------------------------
    const first = await reserve();
    const stored = await client.query(
      `SELECT "retentionUntil" = "createdAt" + INTERVAL '24 months' AS ok,
              "monthStart" = date_trunc('month', "createdAt") AS month FROM "MarketingLlmCall" WHERE "id" = $1`,
      [first],
    );
    assert.deepEqual(stored.rows[0], { ok: true, month: true });

    const insertWith = (columns: string, values: string) =>
      `WITH t AS (SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS at)
       INSERT INTO "MarketingLlmCall" ("id", "state", "requestKey", "reservePayloadDigest", "requestDigest",
         "configSnapshot", "generatorRunId", "purpose", "provider", "model", "reservedInputTokens",
         "reservedOutputTokens", "reservedMicroUsd", "monthStart", "reservationAuditLogId", "createdAt"${columns})
       SELECT $1, $2, $3, '${hex("a")}', '${hex("b")}', '{}'::jsonb, 'run-1', 'draft', 'openai', 'm', 1, 1, 1,
         date_trunc('month', t.at), $4, t.at${values} FROM t`;
    const freshAudit = await auditId();
    await rejects(insertWith("", ""), [cuid(900), "settled", uuid(900), freshAudit], /insert_not_reserved/);
    await rejects(insertWith(`, "legalHold"`, ", true"), [cuid(900), "reserved", uuid(900), freshAudit], /insert_not_reserved/);
    await rejects(insertWith(`, "consumerDigest"`, `, '${hex("f")}'`), [cuid(900), "reserved", uuid(900), freshAudit], /insert_not_reserved/);
    await rejects(insertWith(`, "dispatchIntentId"`, `, '${uuid(901)}'`), [cuid(900), "reserved", uuid(900), freshAudit], /insert_not_reserved/);

    // The reservation clock is checked against this clock, not taken on trust.
    const clocked = (createdAt: string, monthStart: string) =>
      `INSERT INTO "MarketingLlmCall" ("id", "state", "requestKey", "reservePayloadDigest", "requestDigest",
         "configSnapshot", "generatorRunId", "purpose", "provider", "model", "reservedInputTokens",
         "reservedOutputTokens", "reservedMicroUsd", "monthStart", "reservationAuditLogId", "createdAt")
       SELECT '${cuid(910)}', 'reserved', '${uuid(910)}', '${hex("a")}', '${hex("b")}', '{}'::jsonb, 'run-1',
         'draft', 'openai', 'm', 1, 1, 1, ${monthStart}, '${freshAudit}', ${createdAt}`;
    const now = `(clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)`;
    await rejects(clocked(`${now} - INTERVAL '11 seconds'`, `date_trunc('month', ${now})`), [], /reservation_clock_invalid/);
    await rejects(clocked(`${now} + INTERVAL '1 second'`, `date_trunc('month', ${now})`), [], /reservation_clock_invalid/);
    await rejects(clocked(now, `date_trunc('month', ${now}) - INTERVAL '1 month'`), [], /reservation_clock_invalid/);

    // --- dispatch ----------------------------------------------------------
    await dispatch(first);
    const dispatchedAt = await client.query(
      `SELECT "dispatchedAt" > TIMESTAMP '2001-01-01' AS fresh FROM "MarketingLlmCall" WHERE "id" = $1`,
      [first],
    );
    assert.equal(dispatchedAt.rows[0].fresh, true, "the database stamps dispatchedAt");
    await rejects(`UPDATE "MarketingLlmCall" SET "dispatchDigest" = '${hex("9")}' WHERE "id" = $1`, [first], /update_invalid/);
    await rejects(`UPDATE "MarketingLlmCall" SET "requestDigest" = '${hex("9")}' WHERE "id" = $1`, [first], /update_invalid/);
    await rejects(`UPDATE "MarketingLlmCall" SET "consumerDigest" = '${hex("9")}' WHERE "id" = $1`, [first], /update_invalid/);

    const late = await reserve();
    await backdate(late, "createdAt", "16 minutes");
    await rejects(
      `UPDATE "MarketingLlmCall" SET "state" = 'dispatched', "dispatchIntentId" = '${uuid(920)}',
         "adapterConfigDigest" = '${hex("c")}', "dispatchDigest" = '${hex("d")}', "dispatchAuditLogId" = '${freshAudit}'
       WHERE "id" = $1`,
      [late],
      /dispatch_late/,
    );
    // A reservation changed alongside a dispatch is refused.
    const rebound = await reserve();
    await rejects(
      `UPDATE "MarketingLlmCall" SET "state" = 'dispatched', "dispatchIntentId" = '${uuid(921)}',
         "adapterConfigDigest" = '${hex("c")}', "dispatchDigest" = '${hex("d")}',
         "dispatchAuditLogId" = '${freshAudit}', "reservedMicroUsd" = 1
       WHERE "id" = $1`,
      [rebound],
      /update_invalid/,
    );

    // --- transitions outside the table ----------------------------------------
    await rejects(`UPDATE "MarketingLlmCall" SET "state" = 'settled' WHERE "id" = $1`, [rebound], /transition_invalid/);
    await rejects(`UPDATE "MarketingLlmCall" SET "state" = 'reserved' WHERE "id" = $1`, [first], /transition_invalid/);

    // --- close pairing: state x reason x observation ---------------------------
    const pairings: Array<[string, string, boolean]> = [
      ["settled", "settled", false],
      ["settled", "tokens_over_bound", true],
      ["unknown_retained", "reported_unknown", true],
      ["unknown_retained", "tokens_over_bound", false],
      ["unknown_retained", "model_mismatch", false],
      ["unknown_retained", "tier_mismatch", false],
      ["unknown_retained", "settled", true],
      ["unknown_retained", "reservation_expired", false],
      ["released", "reported_unknown", false],
    ];
    for (const [state, reason, withObservation] of pairings) {
      const id = state === "released" ? await reserve() : await reserve();
      if (state !== "released") await dispatch(id);
      await assert.rejects(close(id, state, reason, withObservation), /MarketingLlmCall_state_check|violates check/, `${state}/${reason}/${withObservation}`);
    }

    // Accepted closes and the timestamp the database writes.
    await close(first, "settled", "settled", true);
    const closed = await client.query(
      `SELECT "closedAt" > TIMESTAMP '2001-01-01' AS fresh FROM "MarketingLlmCall" WHERE "id" = $1`,
      [first],
    );
    assert.equal(closed.rows[0].fresh, true, "the database stamps closedAt");
    const overBound = await reserve();
    await dispatch(overBound);
    await close(overBound, "unknown_retained", "tokens_over_bound", true);
    const unknown = await reserve();
    await dispatch(unknown);
    await close(unknown, "unknown_retained", "reported_unknown", false);
    const released = await reserve();
    await close(released, "released", "reported_undispatched", false);

    // A close that also rewrites the dispatch evidence or the hold is refused.
    const sneaky = await reserve();
    await dispatch(sneaky);
    await rejects(
      `UPDATE "MarketingLlmCall" SET "state" = 'unknown_retained', "closeReason" = 'reported_unknown',
         "closeDigest" = '${hex("e")}', "closeAuditLogId" = '${await auditId()}', "dispatchDigest" = '${hex("9")}'
       WHERE "id" = $1`,
      [sneaky],
      /update_invalid/,
    );
    await rejects(
      `UPDATE "MarketingLlmCall" SET "state" = 'unknown_retained', "closeReason" = 'reported_unknown',
         "closeDigest" = '${hex("e")}', "closeAuditLogId" = '${await auditId()}', "legalHold" = true
       WHERE "id" = $1`,
      [sneaky],
      /update_invalid/,
    );

    // --- expiry is refused early --------------------------------------------
    const fresh = await reserve();
    await assert.rejects(close(fresh, "released", "reservation_expired", false), /expiry_early/);
    await backdate(fresh, "createdAt", "16 minutes");
    await close(fresh, "released", "reservation_expired", false);
    const stuck = await reserve();
    await dispatch(stuck);
    await assert.rejects(close(stuck, "unknown_retained", "dispatch_expired", false), /expiry_early/);
    await backdate(stuck, "dispatchedAt", "61 minutes");
    await close(stuck, "unknown_retained", "dispatch_expired", false);

    // --- closed rows: evidence frozen, one consumer write, legal hold ---------
    await rejects(`UPDATE "MarketingLlmCall" SET "closeDigest" = '${hex("9")}' WHERE "id" = $1`, [first], /update_invalid/);
    await rejects(`UPDATE "MarketingLlmCall" SET "reportedInputTokens" = 1 WHERE "id" = $1`, [first], /update_invalid/);
    await rejects(`UPDATE "MarketingLlmCall" SET "state" = 'unknown_retained' WHERE "id" = $1`, [first], /transition_invalid/);
    await rejects(
      `UPDATE "MarketingLlmCall" SET "consumerDigest" = '${hex("1")}', "legalHold" = true WHERE "id" = $1`,
      [first],
      /update_invalid/,
    );
    await client.query(`UPDATE "MarketingLlmCall" SET "consumerDigest" = '${hex("1")}' WHERE "id" = $1`, [first]);
    await rejects(`UPDATE "MarketingLlmCall" SET "consumerDigest" = '${hex("2")}' WHERE "id" = $1`, [first], /update_invalid/);
    await rejects(`UPDATE "MarketingLlmCall" SET "consumerDigest" = '${hex("1")}' WHERE "id" = $1`, [released], /update_invalid|state_check/);
    const intel = await reserve({ purpose: "market_intel" });
    await dispatch(intel);
    await close(intel, "unknown_retained", "reported_unknown", false);
    await assert.rejects(
      client.query(`UPDATE "MarketingLlmCall" SET "consumerDigest" = '${hex("1")}' WHERE "id" = $1`, [intel]),
      /state_check|violates check/,
    );
    await client.query(`UPDATE "MarketingLlmCall" SET "legalHold" = true WHERE "id" = $1`, [unknown]);
    await client.query(`UPDATE "MarketingLlmCall" SET "legalHold" = false WHERE "id" = $1`, [unknown]);

    // --- deletion is retention's alone ------------------------------------------
    await rejects(`DELETE FROM "MarketingLlmCall" WHERE "id" = $1`, [released], /delete_forbidden/);
    await client.query("BEGIN");
    await client.query(`SET LOCAL tomverse.marketing_retention_compaction = 'on'`);
    await assert.rejects(client.query(`DELETE FROM "MarketingLlmCall" WHERE "id" = $1`, [released]), /delete_forbidden/);
    await client.query("ROLLBACK");
    await backdate(released, "retentionUntil", "25 months");
    await backdate(unknown, "retentionUntil", "25 months");
    await client.query(`UPDATE "MarketingLlmCall" SET "legalHold" = true WHERE "id" = $1`, [unknown]);
    await rejects(`DELETE FROM "MarketingLlmCall" WHERE "id" = $1`, [released], /delete_forbidden/);
    await client.query("BEGIN");
    await client.query(`SET LOCAL tomverse.marketing_retention_compaction = 'on'`);
    await assert.rejects(client.query(`DELETE FROM "MarketingLlmCall" WHERE "id" = $1`, [unknown]), /delete_forbidden/);
    await client.query("ROLLBACK");
    await client.query("BEGIN");
    await client.query(`SET LOCAL tomverse.marketing_retention_compaction = 'on'`);
    const deleted = await client.query(`DELETE FROM "MarketingLlmCall" WHERE "id" = $1`, [released]);
    await client.query("COMMIT");
    assert.equal(deleted.rowCount, 1);
    // An open call is never deleted, however old.
    const open = await reserve();
    await backdate(open, "retentionUntil", "25 months");
    await client.query("BEGIN");
    await client.query(`SET LOCAL tomverse.marketing_retention_compaction = 'on'`);
    await assert.rejects(client.query(`DELETE FROM "MarketingLlmCall" WHERE "id" = $1`, [open]), /delete_forbidden/);
    await client.query("ROLLBACK");

    await rejects(`TRUNCATE "MarketingLlmCall"`, [], /delete_forbidden/);
    // The audit rows the ledger points at cannot be removed under it.
    await assert.rejects(client.query(`DELETE FROM "AdminAuditLog" WHERE "id" = 'audit_1'`), /foreign key/);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await client.end();
  }
});
