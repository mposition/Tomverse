import assert from "node:assert/strict";
import test from "node:test";

import { alignVerdicts, compareJudgesAgainstHumans } from "../lib/routerJudgeComparator.ts";

const rec = (pairs, verdicts) => pairs.map((pairId, i) => ({ pairId, verdict: verdicts[i] }));
const ids = (n) => Array.from({ length: n }, (_, i) => `p-${String(i).padStart(3, "0")}`);

test("only pairs all three graded enter the comparison, and duplicates are named", () => {
  const p = ids(4);
  const { aligned, problems } = alignVerdicts({
    human: rec(p, ["auto", "baseline", "equivalent", "auto"]),
    luna: rec(p.slice(0, 3), ["auto", "baseline", "auto"]),
    fable: [...rec(p, ["auto", "auto", "equivalent", "baseline"]), { pairId: p[0], verdict: "auto" }],
  });
  assert.deepEqual(aligned.map((a) => a.pairId), p.slice(0, 3));
  assert.deepEqual(problems, ["Fable grades p-000 twice"]);
});

// The pilot's scale: baseline positive. A judge that agrees with every human
// verdict has zero shift, zero error, full agreement and no inversions.
test("a judge identical to the humans is at distance zero", () => {
  const p = ids(6);
  const v = ["auto", "baseline", "equivalent", "baseline", "auto", "baseline"];
  const { aligned } = alignVerdicts({ human: rec(p, v), luna: rec(p, v), fable: rec(p, v) });
  const r = compareJudgesAgainstHumans(aligned, { seed: 1, resamples: 200 });
  assert.equal(r.humanBaselineMarginPp, (3 - 2) / 6 * 100);
  assert.equal(r.luna.marginErrorPp, 0);
  assert.equal(r.luna.exactAgreement, 1);
  assert.equal(r.luna.oppositeVerdictRate, 0);
  assert.equal(r.selection.outcome, "undecided");
});

test("an inversion is counted only when auto and baseline are swapped", () => {
  const p = ids(4);
  const { aligned } = alignVerdicts({
    human: rec(p, ["auto", "baseline", "equivalent", "auto"]),
    luna: rec(p, ["baseline", "auto", "auto", "equivalent"]),
    fable: rec(p, ["auto", "baseline", "equivalent", "auto"]),
  });
  const r = compareJudgesAgainstHumans(aligned, { seed: 1, resamples: 200 });
  assert.equal(r.luna.oppositeVerdictRate, 2 / 4);
  assert.equal(r.luna.exactAgreement, 0);
});

// Luna sits far from the humans, Fable on top of them: the interval on dD
// must exclude zero and be positive throughout, and the rule prefers Fable.
test("a judge measurably closer is preferred, with the interval reproducible from the seed", () => {
  const p = ids(60);
  const human = p.map((_, i) => (i % 3 === 0 ? "baseline" : "auto"));
  const luna = p.map(() => "baseline");
  const { aligned } = alignVerdicts({ human: rec(p, human), luna: rec(p, luna), fable: rec(p, human) });
  const a = compareJudgesAgainstHumans(aligned, { seed: 20260826, resamples: 2000 });
  const b = compareJudgesAgainstHumans(aligned, { seed: 20260826, resamples: 2000 });
  assert.deepEqual(a.marginErrorDifferenceCi, b.marginErrorDifferenceCi);
  assert.ok(a.marginErrorDifferenceCi.lowerPp > 0, JSON.stringify(a.marginErrorDifferenceCi));
  assert.equal(a.selection.outcome, "preferred");
  assert.equal(a.selection.judgeId, "fable");
  assert.equal(a.selection.activatesSampleSize, false);
});

test("two judges the sample cannot tell apart are undecided, whatever their agreement", () => {
  const p = ids(60);
  const human = p.map((_, i) => (i % 2 === 0 ? "baseline" : "auto"));
  const shuffled = [...human].reverse();
  const { aligned } = alignVerdicts({ human: rec(p, human), luna: rec(p, shuffled), fable: rec(p, shuffled) });
  const r = compareJudgesAgainstHumans(aligned, { seed: 7, resamples: 500 });
  assert.equal(r.selection.outcome, "undecided");
  assert.equal(r.selection.activatesSampleSize, false);
});
