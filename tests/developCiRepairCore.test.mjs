import assert from "node:assert/strict";
import test from "node:test";

import {
  DEVELOP_CI_REPAIR_IGNORED_CHECKS,
  DEVELOP_CI_REPAIR_MIN_SIGHTING_GAP_MS,
  DEVELOP_CI_REPAIR_PER_DAY,
  EMPTY_DEVELOP_CI_REPAIR_STATE,
  decideDevelopCiRepair,
  developCiLogTail,
  developCiRepairDayStart,
  developCiRepairIdea,
  developCiRepairRequestId,
  parseDevelopCiRepairMode,
  readDevelopCiRepairState,
  redChecksOf,
} from "../lib/developCiRepairCore.ts";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const NOW = new Date("2026-11-06T08:00:00.000Z");

const red = [
  { id: 2, name: "Unit tests", conclusion: "failure" },
  { id: 1, name: "Build", conclusion: "success" },
];

test("only completed code failures count; cancelled runs and branch checks never do", () => {
  const runs = [
    { id: 1, name: "Unit tests", conclusion: "failure" },
    { id: 2, name: "Lint", conclusion: "timed_out" },
    { id: 3, name: "Build", conclusion: "cancelled" },
    { id: 4, name: "E2E", conclusion: null },
    { id: 5, name: "Docs", conclusion: "success" },
    { id: 6, name: "Back-merge main into develop", conclusion: "failure" },
    { id: 7, name: "Deployed commit vs branch head", conclusion: "failure" },
  ];
  assert.deepEqual(redChecksOf(runs).map((run) => run.name), ["Lint", "Unit tests"]);
  assert.ok(DEVELOP_CI_REPAIR_IGNORED_CHECKS.has("main is in develop's ancestry"));
});

const NONE = { submittedForHead: false, repairInFlight: false, submittedToday: 0 };
const LATER = new Date(NOW.getTime() + DEVELOP_CI_REPAIR_MIN_SIGHTING_GAP_MS);

test("a red head is submitted only on a second sighting at least the gap later", () => {
  const first = decideDevelopCiRepair({ state: EMPTY_DEVELOP_CI_REPAIR_STATE, headSha: HEAD, checkRuns: red, facts: NONE, now: NOW });
  assert.equal(first.action, "none");
  assert.equal(first.reason, "first_sighting");
  assert.deepEqual(first.state, { redHeadSha: HEAD, redSeenAt: NOW.toISOString() });
  // An immediate retry or a second caller is not a second sighting.
  const soon = new Date(NOW.getTime() + DEVELOP_CI_REPAIR_MIN_SIGHTING_GAP_MS - 1);
  const early = decideDevelopCiRepair({ state: first.state, headSha: HEAD, checkRuns: red, facts: NONE, now: soon });
  assert.equal(early.reason, "waiting");
  assert.deepEqual(early.state, first.state);
  const second = decideDevelopCiRepair({ state: first.state, headSha: HEAD, checkRuns: red, facts: NONE, now: LATER });
  assert.equal(second.action, "submit");
  assert.equal(second.headSha, HEAD);
  assert.deepEqual(second.checks.map((check) => check.id), [2]);
});

test("a green head clears the sighting, and a new red head starts over", () => {
  const seen = { redHeadSha: HEAD, redSeenAt: NOW.toISOString() };
  const green = decideDevelopCiRepair({ state: seen, headSha: OTHER, checkRuns: [{ id: 1, name: "Build", conclusion: "success" }], facts: NONE, now: LATER });
  assert.equal(green.reason, "green");
  assert.deepEqual(green.state, EMPTY_DEVELOP_CI_REPAIR_STATE);
  const moved = decideDevelopCiRepair({ state: seen, headSha: OTHER, checkRuns: red, facts: NONE, now: LATER });
  assert.equal(moved.reason, "first_sighting");
  assert.equal(moved.state.redHeadSha, OTHER);
});

test("one repair at a time, never twice for one head, and a daily ceiling", () => {
  const seen = { redHeadSha: HEAD, redSeenAt: NOW.toISOString() };
  const decide = (facts) => decideDevelopCiRepair({ state: seen, headSha: HEAD, checkRuns: red, facts: { ...NONE, ...facts }, now: LATER });
  assert.equal(decide({ repairInFlight: true }).reason, "repair_in_flight");
  assert.equal(decide({ submittedForHead: true }).reason, "same_head_already_submitted");
  assert.equal(decide({ submittedToday: DEVELOP_CI_REPAIR_PER_DAY }).reason, "daily_limit");
  assert.equal(decide({ submittedToday: DEVELOP_CI_REPAIR_PER_DAY - 1 }).action, "submit");
});

test("the daily window starts at the UTC midnight", () => {
  assert.equal(developCiRepairDayStart(new Date("2026-11-06T23:59:59.000Z")).toISOString(), "2026-11-06T00:00:00.000Z");
});

test("the request id is a stable UUID per head", () => {
  const id = developCiRepairRequestId(HEAD);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(developCiRepairRequestId(HEAD), id);
  assert.notEqual(developCiRepairRequestId(OTHER), id);
});

test("the mode is on only with an owner id, and a broken state reads as empty", () => {
  assert.deepEqual(parseDevelopCiRepairMode("on:user-1"), { mode: "on", ownerUserId: "user-1" });
  for (const value of [null, undefined, "", "on:", "on", "off", "true"]) {
    assert.deepEqual(parseDevelopCiRepairMode(value), { mode: "off" });
  }
  assert.deepEqual(readDevelopCiRepairState("{not json"), EMPTY_DEVELOP_CI_REPAIR_STATE);
  assert.deepEqual(readDevelopCiRepairState(JSON.stringify({ redHeadSha: HEAD, redSeenAt: "not a date" })), EMPTY_DEVELOP_CI_REPAIR_STATE);
  assert.deepEqual(readDevelopCiRepairState(JSON.stringify({ redHeadSha: HEAD, redSeenAt: NOW.toISOString() })), { redHeadSha: HEAD, redSeenAt: NOW.toISOString() });
});

test("the log tail drops timestamps and colour codes and keeps the end", () => {
  const log = "2026-11-06T07:00:00.1234567Z setup\n2026-11-06T07:00:01.0000000Z \u001b[31mnot ok 3 - fails\u001b[0m\n";
  assert.equal(developCiLogTail(log), "setup\nnot ok 3 - fails");
  assert.equal(developCiLogTail("x".repeat(10) + "END", 3), "END");
});

test("the idea names each check with its link and fits the size limit", () => {
  const checks = [1, 2, 3].map((id) => ({ id, name: `Check ${id}`, conclusion: "failure", logTail: "가".repeat(6000) }));
  const idea = developCiRepairIdea({ headSha: HEAD, checks, maxBytes: 8_192 });
  assert.ok(Buffer.byteLength(idea, "utf8") <= 8_192);
  assert.ok(idea.includes(HEAD));
  for (const id of [1, 2, 3]) {
    assert.ok(idea.includes(`## Check ${id} (failure)`));
    assert.ok(idea.includes(`https://github.com/mposition/Tomverse/runs/${id}`));
  }
  assert.ok(idea.includes("Do not skip, weaken or delete a test"));
  const unread = developCiRepairIdea({ headSha: HEAD, checks: [{ id: 9, name: "X", conclusion: "failure", logTail: null }], maxBytes: 8_192 });
  assert.ok(unread.includes("could not be read"));
});
