import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AMUX_IDEA_LANE_FAILURES,
  AMUX_IDEA_LANE_MAX_ATTEMPTS,
  amuxIdeaLaneBranch,
  amuxIdeaLaneClaimable,
  amuxIdeaLaneDailyAttempts,
  amuxIdeaLaneEnabled,
  amuxIdeaLaneState,
  inspectAmuxIdeaLaneResult,
} from "../lib/amux/ideaLaneCore.ts";
import { amuxIdeaProgress } from "../lib/amux/ideaProgressCore.ts";

const NOW = 1_800_000_000_000;
const run = (overrides = {}) => ({ claimedAtMs: NOW - 60_000, leaseUntilMs: NOW + 60_000, outcome: null,
  prNumber: null, ...overrides });
const failed = (minutesAgo, outcome = "cli_failed") =>
  run({ claimedAtMs: NOW - minutesAgo * 60_000, leaseUntilMs: NOW - 1, outcome });
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

test("an idea's runs decide whether the lane runs it again", () => {
  assert.equal(amuxIdeaLaneState([], NOW), null, "an idea the lane never took has no state");
  assert.equal(amuxIdeaLaneClaimable(null), true);
  assert.deepEqual(amuxIdeaLaneState([run()], NOW),
    { state: "running", attempts: 1, prNumber: null, lastOutcome: null });
  const vanished = amuxIdeaLaneState([run({ leaseUntilMs: NOW - 1 })], NOW);
  assert.deepEqual(vanished, { state: "queued", attempts: 1, prNumber: null, lastOutcome: "lease_expired" },
    "a run that never reported is retried, not held for a proof");
  assert.equal(amuxIdeaLaneClaimable(vanished), true);
  assert.deepEqual(amuxIdeaLaneState([failed(30), failed(10, "no_change")], NOW),
    { state: "queued", attempts: 2, prNumber: null, lastOutcome: "no_change" });
  const spent = amuxIdeaLaneState(Array.from({ length: AMUX_IDEA_LANE_MAX_ATTEMPTS }, (_, i) => failed(i + 1)), NOW);
  assert.equal(spent.state, "failed", "the attempt limit stops it");
  assert.equal(amuxIdeaLaneClaimable(spent), false);
  const opened = amuxIdeaLaneState([failed(30), run({ outcome: "pr_open", prNumber: 42, leaseUntilMs: NOW - 1 })], NOW);
  assert.deepEqual(opened, { state: "pr_open", attempts: 2, prNumber: 42, lastOutcome: "pr_open" });
  assert.equal(amuxIdeaLaneClaimable(opened), false, "an opened PR ends the lane's work");
  assert.equal(amuxIdeaLaneClaimable(amuxIdeaLaneState([run()], NOW)), false, "never two runs at once");
});

test("the switch is off unless set, and the daily limit stays bounded", () => {
  assert.equal(amuxIdeaLaneEnabled({}), false);
  assert.equal(amuxIdeaLaneEnabled({ AMUX_IDEA_LANE_ENABLED: "1" }), false);
  assert.equal(amuxIdeaLaneEnabled({ AMUX_IDEA_LANE_ENABLED: "true" }), true);
  assert.equal(amuxIdeaLaneDailyAttempts({}), 10);
  assert.equal(amuxIdeaLaneDailyAttempts({ AMUX_IDEA_LANE_MAX_ATTEMPTS_PER_DAY: "25" }), 25);
  for (const value of ["0", "101", "2.5", "lots"]) {
    assert.equal(amuxIdeaLaneDailyAttempts({ AMUX_IDEA_LANE_MAX_ATTEMPTS_PER_DAY: value }), 10, value);
  }
  assert.equal(amuxIdeaLaneBranch(ID), `amux-idea/${ID}`);
});

test("a run reports an opened PR or one fixed failure word, nothing else", () => {
  assert.deepEqual(inspectAmuxIdeaLaneResult({ attemptId: ID, outcome: "pr_open", prNumber: 3300 }),
    { attemptId: ID, outcome: "pr_open", prNumber: 3300 });
  for (const outcome of AMUX_IDEA_LANE_FAILURES) {
    assert.deepEqual(inspectAmuxIdeaLaneResult({ attemptId: ID, outcome }), { attemptId: ID, outcome, prNumber: null });
  }
  for (const body of [null, [], { attemptId: "x", outcome: "no_change" }, { attemptId: ID, outcome: "pr_open" },
    { attemptId: ID, outcome: "pr_open", prNumber: 0 }, { attemptId: ID, outcome: "no_change", prNumber: 5 },
    { attemptId: ID, outcome: "merged" }, { attemptId: ID, outcome: "no_change", note: "hi" }]) {
    assert.equal(inspectAmuxIdeaLaneResult(body), null, JSON.stringify(body));
  }
  const migration = readFileSync("prisma/migrations/20261102120000_amux_idea_lane_attempt/migration.sql", "utf8");
  for (const word of ["pr_open", ...AMUX_IDEA_LANE_FAILURES]) {
    assert.ok(migration.includes(`'${word}'`), `the table's CHECK accepts ${word}`);
  }
});

test("a lane idea skips analysis and approvals on the Ideas list", () => {
  const facts = (lane) => amuxIdeaProgress({ state: "submitted", submissionOrigin: "owner", cancelled: false,
    chunks: [], proposedUnits: 0, cards: [], lane });
  const view = (lane) => { const result = facts(lane); return [result.stage, result.waitingFor, result.attention]; };
  assert.deepEqual(view(null), ["execution_approval", "execution_approval", false], "without the lane nothing changes");
  assert.deepEqual(view(amuxIdeaLaneState([run()], NOW)), ["execution", null, false]);
  assert.deepEqual(view(amuxIdeaLaneState([failed(5)], NOW)), ["execution", null, false], "a retry asks nothing");
  assert.deepEqual(view(amuxIdeaLaneState([run({ outcome: "pr_open", prNumber: 7 })], NOW)), ["review", null, false]);
  assert.deepEqual(view(amuxIdeaLaneState([failed(3), failed(2), failed(1)], NOW)), ["execution", null, true],
    "out of attempts is flagged for the owner");
});
