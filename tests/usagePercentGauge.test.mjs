import assert from "node:assert/strict";
import test from "node:test";
import { usagePercent } from "../components/chat/UsagePercentGauge.tsx";

test("usage gauges show used allowance, clamp outliers and never invent an unlimited denominator", () => {
  assert.equal(usagePercent(68, 3000), 2);
  assert.equal(usagePercent(68, 300), 23);
  assert.equal(usagePercent(400, 300), 100);
  assert.equal(usagePercent(-1, 300), 0);
  for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(usagePercent(10, limit), null);
  assert.equal(usagePercent(Number.NaN, 300), null);
});
