import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

const rawUrl = process.env.TEST_DATABASE_URL?.trim();
const url = rawUrl ? new URL(rawUrl) : null;
if (!url || !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !/^\/[A-Za-z0-9_-]+(?:[_-]test[0-9]*)$/i.test(url.pathname) ||
    url.search !== "" || url.hash !== "" ||
    process.env.DATABASE_URL !== rawUrl ||
    (process.env.DIRECT_DATABASE_URL && process.env.DIRECT_DATABASE_URL !== rawUrl)) {
  throw new Error("REFUSE: AMUX aggregate schema test needs a dedicated loopback test database");
}

const years: number[] = [];
before(async () => {
  const taken = await prisma.$queryRaw<Array<{ year: number }>>`
    SELECT "year" FROM "AmuxCliUsageAggregateFinalization"
    WHERE "providerScopeKey" = 'openai'`;
  const used = new Set(taken.map((row) => row.year));
  while (years.length < 14) {
    const candidate = randomInt(3000, 8000);
    if (!used.has(candidate)) {
      years.push(candidate);
      used.add(candidate);
    }
  }
});
after(async () => { await prisma.$disconnect(); });

async function insertFinalization(
  tx: Prisma.TransactionClient,
  id: string,
  year: number,
  outcome: "published" | "excluded_small" | "empty" = "published",
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "AmuxCliUsageAggregateFinalization"
      ("id", "year", "providerScopeKey", "outcome", "rawInvocationCount",
       "creationXid", "finalizedAt")
    VALUES (${id}, ${year}, 'openai', ${outcome},
      ${outcome === "published" ? 5 : null}, 0,
      '2020-01-01T00:00:00.000Z'::timestamptz)`;
}

async function insertCell(
  tx: Prisma.TransactionClient,
  finalizationId: string,
  year: number,
  overrides: {
    id?: string; month?: string; granularity?: string; modelId?: string | null;
    workerRole?: string | null; invocationCount?: number;
    inputTokens?: bigint | null; unknownInputCount?: number;
  } = {},
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "AmuxCliUsageAggregateCell"
      ("id", "finalizationId", "granularity", "period", "actualModelId",
       "workerRole", "invocationCount", "inputTokens", "outputTokens",
       "cacheReadInputTokens", "cacheCreationInputTokens", "unknownInputCount",
       "unknownOutputCount", "unknownCacheReadCount", "unknownCacheCreationCount",
       "firstRecordedAt")
    VALUES (${overrides.id ?? randomUUID()}, ${finalizationId},
      ${overrides.granularity ?? "month_role"},
      ${`${year}-${overrides.month ?? "01"}`},
      ${overrides.modelId === undefined ? "gpt-6-sol" : overrides.modelId},
      ${overrides.workerRole === undefined ? "implement" : overrides.workerRole},
      ${overrides.invocationCount ?? 5},
      ${overrides.inputTokens === undefined ? BigInt(50) : overrides.inputTokens},
      ${BigInt(25)}, ${BigInt(10)}, NULL,
      ${overrides.unknownInputCount ?? 0}, 0, 0, 5,
      '2020-01-01T00:00:00.000Z'::timestamptz)`;
}

test("provider-year finalization and its cells commit atomically and stay immutable", async () => {
  const id = randomUUID();
  const cellId = randomUUID();
  let transactionXid: bigint | undefined;
  await prisma.$transaction(async (tx) => {
    const xidRows = await tx.$queryRaw<Array<{ xid: bigint }>>`
      SELECT txid_current()::bigint AS xid`;
    transactionXid = xidRows[0].xid;
    await insertFinalization(tx, id, years[0]);
    await insertCell(tx, id, years[0], { id: cellId });
  });
  const stored = await prisma.$queryRaw<Array<{
    creationXid: bigint; finalizedAt: Date; firstRecordedAt: Date;
  }>>`
    SELECT f."creationXid", f."finalizedAt", c."firstRecordedAt"
    FROM "AmuxCliUsageAggregateFinalization" f
    JOIN "AmuxCliUsageAggregateCell" c ON c."finalizationId" = f."id"
    WHERE f."id" = ${id}`;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].creationXid, transactionXid);
  assert.ok(stored[0].finalizedAt.getTime() > Date.parse("2026-01-01T00:00:00Z"));
  assert.ok(stored[0].firstRecordedAt.getTime() > Date.parse("2026-01-01T00:00:00Z"));
  await assert.rejects(prisma.$executeRaw`
    UPDATE "AmuxCliUsageAggregateCell" SET "inputTokens" = 1 WHERE "id" = ${cellId}`,
  /immutable/);
  await assert.rejects(prisma.$executeRaw`
    UPDATE "AmuxCliUsageAggregateFinalization" SET "outcome" = 'empty'
    WHERE "id" = ${id}`, /immutable/);
  await assert.rejects(insertCell(prisma, id, years[0]), /same transaction|must be part/);
  await assert.rejects(prisma.$executeRaw`
    TRUNCATE "AmuxCliUsageAggregateCell"`, /immutable/);
  await assert.rejects(prisma.$executeRaw`
    TRUNCATE "AmuxCliUsageAggregateFinalization", "AmuxCliUsageAggregateCell"`,
  /immutable/);
  await assert.rejects(prisma.$executeRaw`
    TRUNCATE "AmuxCliUsageAggregateFinalization" CASCADE`, /immutable/);
  await assert.rejects(prisma.$executeRaw`
    DELETE FROM "AmuxCliUsageAggregateCell" WHERE "id" = ${cellId}`, /immutable/);
  await assert.rejects(prisma.$executeRaw`
    DELETE FROM "AmuxCliUsageAggregateFinalization" WHERE "id" = ${id}`, /immutable/);
  await assert.rejects(prisma.$executeRaw`
    INSERT INTO "AmuxCliUsageAggregateFinalization"
      ("id", "year", "providerScopeKey", "outcome")
    VALUES (${randomUUID()}, ${years[0]}, 'openai', 'empty')`,
  /year_providerScopeKey_key/);
});

