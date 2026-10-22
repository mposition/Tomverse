import assert from "node:assert/strict";
import test from "node:test";

import {
  CI_ADMISSION_CHECK_LIMIT,
  CI_ADMISSION_HOLD_LABEL,
  CI_ADMISSION_RELEASE_GRACE_MS,
  ciAdmissionDraftsToCheck,
  ciAdmissionOrder,
  ciAdmissionUnits,
  ciRunKey,
  emptyCiAdmissionState,
  evaluateCiAdmission,
  moveCiAdmissionEntry,
  parseCiAdmissionMode,
  parseCiAdmissionState,
  reorderCiAdmissionQueue,
} from "../lib/ciAdmissionCore.ts";

const T0 = Date.parse("2026-10-21T02:00:00Z");
const sha = (n) => String(n % 10).repeat(40);
const pull = (number, overrides = {}) => ({
  number,
  nodeId: `PR_${number}`,
  title: `Pull ${number}`,
  base: "develop",
  head: `claude/to-develop/x${number}`,
  headSha: sha(number),
  draft: true,
  fork: false,
  labels: [],
  ...overrides,
});
const clean = { conflict: false, behind: false };
const checksFor = (pulls, check = clean) => new Map(pulls.map((p) => [p.number, check]));
const state = (overrides = {}) => ({ ...emptyCiAdmissionState(), ...overrides });
const lineOf = (...numbers) => numbers.map((number) => ({ number, title: "", base: "develop", head: "", headSha: "", queuedAt: "2026-10-21T01:00:00.000Z", draft: true, status: "waiting" }));
// Running pull_request runs of these pull requests, on their heads.
const runs = (...pulls) => new Set(pulls.map((p) => ciRunKey(p.number, p.headSha)));
const judge = (input) => evaluateCiAdmission({ running: new Set(), nowMs: T0, shadow: false, ...input });
const kinds = (evaluation) => evaluation.actions.map((a) => `${a.kind}:${a.kind === "clear_status" ? a.number : a.pull.number}`);
const statuses = (evaluation) => Object.fromEntries(evaluation.state.queue.map((e) => [e.number, e.status]));

test("mode: undeclared or empty is off; only off, shadow and on", () => {
  assert.equal(parseCiAdmissionMode(undefined), "off");
  assert.equal(parseCiAdmissionMode(" "), "off");
  assert.equal(parseCiAdmissionMode("shadow"), "shadow");
  assert.equal(parseCiAdmissionMode("on"), "on");
  for (const value of ["ON", "true", "1"]) assert.equal(parseCiAdmissionMode(value), null);
});

test("slots: develop 1, main 2, stacked and forks not handled", () => {
  assert.equal(ciAdmissionUnits({ base: "develop", fork: false }), 1);
  assert.equal(ciAdmissionUnits({ base: "main", fork: false }), 2);
  assert.equal(ciAdmissionUnits({ base: "claude/to-develop/a", fork: false }), null);
  assert.equal(ciAdmissionUnits({ base: "develop", fork: true }), null);
});

test("an unreadable stored state is an empty one; the first shape keeps its budget and order", () => {
  assert.deepEqual(parseCiAdmissionState(null), emptyCiAdmissionState());
  assert.deepEqual(parseCiAdmissionState("{"), emptyCiAdmissionState());
  assert.deepEqual(parseCiAdmissionState(JSON.stringify({ version: 9 })), emptyCiAdmissionState());
  const legacy = parseCiAdmissionState(
    JSON.stringify({
      version: 1,
      capacity: 5,
      queue: [{ number: 7, title: "Seven", base: "develop", head: "a", queuedAt: "2026-10-20T00:00:00.000Z" }, { number: 3 }],
      released: [],
    }),
  );
  assert.equal(legacy.version, 2);
  assert.equal(legacy.capacity, 5);
  assert.deepEqual(legacy.queue.map((e) => e.number), [7, 3]);
  assert.equal(legacy.queue[0].title, "Seven");
});

test("the line is every open handled pull request, drafts included: stored order kept, new ones appended by number", () => {
  const open = [pull(30), pull(10, { draft: false }), pull(20), pull(40, { base: "claude/x" }), pull(50, { fork: true }), pull(5, { base: "main" })];
  const order = ciAdmissionOrder(lineOf(20, 99, 30), open).map((p) => p.number);
  // 99 is closed; 40 (stacked) and 50 (a fork) are not handled; 5 and 10 are new, by number.
  assert.deepEqual(order, [20, 30, 5, 10]);
});

