import assert from "node:assert/strict";
import test from "node:test";

import {
  CI_ADMISSION_RELEASE_GRACE_MS,
  ciAdmissionUnits,
  emptyCiAdmissionState,
  evaluateCiAdmission,
  parseCiAdmissionMode,
  parseCiAdmissionState,
  reorderCiAdmissionQueue,
} from "../lib/ciAdmissionCore.ts";

const T0 = Date.parse("2026-10-20T02:00:00Z");
const sha = (n) => String(n % 10).repeat(40);
const pull = (number, overrides = {}) => ({
  number,
  nodeId: `PR_${number}`,
  title: `Pull ${number}`,
  base: "develop",
  head: `claude/to-develop/x${number}`,
  headSha: sha(number),
  draft: false,
  fork: false,
  ...overrides,
});
const queued = (number, base = "develop") => ({ number, title: `Pull ${number}`, base, head: `h${number}`, queuedAt: "2026-10-20T01:00:00.000Z" });
const state = (overrides = {}) => ({ ...emptyCiAdmissionState(), ...overrides });
const run = (input) =>
  evaluateCiAdmission({ arrival: null, nowMs: T0, shadow: false, runningShas: new Set(), ...input });
const kinds = (evaluation) => evaluation.actions.map((a) => `${a.kind}:${a.pull.number}`);

test("mode: undeclared or empty is off; only off, shadow and on", () => {
  assert.equal(parseCiAdmissionMode(undefined), "off");
  assert.equal(parseCiAdmissionMode(" "), "off");
  assert.equal(parseCiAdmissionMode("shadow"), "shadow");
  assert.equal(parseCiAdmissionMode("on"), "on");
  for (const value of ["ON", "true", "1"]) assert.equal(parseCiAdmissionMode(value), null);
});

test("slots: develop 1, main 2 (release and hotfix alike), stacked and forks not handled", () => {
  assert.equal(ciAdmissionUnits({ base: "develop", fork: false }), 1);
  assert.equal(ciAdmissionUnits({ base: "main", fork: false }), 2);
  assert.equal(ciAdmissionUnits({ base: "claude/to-develop/a", fork: false }), null);
  assert.equal(ciAdmissionUnits({ base: "develop", fork: true }), null);
});

test("an unreadable stored state is an empty one", () => {
  assert.deepEqual(parseCiAdmissionState(null), emptyCiAdmissionState());
  assert.deepEqual(parseCiAdmissionState("{"), emptyCiAdmissionState());
  assert.deepEqual(parseCiAdmissionState(JSON.stringify({ version: 2 })), emptyCiAdmissionState());
});

test("an arrival runs while it fits: three develop, or main and develop", () => {
  const running = [pull(1), pull(2)];
  const arrives = run({ state: state(), openPulls: [...running, pull(3)], runningShas: new Set([sha(1), sha(2)]), arrival: 3 });
  assert.deepEqual(kinds(arrives), []);
  assert.equal(arrives.state.events.at(-1).kind, "admitted");

  const main = pull(4, { base: "main", head: "release/x" });
  const withMain = run({ state: state(), openPulls: [main, pull(5)], runningShas: new Set([main.headSha]), arrival: 5 });
  assert.deepEqual(kinds(withMain), []);
});

test("an arrival that does not fit is held at the end of the line", () => {
  const running = [pull(1), pull(2), pull(3)];
  const evaluation = run({ state: state(), openPulls: [...running, pull(4)], runningShas: new Set(running.map((p) => p.headSha)), arrival: 4 });
  assert.deepEqual(kinds(evaluation), ["hold:4"]);
  assert.deepEqual(evaluation.state.queue.map((e) => e.number), [4]);
  assert.equal(evaluation.state.events.at(-1).detail, "no_slot");

  // A second release into main does not fit beside one already running.
  const main = pull(5, { base: "main", head: "release/a" });
  const second = pull(6, { base: "main", head: "release/b" });
  const mains = run({ state: state(), openPulls: [main, second], runningShas: new Set([main.headSha]), arrival: 6 });
  assert.deepEqual(kinds(mains), ["hold:6"]);
});

test("an arrival never jumps a waiting line, even with room -- a hotfix included", () => {
  const hotfix = pull(9, { base: "main", head: "hotfix/urgent" });
  const evaluation = run({
    state: state({ capacity: 3, queue: [queued(7, "main"), queued(8)] }),
    openPulls: [pull(1), pull(7, { base: "main", draft: true }), pull(8, { draft: true }), hotfix],
    runningShas: new Set([sha(1), sha(1)]),
    arrival: 9,
  });
  // #1 uses 1 of 3; #7 (main, 2) is released from the top; #9 waits behind #8.
  assert.deepEqual(kinds(evaluation), ["hold:9", "release:7"]);
  assert.deepEqual(evaluation.state.queue.map((e) => e.number), [8, 9]);
});

test("release is strictly from the top: a smaller pull request does not pass one that does not fit", () => {
  const evaluation = run({
    state: state({ queue: [queued(7, "main"), queued(8)] }),
    openPulls: [pull(1), pull(2), pull(7, { base: "main", draft: true }), pull(8, { draft: true })],
    runningShas: new Set([sha(1), sha(2)]),
  });
  assert.deepEqual(kinds(evaluation), []);
  assert.equal(evaluation.used, 2);
});