test("published seal without all final cells rolls back at commit", async () => {
  const id = randomUUID();
  await assert.rejects(prisma.$transaction(async (tx) => {
    await insertFinalization(tx, id, years[1]);
  }), /incomplete/);
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*) AS count FROM "AmuxCliUsageAggregateFinalization"
    WHERE "id" = ${id}`;
  assert.equal(rows[0].count, BigInt(0));
});

test("empty and excluded-small seals commit only without cells", async () => {
  const emptyId = randomUUID();
  const smallId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await insertFinalization(tx, emptyId, years[9], "empty");
    await insertFinalization(tx, smallId, years[10], "excluded_small");
  });
  const rows = await prisma.$queryRaw<Array<{ id: string; cellCount: bigint }>>`
    SELECT f."id", count(c."id") AS "cellCount"
    FROM "AmuxCliUsageAggregateFinalization" f
    LEFT JOIN "AmuxCliUsageAggregateCell" c ON c."finalizationId" = f."id"
    WHERE f."id" IN (${emptyId}, ${smallId})
    GROUP BY f."id"`;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.cellCount === BigInt(0)));
});

test("unknown and multi-model leaf labels are distinct stored dimensions", async () => {
  const unknownId = randomUUID();
  const multiId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await insertFinalization(tx, unknownId, years[12]);
    await insertCell(tx, unknownId, years[12], { modelId: "actualModelUnknown" });
    await insertFinalization(tx, multiId, years[13]);
    await insertCell(tx, multiId, years[13], { modelId: "multi_model" });
  });
  const rows = await prisma.$queryRaw<Array<{ finalizationId: string; actualModelId: string }>>`
    SELECT "finalizationId", "actualModelId"
    FROM "AmuxCliUsageAggregateCell"
    WHERE "finalizationId" IN (${unknownId}, ${multiId})`;
  assert.deepEqual(new Map(rows.map((row) => [row.finalizationId, row.actualModelId])),
    new Map([[unknownId, "actualModelUnknown"], [multiId, "multi_model"]]));
});

test("DB refuses a token sum reported by fewer than five calls", async () => {
  const id = randomUUID();
  await assert.rejects(prisma.$transaction(async (tx) => {
    await insertFinalization(tx, id, years[2]);
    await insertCell(tx, id, years[2], {
      inputTokens: BigInt(99), unknownInputCount: 4,
    });
  }), /AmuxCliUsageAggregateCell_token_visibility_check/);
});

test("SET CONSTRAINTS IMMEDIATE cannot consume completeness before a later cell", async () => {
  const id = randomUUID();
  await assert.rejects(prisma.$transaction(async (tx) => {
    await insertFinalization(tx, id, years[3]);
    await insertCell(tx, id, years[3]);
    await tx.$executeRaw`SET CONSTRAINTS "AmuxCliUsageAggregateFinalization_complete" IMMEDIATE`;
    await insertCell(tx, id, years[3], { month: "02" });
  }), /incomplete/);
});

test("sum mismatch and cells under an excluded-small seal fail closed", async () => {
  await assert.rejects(prisma.$transaction(async (tx) => {
    const id = randomUUID();
    await insertFinalization(tx, id, years[4]);
    await insertCell(tx, id, years[4], { invocationCount: 6 });
  }), /incomplete/);
  await assert.rejects(prisma.$transaction(async (tx) => {
    const id = randomUUID();
    await insertFinalization(tx, id, years[5], "excluded_small");
    await insertCell(tx, id, years[5]);
  }), /must be part/);
});

test("period and dimensions remain bound to a single final provider-year", async () => {
  await assert.rejects(prisma.$transaction(async (tx) => {
    const id = randomUUID();
    await insertFinalization(tx, id, years[6]);
    await insertCell(tx, id, years[6] + 1);
  }), /must be part/);
  await assert.rejects(prisma.$transaction(async (tx) => {
    const id = randomUUID();
    await insertFinalization(tx, id, years[7]);
    await insertCell(tx, id, years[7], { granularity: "month" });
  }), /AmuxCliUsageAggregateCell_shape_check/);
  await assert.rejects(prisma.$transaction(async (tx) => {
    const id = randomUUID();
    await insertFinalization(tx, id, years[8]);
    await insertCell(tx, id, years[8], { modelId: null });
  }), /AmuxCliUsageAggregateCell_shape_check/);
  await assert.rejects(prisma.$transaction(async (tx) => {
    const id = randomUUID();
    await insertFinalization(tx, id, years[11]);
    await insertCell(tx, id, years[11], {
      granularity: "month", modelId: null, workerRole: null,
    });
    await insertCell(tx, id, years[11], {
      granularity: "month", modelId: null, workerRole: null,
    });
  }), /AmuxCliUsageAggregateCell_final_dimensions_key/);
});
