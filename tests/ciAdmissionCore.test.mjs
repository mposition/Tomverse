import assert from "node:assert/strict";
import test from "node:test";

import {
  CI_ADMISSION_CHECK_LIMIT,
  CI_ADMISSION_HOLD_LABEL,
  CI_ADMISSION_RAMP_MS,
  CI_ADMISSION_WAIT_RECHECK_MS,
  CI_ADMISSION_RELEASE_GRACE_MS,
  CI_ADMISSION_UPDATE_RETRY_MS,
  ciAdmissionDraftsToCheck,
  ciAdmissionOrder,
  ciAdmissionUnits,
  ciAdmissionUpdatesBranchOf,
  ciRunKey,
  ciRunnerCount,
  ciRunnerOwnerKey,
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
// The scenarios below were written in slots; the same proportions in runners keep their meaning.
const SLOT_NEEDS = { develop: 1, main: 2, developPush: 1, mainPush: 2 };
const state = (overrides = {}) => ({ ...emptyCiAdmissionState(), capacity: 3, needs: SLOT_NEEDS, ...overrides });
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

test("runners: develop 15, main 34 by default (measured peaks); stacked and forks not handled", () => {
  assert.equal(ciAdmissionUnits({ base: "develop", fork: false }), 15);
  assert.equal(ciAdmissionUnits({ base: "main", fork: false }), 34);
  assert.equal(ciAdmissionUnits({ base: "main", fork: false }, SLOT_NEEDS), 2);
  assert.equal(emptyCiAdmissionState().capacity, 40);
  assert.equal(ciAdmissionUnits({ base: "claude/to-develop/a", fork: false }), null);
  assert.equal(ciAdmissionUnits({ base: "develop", fork: true }), null);
});

test("an unreadable stored state is an empty one; older shapes keep their order, not their slot budget", () => {
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
  assert.equal(legacy.version, 3);
  // A slot count means nothing in runners: the budget is the runner default.
  assert.equal(legacy.capacity, 40);
  assert.deepEqual(legacy.queue.map((e) => e.number), [7, 3]);
  assert.equal(legacy.queue[0].title, "Seven");
});

test("the line is every open handled pull request, drafts included: stored order kept, new ones appended by number", () => {
  const open = [pull(30), pull(10, { draft: false }), pull(20), pull(40, { base: "claude/x" }), pull(50, { fork: true }), pull(5, { base: "main" })];
  const order = ciAdmissionOrder(lineOf(20, 99, 30), open).map((p) => p.number);
  // 99 is closed; 40 (stacked) and 50 (a fork) are not handled; 5 and 10 are new, by number.
  assert.deepEqual(order, [20, 30, 5, 10]);
  // A ci:hold label takes a pull request out of the line wherever it was.
  assert.deepEqual(ciAdmissionOrder(lineOf(20, 30), open.map((p) => (p.number === 20 ? { ...p, labels: [CI_ADMISSION_HOLD_LABEL] } : p))).map((p) => p.number), [30, 5, 10]);
});

test("the engineering agent's pull requests are never in the line, so admission never marks an owner review draft ready", () => {
  const agent = pull(7, { head: "agent/engineering/123456789012" });
  const open = [pull(30), agent, pull(8, { head: "agent/other" })];
  assert.deepEqual(ciAdmissionOrder(lineOf(7, 30), open).map((p) => p.number), [30, 8]);
  const evaluation = judge({ state: state(), openPulls: open, checks: checksFor(open) });
  assert.ok(!evaluation.actions.some((action) => action.pull?.number === 7), "nothing is done to it");
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

test("a draft with a conflict, behind its base, or not checked yet is passed over and says why; one labelled ci:hold is not in the line", () => {
  const open = [pull(1), pull(2), pull(3, { labels: [CI_ADMISSION_HOLD_LABEL] }), pull(4), pull(5), pull(6)];
  const checks = new Map([
    [1, { conflict: true, behind: false }],
    [2, { conflict: false, behind: true }],
    [4, { conflict: null, behind: null }],
    [5, clean],
    [6, { conflict: false, behind: null }],
  ]);
  const queue = lineOf(1, 2, 3, 4, 5, 6).map((entry) => ({ ...entry, title: `Pull ${entry.number}` }));
  // Branch updates off: a draft behind its base is only passed over.
  const evaluation = judge({ state: state({ queue }), openPulls: open, checks, updateBranches: false });
  assert.deepEqual(statuses(evaluation), { 1: "conflict", 2: "behind", 4: "checking", 5: "next", 6: "next" });
  // Left the line while open: not recorded as closed.
  assert.equal(evaluation.state.events.filter((e) => e.kind === "dropped").length, 0);
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
  // GitHub's jobs read (none listed: each CI at its need), so the count is real enough to cancel on.
  const evaluation = judge({ state: state({ queue: lineOf(1, 2, 3, 4) }), openPulls: open, running: runs(open[0], open[2], open[3]), checks: checksFor(open), runners: [] });
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

test("a running pull request is not sent back to draft when GitHub's jobs went unread, or within the grace after admission marked it ready", () => {
  const open = [pull(1, { draft: false }), pull(3, { draft: false }), pull(4, { draft: false })];
  const base = { state: state({ queue: lineOf(1, 3, 4) }), openPulls: open, running: runs(...open), checks: checksFor(open) };
  // 1 + 1 + 1 runners with a deploy holding 1 of 3: 4 is past the budget.
  const deploys = [{ branch: "develop", sha: "d".repeat(40), title: "Merge" }];
  assert.deepEqual(kinds(judge({ ...base, deploys, runners: [] })), ["hold:4"]);
  // Unread: every CI at its need is a different sum from the round that released it; nothing is cancelled on it.
  const unread = judge({ ...base, deploys, runners: null });
  assert.deepEqual(kinds(unread), []);
  assert.equal(statuses(unread)[4], "running");
  // Marked ready by admission five minutes ago: kept; eleven minutes ago: held.
  const releasedEvent = (minutes) => ({ at: new Date(T0 - minutes * 60_000).toISOString(), kind: "released", number: 4, shadow: false, detail: null });
  const recent = judge({ ...base, deploys, runners: [], state: state({ queue: lineOf(1, 3, 4), events: [releasedEvent(5)] }) });
  assert.deepEqual(kinds(recent), []);
  const older = judge({ ...base, deploys, runners: [], state: state({ queue: lineOf(1, 3, 4), events: [releasedEvent(11)] }) });
  assert.deepEqual(kinds(older), ["hold:4"]);
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

test("GitHub is asked only about drafts the free slots reach, ci:hold ones not in line, at most the limit", () => {
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

test("a stored slot state (version 2) becomes runners: order and events kept, budget and needs reset", () => {
  const v2 = { ...emptyCiAdmissionState(), version: 2, capacity: 3, queue: lineOf(5, 4), events: [] };
  delete v2.needs;
  const parsed = parseCiAdmissionState(JSON.stringify(v2));
  assert.equal(parsed.version, 3);
  assert.equal(parsed.capacity, 40);
  assert.deepEqual(parsed.needs, { develop: 15, main: 34, developPush: 18, mainPush: 19 });
  assert.deepEqual(parsed.queue.map((e) => e.number), [5, 4]);
});

test("in runners: two develop pull requests fit 40, a third waits; a develop deploy leaves room for one", () => {
  const open = [pull(1), pull(2), pull(3)];
  const free = judge({ state: { ...emptyCiAdmissionState(), queue: lineOf(1, 2, 3) }, openPulls: open, checks: checksFor(open) });
  assert.deepEqual(kinds(free), ["release:1", "release:2"]);
  assert.equal(statuses(free)[3], "waiting");
  assert.equal(free.used, 30);

  const deploying = judge({
    state: { ...emptyCiAdmissionState(), queue: lineOf(1, 2, 3) },
    openPulls: open,
    checks: checksFor(open),
    deploys: [{ branch: "develop", sha: "d".repeat(40), title: "Merge" }],
  });
  assert.deepEqual(kinds(deploying), ["release:1"]);
  assert.equal(deploying.used, 33);
});

// A holder of runners as GitHub listed it: started long enough ago that its jobs are all listed.
const owner = (key, running, queued = 0, startedAt = new Date(T0 - 10 * 60_000).toISOString()) => ({
  key,
  title: "",
  number: null,
  base: null,
  sha: null,
  running,
  queued,
  startedAt,
});

test("a running CI counts at its jobs right now; while its run is starting, at its need at least; unread, at its need", () => {
  const started = new Date(T0 - 30_000).toISOString();
  assert.equal(ciRunnerCount(15, owner("pull:1", 4, 1), T0), 5);
  assert.equal(ciRunnerCount(15, owner("pull:1", 4, 1, started), T0), 15);
  assert.equal(ciRunnerCount(15, owner("pull:1", 20, 0, started), T0), 20);
  assert.equal(ciRunnerCount(15, owner("pull:1", 4, 0, started), T0 + CI_ADMISSION_RAMP_MS), 4);
  assert.equal(ciRunnerCount(15, undefined, T0), 15);
});

test("in live runners: the next draft starts once finished jobs leave room for its need", () => {
  const open = [pull(1, { draft: false }), pull(2, { base: "main", head: "release/x" }), pull(3)];
  const base = { state: { ...emptyCiAdmissionState(), queue: lineOf(1, 2, 3) }, openPulls: open, running: runs(open[0]), checks: checksFor(open) };
  // 1 has 10 of its 15 jobs left: 30 free is not room for the release (34); 3 must not jump it.
  const busy = judge({ ...base, runners: [owner(ciRunnerOwnerKey.pull(1), 9, 1)] });
  assert.deepEqual(kinds(busy), []);
  assert.deepEqual(statuses(busy), { 1: "running", 2: "waiting", 3: "waiting" });
  assert.equal(busy.used, 10);
  assert.equal(busy.state.lastRound.running[0].runners, 10);
  assert.equal(busy.nextCheckInMs, CI_ADMISSION_WAIT_RECHECK_MS, "judged again while a draft waits: a finished job sends no webhook");
  // Its jobs finish: 6 left, so the release fits.
  const freed = judge({ ...base, runners: [owner(ciRunnerOwnerKey.pull(1), 6)] });
  assert.deepEqual(kinds(freed), ["release:2"]);
  assert.equal(freed.used, 40);
  // Unread, it counts at its need: 25 free, nothing fits.
  assert.deepEqual(kinds(judge({ ...base, runners: null })), []);
});

test("deploys count at their live jobs; other workflows' jobs count too", () => {
  const open = [pull(1), pull(2)];
  const deploy = { branch: "develop", sha: "d".repeat(40), title: "Merge" };
  const evaluation = judge({
    state: { ...emptyCiAdmissionState(), queue: lineOf(1, 2) },
    openPulls: open,
    checks: checksFor(open),
    deploys: [deploy],
    runners: [owner(ciRunnerOwnerKey.deploy("develop", deploy.sha), 3), owner("other:CodeQL", 5, 2)],
  });
  // 3 + 7 in use: two develop pull requests fit (10 + 30 = 40).
  assert.deepEqual(kinds(evaluation), ["release:1", "release:2"]);
  assert.equal(evaluation.state.lastRound.deploys[0].runners, 3);
  assert.equal(evaluation.state.lastRound.others, 7);
  // Without the reading, the deploy counts at its need (18): only one fits.
  const unread = judge({ state: { ...emptyCiAdmissionState(), queue: lineOf(1, 2) }, openPulls: open, checks: checksFor(open), deploys: [deploy] });
  assert.deepEqual(kinds(unread), ["release:1"]);
});

test("a CI needing more than the budget still runs alone", () => {
  const main = [pull(9, { base: "main" })];
  const small = judge({ state: { ...emptyCiAdmissionState(), capacity: 20, queue: lineOf(9) }, openPulls: main, checks: checksFor(main) });
  assert.deepEqual(kinds(small), ["release:9"]);
});

test("a draft the slots reach that is behind its base has its branch updated once per head, then is released on its new head", () => {
  const behind = [pull(1), pull(2)];
  const checks = new Map([[1, { conflict: false, behind: true }], [2, clean]]);
  const first = judge({ state: state({ queue: lineOf(1, 2) }), openPulls: behind, checks });
  assert.deepEqual(kinds(first), ["update_branch:1", "release:2"]);
  assert.deepEqual(statuses(first), { 1: "updating", 2: "next" });
  assert.equal(first.state.events.find((e) => e.number === 1).kind, "updated");
  assert.notEqual(first.nextCheckInMs, null, "judged again while GitHub merges");
  // GitHub has not moved the head yet: not asked again.
  const again = judge({ state: first.state, openPulls: [behind[0], { ...behind[1], draft: false }], checks, nowMs: T0 + 60_000 });
  assert.deepEqual(kinds(again).filter((k) => k.startsWith("update_branch")), []);
  assert.equal(statuses(again)[1], "updating");
  // Long enough without a new head: asked again.
  const retry = judge({ state: first.state, openPulls: [behind[0]], checks, nowMs: T0 + CI_ADMISSION_UPDATE_RETRY_MS });
  assert.deepEqual(kinds(retry), ["update_branch:1"]);
  // The new head is up to date: released like any draft.
  const updated = { ...behind[0], headSha: "a".repeat(40) };
  const done = judge({ state: first.state, openPulls: [updated], checks: new Map([[1, clean]]), nowMs: T0 + 60_000 });
  assert.deepEqual(kinds(done), ["release:1"]);
  assert.deepEqual(done.state.updating, []);
});

test("shadow records the branch update it would ask for; a stored state from before has no updates", () => {
  const open = [pull(1)];
  const shadow = judge({ state: state(), openPulls: open, checks: new Map([[1, { conflict: false, behind: true }]]), shadow: true });
  assert.equal(shadow.state.events.at(-1).shadow, true);
  const { updating, ...before } = emptyCiAdmissionState();
  assert.deepEqual(updating, []);
  assert.deepEqual(parseCiAdmissionState(JSON.stringify(before)).updating, []);
});

test("a branch is brought up to date into develop from a working branch, or into main from a release train: never a deploy branch or a hand-made release", () => {
  assert.equal(ciAdmissionUpdatesBranchOf({ base: "develop", head: "claude/to-develop/x", fork: false }), true);
  assert.equal(ciAdmissionUpdatesBranchOf({ base: "develop", head: "dependabot/npm_and_yarn/x", fork: false }), true);
  for (const head of ["main", "develop", "release/2026-10-25", "hotfix/x"]) {
    assert.equal(ciAdmissionUpdatesBranchOf({ base: "develop", head, fork: false }), false, head);
  }
  // The train service's branch into main (2026-10-27: #3047); a look-alike name is not one.
  assert.equal(ciAdmissionUpdatesBranchOf({ base: "main", head: "release/train-20261027-0941", fork: false }), true);
  for (const head of ["release/train-1", "release/train-20261027-0941-x", "release/2026-10-25-x", "hotfix/x", "develop", "claude/to-develop/x"]) {
    assert.equal(ciAdmissionUpdatesBranchOf({ base: "main", head, fork: false }), false, head);
  }
  assert.equal(ciAdmissionUpdatesBranchOf({ base: "develop", head: "x", fork: true }), false);
  assert.equal(ciAdmissionUpdatesBranchOf({ base: "main", head: "release/train-20261027-0941", fork: true }), false);
  // A hand-made release behind main stays "behind": no update is asked for.
  const release = [pull(1, { base: "main", head: "release/x" })];
  const judged = judge({ state: state({ queue: lineOf(1) }), openPulls: release, checks: new Map([[1, { conflict: false, behind: true }]]) });
  assert.deepEqual(kinds(judged), []);
  assert.equal(statuses(judged)[1], "behind");
  // A train behind main is brought up to date.
  const train = [pull(2, { base: "main", head: "release/train-20261027-0941" })];
  const updating = judge({ state: state({ queue: lineOf(2) }), openPulls: train, checks: new Map([[2, { conflict: false, behind: true }]]) });
  assert.deepEqual(kinds(updating), ["update_branch:2"]);
  assert.equal(statuses(updating)[2], "updating");
});

test("a ci:hold pull request out of the line still counts the runners its CI holds when GitHub's jobs are unread", () => {
  const held = pull(1, { draft: false, labels: [CI_ADMISSION_HOLD_LABEL] });
  const open = [held, pull(2), pull(3)];
  const judged = judge({ state: state({ capacity: 2, queue: lineOf(2, 3) }), openPulls: open, running: runs(held), checks: checksFor(open), runners: null });
  // 1 holds one of the two runners: only one more draft fits.
  assert.deepEqual(kinds(judged), ["release:2"]);
  assert.equal(judged.used, 2);
  assert.deepEqual(judged.state.lastRound.running.map((r) => r.number).sort(), [1, 2]);
  assert.equal(judged.state.lastRound.running.find((r) => r.number === 1).title, "Pull 1");
});
