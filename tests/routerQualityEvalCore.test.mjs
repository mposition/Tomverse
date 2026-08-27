import assert from "node:assert/strict";
import test from "node:test";

import {
  EXCLUSION_CEILING,
  PAIRED_EVALUATION_UNIT,
  cellShortfalls,
  computeWinRateDelta,
  evaluateRouterQualityRun,
  evaluationRecordProblems,
  measurePositionBias,
  pairScore,
  requiredSampleSize,
  routedAwayRate,
  seededRandom,
  summariseExclusions,
} from "../lib/routerQualityEvalCore.ts";

// ROUTE-01 turns on one number and the rules that decide whether the number
// means anything. These tests are mostly about the second half: a run that
// produced a delta but should not be quoted is the failure that costs a
// launch decision, and it is invisible unless something refuses it.

let sequence = 0;
const pair = (overrides = {}) => ({
  itemId: `item-${(sequence += 1)}`,
  stratum: "general",
  cell: "ko",
  autoModelId: "deepseek-v4-flash",
  baselineModelId: "gpt-5-6-luna",
  autoPosition: "first",
  outcome: { status: "judged", verdict: "equivalent" },
  ...overrides,
});

const judged = (verdict, count, overrides = {}) =>
  Array.from({ length: count }, () =>
    pair({ outcome: { status: "judged", verdict }, ...overrides })
  );

const excluded = (reason, count) =>
  Array.from({ length: count }, () => pair({ outcome: { status: "excluded", reason } }));

test("a verdict becomes +1, -1 or 0, and no verdict becomes null", () => {
  assert.equal(pairScore(pair({ outcome: { status: "judged", verdict: "auto" } })), 1);
  assert.equal(pairScore(pair({ outcome: { status: "judged", verdict: "baseline" } })), -1);
  assert.equal(pairScore(pair()), 0);
  assert.equal(
    pairScore(pair({ outcome: { status: "excluded", reason: "no_candidate" } })),
    null
  );
});

// The mistake this measurement is most often reported with. Dropping ties
// rescales 2 wins and 2 losses out of 100 into "50% versus 50%" of four
// items, and the interval that comes out describes a set nobody evaluated.
test("ties score zero and stay in the denominator", () => {
  const delta = computeWinRateDelta([
    ...judged("auto", 2),
    ...judged("baseline", 2),
    ...judged("equivalent", 96),
  ]);

  assert.equal(delta.n, 100);
  assert.equal(delta.ties, 96);
  assert.equal(delta.pointEstimatePp, 0);
  assert.equal(delta.discordantPairs, 4);
  assert.equal(delta.discordanceRate, 0.04);
});

test("an all-win set is +100pp and an all-loss set is -100pp", () => {
  assert.equal(computeWinRateDelta(judged("auto", 40)).pointEstimatePp, 100);
  assert.equal(computeWinRateDelta(judged("baseline", 40)).pointEstimatePp, -100);
});

// The closed form has to reproduce the sizing table in §3 of the procedure
// doc, or the collection plan built on that table is sized against different
// arithmetic than the harness reports.
test("the normal interval matches the sizing table the collection plan was built on", () => {
  const delta = computeWinRateDelta(
    [...judged("auto", 25), ...judged("baseline", 25), ...judged("equivalent", 450)],
    { method: "normal_approximation" }
  );

  assert.equal(delta.n, 500);
  assert.equal(delta.discordanceRate, 0.1);
  // §3: 10% discordance at n = 500 is a ±2.8pp half-width.
  const halfWidth = (delta.ci95UpperPp - delta.ci95LowerPp) / 2;
  assert.ok(
    Math.abs(halfWidth - 2.8) < 0.1,
    `half-width was ${halfWidth.toFixed(2)}pp, table says 2.8pp`
  );
  assert.equal(delta.seed, null, "the closed form consumes no seed");
});

test("the sample size needed for a ±2pp interval matches the table too", () => {
  // §3: ~960 items at 10% discordance, ~1,920 at 20%, ~3,840 at 40%.
  assert.ok(Math.abs(requiredSampleSize(0.1) - 960) <= 2);
  assert.ok(Math.abs(requiredSampleSize(0.2) - 1_920) <= 3);
  assert.ok(Math.abs(requiredSampleSize(0.4) - 3_840) <= 5);
  // A wider margin buys a smaller set, which is why widening it is a
  // threshold change and not a scheduling decision.
  assert.ok(requiredSampleSize(0.2, 4) < requiredSampleSize(0.2, 2));
});

