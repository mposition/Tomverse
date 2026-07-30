import assert from "node:assert/strict";
import test from "node:test";
import { deriveModelSelectionLimit } from "../lib/modelSelectionLimit.ts";

test("below the cap there is room left and no swap is required", () => {
  const limit = deriveModelSelectionLimit({ selectedCount: 1, maxCount: 3 });
  assert.equal(limit.limitReached, false);
  assert.equal(limit.remainingSlots, 2);
  assert.equal(limit.requiresSwapToAdd, false);
});

test("exactly at the cap is a reached limit, not an overflow", () => {
  const limit = deriveModelSelectionLimit({ selectedCount: 3, maxCount: 3 });
  assert.equal(limit.limitReached, true);
  assert.equal(limit.remainingSlots, 0);
  assert.equal(limit.requiresSwapToAdd, true);
});

test("removing one model reopens a slot", () => {
  const limit = deriveModelSelectionLimit({ selectedCount: 2, maxCount: 3 });
  assert.equal(limit.limitReached, false);
  assert.equal(limit.remainingSlots, 1);
});

test("a selection somehow past the cap never reports negative room", () => {
  const limit = deriveModelSelectionLimit({ selectedCount: 5, maxCount: 3 });
  assert.equal(limit.limitReached, true);
  assert.equal(limit.remainingSlots, 0);
});

test("a nonsensical negative cap is clamped instead of inverting the logic", () => {
  const limit = deriveModelSelectionLimit({ selectedCount: 0, maxCount: -1 });
  assert.equal(limit.maxCount, 0);
  assert.equal(limit.limitReached, true);
  assert.equal(limit.remainingSlots, 0);
});
