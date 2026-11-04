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
  inspectAmuxIdeaLaneFence,
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

test("an observed merge of the lane's PR settles the idea as done", () => {
  const opened = (prNumber, mergedAtMs = null, minutesAgo = 30) => run({ claimedAtMs: NOW - minutesAgo * 60_000,
    leaseUntilMs: NOW - 1, outcome: "pr_open", prNumber, mergedAtMs });
  assert.deepEqual(amuxIdeaLaneState([opened(42, NOW - 1)], NOW),
    { state: "merged", attempts: 1, prNumber: 42, lastOutcome: "pr_open" });
  assert.equal(amuxIdeaLaneState([opened(42, null)], NOW).state, "pr_open", "an unmerged PR is still in review");
  assert.deepEqual(amuxIdeaLaneState([opened(42, NOW - 1, 60), opened(43, null, 10)], NOW).prNumber, 42,
    "a retry's PR left open does not hide the one that merged");
  const view = (lane) => { const result = amuxIdeaProgress({ state: "submitted", submissionOrigin: "owner",
    cancelled: false, chunks: [], proposedUnits: 0, cards: [], lane }); return [result.stage, result.waitingFor, result.attention]; };
  assert.deepEqual(view(amuxIdeaLaneState([opened(42, NOW - 1)], NOW)), ["done", null, false]);
  assert.equal(amuxIdeaLaneClaimable(amuxIdeaLaneState([opened(42, NOW - 1)], NOW)), false);
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
  assert.equal(inspectAmuxIdeaLaneFence({ attemptId: ID }), ID);
  for (const body of [null, [], {}, { attemptId: "x" }, { attemptId: ID, extra: 1 }, { attemptId: ID.toUpperCase() }]) {
    assert.equal(inspectAmuxIdeaLaneFence(body), null, JSON.stringify(body));
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

test("the claim and result routes answer only the lane's own secret, and only while the lane is on", async () => {
  const { isAmuxIdeaLaneAuthorized } = await import("../lib/amux/ideaLaneService.ts");
  const secret = "s".repeat(40);
  const on = { AMUX_IDEA_LANE_ENABLED: "true", AMUX_IDEA_LANE_SYNC_SECRET: secret };
  const ask = (authorization) => new Request("https://tomverse.test/api/internal/amux/idea-lane/claim",
    { method: "POST", headers: authorization ? { authorization } : {} });
  assert.equal(isAmuxIdeaLaneAuthorized(ask(`Bearer ${secret}`), on), true);
  assert.equal(isAmuxIdeaLaneAuthorized(ask(`Bearer ${secret}`), { ...on, AMUX_IDEA_LANE_ENABLED: "false" }), false,
    "off means off, whatever the caller holds");
  assert.equal(isAmuxIdeaLaneAuthorized(ask("Bearer short"), { ...on, AMUX_IDEA_LANE_SYNC_SECRET: "short" }), false,
    "a short configured secret is no secret");
  for (const header of [null, secret, `Bearer ${secret}x`, `bearer ${secret}`, "Bearer "]) {
    assert.equal(isAmuxIdeaLaneAuthorized(ask(header), on), false, String(header));
  }
  for (const route of ["claim", "result"]) {
    const source = readFileSync(`app/api/internal/amux/idea-lane/${route}/route.ts`, "utf8");
    assert.ok(source.indexOf("isAmuxIdeaLaneAuthorized(request)") < source.indexOf(route === "claim"
      ? "claimAmuxIdeaLane()" : "readLimitedJson("), `${route} checks the secret before anything else`);
  }
});