test("a discordance of zero needs no sample size, and says so", () => {
  assert.ok(Number.isNaN(requiredSampleSize(0)));
});

// A recorded seed that changed nothing is a decoration, and §9 asks for it
// precisely so the run can be replayed.
test("the same seed replays the same interval and a different seed does not", () => {
  const pairs = [...judged("auto", 30), ...judged("baseline", 20), ...judged("equivalent", 50)];
  const first = computeWinRateDelta(pairs, { seed: 7, resamples: 2_000 });
  const again = computeWinRateDelta(pairs, { seed: 7, resamples: 2_000 });
  const other = computeWinRateDelta(pairs, { seed: 8, resamples: 2_000 });

  assert.equal(first.ci95LowerPp, again.ci95LowerPp);
  assert.equal(first.ci95UpperPp, again.ci95UpperPp);
  assert.equal(first.seed, 7);
  assert.notEqual(first.ci95LowerPp, other.ci95LowerPp);
});

test("the seeded generator is a generator, not a constant", () => {
  const random = seededRandom(1);
  const draws = Array.from({ length: 200 }, random);
  assert.equal(new Set(draws).size > 190, true);
  assert.ok(draws.every((draw) => draw >= 0 && draw < 1));
  assert.deepEqual(draws, Array.from({ length: 200 }, seededRandom(1)));
});

// Two methods that disagreed materially on a large clean sample would mean one
// of them is wrong, and the pre-registration of a method would become a
// choice of answer rather than a choice of estimator.
test("bootstrap and closed form agree on a large sample", () => {
  const pairs = [
    ...judged("auto", 120),
    ...judged("baseline", 80),
    ...judged("equivalent", 800),
  ];
  const boot = computeWinRateDelta(pairs, { seed: 42, resamples: 4_000 });
  const normal = computeWinRateDelta(pairs, { method: "normal_approximation" });

  assert.equal(boot.pointEstimatePp, normal.pointEstimatePp);
  assert.ok(Math.abs(boot.ci95LowerPp - normal.ci95LowerPp) < 0.5);
  assert.ok(Math.abs(boot.ci95UpperPp - normal.ci95UpperPp) < 0.5);
});

test("one judged pair yields no interval rather than a certain one", () => {
  const delta = computeWinRateDelta(judged("auto", 1));
  assert.equal(delta.n, 1);
  assert.ok(Number.isNaN(delta.ci95LowerPp));
  assert.ok(Number.isNaN(delta.ci95UpperPp));
});

test("exclusions are counted by reason, because they are not the same event", () => {
  const summary = summariseExclusions([
    ...judged("equivalent", 90),
    ...excluded("no_candidate", 6),
    ...excluded("self_identified", 4),
  ]);

  assert.equal(summary.total, 10);
  assert.equal(summary.rate, 0.1);
  assert.equal(summary.byReason.no_candidate, 6);
  assert.equal(summary.byReason.self_identified, 4);
  assert.equal(summary.byReason.judge_failed, 0);
});

// Excluded pairs are not evidence about their cell, so they cannot fill it.
test("a cell is short when its judged pairs are short, not its collected ones", () => {
  const shortfalls = cellShortfalls(
    [
      ...judged("equivalent", 8, { stratum: "coding", cell: "ko" }),
      ...excluded("auto_arm_failed", 5).map((item) => ({
        ...item,
        stratum: "coding",
        cell: "ko",
      })),
      ...judged("equivalent", 10, { stratum: "coding", cell: "en" }),
    ],
    [
      { stratum: "coding", cell: "ko", target: 10 },
      { stratum: "coding", cell: "en", target: 10 },
    ]
  );

  assert.equal(shortfalls.length, 1);
  assert.equal(shortfalls[0].cell, "ko");
  assert.equal(shortfalls[0].judged, 8);
});

test("position preference is measured over decided pairs only", () => {
  const bias = measurePositionBias([
    ...judged("auto", 6, { autoPosition: "first" }),
    ...judged("baseline", 4, { autoPosition: "second" }),
    ...judged("equivalent", 50, { autoPosition: "first" }),
  ]);

  // Every decided pair happened to favour whichever answer came first.
  assert.equal(bias.decided, 10);
  assert.equal(bias.preferredFirst, 10);
  assert.equal(bias.firstRate, 1);
});