test("the same GitHub snapshot judged again gives the same line: nothing appears and disappears", () => {
  const open = [pull(1), pull(2), pull(3), pull(4, { draft: false })];
  const first = judge({ state: state(), openPulls: open, checks: checksFor(open) });
  // GitHub after the releases: 1-3 ready with runs showing.
  const after = open.map((p) => ({ ...p, draft: false }));
  const running = runs(after[0], after[1], after[2]);
  const second = judge({ state: first.state, openPulls: after, running, checks: new Map(), nowMs: T0 + 60_000 });
  const third = judge({ state: second.state, openPulls: after, running, checks: new Map(), nowMs: T0 + 120_000 });
  for (const evaluation of [first, second, third]) assert.deepEqual(evaluation.state.queue.map((e) => e.number), [1, 2, 3, 4]);
  assert.deepEqual(statuses(third), { 1: "running", 2: "running", 3: "running", 4: "done" });
  assert.deepEqual(kinds(third), []);
  assert.equal(third.state.events.length, first.state.events.length, "an unchanged line records no new event");
});

test("drafts the slots reach are marked ready from the top, within the budget", () => {
  const open = [pull(1), pull(2), pull(3), pull(4)];
  const evaluation = judge({ state: state({ queue: lineOf(1, 2, 3, 4) }), openPulls: open, checks: checksFor(open) });
  assert.deepEqual(kinds(evaluation), ["release:1", "release:2", "release:3"]);
  assert.deepEqual(statuses(evaluation), { 1: "next", 2: "next", 3: "next", 4: "waiting" });
  assert.equal(evaluation.used, 3);
  assert.deepEqual(evaluation.state.queue.map((e) => e.draft), [false, false, false, true]);
});

test("a draft with a conflict, behind its base, held by label, or not checked yet is passed over and says why", () => {
  const open = [pull(1), pull(2), pull(3, { labels: [CI_ADMISSION_HOLD_LABEL] }), pull(4), pull(5), pull(6)];
  const checks = new Map([
    [1, { conflict: true, behind: false }],
    [2, { conflict: false, behind: true }],
    [4, { conflict: null, behind: null }],
    [5, clean],
    [6, { conflict: false, behind: null }],
  ]);
  const evaluation = judge({ state: state({ queue: lineOf(1, 2, 3, 4, 5, 6) }), openPulls: open, checks });
  assert.deepEqual(statuses(evaluation), { 1: "conflict", 2: "behind", 3: "hold", 4: "checking", 5: "next", 6: "next" });
  // Behind unknown (no permission to compare) does not block.
  assert.deepEqual(kinds(evaluation), ["release:5", "release:6"]);
});

test("nothing jumps a higher draft: one that does not fit stops the drafts below it", () => {
  const open = [pull(1, { draft: false }), pull(2, { base: "main", head: "release/x" }), pull(3)];
  // 1 runs (1 slot) and a deploy takes 1: 2 needs 2 of the 1 left; 3 must not go first.
  const evaluation = judge({
    state: state({ queue: lineOf(1, 2, 3) }),
    openPulls: open,
    running: runs(open[0]),
    deploys: [{ branch: "develop", sha: "d".repeat(40), title: "Merge" }],
    checks: checksFor(open),
  });
  assert.deepEqual(statuses(evaluation), { 1: "running", 2: "waiting", 3: "waiting" });
  assert.deepEqual(kinds(evaluation), []);
});

test("a ready pull request lower in line whose CI runs past the budget goes back to draft", () => {
  const open = [pull(1, { draft: false }), pull(2), pull(3, { draft: false }), pull(4, { draft: false })];
  const evaluation = judge({ state: state({ queue: lineOf(1, 2, 3, 4) }), openPulls: open, running: runs(open[0], open[2], open[3]), checks: checksFor(open) });
  // 1 runs (1), 2 is reached (2), 3 runs (3); 4 is past the budget.
  assert.deepEqual(statuses(evaluation), { 1: "running", 2: "next", 3: "running", 4: "held" });
  // 2 waits until 4's cancelled runs stop: they still hold runners.
  assert.deepEqual(kinds(evaluation), ["hold:4"]);
  assert.equal(evaluation.state.queue.find((e) => e.number === 4).draft, true);
  assert.deepEqual(evaluation.state.pendingStatus, [{ number: 4, headSha: sha(4) }]);
  assert.notEqual(evaluation.nextCheckInMs, null, "judged again without waiting for an event");
  // Once 4's runs stop, 2 is marked ready.
  const later = judge({
    state: evaluation.state,
    openPulls: open.map((p) => (p.number === 4 ? { ...p, draft: true } : p)),
    running: runs(open[0], open[2]),
    checks: checksFor(open),
    nowMs: T0 + 30_000,
  });
  assert.deepEqual(kinds(later), ["release:2"]);
});

test("a ready pull request whose CI is not running takes no slot and is left alone", () => {
  const open = [pull(1, { draft: false }), pull(2, { draft: false }), pull(3, { draft: false }), pull(4)];
  const evaluation = judge({ state: state({ capacity: 1, queue: lineOf(1, 2, 3, 4) }), openPulls: open, checks: checksFor(open) });
  assert.deepEqual(statuses(evaluation), { 1: "done", 2: "done", 3: "done", 4: "next" });
  assert.deepEqual(kinds(evaluation), ["release:4"]);
});