test("a pull request whose CI finished holds no slot; a released one holds its slots until its runs appear", () => {
  const evaluation = run({
    state: state({ queue: [queued(8)] }),
    openPulls: [pull(1), pull(2), pull(3), pull(8, { draft: true })],
    runningShas: new Set([sha(1)]),
  });
  assert.deepEqual(kinds(evaluation), ["release:8"]);
  assert.deepEqual(evaluation.state.released.map((r) => r.number), [8]);

  // Just released, no runs visible yet: still counts, so nothing else is released.
  const next = run({
    state: { ...evaluation.state, queue: [queued(9, "main")] },
    openPulls: [pull(1), pull(8), pull(9, { base: "main", draft: true })],
    runningShas: new Set([sha(1)]),
    nowMs: T0 + 60_000,
  });
  assert.deepEqual(kinds(next), []);
  // After the grace period with no runs, its slot is free again.
  const later = run({
    state: { ...evaluation.state, queue: [queued(9, "main")] },
    openPulls: [pull(1), pull(8), pull(9, { base: "main", draft: true })],
    runningShas: new Set([sha(1)]),
    nowMs: T0 + CI_ADMISSION_RELEASE_GRACE_MS,
  });
  assert.deepEqual(kinds(later), ["release:9"]);
});

test("its own release's ready_for_review event is not an arrival to hold", () => {
  const released = run({ state: state({ queue: [queued(8)] }), openPulls: [pull(8, { draft: true })] });
  const echo = run({ state: released.state, openPulls: [pull(8)], arrival: 8, nowMs: T0 + 2_000 });
  assert.deepEqual(kinds(echo), []);
});

test("the line drops closed pull requests and ones made ready elsewhere", () => {
  const evaluation = run({
    state: state({ capacity: 1, queue: [queued(7), queued(8), queued(9)] }),
    openPulls: [pull(1), pull(8), pull(9, { draft: true })],
    runningShas: new Set([sha(1), sha(8)]),
  });
  assert.deepEqual(evaluation.state.queue.map((e) => e.number), [9]);
  assert.deepEqual(
    evaluation.state.events.map((e) => `${e.kind}:${e.number}:${e.detail}`),
    ["dropped:7:closed", "dropped:8:ready_elsewhere"],
  );
});

test("a draft running CI (a replayed re-run) is cancelled; a draft at rest is not", () => {
  const evaluation = run({
    state: state(),
    openPulls: [pull(1, { draft: true }), pull(2, { draft: true }), pull(3, { draft: true, base: "claude/x" })],
    runningShas: new Set([sha(1), sha(3)]),
  });
  assert.deepEqual(kinds(evaluation), ["cancel:1"]);
  assert.equal(evaluation.state.events.at(-1).detail, "draft_rerun");
});

test("shadow marks every event", () => {
  const evaluation = run({ state: state({ queue: [queued(8)] }), openPulls: [pull(8, { draft: true })], shadow: true });
  assert.ok(evaluation.state.events.every((e) => e.shadow));
});

test("reorder accepts exactly the same numbers rearranged", () => {
  const s = state({ queue: [queued(1), queued(2), queued(3)] });
  assert.deepEqual(reorderCiAdmissionQueue(s, [3, 1, 2]).queue.map((e) => e.number), [3, 1, 2]);
  assert.equal(reorderCiAdmissionQueue(s, [3, 1]), null);
  assert.equal(reorderCiAdmissionQueue(s, [3, 1, 1]), null);
  assert.equal(reorderCiAdmissionQueue(s, [3, 1, 4]), null);
});

test("the round records which pull requests use the slots, released ones included", () => {
  const evaluation = run({
    state: state({ capacity: 4, queue: [queued(8)] }),
    openPulls: [pull(1), pull(2, { draft: true }), pull(8, { draft: true }), pull(9, { base: "main", head: "release/x" })],
    runningShas: new Set([sha(1), sha(9)]),
  });
  assert.equal(evaluation.state.lastRound.used, 4);
  assert.deepEqual(evaluation.state.lastRound.running.map((p) => p.number), [1, 8, 9]);
});

test("a burst of arrivals before any run is visible cannot share one free slot", () => {
  const first = run({ state: state({ capacity: 1 }), openPulls: [pull(1), pull(2, { draft: true })], arrival: 1 });
  assert.deepEqual(kinds(first), []);
  const second = run({ state: first.state, openPulls: [pull(1), pull(2)], arrival: 2, nowMs: T0 + 1_000 });
  assert.deepEqual(kinds(second), ["hold:2"]);
});

test("once a released pull request's runs are seen, a fast finish frees its slot at once", () => {
  const released = run({ state: state({ capacity: 1, queue: [queued(8), queued(9)] }), openPulls: [pull(8, { draft: true }), pull(9, { draft: true })] });
  assert.deepEqual(kinds(released), ["release:8"]);
  assert.ok(released.nextCheckInMs > 0, "someone waits behind an unobserved reservation");
  const seen = run({ state: released.state, openPulls: [pull(8), pull(9, { draft: true })], runningShas: new Set([sha(8)]), nowMs: T0 + 30_000 });
  assert.deepEqual(kinds(seen), []);
  assert.equal(seen.nextCheckInMs, null);
  // Two minutes later its CI has finished: well inside the grace period, #9 goes.
  const done = run({ state: seen.state, openPulls: [pull(8), pull(9, { draft: true })], nowMs: T0 + 120_000 });
  assert.deepEqual(kinds(done), ["release:9"]);
});

test("its own ready event is not an arrival even when its runs are already visible", () => {
  const released = run({ state: state({ capacity: 1, queue: [queued(8), queued(9)] }), openPulls: [pull(8, { draft: true }), pull(9, { draft: true })] });
  const echo = run({ state: released.state, openPulls: [pull(8), pull(9, { draft: true })], runningShas: new Set([sha(8)]), arrival: 8, nowMs: T0 + 3_000 });
  assert.deepEqual(kinds(echo), []);
  assert.deepEqual(echo.state.queue.map((e) => e.number), [9]);
});