test("the randomisation balance is reported so an unbalanced seed is visible", () => {
  const bias = measurePositionBias([
    ...judged("equivalent", 30, { autoPosition: "first" }),
    ...judged("equivalent", 10, { autoPosition: "second" }),
  ]);
  assert.equal(bias.autoFirstRate, 0.75);
});

test("routing away from the baseline is counted over judged pairs", () => {
  const rate = routedAwayRate([
    ...judged("equivalent", 30, { autoModelId: "gpt-5-6-luna" }),
    ...judged("equivalent", 10, { autoModelId: "deepseek-v4-flash" }),
    ...excluded("no_candidate", 20),
  ]);
  assert.equal(rate, 0.25);
});

const cleanRun = () => [
  ...judged("auto", 30, { stratum: "general", cell: "ko" }),
  ...judged("baseline", 28, { stratum: "general", cell: "ko" }),
  ...judged("equivalent", 142, { stratum: "general", cell: "ko" }),
];

test("a clean run is measured and states whether it clears the margin", () => {
  const verdict = evaluateRouterQualityRun({
    pairs: cleanRun(),
    cellTargets: [{ stratum: "general", cell: "ko", target: 200 }],
    preRegisteredSampleSize: 200,
    seed: 11,
    resamples: 2_000,
  });

  assert.equal(verdict.outcome, "measured");
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.delta.n, 200);
  assert.equal(typeof verdict.meetsMargin, "boolean");
});

// The rule that stops "the exclusions were a bit high, but the delta was
// +3pp" from ever being an argument anybody makes.
test("an underpowered or disqualified run reports no pass or fail at all", () => {
  const short = evaluateRouterQualityRun({
    pairs: cleanRun(),
    cellTargets: [{ stratum: "general", cell: "ko", target: 400 }],
    seed: 1,
    resamples: 500,
  });

  assert.equal(short.outcome, "underpowered");
  assert.equal(short.meetsMargin, null);
  assert.match(short.reasons[0], /below target/);
  // The delta is still computed and reported; what it is not is a verdict.
  assert.equal(short.delta.n, 200);
});

test("a run below its pre-registered size is underpowered even with full cells", () => {
  const verdict = evaluateRouterQualityRun({
    pairs: cleanRun(),
    preRegisteredSampleSize: 960,
    seed: 1,
    resamples: 500,
  });

  assert.equal(verdict.outcome, "underpowered");
  assert.match(verdict.reasons.join(" "), /pre-registered 960/);
});

// The exclusions land on one arm, so the survivors are the questions Auto
// managed to answer rather than a sample of the set.
test("exclusions above the ceiling make the run inconclusive, not smaller", () => {
  const verdict = evaluateRouterQualityRun({
    pairs: [...judged("equivalent", 90), ...excluded("no_candidate", 10)],
    seed: 1,
    resamples: 500,
  });

  assert.equal(verdict.outcome, "inconclusive");
  assert.equal(verdict.meetsMargin, null);
  assert.match(verdict.reasons.join(" "), /excluded/);
  assert.ok(EXCLUSION_CEILING < 0.5, "an arm-asymmetric failure needs a tight ceiling");
});

test("a few exclusions are tolerated, because a perfect run is not the bar", () => {
  const verdict = evaluateRouterQualityRun({
    pairs: [...judged("equivalent", 98), ...excluded("judge_failed", 2)],
    seed: 1,
    resamples: 500,
  });
  assert.equal(verdict.outcome, "measured");
});

test("a judge that reads position rather than quality disqualifies the run", () => {
  const verdict = evaluateRouterQualityRun({
    pairs: [
      ...judged("auto", 45, { autoPosition: "first" }),
      ...judged("baseline", 45, { autoPosition: "second" }),
      ...judged("equivalent", 10),
    ],
    seed: 1,
    resamples: 500,
  });

  assert.equal(verdict.outcome, "inconclusive");
  assert.match(verdict.reasons.join(" "), /position/);
});

test("no pairs, and all-excluded pairs, are both reported as not run", () => {
  assert.equal(evaluateRouterQualityRun({ pairs: [] }).outcome, "not_run");
  assert.equal(
    evaluateRouterQualityRun({ pairs: excluded("auto_arm_failed", 12) }).outcome,
    "not_run"
  );
});

