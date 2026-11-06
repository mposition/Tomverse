import assert from "node:assert/strict";
import test from "node:test";

import {
  DEVELOP_CI_REPAIR_IGNORED_CHECKS,
  DEVELOP_CI_REPAIR_PER_DAY,
  EMPTY_DEVELOP_CI_REPAIR_STATE,
  decideDevelopCiRepair,
  developCiLogTail,
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

test("a red head is submitted only on its second sighting", () => {
  const first = decideDevelopCiRepair({ state: EMPTY_DEVELOP_CI_REPAIR_STATE, headSha: HEAD, checkRuns: red, repairInFlight: false, now: NOW });
  assert.equal(first.action, "none");
  assert.equal(first.reason, "first_sighting");
  assert.equal(first.state.redHeadSha, HEAD);
  const second = decideDevelopCiRepair({ state: first.state, headSha: HEAD, checkRuns: red, repairInFlight: false, now: NOW });
  assert.equal(second.action, "submit");
  assert.equal(second.headSha, HEAD);
  assert.deepEqual(second.checks.map((check) => check.id), [2]);
});

test("a green head clears the sighting, and a new red head starts over", () => {
  const seen = { ...EMPTY_DEVELOP_CI_REPAIR_STATE, redHeadSha: HEAD, redSeenAt: NOW.toISOString() };
  const green = decideDevelopCiRepair({ state: seen, headSha: OTHER, checkRuns: [{ id: 1, name: "Build", conclusion: "success" }], repairInFlight: false, now: NOW });
  assert.equal(green.reason, "green");
  assert.equal(green.state.redHeadSha, null);
  const moved = decideDevelopCiRepair({ state: seen, headSha: OTHER, checkRuns: red, repairInFlight: false, now: NOW });
  assert.equal(moved.reason, "first_sighting");
  assert.equal(moved.state.redHeadSha, OTHER);
});

test("one repair at a time, never twice for one head, and a daily ceiling", () => {
  const seen = { ...EMPTY_DEVELOP_CI_REPAIR_STATE, redHeadSha: HEAD, day: "2026-11-06" };
  const decide = (state, repairInFlight = false) =>
    decideDevelopCiRepair({ state, headSha: HEAD, checkRuns: red, repairInFlight, now: NOW });
  assert.equal(decide(seen, true).reason, "repair_in_flight");
  assert.equal(decide({ ...seen, lastHeadSha: HEAD }).reason, "same_head_already_submitted");
  assert.equal(decide({ ...seen, submitted: DEVELOP_CI_REPAIR_PER_DAY }).reason, "daily_limit");
  // The ceiling is per UTC day.
  const yesterday = decide({ ...seen, day: "2026-11-05", submitted: DEVELOP_CI_REPAIR_PER_DAY });
  assert.equal(yesterday.action, "submit");
  assert.equal(yesterday.state.submitted, 0);
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
  assert.deepEqual(readDevelopCiRepairState(JSON.stringify({ submitted: -1, lastIdeaId: 3 })), EMPTY_DEVELOP_CI_REPAIR_STATE);
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
