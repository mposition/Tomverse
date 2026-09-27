import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_RECONCILIATION_APPLY_CODE_LATCH,
  AMUX_RECONCILIATION_PRESERVED_CARD,
  amuxReconciliationApplyPermitted,
  classifySourceReconciliation,
} from "../lib/amux/boardReconciliationCore.ts";

const digest = (seed) => seed.padEnd(64, "a").slice(0, 64);
const item = (sourceKey, sectionCode = "investment", detail = sourceKey) => ({
  sourceKey,
  sectionCode,
  detailDigest: digest(detail),
});

const stored = [
  item("AMUX-BOARD-01"),
  item("AMUX-INTAKE-01"),
  ...Array.from({ length: 63 }, (_, index) => item(`ITEM-${index}`)),
];

test("a new board digest is one global drift and does not mark unchanged items", () => {
  const observed = stored.map((entry) => ({ ...entry }));
  const classified = classifySourceReconciliation({
    storedBoardDigest: digest("stored-board"),
    observedBoardDigest: digest("later-board"),
    storedItems: stored,
    observedItems: observed,
  });
  assert.equal(classified.globalSnapshotDrift, 1);
  assert.deepEqual(classified.itemDrift, []);
  assert.equal(classified.itemNoOp.length, 65);
  assert.deepEqual(classified.missing, []);
  assert.deepEqual(classified.extra, []);
});

test("only the two changed detail digests are item drift", () => {
  const observed = stored.map((entry) =>
    entry.sourceKey === "AMUX-BOARD-01" || entry.sourceKey === "AMUX-INTAKE-01"
      ? { ...entry, detailDigest: digest(`${entry.sourceKey}-later`) }
      : { ...entry },
  );
  const classified = classifySourceReconciliation({
    storedBoardDigest: digest("stored-board"),
    observedBoardDigest: digest("later-board"),
    storedItems: stored,
    observedItems: observed,
  });
  assert.equal(classified.globalSnapshotDrift, 1);
  assert.deepEqual(classified.itemDrift, ["AMUX-BOARD-01", "AMUX-INTAKE-01"]);
  assert.equal(classified.itemNoOp.length, 63);
  assert.equal(classified.itemNoOp.includes("AMUX-BOARD-01"), false);
  assert.equal(classified.itemNoOp.includes("AMUX-INTAKE-01"), false);
});

test("a missing key and an extra key stay out of the no-op list", () => {
  const observed = stored.filter((entry) => entry.sourceKey !== "ITEM-0");
  observed.push(item("NEW-ITEM"));
  const classified = classifySourceReconciliation({
    storedBoardDigest: digest("same"),
    observedBoardDigest: digest("same"),
    storedItems: stored,
    observedItems: observed,
  });
  assert.equal(classified.globalSnapshotDrift, 0);
  assert.deepEqual(classified.missing, ["ITEM-0"]);
  assert.deepEqual(classified.extra, ["NEW-ITEM"]);
  assert.equal(classified.itemNoOp.length, 64);
});

test("an accepted revision preserves the backlog card and the latch stays off", () => {
  assert.equal(AMUX_RECONCILIATION_APPLY_CODE_LATCH, false);
  assert.equal(amuxReconciliationApplyPermitted("enabled"), false);
  assert.equal(amuxReconciliationApplyPermitted(undefined), false);
  assert.deepEqual(AMUX_RECONCILIATION_PRESERVED_CARD, {
    status: "backlog",
    kind: "unknown",
    priority: "p3",
    owner: null,
    claimedAt: null,
  });
});
