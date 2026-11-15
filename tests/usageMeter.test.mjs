import assert from "node:assert/strict";
import test from "node:test";

import {
  USAGE_METER_CEILINGS,
  USAGE_METER_LEVELS,
  approximateUses,
  remainingUses,
  usageMeterLevel,
} from "../lib/usageMeter.ts";

test("chat and image models sit on one five-step scale", () => {
  // Owner decision 2026-11-15. One scale: judged among image models only, a
  // 45-credit image would show fewer bars than a 16-credit chat model.
  assert.equal(USAGE_METER_LEVELS, 5);
  assert.deepEqual([...USAGE_METER_CEILINGS], [2, 8, 24, 60]);
  const levels = (credits) => credits.map(usageMeterLevel);
  assert.deepEqual(levels([1, 2]), [1, 1]);
  assert.deepEqual(levels([4, 8]), [2, 2]);
  assert.deepEqual(levels([12, 16, 20]), [3, 3, 3]);
  // The cheapest image models and the dearest chat models overlap here.
  assert.deepEqual(levels([30, 32, 45, 50, 55]), [4, 4, 4, 4, 4]);
  assert.deepEqual(levels([65, 80, 120, 150]), [5, 5, 5, 5]);
  assert.ok(usageMeterLevel(45) > usageMeterLevel(16));
});

test("remaining uses are what the balance covers, and unknown without a balance", () => {
  assert.equal(remainingUses(3_000, 1), 3_000);
  assert.equal(remainingUses(3_000, 50), 60);
  assert.equal(remainingUses(149, 150), 0);
  assert.equal(remainingUses(0, 1), 0);
  // A part of a use is not a use.
  assert.equal(remainingUses(99, 50), 1);
  for (const balance of [null, undefined, Number.NaN]) assert.equal(remainingUses(balance, 1), null);
  assert.equal(remainingUses(100, 0), null);
});

test("the count is an approximation that never promises more than the balance covers", () => {
  assert.equal(approximateUses(0), 0);
  assert.equal(approximateUses(60), 60);
  assert.equal(approximateUses(99), 99);
  assert.equal(approximateUses(187), 180);
  assert.equal(approximateUses(3_127), 3_100);
  assert.equal(approximateUses(12_999), 12_000);
  for (const uses of [100, 101, 999, 1_000, 54_321]) assert.ok(approximateUses(uses) <= uses);
});