// A Router that never routes away is non-inferior and should pass. It is the
// reading of that pass that needs the number beside it.
test("a Router that always picks the baseline passes, and the report says why", () => {
  const verdict = evaluateRouterQualityRun({
    pairs: judged("equivalent", 200, { autoModelId: "gpt-5-6-luna" }),
    seed: 3,
    resamples: 1_000,
  });

  assert.equal(verdict.outcome, "measured");
  assert.equal(verdict.meetsMargin, true);
  assert.equal(verdict.routedAwayRate, 0);
});

const record = (overrides = {}) => ({
  evaluationSetVersion: "router-eval-set-2026-08-01",
  cellCounts: { "general/ko": 200 },
  startedAt: "2026-08-10T00:00:00.000Z",
  baseline: {
    modelId: "gpt-5-6-luna",
    catalogueVersion: "catalogue-2026-08-01",
    preRegisteredAt: "2026-08-01T00:00:00.000Z",
  },
  versions: {
    router: "router-decision-v1",
    estimator: "generic_multilingual_v1",
    planner: "none",
    template: "judge-rubric-v1",
  },
  sampleSize: 200,
  discordantPairs: 58,
  pairedUnit: PAIRED_EVALUATION_UNIT,
  ciMethod: "bootstrap_percentile",
  seed: 11,
  pointEstimatePp: 1,
  ci95LowerPp: -1.4,
  ci95UpperPp: 3.4,
  judge: { identity: "human-panel-a", isRoutableModel: false, biasMeasurement: null },
  exclusions: [],
  ...overrides,
});

test("a complete record has nothing to report", () => {
  assert.deepEqual(evaluationRecordProblems(record()), []);
});

test("every field §9 lists is required, one at a time", () => {
  for (const field of [
    "evaluationSetVersion",
    "cellCounts",
    "startedAt",
    "sampleSize",
    "discordantPairs",
    "pairedUnit",
    "ciMethod",
    "seed",
    "pointEstimatePp",
    "ci95LowerPp",
    "ci95UpperPp",
    "exclusions",
  ]) {
    const broken = record();
    delete broken[field];
    assert.ok(
      evaluationRecordProblems(broken).length > 0,
      `a report with no ${field} was accepted as decision-grade`
    );
  }
});

test("a number nobody can replay is not evidence", () => {
  const problems = evaluationRecordProblems(record({ seed: null }));
  assert.match(problems.join(" "), /replay/);
});

// §4. Naming the baseline afterwards means naming the comparison that
// flattered Auto, and the dates are in the record, so it is checkable.
test("a baseline pre-registered after the run started is refused", () => {
  const problems = evaluationRecordProblems(
    record({
      baseline: {
        modelId: "gpt-5-6-luna",
        catalogueVersion: "catalogue-2026-08-01",
        preRegisteredAt: "2026-08-11T00:00:00.000Z",
      },
    })
  );
  assert.match(problems.join(" "), /with the answers in hand/);
});

test("a routable model may judge only with its bias measured", () => {
  const unmeasured = evaluationRecordProblems(
    record({ judge: { identity: "gpt-5-6-luna", isRoutableModel: true } }),
    { routableModelIds: ["gpt-5-6-luna", "deepseek-v4-flash"] }
  );
  assert.match(unmeasured.join(" "), /bias measurement/);

  const measured = evaluationRecordProblems(
    record({
      judge: {
        identity: "gpt-5-6-luna",
        isRoutableModel: true,
        biasMeasurement: { heldOutPairs: 120, ownAnswerPreferenceRate: 0.53 },
      },
    }),
    { routableModelIds: ["gpt-5-6-luna"] }
  );
  assert.deepEqual(measured, []);
});

test("a judge named in the routable catalogue is caught even when unflagged", () => {
  const problems = evaluationRecordProblems(
    record({ judge: { identity: "deepseek-v4-flash" } }),
    { routableModelIds: ["deepseek-v4-flash"] }
  );
  assert.match(problems.join(" "), /itself routable/);
});

test("a missing report is a problem rather than an empty pass", () => {
  assert.equal(evaluationRecordProblems(null).length, 1);
  assert.equal(evaluationRecordProblems(undefined).length, 1);
});
