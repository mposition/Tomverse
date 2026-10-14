import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import pg from "pg";

import { allocateAmuxCardDisplayKey } from "@/lib/amux/cardDisplayKeyAllocator";
import { prisma } from "@/lib/prisma";

// docs/policy/amux-card-display-key.md §3, against PostgreSQL through the
// migration history (20261014100000_amux_card_display_key). What the
// migration header says the database enforces: a card's number and a
// Feature's prefix are well formed, unique and immutable once set; a Feature
// prefix is never a reserved path prefix and never on another level; the
// per-prefix counter starts at 1, only advances by one and is never removed;
// and an allocation the caller rolls back spends no number.

const requireDedicatedAmuxTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  const runtimeRaw = process.env.DATABASE_URL?.trim();
  if (!testRaw) throw new Error("TEST_DATABASE_URL is required");
  if (runtimeRaw !== testRaw) {
    throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
  }
  const url = new URL(testRaw);
  const schemaName = url.searchParams.get("schema");
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const usesDedicatedAmuxSchema = schemaName === "tomverse_amux_test";
  const usesCanonicalCiDatabase =
    databaseName === "tomverse_test" &&
    (schemaName === null || schemaName === "public") &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (!usesDedicatedAmuxSchema && !usesCanonicalCiDatabase) {
    throw new Error("REFUSE: AMUX DB tests require the dedicated AMUX schema or the local canonical test database");
  }
};
requireDedicatedAmuxTestDatabase();

after(async () => {
  await prisma.$disconnect();
});

// The counter refuses deletes and truncates, so every test uses prefixes no
// other run has used rather than cleaning up.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const freshPrefix = () =>
  "T" + Array.from(randomBytes(10), (byte) => ALPHABET[byte % ALPHABET.length]).join("");

class Rollback extends Error {}

const allocate = (prefix: string) =>
  prisma.$transaction((tx) => allocateAmuxCardDisplayKey(tx, prefix));

/** One pg connection in a transaction that is always rolled back. */
async function inRolledBackTransaction(body: (probe: Probe) => Promise<void>) {
  const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await body(new Probe(client));
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}

class Probe {
  constructor(readonly client: pg.Client) {}

  query(sql: string, params: unknown[] = []) {
    return this.client.query(sql, params);
  }

  /** Runs one statement that must fail, and leaves the transaction usable. */
  async rejects(sql: string, params: unknown[], expected: { constraint?: string; code?: string }) {
    await this.client.query("SAVEPOINT reject_probe");
    let caught: (Error & { constraint?: string; code?: string }) | null = null;
    try {
      await this.client.query(sql, params);
    } catch (error) {
      caught = error as Error & { constraint?: string; code?: string };
    } finally {
      await this.client.query("ROLLBACK TO SAVEPOINT reject_probe");
      await this.client.query("RELEASE SAVEPOINT reject_probe");
    }
    assert.ok(caught, `the database accepted: ${sql}`);
    if (expected.constraint) assert.equal(caught.constraint, expected.constraint, caught.message);
    if (expected.code) assert.equal(caught.code, expected.code, caught.message);
  }

  async addCard(displayKey: string | null = null) {
    const id = randomUUID();
    await this.query(
      `INSERT INTO public."AmuxWorkItem" ("id", "title", "displayKey", "updatedAt")
       VALUES ($1, 'display key probe', $2, CURRENT_TIMESTAMP)`,
      [id, displayKey],
    );
    return id;
  }

  async addNode(level: "initiative" | "epic" | "feature", parentId: string | null, displayPrefix: string | null = null) {
    const id = randomUUID();
    await this.query(
      `INSERT INTO public."AmuxPortfolioNode"
       ("id", "level", "parentId", "state", "revision", "titleCiphertext",
        "contentKeyId", "contentKeyVersion", "contentDigest", "contentDigestKeyId",
        "approvedByUserId", "authorizationAuditLogId", "displayPrefix", "updatedAt")
       VALUES ($1, $2, $3, 'active', 0, $4, 'synthetic', 1, $5, 'synthetic',
               'synthetic', $6, $7, CURRENT_TIMESTAMP)`,
      [id, level, parentId, Buffer.from("synthetic-only", "utf8"), "a".repeat(64), randomUUID(), displayPrefix],
    );
    return id;
  }
}

