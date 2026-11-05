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
  amuxIdeaLaneView,
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
const PART1 = { part: 1, continues: false, previousPrNumber: null };

test("an idea's runs decide whether the lane runs it again", () => {
  assert.equal(amuxIdeaLaneState([], NOW), null, "an idea the lane never took has no state");
  assert.equal(amuxIdeaLaneClaimable(null), true);
  assert.deepEqual(amuxIdeaLaneState([run()], NOW),
    { ...PART1, state: "running", attempts: 1, prNumber: null, lastOutcome: null });
  const vanished = amuxIdeaLaneState([run({ leaseUntilMs: NOW - 1 })], NOW);
  assert.deepEqual(vanished, { ...PART1, state: "queued", attempts: 1, prNumber: null, lastOutcome: "lease_expired" },
    "a run that never reported is retried, not held for a proof");
  assert.equal(amuxIdeaLaneClaimable(vanished), true);
  assert.deepEqual(amuxIdeaLaneState([failed(30), failed(10, "no_change")], NOW),
    { ...PART1, state: "queued", attempts: 2, prNumber: null, lastOutcome: "no_change" });
  const spent = amuxIdeaLaneState(Array.from({ length: AMUX_IDEA_LANE_MAX_ATTEMPTS }, (_, i) => failed(i + 1)), NOW);
  assert.equal(spent.state, "failed", "the attempt limit stops it");
  assert.equal(amuxIdeaLaneClaimable(spent), false);
  const opened = amuxIdeaLaneState([failed(30), run({ outcome: "pr_open", prNumber: 42, leaseUntilMs: NOW - 1 })], NOW);
  assert.deepEqual(opened, { ...PART1, state: "pr_open", attempts: 2, prNumber: 42, lastOutcome: "pr_open" });
  assert.equal(amuxIdeaLaneClaimable(opened), false, "an opened PR ends the lane's work");
  assert.equal(amuxIdeaLaneClaimable(amuxIdeaLaneState([run()], NOW)), false, "never two runs at once");
});

test("an observed merge of the lane's PR settles the idea as done", () => {
  const opened = (prNumber, mergedAtMs = null, minutesAgo = 30) => run({ claimedAtMs: NOW - minutesAgo * 60_000,
    leaseUntilMs: NOW - 1, outcome: "pr_open", prNumber, mergedAtMs });
  assert.deepEqual(amuxIdeaLaneState([opened(42, NOW - 1)], NOW),
    { ...PART1, state: "merged", attempts: 1, prNumber: 42, lastOutcome: "pr_open" });
  assert.equal(amuxIdeaLaneState([opened(42, null)], NOW).state, "pr_open", "an unmerged PR is still in review");
  assert.deepEqual(amuxIdeaLaneState([opened(42, NOW - 1, 60), opened(43, null, 10)], NOW).prNumber, 42,
    "a retry's PR left open does not hide the one that merged");
  const view = (lane) => { const result = amuxIdeaProgress({ state: "submitted", submissionOrigin: "owner",
    cancelled: false, chunks: [], proposedUnits: 0, cards: [], lane }); return [result.stage, result.waitingFor, result.attention]; };
  assert.deepEqual(view(amuxIdeaLaneState([opened(42, NOW - 1)], NOW)), ["done", null, false]);
  const closed = amuxIdeaLaneState([run({ claimedAtMs: NOW - 60_000, leaseUntilMs: NOW - 1, outcome: "pr_open",
    prNumber: 44, prClosedAtMs: NOW - 1 })], NOW);
  assert.equal(closed.state, "pr_closed");
  assert.deepEqual(view(closed), ["review", null, true], "a PR closed without a merge is flagged for the owner");
  assert.equal(amuxIdeaLaneClaimable(amuxIdeaLaneState([opened(42, NOW - 1)], NOW)), false);
});