test("deploy CI and runs of closed pull requests use slots nobody can give back", () => {
  const open = [pull(1), pull(2)];
  const evaluation = judge({
    state: state({ queue: lineOf(1, 2) }),
    openPulls: open,
    running: new Set([ciRunKey(77, "7".repeat(40))]),
    runningBases: new Map([[77, "develop"]]),
    deploys: [{ branch: "develop", sha: "d".repeat(40), title: "Merge" }],
    checks: checksFor(open),
  });
  assert.deepEqual(kinds(evaluation), ["release:1"]);
  assert.equal(evaluation.used, 3);
  assert.deepEqual(evaluation.state.lastRound.running.map((r) => r.number), [1, 77]);
});

test("a release is reserved until its runs show or the grace period ends", () => {
  const open = [pull(1), pull(2), pull(3), pull(4)];
  const first = judge({ state: state({ queue: lineOf(1, 2, 3, 4) }), openPulls: open, checks: checksFor(open) });
  const ready = open.map((p) => (p.number <= 3 ? { ...p, draft: false } : p));
  // No runs shown yet: the reservations still hold the slots.
  const soon = judge({ state: first.state, openPulls: ready, checks: checksFor(open), nowMs: T0 + 60_000 });
  assert.deepEqual(kinds(soon), []);
  assert.deepEqual(statuses(soon), { 1: "running", 2: "running", 3: "running", 4: "waiting" });
  // Grace over, still no runs: the slots are free again.
  const late = judge({ state: soon.state, openPulls: ready, checks: checksFor(open), nowMs: T0 + CI_ADMISSION_RELEASE_GRACE_MS + 1 });
  assert.deepEqual(kinds(late), ["release:4"]);
});

test("a draft with a run in progress has it cancelled", () => {
  const open = [pull(1)];
  const evaluation = judge({ state: state(), openPulls: open, running: runs(open[0]), checks: new Map([[1, { conflict: true, behind: false }]]) });
  assert.deepEqual(kinds(evaluation), ["cancel:1"]);
  assert.equal(evaluation.state.events.at(-1).kind, "cancelled");
});

test("a pending status admission left is cleared once its pull request is ready again, on a new head, or closed", () => {
  const pending = [1, 2, 3, 4].map((number) => ({ number, headSha: sha(number) }));
  const open = [pull(1, { draft: false }), pull(2, { headSha: "a".repeat(40) }), pull(4)];
  const evaluation = judge({ state: state({ capacity: 1, queue: lineOf(1, 2, 4), pendingStatus: pending }), openPulls: open, checks: new Map() });
  // 1 is ready again, 2 moved on, 3 is closed; 4, still a draft on that head, keeps it.
  assert.deepEqual(kinds(evaluation).filter((k) => k.startsWith("clear_status")), ["clear_status:1", "clear_status:2", "clear_status:3"]);
});

test("GitHub is asked only about drafts the free slots reach, held ones skipped, at most the limit", () => {
  const open = Array.from({ length: CI_ADMISSION_CHECK_LIMIT + 3 }, (_, i) =>
    pull(i + 1, i === 0 ? { labels: [CI_ADMISSION_HOLD_LABEL] } : i === 1 ? { draft: false } : {}),
  );
  const checked = ciAdmissionDraftsToCheck({ state: state(), openPulls: open, running: new Set(), nowMs: T0 }).map((p) => p.number);
  assert.equal(checked.length, CI_ADMISSION_CHECK_LIMIT);
  assert.deepEqual(checked.slice(0, 2), [3, 4]);
  // Every slot taken by running CI: nothing to ask about.
  const busy = [pull(1, { draft: false }), pull(2, { draft: false }), pull(3, { draft: false }), pull(4)];
  assert.deepEqual(ciAdmissionDraftsToCheck({ state: state(), openPulls: busy, running: runs(busy[0], busy[1], busy[2]), nowMs: T0 }), []);
});

test("reorder keeps pull requests the operator did not see; move sends one to the top or the bottom", () => {
  const s = state({ queue: lineOf(1, 2, 3, 4) });
  assert.deepEqual(reorderCiAdmissionQueue(s, [3, 1, 99]).queue.map((e) => e.number), [3, 1, 2, 4]);
  assert.equal(reorderCiAdmissionQueue(s, [99]), null);
  assert.deepEqual(moveCiAdmissionEntry(s, 3, "top").queue.map((e) => e.number), [3, 1, 2, 4]);
  assert.deepEqual(moveCiAdmissionEntry(s, 1, "bottom").queue.map((e) => e.number), [2, 3, 4, 1]);
  assert.equal(moveCiAdmissionEntry(s, 9, "top"), null);
});

test("shadow decisions are marked as shadow", () => {
  const open = [pull(1)];
  const evaluation = judge({ state: state(), openPulls: open, checks: checksFor(open), shadow: true });
  assert.equal(evaluation.state.events.at(-1).shadow, true);
});
