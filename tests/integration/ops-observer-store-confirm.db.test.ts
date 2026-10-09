// The ops-observer confirm (docs/policy/sre-ops.md §3 rules 3 and 9): the
// reservation closes as shadowed under a shadow genesis and confirmed under a
// live one -- by the row's mode, never the request -- with its own audit
// action; a repeat is replayed, another run's id is not found, an abandoned
// reservation stays abandoned, and an untrusted chain writes nothing.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import pg from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

import { computeAdminAuditEntryHash } from "../../lib/adminAuditIntegrityCore";
import { S2_PAGE_KEYS, initialKeyState } from "../../scripts/ops-observer/classify-core.mjs";

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
const schema = `ops_observer_confirm_${randomUUID().replaceAll("-", "")}`;
const KEY = "store-confirm-test-integrity-key-0123456789abcdef";
const DIGEST = "b".repeat(64);
const inSeconds = (s: number) => new Date(Date.now() + s * 1000);

test("the ops-observer confirm", { skip: !rawUrl }, async (t) => {
  const url = new URL(rawUrl!);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  assert.match(`${databaseName}_${url.searchParams.get("schema") || ""}`, /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i,
    "only a dedicated test database is accepted");
  process.env.DATABASE_URL ||= rawUrl;
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = KEY;
  const { advanceOpsObserverState, confirmOpsObserverDelivery, readOpsObserverState } = await import("@/lib/opsObserverStore");

  const admin = new pg.Client({ connectionString: rawUrl });
  await admin.connect();
  const q = (sql: string, params?: unknown[]) => (params ? admin.query(sql, params) : admin.query(sql));
  const pool = new pg.Pool({ connectionString: rawUrl, options: `-c search_path="${schema}"` });
  const client = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
  const initial = Object.fromEntries(S2_PAGE_KEYS.map((key) => [key, initialKeyState()]));
  let auditSeconds = 0;

  /** An approved genesis with its state, as the Admin route will write it. */
  async function approvedGenesis(reason: string, mode: string, supersedes: string | null) {
    const id = randomUUID();
    auditSeconds += 1;
    const at = `2026-10-05T00:00:${String(auditSeconds).padStart(2, "0")}.000`;
    const entry = {
      previousHash: null, actorUserId: "owner-1", actorEmail: "owner@example.test",
      action: "ops_observer.genesis_created", targetType: "OpsObserverGenesis", targetId: id,
      summary: "Genesis.", metadata: { requestDigest: DIGEST, supersedesGenesisId: supersedes, mode },
      ipAddress: null, userAgent: null, createdAt: `${at}Z`,
    };
    await q("BEGIN");
    await q(`INSERT INTO "OpsObserverGenesis" (id, reason, mode, "supersedesGenesisId", "requestDigest", "invariantVersion", "runDeadlineAt")
             VALUES ($1, $2, $3, $4, $5, 1, clock_timestamp() + interval '60 seconds')`, [id, reason, mode, supersedes, DIGEST]);
    await q(`INSERT INTO "AdminAuditLog" (id, "actorUserId", "actorEmail", action, "targetType", "targetId", summary, metadata, "entryHash", "createdAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [randomUUID(), entry.actorUserId, entry.actorEmail, entry.action, entry.targetType, entry.targetId, entry.summary,
        JSON.stringify(entry.metadata), computeAdminAuditEntryHash(entry, KEY), at]);
    await q(`INSERT INTO "OpsObserverState" ("genesisId", generation, keys, "invariantVersion", "stampGeneration",
               "stampKeysSha256", "stampCheckpointSha256", "runDeadlineAt")
             VALUES ($1, 0, $2, 0, 0, '', '', clock_timestamp() + interval '60 seconds')`, [id, JSON.stringify(initial)]);
    await q("COMMIT");
    return id;
  }

  /** A channel-check reservation through the advance; returns its id and run. */
  async function reserve(genesisId: string, ownerDate: string) {
    const state = (await readOpsObserverState(inSeconds(120), client)) as { trust: string; generation: number; keys: Record<string, unknown> };
    assert.equal(state.trust, "trusted");
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const result = await advanceOpsObserverState(
      { runDeadline: inSeconds(150), runId, baseGenesisId: genesisId, baseGeneration: state.generation, keys: state.keys,
        reservation: { ownerDate, channelCheck: true, items: [] } },
      client,
    );
    assert.equal(result.result, "advanced");
    return { deliveryId: (result as { deliveryId: string }).deliveryId, runId, state };
  }
  const confirm = (deliveryId: string, runId: string) =>
    confirmOpsObserverDelivery({ runDeadline: inSeconds(150), deliveryId, runId }, client);
  const statusOf = async (id: string) => (await q(`SELECT status FROM "OpsObserverDelivery" WHERE id = $1`, [id])).rows[0].status;
  const auditActions = async (id: string) =>
    (await q(`SELECT action FROM "AdminAuditLog" WHERE "targetType" = 'OpsObserverDelivery' AND "targetId" = $1`, [id])).rows.map((r) => r.action);

  try {
    await q(`CREATE SCHEMA "${schema}"`);
    await q(`SET search_path TO "${schema}"`);
    await q(`CREATE TABLE "AdminAuditLog" (
      id TEXT PRIMARY KEY, "actorUserId" TEXT, "actorEmail" TEXT, action TEXT NOT NULL,
      "targetType" TEXT NOT NULL, "targetId" TEXT, summary TEXT NOT NULL, metadata JSONB,
      "ipAddress" TEXT, "userAgent" TEXT, "previousHash" TEXT, "entryHash" TEXT UNIQUE,
      "createdAt" TIMESTAMP(3) NOT NULL)`);
    await q(`CREATE TABLE "AgentDigestItem" (id UUID PRIMARY KEY)`);
    for (const file of migrations) await q(await readFile(file, "utf8"));
    const shadowGenesis = await approvedGenesis("initial", "shadow", null);

    await t.test("under a shadow genesis the reservation closes as shadowed, once", async () => {
      const { deliveryId, runId } = await reserve(shadowGenesis, "2026-10-05");
      assert.deepEqual(await confirm(deliveryId, runId), { result: "shadowed" });
      assert.equal(await statusOf(deliveryId), "shadowed");
      assert.deepEqual(await auditActions(deliveryId), ["ops_observer.delivery_shadowed"]);
      assert.deepEqual(await confirm(deliveryId, runId), { result: "replayed" });
      assert.deepEqual(await auditActions(deliveryId), ["ops_observer.delivery_shadowed"]);
    });

    await t.test("another run's id, an abandoned reservation or an untrusted chain closes nothing", async () => {
      const { deliveryId, runId, state } = await reserve(shadowGenesis, "2026-10-06");
      assert.deepEqual(await confirm(deliveryId, "run-someone-else"), { result: "not_found" });
      assert.deepEqual(await confirm(randomUUID(), runId), { result: "not_found" });
      process.env.ADMIN_AUDIT_INTEGRITY_KEY = "another-integrity-key-0123456789abcdef";
      try {
        assert.deepEqual(await confirm(deliveryId, runId), { result: "untrusted", trust: "audit_unverified" });
      } finally {
        process.env.ADMIN_AUDIT_INTEGRITY_KEY = KEY;
      }
      assert.equal(await statusOf(deliveryId), "reserved");
      // The next advance closes it as abandoned; a late confirm cannot revive it.
      const next = await advanceOpsObserverState(
        { runDeadline: inSeconds(150), runId: "run-after", baseGenesisId: shadowGenesis, baseGeneration: state.generation + 1,
          keys: state.keys, reservation: null },
        client,
      );
      assert.equal(next.result, "advanced");
      assert.equal(await statusOf(deliveryId), "abandoned");
      assert.deepEqual(await confirm(deliveryId, runId), { result: "abandoned" });
      assert.deepEqual(await auditActions(deliveryId), []);
    });

    await t.test("under a live genesis the same call confirms", async () => {
      // The activation genesis, the seven-day rule met by moving the first back (fixture only).
      await q(`ALTER TABLE "OpsObserverGenesis" DISABLE TRIGGER USER`);
      try {
        await q(`UPDATE "OpsObserverGenesis" SET "createdAt" = clock_timestamp() - interval '8 days' WHERE id = $1`, [shadowGenesis]);
      } finally {
        await q(`ALTER TABLE "OpsObserverGenesis" ENABLE TRIGGER USER`);
      }
      const liveGenesis = await approvedGenesis("activation", "live", shadowGenesis);
      const { deliveryId, runId } = await reserve(liveGenesis, "2026-10-07");
      assert.deepEqual(await confirm(deliveryId, runId), { result: "confirmed" });
      assert.equal(await statusOf(deliveryId), "confirmed");
      assert.deepEqual(await auditActions(deliveryId), ["ops_observer.delivery_confirmed"]);
      assert.equal(((await readOpsObserverState(inSeconds(120), client)) as { trust: string }).trust, "trusted");

      // A reservation forged past the trigger under the replaced shadow
      // genesis, claiming live: the current chain is trusted, but this row's
      // own stamps are not, and the confirm touches nothing.
      const forged = randomUUID();
      await q(`ALTER TABLE "OpsObserverDelivery" DISABLE TRIGGER USER`);
      try {
        await q(`INSERT INTO "OpsObserverDelivery" (id, "genesisId", mode, "runId", status, "reservedMarker", "ownerDate",
                   "invariantVersion", "stampStatus", "runDeadlineAt")
                 VALUES ($1, $2, 'live', 'run-forged', 'reserved', 1, '2026-10-08', 1, 'reserved', clock_timestamp() + interval '60 seconds')`,
          [forged, shadowGenesis]);
      } finally {
        await q(`ALTER TABLE "OpsObserverDelivery" ENABLE TRIGGER USER`);
      }
      assert.deepEqual(await confirm(forged, "run-forged"), { result: "untrusted", trust: "unenforced_write" });
      assert.equal(await statusOf(forged), "reserved");
      assert.deepEqual(await auditActions(forged), []);
      const stamps = await q(`SELECT "invariantVersion" FROM "OpsObserverDelivery" WHERE id = $1`, [forged]);
      assert.equal(stamps.rows[0].invariantVersion, 1, "the forged row keeps the stamps it was written with");
    });
  } finally {
    await client.$disconnect().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await admin.end();
  }
});