test("a larger idea runs in parts, each only after the part before merged", () => {
  const part = (prNumber, minutesAgo, { continues = true, mergedAtMs = null } = {}) => run({
    claimedAtMs: NOW - minutesAgo * 60_000, leaseUntilMs: NOW - 1, outcome: "pr_open", prNumber, continues, mergedAtMs });
  const view = (lane) => { const result = amuxIdeaProgress({ state: "submitted", submissionOrigin: "owner",
    cancelled: false, chunks: [], proposedUnits: 0, cards: [], lane }); return [result.stage, result.waitingFor, result.attention]; };
  // Part 1 opened its PR and named more: in review, and the lane waits for the merge.
  const open = amuxIdeaLaneState([part(41, 90)], NOW);
  assert.deepEqual(open, { state: "pr_open", attempts: 1, prNumber: 41, lastOutcome: "pr_open",
    part: 1, continues: true, previousPrNumber: null });
  assert.equal(amuxIdeaLaneClaimable(open), false, "part 2 never starts before part 1 merged");
  assert.deepEqual(view(open), ["review", null, false]);
  // Merged: the idea is queued for part 2, which knows the PR that named its work.
  const next = amuxIdeaLaneState([part(41, 90, { mergedAtMs: NOW - 5 })], NOW);
  assert.deepEqual(next, { state: "queued", attempts: 0, prNumber: null, lastOutcome: null,
    part: 2, continues: false, previousPrNumber: 41 });
  assert.equal(amuxIdeaLaneClaimable(next), true);
  assert.deepEqual(view(next), ["execution", null, false], "a merged part is not the idea done");
  // Part 2 has its own attempt limit: part 1's failed tries do not count against it.
  const early = [failed(200), failed(150), part(41, 90, { mergedAtMs: NOW - 5 })];
  const retry = amuxIdeaLaneState([...early, failed(2)], NOW);
  assert.equal(retry.state, "queued");
  assert.equal(retry.attempts, 1);
  assert.equal(retry.part, 2);
  // The last part names nothing more: its merge makes the idea done.
  const done = amuxIdeaLaneState([...early, part(42, 1, { continues: false, mergedAtMs: NOW - 1 })], NOW);
  assert.deepEqual([done.state, done.part, done.prNumber, done.previousPrNumber], ["merged", 2, 42, 41]);
  assert.deepEqual(view(done), ["done", null, false]);
  // A part's PR closed without a merge stops the chain for the owner to look at.
  const closed = amuxIdeaLaneState([run({ claimedAtMs: NOW - 60_000, leaseUntilMs: NOW - 1, outcome: "pr_open",
    prNumber: 43, continues: true, prClosedAtMs: NOW - 1 })], NOW);
  assert.equal(closed.state, "pr_closed");
  assert.equal(amuxIdeaLaneClaimable(closed), false);
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
    { attemptId: ID, outcome: "pr_open", prNumber: 3300, continues: false });
  for (const outcome of AMUX_IDEA_LANE_FAILURES) {
    assert.deepEqual(inspectAmuxIdeaLaneResult({ attemptId: ID, outcome }), { attemptId: ID, outcome, prNumber: null });
  }
  assert.deepEqual(inspectAmuxIdeaLaneResult({ attemptId: ID, outcome: "pr_open", prNumber: 3300, continues: true }),
    { attemptId: ID, outcome: "pr_open", prNumber: 3300, continues: true }, "a part that names more work");
  for (const body of [null, [], { attemptId: "x", outcome: "no_change" }, { attemptId: ID, outcome: "pr_open" },
    { attemptId: ID, outcome: "no_change", continues: true }, { attemptId: ID, outcome: "pr_open", prNumber: 3, continues: "yes" },
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

test("an owner idea the lane will take next waits for the lane's turn, not an execution approval", () => {
  const candidate = (overrides = {}) => ({ submissionOrigin: "owner", state: "submitted", cancelled: false,
    rawReadable: true, analysisDeadlineMs: NOW + 60_000, sourcePlan: false, chunks: 0, ...overrides });
  const view = (facts, enabled) => {
    const lane = amuxIdeaLaneView([], NOW, facts, enabled);
    const result = amuxIdeaProgress({ state: facts.state, submissionOrigin: facts.submissionOrigin,
      cancelled: facts.cancelled, chunks: [], proposedUnits: 0, cards: [], lane });
    return [lane?.state ?? null, lane?.attempts ?? null, result.stage, result.waitingFor];
  };
  assert.deepEqual(view(candidate(), true), ["queued", 0, "execution", null], "the lane's turn asks nobody");
  assert.deepEqual(view(candidate(), false), [null, null, "execution_approval", "execution_approval"],
    "with the lane off nothing changes");
  for (const [why, overrides] of [
    ["a source plan", { sourcePlan: true }],
    ["a session idea", { submissionOrigin: "session" }],
    ["an analysis page", { chunks: 1 }],
    ["a passed deadline", { analysisDeadlineMs: NOW }],
    ["purged raw text", { rawReadable: false }],
    ["a cancelled idea", { cancelled: true }],
    ["an idea past submission", { state: "analyzing" }],
  ]) {
    assert.equal(amuxIdeaLaneView([], NOW, candidate(overrides), true), null, `the claim never takes ${why}`);
  }
  const plan = candidate({ sourcePlan: true });
  assert.deepEqual(view(plan, true), [null, null, "execution_approval", "execution_approval"], "a source plan keeps its approval");
  assert.deepEqual(view(candidate({ submissionOrigin: "session" }), true), [null, null, "analysis", null],
    "a session idea stays on the v19 queue");
  assert.deepEqual(amuxIdeaLaneView([failed(5)], NOW, candidate(), false), amuxIdeaLaneState([failed(5)], NOW),
    "an idea the lane ran shows its runs whatever the switch");
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
