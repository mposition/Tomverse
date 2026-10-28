import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_DB_COMMIT_RESERVE_MS,
  AmuxDbBoundaryError,
  amuxRouteHasBudgetForMs,
  anchorAmuxRouteDeadline,
  fenceAmuxRouteDeadline,
  withAmuxRouteBudget,
} from "../lib/amux/dbBoundary.ts";

// A transaction that is not a `withAmuxDbBoundary` one (the auto-promotion
// tick's) meets the same route deadline through these three helpers. The
// database clock is faked: each call hands back the next queued row.
const fakeTransaction = (rows) => {
  const calls = [];
  return {
    calls,
    $queryRaw: async (strings, ...values) => {
      calls.push({ sql: strings.join("?"), values });
      if (rows.length === 0) throw new Error("unexpected query");
      return [rows.shift()];
    },
  };
};

const isDeadline = (error) =>
  error instanceof AmuxDbBoundaryError && error.code === "AMUX_DB_DEADLINE_EXCEEDED";

test("outside a route budget nothing is refused and nothing is queried", async () => {
  assert.equal(amuxRouteHasBudgetForMs(Number.MAX_SAFE_INTEGER), true);
  const tx = fakeTransaction([]);
  assert.equal(await anchorAmuxRouteDeadline(tx, 7_200, "test"), null);
  await fenceAmuxRouteDeadline(tx, null, "test");
  assert.equal(tx.calls.length, 0);
});

test("admission counts the time left against the whole maximum a transaction may take", async () => {
  await withAmuxRouteBudget(async () => {
    assert.equal(amuxRouteHasBudgetForMs(9_000), true);
    assert.equal(amuxRouteHasBudgetForMs(10_500), false);
  }, 10_000);
});

test("the route deadline is anchored on the first transaction's database clock and shared by the next", async () => {
  await withAmuxRouteBudget(async () => {
    const first = fakeTransaction([{ dbNowEpochMs: 1_000_000n }]);
    const deadline = await anchorAmuxRouteDeadline(first, 7_200, "test");
    assert.equal(deadline?.getTime(), 1_000_000 + 27_000);
    assert.match(first.calls[0].sql, /clock_timestamp\(\)/);

    // A later transaction with 7.2 s left may start; one with less may not,
    // whatever the local clock says.
    const second = fakeTransaction([{ dbNowEpochMs: 1_000_000n + 19_800n }]);
    assert.equal((await anchorAmuxRouteDeadline(second, 7_200, "test"))?.getTime(), deadline?.getTime());
    const late = fakeTransaction([{ dbNowEpochMs: 1_000_000n + 19_801n }]);
    await assert.rejects(() => anchorAmuxRouteDeadline(late, 7_200, "test"), isDeadline);

    const unreadable = fakeTransaction([{ dbNowEpochMs: null }]);
    await assert.rejects(() => anchorAmuxRouteDeadline(unreadable, 7_200, "test"), isDeadline);
  }, 27_000);
});

test("the fence rolls a transaction back once the database clock reaches the deadline", async () => {
  // The fence records the route deadline less the commit reserve for the
  // COMMIT-time trigger and compares the clock with that same stored value
  // (orchestration policy version 18).
  const deadline = new Date("2026-09-29T00:00:27.000Z");
  const inTime = fakeTransaction([{ withinDeadline: true, commitCheckInstalled: true }]);
  await fenceAmuxRouteDeadline(inTime, deadline, "test");
  assert.equal(inTime.calls.length, 1);
  assert.match(inTime.calls[0].sql, /\?::timestamptz -\s+\? \* INTERVAL '1 millisecond'/);
  assert.match(inTime.calls[0].sql, /INSERT INTO "AmuxCommitDeadline"/);
  assert.match(inTime.calls[0].sql, /clock_timestamp\(\) < marker\."deadline" AS "withinDeadline"/);
  assert.deepEqual(inTime.calls[0].values, [
    deadline.toISOString(),
    AMUX_DB_COMMIT_RESERVE_MS,
    "test",
    "amux_commit_deadline_check",
  ]);

  for (const row of [
    { withinDeadline: false, commitCheckInstalled: true },
    { withinDeadline: null, commitCheckInstalled: true },
  ]) {
    const late = fakeTransaction([row]);
    await assert.rejects(() => fenceAmuxRouteDeadline(late, deadline, "test"), isDeadline);
  }
});

test("the fence refuses when the commit deadline trigger is not there to fire", async () => {
  const deadline = new Date("2026-09-29T00:00:27.000Z");
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    for (const row of [
      { withinDeadline: true, commitCheckInstalled: false },
      { withinDeadline: true, commitCheckInstalled: null },
      { withinDeadline: false, commitCheckInstalled: false },
      {},
    ]) {
      await assert.rejects(
        () => fenceAmuxRouteDeadline(fakeTransaction([row]), deadline, "test"),
        (error) => error instanceof AmuxDbBoundaryError && error.code === "AMUX_DB_COMMIT_CHECK_MISSING",
      );
    }
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 4);
});
