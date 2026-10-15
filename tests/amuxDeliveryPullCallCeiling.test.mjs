import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The read-only recovery delivery makes 22 Prisma calls in one transaction:
// setup 1, admission lock + incident 2, safe-stop fence 1, runtime lock 1,
// candidate 1, card/attempt/assignment 3, recovery authority 5, bound proof and
// check 2, lease update 1, canonical audit 4 (chain lock, clock, previous
// entry, insert), commit fence 1. The base deliveryPull budget of 9 counts the
// audit as one call. 19 refused the first production recovery delivery at its
// 20th call (2026-10-15).
test("the recovery delivery budget covers its 22 calls", () => {
  const boundaries = readFileSync("lib/amux/dbBoundary.ts", "utf8");
  const base = Number(/deliveryPull: \{[\s\S]*?prismaCallCeiling: (\d+)/.exec(boundaries)?.[1]);
  const delivery = readFileSync("lib/amux/delivery.ts", "utf8");
  const extra = /prismaCallCeiling: AMUX_DB_BOUNDARIES\.deliveryPull\.prismaCallCeiling((?: \+ \d+)+) \}/
    .exec(delivery)?.[1];
  assert.ok(base > 0 && extra, "the delivery pull budget expression is present");
  const total = base + extra.split("+").map(Number).reduce((sum, value) => sum + value, 0);
  assert.ok(total >= 22, `recovery delivery budget ${total} is below its 22 calls`);
});
