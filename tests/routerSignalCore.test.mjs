import assert from "node:assert/strict";
import test from "node:test";

import {
  DISPATCH_OUTCOMES_COUNTED,
  summariseDispatchSignals,
  toTieBreakSignalMaps,
} from "../lib/routerSignalCore.ts";

/**
 * The Router's two measured tie-break signals.
 *
 * What these are about is not arithmetic; it is which observations are allowed
 * to count. A success rate that quietly includes attempts the user cancelled,
 * or a p95 taken over four points, is a number that looks like evidence and is
 * not one.
 */

const thresholds = { minSuccessObservations: 3, minTtftObservations: 3 };

const attempts = (modelId, outcome, count, ttftMs = null) =>
  Array.from({ length: count }, () => ({ modelId, outcome, ttftMs }));

test("only outcomes that describe the model are counted", () => {
  // not_dispatched never reached a provider, cancelled is the person changing
  // their mind, pending has not ended, and unknown_after_dispatch is a crash
  // that says nothing either way. None of them is evidence about the model.
  const summarised = summariseDispatchSignals(
    [
      ...attempts("m", "succeeded", 3),
      ...attempts("m", "not_dispatched", 10),
      ...attempts("m", "cancelled", 10),
      ...attempts("m", "pending", 10),
      ...attempts("m", "unknown_after_dispatch", 10),
    ],
    thresholds
  );
  assert.equal(summarised.get("m").countedAttempts, 3);
  assert.equal(summarised.get("m").successRate, 1);
});

test("the counted set is the one the module declares", () => {
  for (const outcome of DISPATCH_OUTCOMES_COUNTED) {
    const summarised = summariseDispatchSignals(
      attempts("m", outcome, 3),
      thresholds
    );
    assert.equal(summarised.get("m").countedAttempts, 3, outcome);
  }
});

test("a failure counts against the rate without ending it", () => {
  const summarised = summariseDispatchSignals(
    [
      ...attempts("m", "succeeded", 3),
      ...attempts("m", "failed_pre_token", 1),
    ],
    thresholds
  );
  assert.equal(summarised.get("m").countedAttempts, 4);
  assert.equal(summarised.get("m").successRate, 0.75);
});

// The rule the whole design rests on: too few observations means no number,
// not a provisional one. A model nobody has dispatched has not failed.
test("an under-sampled model gets no rate and no percentile", () => {
  const summarised = summariseDispatchSignals(
    attempts("m", "succeeded", 2, 100),
    thresholds
  );
  assert.equal(summarised.get("m").countedAttempts, 2);
  assert.equal(summarised.get("m").successRate, null);
  assert.equal(summarised.get("m").ttftP95Ms, null);
});

test("a null rate is dropped from the map rather than written as a value", () => {
  // An absent key is what makes the criterion abstain. A key holding null
  // would rely on `typeof null !== "number"` catching it downstream, which is
  // a coincidence rather than a contract.
  const maps = toTieBreakSignalMaps(
    summariseDispatchSignals(
      [
        ...attempts("enough", "succeeded", 3, 100),
        ...attempts("sparse", "succeeded", 1, 100),
      ],
      thresholds
    )
  );
  assert.deepEqual(Object.keys(maps.recentSuccessRateByModelId), ["enough"]);
  assert.deepEqual(Object.keys(maps.ttftP95MsByModelId), ["enough"]);
  assert.equal("sparse" in maps.recentSuccessRateByModelId, false);
});

test("time to first token is measured only where there was one", () => {
  // An attempt that never produced a token is a failure the success rate
  // already counts. Folding it into the latency distribution as a zero, or as
  // the time it took to fail, would make a broken model look fast.
  const summarised = summariseDispatchSignals(
    [
      ...attempts("m", "succeeded", 3, 200),
      ...attempts("m", "failed_pre_token", 3, null),
    ],
    thresholds
  );
  assert.equal(summarised.get("m").countedAttempts, 6);
  assert.equal(summarised.get("m").ttftObservations, 3);
  assert.equal(summarised.get("m").successRate, 0.5);
});

test("a negative or non-finite delay is not an observation", () => {
  const summarised = summariseDispatchSignals(
    [
      { modelId: "m", outcome: "succeeded", ttftMs: -5 },
      { modelId: "m", outcome: "succeeded", ttftMs: Number.NaN },
      { modelId: "m", outcome: "succeeded", ttftMs: Number.POSITIVE_INFINITY },
      { modelId: "m", outcome: "succeeded", ttftMs: 10 },
    ],
    { minSuccessObservations: 1, minTtftObservations: 1 }
  );
  assert.equal(summarised.get("m").countedAttempts, 4);
  assert.equal(summarised.get("m").ttftObservations, 1);
  assert.equal(summarised.get("m").ttftP95Ms, 10);
});

test("the percentile is nearest-rank, the same convention the shadow report uses", () => {
  // Two definitions of a percentile in one repository disagree exactly where
  // these samples live: at the small end.
  const summarised = summariseDispatchSignals(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((ttftMs) => ({
      modelId: "m",
      outcome: "succeeded",
      ttftMs,
    })),
    { minSuccessObservations: 1, minTtftObservations: 1 }
  );
  // ceil(0.95 * 10) = 10 -> the tenth smallest.
  assert.equal(summarised.get("m").ttftP95Ms, 10);
});

test("models are summarised independently", () => {
  const summarised = summariseDispatchSignals(
    [
      ...attempts("fast", "succeeded", 3, 100),
      ...attempts("slow", "succeeded", 3, 9_000),
    ],
    thresholds
  );
  assert.equal(summarised.get("fast").ttftP95Ms, 100);
  assert.equal(summarised.get("slow").ttftP95Ms, 9_000);
});

test("an empty sample produces an empty summary, not a zeroed one", () => {
  const summarised = summariseDispatchSignals([], thresholds);
  assert.equal(summarised.size, 0);
  const maps = toTieBreakSignalMaps(summarised);
  assert.deepEqual(maps.recentSuccessRateByModelId, {});
  assert.deepEqual(maps.ttftP95MsByModelId, {});
});
