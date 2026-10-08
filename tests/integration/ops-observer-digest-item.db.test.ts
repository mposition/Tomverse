// The digest item the notice links to (docs/policy/sre-ops.md §1 item 3, §3
// rule 1, §10): read by id, this agent's daily digest only, in a bounded
// transaction; a body past its retention or outside the closed shape is shown
// as absent. A throwaway schema with the ops migrations (for the arming
// function) and a stand-in for the shared table's columns this read uses.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import pg from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const rawUrl = process.env.TEST_DATABASE_URL?.trim();
const schema = `ops_observer_digest_item_${randomUUID().replaceAll("-", "")}`;

test("the ops-observer digest item read", { skip: !rawUrl }, async (t) => {
  const url = new URL(rawUrl!);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  assert.match(`${databaseName}_${url.searchParams.get("schema") || ""}`, /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i,
    "only a dedicated test database is accepted");
  process.env.DATABASE_URL ||= rawUrl;
  const { readOpsObserverDigestItem } = await import("@/lib/opsObserverDigest");

  const admin = new pg.Client({ connectionString: rawUrl });
  await admin.connect();
  const q = (sql: string, params?: unknown[]) => (params ? admin.query(sql, params) : admin.query(sql));
  const pool = new pg.Pool({ connectionString: rawUrl, options: `-c search_path="${schema}"` });
  const client = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
  const payload = {
    ownerDate: "2026-10-07",
    mode: "shadow",
    readiness: { imageProviderBudget: false },
    reserved: [{ key: "P3#credit_reservation_reconciliation", kind: "new_open", capped: false }],
    channelCheckTaken: false,
  };
  const insert = async (agentKey: string, kind: string, body: unknown) => {
    const id = randomUUID();
    await q(`INSERT INTO "AgentDigestItem" (id, "agentKey", kind, payload) VALUES ($1, $2, $3, $4)`,
      [id, agentKey, kind, body === null ? null : JSON.stringify(body)]);
    return id;
  };

  try {
    await q(`CREATE SCHEMA "${schema}"`);
    await q(`SET search_path TO "${schema}"`);
    await q(await readFile(path.resolve(here, "../../prisma/migrations/20261003060000_ops_observer_transaction_arm/migration.sql"), "utf8"));
    await q(`CREATE TABLE "AgentDigestItem" (id UUID PRIMARY KEY, "agentKey" TEXT NOT NULL, kind TEXT NOT NULL,
      payload JSONB, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
      "retentionUntil" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp() + interval '90 days')`);

    await t.test("this agent's digest is read back in the closed shape", async () => {
      const id = await insert("sre-ops", "daily_digest", payload);
      const view = await readOpsObserverDigestItem(id, client);
      assert.equal(view?.id, id);
      assert.deepEqual(view?.payload, payload);
      assert.ok(view && Number.isFinite(Date.parse(view.createdAt)));
    });

    await t.test("another agent's item, an unknown id or a non-UUID is no digest", async () => {
      assert.equal(await readOpsObserverDigestItem(await insert("qa-release", "daily_digest", payload), client), null);
      assert.equal(await readOpsObserverDigestItem(randomUUID(), client), null);
      assert.equal(await readOpsObserverDigestItem("../etc", client), null);
    });

    await t.test("a deleted or malformed body is shown as absent, not as what it holds", async () => {
      assert.deepEqual((await readOpsObserverDigestItem(await insert("sre-ops", "daily_digest", null), client))?.payload, null);
      const odd = await insert("sre-ops", "daily_digest", { ...payload, note: "<script>" });
      assert.deepEqual((await readOpsObserverDigestItem(odd, client))?.payload, null);
    });

    await t.test("a body past its retention is absent even before the expiry batch has removed it", async () => {
      const id = await insert("sre-ops", "daily_digest", payload);
      await q(`UPDATE "AgentDigestItem" SET "retentionUntil" = clock_timestamp() - interval '1 second' WHERE id = $1`, [id]);
      const view = await readOpsObserverDigestItem(id, client);
      assert.equal(view?.id, id);
      assert.equal(view?.payload, null);
    });

    await t.test("a read without the time left to finish returns nothing", async () => {
      const id = await insert("sre-ops", "daily_digest", payload);
      await assert.rejects(readOpsObserverDigestItem(id, client, new Date(Date.now() + 5_000)));
    });
  } finally {
    await client.$disconnect().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await admin.end();
  }
});
