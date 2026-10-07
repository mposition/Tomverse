import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { prisma } from "@/lib/prisma";

// The shared AgentDigestItem table against PostgreSQL, through the migration
// history (20261003000000_agent_digest_item). Every rule the migration header
// lists is exercised here in both directions: what it lets through and what
// it refuses.

const requireDedicatedTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  const runtimeRaw = process.env.DATABASE_URL?.trim();
  if (!testRaw) throw new Error("TEST_DATABASE_URL is required");
  if (runtimeRaw !== testRaw) {
    throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
  }
};
requireDedicatedTestDatabase();

const SHA = "a".repeat(64);
const insertedIds: string[] = [];

after(async () => {
  if (insertedIds.length > 0) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" DISABLE TRIGGER "AgentDigestItem_before_delete"`);
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM "AgentDigestItem" WHERE "id" = ANY($1::uuid[])`, insertedIds);
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" ENABLE TRIGGER "AgentDigestItem_before_delete"`);
    }
  }
  await prisma.$disconnect();
});

type Row = {
  agentKey?: string;
  kind?: string;
  idempotencyKey?: string;
  payload?: unknown;
  sizeBytes?: number;
  payloadSha256?: string;
  bodyDeletedAt?: Date | null;
};

const insert = async (row: Row = {}) => {
  const id = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "AgentDigestItem"
       ("id", "agentKey", "kind", "schemaVersion", "idempotencyKey", "payload", "payloadSha256", "sizeBytes",
        "createdAt", "retentionUntil", "bodyDeletedAt")
     VALUES ($1::uuid, $2, $3, 1, $4, $5::jsonb, $6, $7,
        TIMESTAMPTZ '2000-01-01', TIMESTAMPTZ '2000-01-02', $8)`,
    id,
    row.agentKey ?? "qa-release",
    row.kind ?? "daily_digest",
    row.idempotencyKey ?? `qa-release:${id}`,
    row.payload === undefined ? JSON.stringify({ a: 1 }) : row.payload === null ? null : JSON.stringify(row.payload),
    row.payloadSha256 ?? SHA,
    row.sizeBytes ?? 7,
    row.bodyDeletedAt ?? null,
  );
  insertedIds.push(id);
  return id;
};

const read = async (id: string) =>
  (await prisma.$queryRawUnsafe<
    { createdAt: Date; retentionUntil: Date; payload: unknown; bodyDeletedAt: Date | null }[]
  >(`SELECT "createdAt", "retentionUntil", "payload", "bodyDeletedAt" FROM "AgentDigestItem" WHERE "id" = $1::uuid`, id))[0];

/** Moves a row's clock columns into the past, around the update trigger. */
const backdate = async (id: string, createdAt: string, retentionUntil: string) => {
  await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" DISABLE TRIGGER "AgentDigestItem_before_update"`);
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE "AgentDigestItem" SET "createdAt" = $2::timestamptz, "retentionUntil" = $3::timestamptz WHERE "id" = $1::uuid`,
      id,
      createdAt,
      retentionUntil,
    );
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" ENABLE TRIGGER "AgentDigestItem_before_update"`);
  }
};

test("insert takes createdAt and retentionUntil from the database clock and the agent's retention", async () => {
  const before = Date.now();
  const id = await insert();
  const row = await read(id);
  assert.ok(row.createdAt.getTime() >= before - 60_000, "createdAt is not the client's 2000-01-01");
  const days = (row.retentionUntil.getTime() - row.createdAt.getTime()) / 86_400_000;
  assert.equal(days, 90);
});

test("a row cannot be born without its body", async () => {
  await assert.rejects(insert({ payload: null }), /inserted with their body|body_state/);
  await assert.rejects(insert({ bodyDeletedAt: new Date() }), /inserted with their body|body_state/);
  await assert.rejects(insert({ sizeBytes: 0 }), /inserted with their body|size_bytes/);
});

test("closed agentKey and kind lists", async () => {
  await assert.rejects(insert({ agentKey: "unregistered-agent", idempotencyKey: `unregistered-agent:${randomUUID()}` }), /agent_key|retention/);
  // A registered agent keeps to its own kinds: sre-ops with billing's kind is refused.
  await assert.rejects(
    insert({ agentKey: "sre-ops", kind: "price_deadline_digest", idempotencyKey: `sre-ops:${randomUUID()}` }),
    /kind_check/,
  );
  await assert.rejects(insert({ kind: "page" }), /kind_check/);
});

test("the idempotency key must start with the agent's prefix and carry something after it", async () => {
  await assert.rejects(insert({ idempotencyKey: `sre-ops:${randomUUID()}` }), /idempotency_prefix/);
  await assert.rejects(insert({ idempotencyKey: "qa-release:" }), /idempotency_suffix/);
  await assert.rejects(insert({ idempotencyKey: `qa-releasex${randomUUID()}` }), /idempotency_prefix/);
  const key = `qa-release:${randomUUID()}`;
  await insert({ idempotencyKey: key });
  await assert.rejects(insert({ idempotencyKey: key }), /unique|duplicate/i);
});

