import assert from "node:assert/strict";
import test from "node:test";

import {
  clearImageGenerationSignal,
  recordImageGenerationSignal,
  type ImageSignalDb,
} from "@/lib/imageGenerationSignals";

// The signal writer against an in-memory stand-in for the calls it makes. The
// same rules run against a real database in
// tests/integration/image-generation-signals.db.test.ts.

type Row = { userId: string; generationId: string; kind: string };

function fakeDb(generations: { id: string; userId: string; groupId: string }[]) {
  const rows: Row[] = [];
  const matches = (row: Row, where: Record<string, unknown>) => {
    if (where.userId !== undefined && row.userId !== where.userId) return false;
    if (where.kind !== undefined && row.kind !== where.kind) return false;
    const target = where.generationId;
    if (typeof target === "string" && row.generationId !== target) return false;
    if (target && typeof target === "object" && row.generationId === (target as { not: string }).not) return false;
    const group = (where.generation as { groupId: string } | undefined)?.groupId;
    if (group && generations.find((g) => g.id === row.generationId)?.groupId !== group) return false;
    return true;
  };
  const tables = {
    $queryRaw: async () => [],
    imageGeneration: {
      findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
        generations.find((g) => g.id === where.id && g.userId === where.userId) ?? null,
    },
    imageGenerationSignal: {
      createMany: async ({ data }: { data: Row[] }) => {
        for (const row of data) {
          const exists = rows.some(
            (r) => r.userId === row.userId && r.generationId === row.generationId && r.kind === row.kind
          );
          if (!exists) rows.push({ ...row });
        }
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        for (let i = rows.length - 1; i >= 0; i -= 1) if (matches(rows[i], where)) rows.splice(i, 1);
      },
    },
  };
  const db = {
    ...tables,
    $transaction: async <T,>(run: (tx: typeof tables) => Promise<T>) => run(tables),
  } as unknown as ImageSignalDb;
  return { db, rows };
}

const generations = [
  { id: "g1", userId: "u1", groupId: "grp1" },
  { id: "g2", userId: "u1", groupId: "grp1" },
  { id: "g3", userId: "u2", groupId: "grp2" },
];

test("another user's generation is refused and nothing is written", async () => {
  const { db, rows } = fakeDb(generations);
  const result = await recordImageGenerationSignal({ userId: "u1", generationId: "g3", kind: "helpful" }, db);
  assert.deepEqual(result, { ok: false, reason: "not_found" });
  assert.equal(rows.length, 0);
  assert.deepEqual(
    await recordImageGenerationSignal({ userId: "u1", generationId: "missing", kind: "helpful" }, db),
    { ok: false, reason: "not_found" }
  );
  assert.deepEqual(
    await clearImageGenerationSignal({ userId: "u1", generationId: "g3", kind: "helpful" }, db),
    { ok: false, reason: "not_found" }
  );
});

test("recording the same signal twice leaves one row", async () => {
  const { db, rows } = fakeDb(generations);
  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(
      await recordImageGenerationSignal({ userId: "u1", generationId: "g1", kind: "download" }, db),
      { ok: true }
    );
  }
  assert.equal(rows.length, 1);
});

test("helpful and not_helpful replace each other, other kinds are left alone", async () => {
  const { db, rows } = fakeDb(generations);
  await recordImageGenerationSignal({ userId: "u1", generationId: "g1", kind: "wanted_text" }, db);
  await recordImageGenerationSignal({ userId: "u1", generationId: "g1", kind: "helpful" }, db);
  await recordImageGenerationSignal({ userId: "u1", generationId: "g1", kind: "not_helpful" }, db);
  assert.deepEqual(rows.map((r) => r.kind).sort(), ["not_helpful", "wanted_text"]);
  await recordImageGenerationSignal({ userId: "u1", generationId: "g1", kind: "helpful" }, db);
  assert.deepEqual(rows.map((r) => r.kind).sort(), ["helpful", "wanted_text"]);
});

test("choosing a result moves the earlier choice in the same group only", async () => {
  const { db, rows } = fakeDb(generations);
  await recordImageGenerationSignal({ userId: "u2", generationId: "g3", kind: "selected" }, db);
  await recordImageGenerationSignal({ userId: "u1", generationId: "g1", kind: "selected" }, db);
  await recordImageGenerationSignal({ userId: "u1", generationId: "g2", kind: "selected" }, db);
  assert.deepEqual(
    rows
      .filter((r) => r.kind === "selected")
      .map((r) => `${r.userId}:${r.generationId}`)
      .sort(),
    ["u1:g2", "u2:g3"]
  );
});

test("taking a signal back removes only that kind and tolerates a missing one", async () => {
  const { db, rows } = fakeDb(generations);
  await recordImageGenerationSignal({ userId: "u1", generationId: "g1", kind: "helpful" }, db);
  await recordImageGenerationSignal({ userId: "u1", generationId: "g1", kind: "wanted_text" }, db);
  assert.deepEqual(await clearImageGenerationSignal({ userId: "u1", generationId: "g1", kind: "helpful" }, db), {
    ok: true,
  });
  assert.deepEqual(await clearImageGenerationSignal({ userId: "u1", generationId: "g1", kind: "helpful" }, db), {
    ok: true,
  });
  assert.deepEqual(
    rows.map((r) => r.kind),
    ["wanted_text"]
  );
});
