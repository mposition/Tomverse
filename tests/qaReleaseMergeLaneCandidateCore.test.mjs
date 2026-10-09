import assert from "node:assert/strict";
import test from "node:test";

import { pickQaReleaseLaneCandidate } from "../lib/qaReleaseMergeLaneCandidateCore.ts";

const GREEN = [
  { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "PR Fast Gate" },
];

const pr = (number, overrides = {}) => ({
  number,
  createdAt: `2026-10-03T0${number % 10}:00:00Z`,
  baseRefName: "develop",
  headRefName: `claude/to-develop/feature-${number}`,
  headRefOid: String(number).padStart(40, "a"),
  isDraft: false,
  mergeable: "MERGEABLE",
  state: "OPEN",
  statusCheckRollup: GREEN,
  ...overrides,
});

const CLEAR = { excluded: false };
const judged = (entries) => new Map(entries);

test("the oldest ready, unexcluded pull request into develop is picked", () => {
  const result = pickQaReleaseLaneCandidate([pr(3), pr(1), pr(2)], judged([[1, CLEAR], [2, CLEAR], [3, CLEAR]]));
  assert.equal(result.pick?.number, 1);
  assert.deepEqual(result.skipped, []);
});

test("an excluded pull request is skipped with its reasons and does not hold up the next", () => {
  const result = pickQaReleaseLaneCandidate(
    [pr(1), pr(2)],
    judged([[1, { excluded: true, reasons: ["gate_path"] }], [2, CLEAR]]),
  );
  assert.equal(result.pick?.number, 2);
  assert.deepEqual(result.skipped, [{ number: 1, kind: "excluded", reasons: ["gate_path"] }]);
});

test("a pull request with no exclusion judgement is skipped, never picked", () => {
  const result = pickQaReleaseLaneCandidate([pr(1)], judged([]));
  assert.equal(result.pick, null);
  assert.deepEqual(result.skipped, [{ number: 1, kind: "exclusion_unjudged" }]);
});

test("readiness is the merge train's own rule: draft, red, pending and unmergeable are skipped", () => {
  const result = pickQaReleaseLaneCandidate(
    [
      pr(1, { isDraft: true }),
      pr(2, { statusCheckRollup: [{ ...GREEN[0], conclusion: "FAILURE" }] }),
      pr(3, { statusCheckRollup: [{ ...GREEN[0], status: "IN_PROGRESS", conclusion: null }] }),
      pr(4, { mergeable: "CONFLICTING" }),
      pr(5, { statusCheckRollup: [{ ...GREEN[0], workflowName: "Something else" }] }),
      pr(6),
    ],
    judged([1, 2, 3, 4, 5, 6].map((n) => [n, CLEAR])),
  );
  assert.equal(result.pick?.number, 6);
  assert.deepEqual(
    result.skipped.map((skip) => [skip.number, skip.reason]),
    [
      [1, "draft"],
      [2, "checks_failed"],
      [3, "checks_pending"],
      [4, "mergeable_conflicting"],
      [5, "checks_missing_required"],
    ],
  );
});

test("only develop is a lane branch: a main pull request is never a candidate", () => {
  const result = pickQaReleaseLaneCandidate([pr(1, { baseRefName: "main" })], judged([[1, CLEAR]]));
  assert.deepEqual(result, { pick: null, skipped: [] });
});

test("ties on creation time fall back to the pull request number, and the input is not reordered", () => {
  const input = [pr(9, { createdAt: "2026-10-03T00:00:00Z" }), pr(4, { createdAt: "2026-10-03T00:00:00Z" })];
  const result = pickQaReleaseLaneCandidate(input, judged([[9, CLEAR], [4, CLEAR]]));
  assert.equal(result.pick?.number, 4);
  assert.deepEqual(input.map((p) => p.number), [9, 4]);
});
