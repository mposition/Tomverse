import assert from "node:assert/strict";
import test from "node:test";
import {
  measuredNonImageCostMicroUsd,
  reservationOutputCostMicroUsd,
  settledThinkingCostMicroUsd,
} from "../lib/imageGenerationService.ts";

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

test("a request that thought settles the reserved thinking cap, never zero", () => {
  // Review finding 2026-10-19: success settled output + prompt only, so a
  // model with a finite thinking cap released that cap back to the budget.
  assert.equal(settledThinkingCostMicroUsd({ thinkingCapMicroUsd: 2_000 }, 0), 0);
  assert.equal(settledThinkingCostMicroUsd({ thinkingCapMicroUsd: 2_000 }, 512), 2_000);
  // No cap recorded (older snapshot): the caller settles the whole reservation.
  assert.equal(settledThinkingCostMicroUsd({ outputCostMicroUsd: 1 }, 512), null);
  assert.equal(settledThinkingCostMicroUsd(null, 512), null);
});

test("a flat thinking surcharge settles at the cap even when no thinking is reported", () => {
  // fal bills high thinking as a fixed $0.002 on every request that pins it
  // and reports no token counts at all. Reading the missing count as zero
  // settles 80,000 for an image fal bills at 82,000 (policy section 16.8).
  assert.equal(settledThinkingCostMicroUsd({ provider: "fal", thinkingCapMicroUsd: 2_000 }, 0), 2_000);
  assert.equal(settledThinkingCostMicroUsd({ provider: "fal", thinkingCapMicroUsd: 2_000 }, 512), 2_000);
  // Older fal snapshot without a cap: settle the whole reservation, never zero.
  assert.equal(settledThinkingCostMicroUsd({ provider: "fal" }, 0), null);
  // Providers that bill no thinking still settle zero.
  assert.equal(settledThinkingCostMicroUsd({ provider: "openai", thinkingCapMicroUsd: 0 }, 0), 0);
  assert.equal(settledThinkingCostMicroUsd({ provider: "xai", thinkingCapMicroUsd: 0 }, 0), 0);
});

test("a measured Google model settles its cap even when no thinking is reported", () => {
  // Measured 2026-11-12: with the thinking level omitted these models report
  // zero thinking and bill their reasoning text inside the output count, so a
  // zero count is not a zero cost.
  const google = (apiModelId, thinkingCapMicroUsd) => ({
    provider: "google",
    thinkingCapMicroUsd,
    executionProfile: { provider: "google", apiModelId },
  });
  assert.equal(settledThinkingCostMicroUsd(google("gemini-3.1-flash-image", 12_288), 0), 12_288);
  assert.equal(settledThinkingCostMicroUsd(google("gemini-3.1-flash-lite-image", 6_144), 900), 6_144);
  // An unmeasured Google model keeps the general rule.
  assert.equal(settledThinkingCostMicroUsd(google("gemini-3-pro-image", 2_000), 0), 0);
});

test("fal settles thinking by the endpoint the reservation froze", () => {
  // fal bills per endpoint, and settlement reads the endpoint from the
  // reservation's executionProfile -- the request it priced -- never the live
  // profile.
  const fal = (apiModelId, thinkingCapMicroUsd) => ({
    provider: "fal",
    thinkingCapMicroUsd,
    executionProfile: { provider: "fal", apiModelId },
  });
  // Nano Banana 2: the flat surcharge is owed whatever the count says.
  assert.equal(settledThinkingCostMicroUsd(fal("fal-ai/nano-banana-2", 2_000), 0), 2_000);
  // Qwen Image 3 is priced per image: nothing is owed for thinking, and a
  // cap a revision stated as margin is not settled as cost.
  assert.equal(settledThinkingCostMicroUsd(fal("alibaba/qwen-image-3/text-to-image", 0), 0), 0);
  assert.equal(settledThinkingCostMicroUsd(fal("alibaba/qwen-image-3/text-to-image", 3_000), 0), 0);
  assert.equal(settledThinkingCostMicroUsd(fal("alibaba/qwen-image-3/text-to-image", null), 0), 0);
  // Token-billed or unlisted: fal's zero count proves nothing, so the cap --
  // never zero -- and with no cap, the whole reservation.
  assert.equal(settledThinkingCostMicroUsd(fal("google/nano-banana-2.1", 2_000), 0), 2_000);
  assert.equal(settledThinkingCostMicroUsd(fal("fal-ai/flux/dev", 2_000), 0), 2_000);
  assert.equal(settledThinkingCostMicroUsd(fal("fal-ai/flux/dev", null), 0), null);
  // A snapshot from before executionProfile existed was Nano Banana 2's.
  assert.equal(settledThinkingCostMicroUsd({ provider: "fal", thinkingCapMicroUsd: 2_000, executionProfile: null }, 0), 2_000);
});

test("a measured Google response past its bound settles what it billed, not the cap", () => {
  // Review finding 2026-11-13: settling the cap for a response that billed
  // more would hide the overage from the provider budget, which is the one
  // deterministic stop once a measured bound stops holding.
  const flash = {
    provider: "google",
    thinkingCapMicroUsd: 12_288,
    executionProfile: { provider: "google", apiModelId: "gemini-3.1-flash-image" },
  };
  // At or under the bound (4,096 tokens at $3.00 per 1M): the cap.
  assert.equal(settledThinkingCostMicroUsd(flash, 0, 468), 12_288);
  assert.equal(settledThinkingCostMicroUsd(flash, 0, 4_096), 12_288);
  // Past it: the tokens at the text rate.
  assert.equal(settledThinkingCostMicroUsd(flash, 0, 10_000), 30_000);
  // No count reported: the cap, never zero.
  assert.equal(settledThinkingCostMicroUsd(flash, 0, null), 12_288);
  assert.equal(settledThinkingCostMicroUsd(flash, 0), 12_288);

  assert.equal(measuredNonImageCostMicroUsd(flash, 1_815), 5_445);
  const lite = { provider: "google", executionProfile: { apiModelId: "gemini-3.1-flash-lite-image" } };
  assert.equal(measuredNonImageCostMicroUsd(lite, 1_815), 2_723);
  // Not a measured model, or no count: nothing to price.
  assert.equal(measuredNonImageCostMicroUsd({ provider: "google", executionProfile: { apiModelId: "gemini-3-pro-image" } }, 1_815), null);
  assert.equal(measuredNonImageCostMicroUsd({ provider: "openai", executionProfile: { apiModelId: "gpt-image-2" } }, 1_815), null);
  assert.equal(measuredNonImageCostMicroUsd(flash, null), null);
  assert.equal(measuredNonImageCostMicroUsd(flash, -1), null);
  assert.equal(measuredNonImageCostMicroUsd(null, 10), null);
});
