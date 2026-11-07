// The presentation arithmetic behind the Development screens: the five-step
// idea bar, the board columns, the worker channel and today's release route.
// None of it decides an approval; it only maps rows the server already read.

import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_IDEA_FLOW_STEPS,
  amuxBarFraction,
  amuxBoardCardStuck,
  amuxCardStatusGroup,
  amuxBoardColumn,
  amuxElapsed,
  amuxIdeaFlowSteps,
  amuxWorkerChannel,
  qaTrainNext,
  qaTrainRoute,
  qaTrainSlotHourToday,
} from "../lib/adminAmuxFlow.ts";

const states = (stage, options) => amuxIdeaFlowSteps(stage, options)?.map((step) => step.state);

test("an idea sits on one of five steps; analysis keeps the plan approval ahead of it", () => {
  assert.deepEqual([...AMUX_IDEA_FLOW_STEPS], ["idea", "execution_approval", "plan_approval", "execution", "pr"]);
  assert.deepEqual(states("execution_approval"), ["done", "current", "todo", "todo", "todo"]);
  assert.deepEqual(states("analysis"), ["done", "done", "current", "todo", "todo"]);
  assert.deepEqual(states("plan_approval"), ["done", "done", "current", "todo", "todo"]);
  assert.deepEqual(states("execution"), ["done", "done", "done", "current", "todo"]);
  assert.deepEqual(states("review"), ["done", "done", "done", "done", "current"]);
  assert.deepEqual(states("done"), ["done", "done", "done", "done", "done"]);
});

test("a stopped step is marked attention, and a cancelled idea has no bar", () => {
  assert.deepEqual(states("execution", { attention: true }), ["done", "done", "done", "attention", "todo"]);
  assert.equal(amuxIdeaFlowSteps("cancelled"), null);
  // A finished idea has no current step to mark.
  assert.deepEqual(states("done", { attention: true }), ["done", "done", "done", "done", "done"]);
});

test("a worker's channel comes from its name and nothing else", () => {
  assert.equal(amuxWorkerChannel("claude-1"), "claude");
  assert.equal(amuxWorkerChannel("Codex-impl"), "codex");
  assert.equal(amuxWorkerChannel("copilot_chore"), "copilot");
  assert.equal(amuxWorkerChannel("cursor"), "cursor");
  assert.equal(amuxWorkerChannel("claudette-2"), null);
  assert.equal(amuxWorkerChannel(null), null);
  assert.equal(amuxWorkerChannel(""), null);
});

test("the six server lanes group into five columns, and the attention lane stays whole", () => {
  for (const lane of ["tomverse_backlog", "amux_backlog", "todo"]) assert.equal(amuxBoardColumn(lane), "waiting");
  assert.equal(amuxBoardColumn("in_progress"), "running");
  assert.equal(amuxBoardColumn("in_review"), "review");
  assert.equal(amuxBoardColumn("attention"), "approval");
  assert.equal(amuxBoardColumn("archive"), "done");
});

test("a card is stuck only when its reason is the work stopping, never when the owner is being asked", () => {
  const card = (lane, attentionReason = null, ownerQuestion = null) => ({ lane, attentionReason, ownerQuestion });
  assert.equal(amuxBoardCardStuck(card("attention", "execution_lease_expired")), true);
  assert.equal(amuxBoardCardStuck(card("attention", "usage_outcome_unknown")), true);
  assert.equal(amuxBoardCardStuck(card("attention", "human_review_required")), false);
  assert.equal(amuxBoardCardStuck(card("attention", "execution_lease_expired", "open")), false);
  assert.equal(amuxBoardCardStuck(card("attention")), false);
  assert.equal(amuxBoardCardStuck(card("in_progress", "execution_lease_expired")), false);
});

test("elapsed time uses the largest whole unit and refuses a time it cannot read", () => {
  const now = Date.UTC(2026, 10, 7, 12, 0);
  assert.deepEqual(amuxElapsed(now - 18 * 60_000, now), { value: 18, unit: "minute" });
  assert.deepEqual(amuxElapsed(now - 3 * 3_600_000, now), { value: 3, unit: "hour" });
  assert.deepEqual(amuxElapsed(now - 2 * 86_400_000, now), { value: 2, unit: "day" });
  assert.deepEqual(amuxElapsed(now + 60_000, now), { value: 0, unit: "minute" });
  assert.equal(amuxElapsed(Number.NaN, now), null);
});

test("today's route marks the next hour, what left, and what did not", () => {
  // 11:42 AEST on 2026-11-07 is 01:42 UTC.
  const now = Date.UTC(2026, 10, 7, 1, 42);
  const hours = [8, 11, 14, 17, 20];
  assert.deepEqual(
    qaTrainRoute(now, hours, new Set([8, 11])).map((stop) => stop.state),
    ["departed", "departed", "next", "upcoming", "upcoming"]
  );
  // A past hour with no admission is not assumed to have left.
  assert.deepEqual(
    qaTrainRoute(now, hours, new Set([11])).map((stop) => stop.state),
    ["missed", "departed", "next", "upcoming", "upcoming"]
  );
  // After the last hour nothing is next; the countdown moves to tomorrow.
  const late = Date.UTC(2026, 10, 7, 11, 30);
  assert.equal(qaTrainRoute(late, hours, new Set()).some((stop) => stop.state === "next"), false);
  assert.deepEqual(qaTrainNext(now, hours), { departsAtMs: Date.UTC(2026, 10, 7, 4, 0), minutes: 138 });
  assert.equal(qaTrainNext(now, []), null);
});

test("an admission slot counts only on the AEST day it was made", () => {
  const now = Date.UTC(2026, 10, 7, 1, 42);
  assert.equal(qaTrainSlotHourToday("20261107-0800", now), 8);
  assert.equal(qaTrainSlotHourToday("20261106-1700", now), null);
  assert.equal(qaTrainSlotHourToday("not a slot", now), null);
  // 23:30 AEST on the 7th is 13:30 UTC; the day is still the 7th, not the 8th.
  assert.equal(qaTrainSlotHourToday("20261107-2000", Date.UTC(2026, 10, 7, 13, 30)), 20);
});

test("a bar fraction is null when a side is unknown, never zero", () => {
  assert.equal(amuxBarFraction(7.6, 20), 0.38);
  assert.equal(amuxBarFraction(30, 20), 1);
  assert.equal(amuxBarFraction(null, 20), null);
  assert.equal(amuxBarFraction(5, null), null);
  assert.equal(amuxBarFraction(5, 0), null);
});

test("a stored card status counts in one named group, and an unknown one only in the total", () => {
  assert.equal(amuxCardStatusGroup("backlog"), "waiting");
  assert.equal(amuxCardStatusGroup("todo"), "waiting");
  assert.equal(amuxCardStatusGroup("doing"), "running");
  assert.equal(amuxCardStatusGroup("review"), "review");
  assert.equal(amuxCardStatusGroup("done"), "done");
  assert.equal(amuxCardStatusGroup("blocked"), "blocked");
  assert.equal(amuxCardStatusGroup("cancelled"), "cancelled");
  assert.equal(amuxCardStatusGroup("mystery"), "other");
});