test("numbers start at 001 per prefix and advance by one", async () => {
  const github = freshPrefix();
  const other = freshPrefix();
  assert.equal(await allocate(github), `AMUX-${github}-001`);
  assert.equal(await allocate(github), `AMUX-${github}-002`);
  assert.equal(await allocate(other), `AMUX-${other}-001`);
  assert.equal(await allocate(github), `AMUX-${github}-003`);
});

test("a rolled-back allocation spends no number", async () => {
  const prefix = freshPrefix();
  assert.equal(await allocate(prefix), `AMUX-${prefix}-001`);
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      assert.equal(await allocateAmuxCardDisplayKey(tx, prefix), `AMUX-${prefix}-002`);
      throw new Rollback("caller failed after allocating");
    }),
    Rollback,
  );
  assert.equal(await allocate(prefix), `AMUX-${prefix}-002`);
});

test("concurrent allocations of one prefix never share a number", async () => {
  const prefix = freshPrefix();
  const keys = await Promise.all(
    Array.from({ length: 6 }, () =>
      prisma.$transaction(async (tx) => {
        const key = await allocateAmuxCardDisplayKey(tx, prefix);
        // Hold the counter row so the others queue behind it.
        await tx.$executeRaw`SELECT pg_sleep(0.05)`;
        return key;
      }),
    ),
  );
  assert.deepEqual([...keys].sort(), [1, 2, 3, 4, 5, 6].map((n) => `AMUX-${prefix}-00${n}`));
});

test("the allocator refuses a malformed prefix before touching the database", async () => {
  for (const prefix of ["github", "A", "GIT-HUB", ""]) {
    await assert.rejects(allocate(prefix), /prefix is invalid/);
  }
});

test("the counter only starts at one, only advances by one and is never removed", async () => {
  const prefix = freshPrefix();
  await allocate(prefix);
  await inRolledBackTransaction(async (db) => {
    const sequence = { constraint: "AmuxCardDisplayKeyCounter_sequence_check" };
    await db.rejects(`INSERT INTO public."AmuxCardDisplayKeyCounter" ("prefix", "lastNumber") VALUES ($1, 5)`,
      [freshPrefix()], sequence);
    await db.rejects(`UPDATE public."AmuxCardDisplayKeyCounter" SET "lastNumber" = "lastNumber" + 2 WHERE "prefix" = $1`,
      [prefix], sequence);
    await db.rejects(`UPDATE public."AmuxCardDisplayKeyCounter" SET "lastNumber" = "lastNumber" - 1 WHERE "prefix" = $1`,
      [prefix], sequence);
    await db.rejects(`UPDATE public."AmuxCardDisplayKeyCounter" SET "prefix" = $2 WHERE "prefix" = $1`,
      [prefix, freshPrefix()], sequence);
    await db.rejects(`DELETE FROM public."AmuxCardDisplayKeyCounter" WHERE "prefix" = $1`, [prefix], sequence);
    await db.rejects(`TRUNCATE TABLE public."AmuxCardDisplayKeyCounter"`, [], sequence);
    await db.rejects(`INSERT INTO public."AmuxCardDisplayKeyCounter" ("prefix", "lastNumber") VALUES ('lower', 1)`,
      [], { constraint: "AmuxCardDisplayKeyCounter_prefix_check" });
    const advanced = await db.query(
      `UPDATE public."AmuxCardDisplayKeyCounter" SET "lastNumber" = "lastNumber" + 1 WHERE "prefix" = $1 RETURNING "lastNumber"`,
      [prefix],
    );
    assert.equal(advanced.rows[0].lastNumber, 2);
  });
  assert.equal(await allocate(prefix), `AMUX-${prefix}-002`);
});

