import assert from "node:assert/strict";
import test from "node:test";

import { amuxCliUnmeasuredRateLowerBound } from
  "../lib/amux/adminCliUsageSummary.ts";

test("coverage is a lower bound, not an invented exact call count", () => {
  assert.equal(amuxCliUnmeasuredRateLowerBound(0, 0, 0), 0);
  assert.equal(amuxCliUnmeasuredRateLowerBound(5, 1, 5), 0.6);
  assert.equal(amuxCliUnmeasuredRateLowerBound(2, 2, 0), 1);
  assert.equal(amuxCliUnmeasuredRateLowerBound(0, 0, 1), 1);
});
