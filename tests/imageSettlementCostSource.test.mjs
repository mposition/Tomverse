import assert from "node:assert/strict";
import test from "node:test";
import { reservationOutputCostMicroUsd } from "../lib/imageGenerationService.ts";

// Settlement used to re-read the live price table and fall back to zero. Both
// halves were wrong in ways that hide: a deploy between reservation and
// settlement rewrote the recorded cost of an already-priced request, and a
// lookup miss recorded the image as free -- understating the cost ledger and
// over-releasing the provider budget at the same time.
//
// The reservation's own snapshot is the answer now, and "cannot answer" is a
// reported incident rather than a default.

test("the cost comes from the reservation's own snapshot", () => {
  assert.equal(
    reservationOutputCostMicroUsd({ outputCostMicroUsd: 53_000, credits: 70 }),
    53_000
  );
});

test("zero is refused, not accepted as a number", () => {
  // No image costs nothing. A zero here is the same corrupt value the old
  // `?? 0` invented, so taking it would reproduce the bug through another
  // door -- the caller falls back to the reserved worst case and reports.
  assert.equal(reservationOutputCostMicroUsd({ outputCostMicroUsd: 0 }), null);
});

test("a missing, malformed or hostile snapshot answers null", () => {
  for (const snapshot of [
    null,
    undefined,
    {},
    "nope",
    7,
    { outputCostMicroUsd: null },
    { outputCostMicroUsd: "53000" },
    { outputCostMicroUsd: Number.NaN },
    { outputCostMicroUsd: Number.POSITIVE_INFINITY },
    { outputCostMicroUsd: -1 },
  ]) {
    assert.equal(
      reservationOutputCostMicroUsd(snapshot),
      null,
      JSON.stringify(snapshot ?? null)
    );
  }
});

test("a snapshot written by an older deploy still answers", () => {
  // Cross-deploy: a reservation made before the tier vocabulary existed
  // carries only the numbers, and those are exactly what settlement needs.
  // Nothing about the key structure is read here, which is why changing that
  // structure cannot disturb an in-flight reservation.
  assert.equal(
    reservationOutputCostMicroUsd({
      credits: 70,
      outputCostMicroUsd: 53_000,
      maxRequestCostMicroUsd: 58_000,
      promptTokenLimit: 1_000,
    }),
    53_000
  );
});