test("size and hash are range- and shape-checked", async () => {
  await assert.rejects(insert({ sizeBytes: 16_385 }), /size_bytes/);
  await assert.rejects(insert({ payloadSha256: "A".repeat(64) }), /payload_sha256/);
  await assert.rejects(insert({ payloadSha256: "a".repeat(63) }), /payload_sha256/);
  await insert({ sizeBytes: 16_384 });
});

test("the only update is the body expiry past retention, and it stamps the deletion time", async () => {
  const id = await insert();
  await assert.rejects(
    prisma.$executeRawUnsafe(`UPDATE "AgentDigestItem" SET "payload" = NULL WHERE "id" = $1::uuid`, id),
    /only the expiry/,
  );
  await assert.rejects(
    prisma.$executeRawUnsafe(`UPDATE "AgentDigestItem" SET "payloadSha256" = $2 WHERE "id" = $1::uuid`, id, "b".repeat(64)),
    /immutable/,
  );
  await backdate(id, "2026-01-01T00:00:00Z", "2026-04-01T00:00:00Z");
  await prisma.$executeRawUnsafe(`UPDATE "AgentDigestItem" SET "payload" = NULL WHERE "id" = $1::uuid`, id);
  const row = await read(id);
  assert.equal(row.payload, null);
  assert.ok(row.bodyDeletedAt instanceof Date);
  await assert.rejects(
    prisma.$executeRawUnsafe(`UPDATE "AgentDigestItem" SET "bodyDeletedAt" = now() WHERE "id" = $1::uuid`, id),
    /only the expiry/,
  );
});

test("the only delete is of an expired body more than 365 days old", async () => {
  const fresh = await insert();
  await assert.rejects(
    prisma.$executeRawUnsafe(`DELETE FROM "AgentDigestItem" WHERE "id" = $1::uuid`, fresh),
    /deleted only after/,
  );
  const oldWithBody = await insert();
  await backdate(oldWithBody, "2024-01-01T00:00:00Z", "2024-04-01T00:00:00Z");
  await assert.rejects(
    prisma.$executeRawUnsafe(`DELETE FROM "AgentDigestItem" WHERE "id" = $1::uuid`, oldWithBody),
    /deleted only after/,
  );
  await prisma.$executeRawUnsafe(`UPDATE "AgentDigestItem" SET "payload" = NULL WHERE "id" = $1::uuid`, oldWithBody);
  await prisma.$executeRawUnsafe(`DELETE FROM "AgentDigestItem" WHERE "id" = $1::uuid`, oldWithBody);
  const remaining = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*) AS n FROM "AgentDigestItem" WHERE "id" = $1::uuid`,
    oldWithBody,
  );
  assert.equal(Number(remaining[0].n), 0);
});

test("every identity, hash, size and clock column is frozen, one by one", async () => {
  const id = await insert();
  const changes: [string, string, unknown][] = [
    ["id", "$2::uuid", randomUUID()],
    // The BEFORE trigger runs ahead of the CHECKs, so even a value the CHECK
    // would also refuse is refused by the trigger first.
    ["agentKey", "$2", "sre-ops"],
    ["kind", "$2", "page"],
    ["schemaVersion", "$2::int", 2],
    ["idempotencyKey", "$2", `qa-release:${randomUUID()}`],
    ["payloadSha256", "$2", "b".repeat(64)],
    ["sizeBytes", "$2::int", 8],
    ["createdAt", "$2::timestamptz", "2026-01-01T00:00:00Z"],
    ["retentionUntil", "$2::timestamptz", "2027-01-01T00:00:00Z"],
  ];
  for (const [column, cast, value] of changes) {
    await assert.rejects(
      prisma.$executeRawUnsafe(`UPDATE "AgentDigestItem" SET "${column}" = ${cast} WHERE "id" = $1::uuid`, id, value),
      /immutable/,
      column,
    );
  }
});

test("schemaVersion and the idempotency key length are range-checked", async () => {
  const at = async (schemaVersion: number) => {
    const id = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "AgentDigestItem" ("id", "agentKey", "kind", "schemaVersion", "idempotencyKey", "payload", "payloadSha256", "sizeBytes")
       VALUES ($1::uuid, 'qa-release', 'daily_digest', $2, $3, '{}'::jsonb, $4, 2)`,
      id,
      schemaVersion,
      `qa-release:${id}`,
      SHA,
    );
    insertedIds.push(id);
  };
  await assert.rejects(at(0), /schema_version/);
  await assert.rejects(at(1001), /schema_version/);
  await at(1000);
  await assert.rejects(insert({ idempotencyKey: `qa-release:${"x".repeat(190)}` }), /idempotency_length/);
  await insert({ idempotencyKey: `qa-release:${randomUUID()}${"x".repeat(153)}` });
});