test("a card's number is well formed, unique, and immutable once set", async () => {
  const prefix = freshPrefix();
  await inRolledBackTransaction(async (db) => {
    const format = { constraint: "AmuxWorkItem_displayKey_format_check" };
    for (const bad of [`AMUX-${prefix}-000`, `AMUX-${prefix}-01`, `AMUX-${prefix}-0001`, "AMUX-github-001", "GITHUB-001"]) {
      await db.rejects(
        `INSERT INTO public."AmuxWorkItem" ("id", "title", "displayKey", "updatedAt") VALUES ($1, 'probe', $2, CURRENT_TIMESTAMP)`,
        [randomUUID(), bad], format);
    }

    const unnumbered = await db.addCard();
    // A card without a number may receive one, once.
    await db.query(`UPDATE public."AmuxWorkItem" SET "displayKey" = $2 WHERE "id" = $1`, [unnumbered, `AMUX-${prefix}-001`]);
    // Other columns still change freely.
    await db.query(`UPDATE public."AmuxWorkItem" SET "priority" = 'p1' WHERE "id" = $1`, [unnumbered]);
    const immutable = { constraint: "AmuxWorkItem_displayKey_immutable_check" };
    await db.rejects(`UPDATE public."AmuxWorkItem" SET "displayKey" = $2 WHERE "id" = $1`,
      [unnumbered, `AMUX-${prefix}-002`], immutable);
    await db.rejects(`UPDATE public."AmuxWorkItem" SET "displayKey" = NULL WHERE "id" = $1`, [unnumbered], immutable);
    // Archiving keeps the number.
    await db.query(`UPDATE public."AmuxWorkItem" SET "archivedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [unnumbered]);
    await db.rejects(`UPDATE public."AmuxWorkItem" SET "displayKey" = $2 WHERE "id" = $1`,
      [unnumbered, `AMUX-${prefix}-003`], immutable);

    await db.addCard(`AMUX-${prefix}-1000`);
    await db.rejects(
      `INSERT INTO public."AmuxWorkItem" ("id", "title", "displayKey", "updatedAt") VALUES ($1, 'probe', $2, CURRENT_TIMESTAMP)`,
      [randomUUID(), `AMUX-${prefix}-001`], { constraint: "AmuxWorkItem_displayKey_key" });
  });
});

test("a Feature's prefix is Feature-only, not reserved, unique and immutable once set", async () => {
  await inRolledBackTransaction(async (db) => {
    const initiative = await db.addNode("initiative", null);
    const epic = await db.addNode("epic", initiative);
    const check = { constraint: "AmuxPortfolioNode_displayPrefix_check" };

    await db.rejects(`UPDATE public."AmuxPortfolioNode" SET "displayPrefix" = 'EPICCODE' WHERE "id" = $1`, [epic], check);

    const feature = await db.addNode("feature", epic);
    for (const bad of ["github", "G", "GIT-HUB", "ABCDEFGHIJKLMNOPQ", "ENG", "WORKBOARD", "LEGACY"]) {
      await db.rejects(`UPDATE public."AmuxPortfolioNode" SET "displayPrefix" = $2 WHERE "id" = $1`, [feature, bad], check);
    }
    const prefix = freshPrefix();
    await db.query(`UPDATE public."AmuxPortfolioNode" SET "displayPrefix" = $2 WHERE "id" = $1`, [feature, prefix]);

    const immutable = { constraint: "AmuxPortfolioNode_displayPrefix_immutable_check" };
    await db.rejects(`UPDATE public."AmuxPortfolioNode" SET "displayPrefix" = $2 WHERE "id" = $1`,
      [feature, freshPrefix()], immutable);
    await db.rejects(`UPDATE public."AmuxPortfolioNode" SET "displayPrefix" = NULL WHERE "id" = $1`, [feature], immutable);

    const second = await db.addNode("feature", epic);
    await db.rejects(`UPDATE public."AmuxPortfolioNode" SET "displayPrefix" = $2 WHERE "id" = $1`,
      [second, prefix], { constraint: "AmuxPortfolioNode_displayPrefix_key" });
    await db.addNode("feature", epic, freshPrefix());
  });
});
