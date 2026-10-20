import assert from "node:assert/strict";
import test from "node:test";

import {
  CI_ADMISSION_RELEASE_GRACE_MS,
  ciAdmissionUnits,
  ciRunKey,
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
// Tests name running heads by SHA; a run belongs to every listed pull request on that head.
const run = ({ runningShas = new Set(), ...input }) =>
  evaluateCiAdmission({
    arrival: null,
    nowMs: T0,
    shadow: false,
    ...input,
    running: input.running ?? new Set(input.openPulls.filter((p) => runningShas.has(p.headSha)).map((p) => ciRunKey(p.number, p.headSha))),
  });
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
  assert.deepEqual(kinds(arrives), ["admit:3"]);
  assert.equal(arrives.state.events.at(-1).kind, "admitted");

  const main = pull(4, { base: "main", head: "release/x" });
  const withMain = run({ state: state(), openPulls: [main, pull(5)], runningShas: new Set([main.headSha]), arrival: 5 });
  assert.deepEqual(kinds(withMain), ["admit:5"]);
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
  assert.deepEqual(kinds(first), ["admit:1"]);
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

test("an arrival that would be held and released in the same round is simply let through", () => {
  // #7 waits; #1 finished, so both #7 (2 slots) and the arriving #9 (1) fit.
  const evaluation = run({
    state: state({ queue: [queued(7, "main")] }),
    openPulls: [pull(7, { base: "main", draft: true }), pull(9)],
    arrival: 9,
  });
  assert.deepEqual(kinds(evaluation), ["release:7", "admit:9"]);
  assert.deepEqual(evaluation.state.queue, []);
  assert.deepEqual(evaluation.state.events.map((e) => `${e.kind}:${e.number}`), ["released:7", "admitted:9"]);
  assert.deepEqual(evaluation.state.released.map((r) => r.number).sort(), [7, 9]);
});

test("a release carries its place in line so a failed ready can put it back", () => {
  const evaluation = run({ state: state({ queue: [queued(8)] }), openPulls: [pull(8, { draft: true })] });
  const release = evaluation.actions.find((a) => a.kind === "release");
  assert.equal(release.entry.number, 8);
  assert.equal(release.entry.queuedAt, "2026-10-20T01:00:00.000Z");
});

test("a pull request that leaves the line while open has its waiting status cleared", () => {
  const evaluation = run({
    state: state({ capacity: 1, queue: [queued(7), queued(8)] }),
    openPulls: [pull(1), pull(7, { base: "claude/x", draft: true }), pull(8)],
    runningShas: new Set([sha(1), sha(8)]),
  });
  assert.deepEqual(kinds(evaluation).sort(), ["clear:7", "clear:8"]);
});

test("a full line takes no more, so the stored state stays inside its schema", () => {
  const full = Array.from({ length: 100 }, (_, i) => queued(1000 + i));
  const unique = (n) => n.toString(16).padStart(40, "e");
  const openPulls = [pull(1), ...full.map((e) => pull(e.number, { draft: true, headSha: unique(e.number) })), pull(5)];
  const evaluation = run({ state: state({ capacity: 1, queue: full }), openPulls, runningShas: new Set([sha(1)]), arrival: 5 });
  assert.deepEqual(kinds(evaluation), []);
  assert.equal(evaluation.state.queue.length, 100);
  assert.equal(evaluation.state.events.at(-1).detail, "queue_full");
  assert.equal(parseCiAdmissionState(JSON.stringify(evaluation.state)).queue.length, 100);
});

test("new commits on a granted pull request keep its slots, reserved for the new head", () => {
  const admitted = run({ state: state({ capacity: 1 }), openPulls: [pull(1)], arrival: 1 });
  assert.deepEqual(admitted.state.granted.map((g) => g.number), [1]);
  const seen = run({ state: admitted.state, openPulls: [pull(1)], runningShas: new Set([sha(1)]), nowMs: T0 + 60_000 });
  assert.equal(seen.state.released[0].observed, true);
  // A fix push while #2 waits: #1 keeps its slot, and its new head is reserved
  // until its runs show, so #2 is not released into the same slot.
  const head = "f".repeat(40);
  const fix = run({
    state: { ...seen.state, queue: [queued(2)] },
    openPulls: [pull(1, { headSha: head }), pull(2, { draft: true })],
    arrival: 1,
    nowMs: T0 + 2 * 60_000,
  });
  assert.deepEqual(kinds(fix), []);
  assert.deepEqual(fix.state.released.map((r) => [r.number, r.headSha, r.observed]), [[1, head, false]]);
  assert.equal(fix.state.events.at(-1).detail, "continuing");
});

test("a pull request seen running but never granted is judged like any arrival", () => {
  // #3's runs were seen (an event raced ahead of its ready event); it was never granted.
  const raced = run({ state: state({ capacity: 1 }), openPulls: [pull(1), pull(3)], runningShas: new Set([sha(1), sha(3)]) });
  assert.deepEqual(raced.state.granted.map((g) => g.number), []);
  const arrives = run({ state: raced.state, openPulls: [pull(1), pull(3)], runningShas: new Set([sha(1), sha(3)]), arrival: 3, nowMs: T0 + 1_000 });
  assert.deepEqual(kinds(arrives), ["hold:3"]);
});

test("a grant ends when its pull request no longer runs", () => {
  const admitted = run({ state: state(), openPulls: [pull(1)], runningShas: new Set([sha(1)]), arrival: 1 });
  assert.deepEqual(admitted.state.granted.map((g) => g.number), [1]);
  const finished = run({ state: admitted.state, openPulls: [pull(1)], nowMs: T0 + 60_000 });
  assert.deepEqual(finished.state.granted.map((g) => g.number), []);
});

test("a pull request released from the line stays granted, so a later fix push keeps its slot", () => {
  const released = run({ state: state({ capacity: 1, queue: [queued(8), queued(9)] }), openPulls: [pull(8, { draft: true }), pull(9, { draft: true })] });
  assert.deepEqual(released.state.granted.map((g) => g.number), [8]);
  const running = run({ state: released.state, openPulls: [pull(8), pull(9, { draft: true })], runningShas: new Set([sha(8)]), nowMs: T0 + 20 * 60_000 });
  assert.deepEqual(running.state.granted.map((g) => g.number), [8]);
  const fix = run({ state: running.state, openPulls: [pull(8, { headSha: "d".repeat(40) }), pull(9, { draft: true })], arrival: 8, nowMs: T0 + 21 * 60_000 });
  assert.deepEqual(kinds(fix), []);
});

test("an older head's reservation does not exempt new commits from judgment", () => {
  // #1 admitted, its CI seen and finished within the grace period: grant ends, reservation (old head) remains.
  const admitted = run({ state: state({ capacity: 1 }), openPulls: [pull(1)], arrival: 1 });
  const seen = run({ state: admitted.state, openPulls: [pull(1)], runningShas: new Set([sha(1)]), nowMs: T0 + 30_000 });
  const finished = run({ state: { ...seen.state, queue: [queued(2)] }, openPulls: [pull(1), pull(2, { draft: true })], nowMs: T0 + 60_000 });
  assert.deepEqual(finished.state.granted.map((g) => g.number), [2]);
  // A new commit on #1 while #2 holds the only slot: #1 is held, not let through.
  const push = run({
    state: finished.state,
    openPulls: [pull(1, { headSha: "c".repeat(40) }), pull(2)],
    arrival: 1,
    nowMs: T0 + 90_000,
  });
  assert.deepEqual(kinds(push), ["hold:1"]);
});

test("a fix push seen first by another round keeps its slot (the push event arrives later)", () => {
  // #1 granted and running on its old head; #2 waits.
  const admitted = run({ state: state({ capacity: 1 }), openPulls: [pull(1)], arrival: 1 });
  const running = run({ state: { ...admitted.state, queue: [queued(2)] }, openPulls: [pull(1), pull(2, { draft: true })], runningShas: new Set([sha(1)]), nowMs: T0 + 60_000 });
  assert.deepEqual(kinds(running), []);
  // A workflow_run event is judged before #1's synchronize: GitHub already shows
  // the new head, only the old head's run is listed.
  const head = "b".repeat(40);
  const between = run({
    state: running.state,
    openPulls: [pull(1, { headSha: head }), pull(2, { draft: true })],
    runningShas: new Set([sha(1)]),
    nowMs: T0 + 2 * 60_000,
  });
  assert.deepEqual(kinds(between), [], "#2 is not released into #1's slot");
  assert.deepEqual(between.state.granted, [{ number: 1, headSha: head }]);
  assert.deepEqual(between.state.released.map((r) => [r.number, r.headSha]), [[1, head]]);
  // Then the synchronize arrives: still #1's slot, nothing held.
  const sync = run({ state: between.state, openPulls: [pull(1, { headSha: head }), pull(2, { draft: true })], arrival: 1, nowMs: T0 + 2 * 60_000 + 5_000 });
  assert.deepEqual(kinds(sync), []);
});

test("a run on a shared commit counts, and is cancelled, only for the pull request it runs for", () => {
  // #1 (granted, running) and draft #2 point at the same commit; the run is #1's.
  const shared = "a".repeat(40);
  const evaluation = run({
    state: state({ capacity: 1 }),
    openPulls: [pull(1, { headSha: shared }), pull(2, { draft: true, headSha: shared })],
    running: new Set([ciRunKey(1, shared)]),
  });
  assert.deepEqual(kinds(evaluation), [], "#2 runs nothing, so nothing of #2 is cancelled");
  assert.equal(evaluation.used, 1);
});

test("a draft running a re-run of an older head is cancelled too", () => {
  const evaluation = run({
    state: state(),
    openPulls: [pull(4, { draft: true, headSha: "9".repeat(40) })],
    running: new Set([ciRunKey(4, "8".repeat(40))]),
  });
  assert.deepEqual(kinds(evaluation), ["cancel:4"]);
});

test("an arrival left pending by a failed read is judged by the next round", () => {
  const evaluation = run({
    state: state({ capacity: 1, queue: [queued(2)], pendingArrivals: [3] }),
    openPulls: [pull(1), pull(2, { draft: true }), pull(3)],
    runningShas: new Set([sha(1)]),
  });
  assert.deepEqual(kinds(evaluation), ["hold:3"]);
  assert.deepEqual(evaluation.state.queue.map((e) => e.number), [2, 3]);
  assert.deepEqual(evaluation.state.pendingArrivals, []);
});

test("a release the last round recorded but GitHub still shows as a draft goes back to the top", () => {
  const released = run({ state: state({ capacity: 1, queue: [queued(8), queued(9)] }), openPulls: [pull(8, { draft: true }), pull(9, { draft: true })] });
  assert.deepEqual(released.state.releasing.map((e) => e.number), [8]);
  // The process stopped before marking #8 ready: the next round finds it a draft.
  const next = run({ state: released.state, openPulls: [pull(1), pull(8, { draft: true }), pull(9, { draft: true })], runningShas: new Set([sha(1)]), nowMs: T0 + 60_000 });
  assert.deepEqual(next.state.queue.map((e) => e.number), [8, 9]);
  assert.ok(next.state.events.some((e) => e.number === 8 && e.detail === "release_unconfirmed"));
});

test("every status a round's actions will write is recorded before they run", () => {
  const evaluation = run({
    state: state({ capacity: 2, queue: [queued(8)], statusRetry: [5] }),
    openPulls: [pull(8, { draft: true }), pull(9, { draft: true, headSha: "7".repeat(40) })],
    running: new Set([ciRunKey(9, "7".repeat(40))]),
  });
  assert.deepEqual(kinds(evaluation).sort(), ["cancel:9", "release:8"]);
  // #8 (release) is owed a status; #9 (only a cancel) is not; #5 stays owed.
  assert.deepEqual(evaluation.state.statusRetry.sort(), [5, 8]);
});

test("a hold the last round recorded but GitHub still shows ready is judged again, not dropped", () => {
  const held = run({ state: state({ capacity: 1 }), openPulls: [pull(1), pull(4)], runningShas: new Set([sha(1), sha(4)]), arrival: 4 });
  assert.deepEqual(kinds(held), ["hold:4"]);
  assert.deepEqual(held.state.holding, [4]);
  // The process stopped before drafting #4: the next round finds it ready.
  const next = run({ state: held.state, openPulls: [pull(1), pull(4)], runningShas: new Set([sha(1), sha(4)]), nowMs: T0 + 60_000 });
  assert.deepEqual(kinds(next), ["hold:4"]);
  assert.ok(!next.state.events.some((e) => e.number === 4 && e.detail === "ready_elsewhere"));
});

test("slots of a pull request held this round count as free for the release that follows", () => {
  // Budget 2: draft #7 waits; #9 arrives with its runs already visible. Both fit.
  const evaluation = run({
    state: state({ capacity: 2, queue: [queued(7)] }),
    openPulls: [pull(7, { draft: true }), pull(9)],
    runningShas: new Set([sha(9)]),
    arrival: 9,
  });
  assert.deepEqual(kinds(evaluation), ["release:7", "admit:9"]);
});

test("the slots shown as running match the budget: a held pull request's runs still show", () => {
  const evaluation = run({ state: state({ capacity: 1, queue: [queued(7)] }), openPulls: [pull(7, { draft: true }), pull(9)], runningShas: new Set([sha(9)]), arrival: 9 });
  assert.deepEqual(kinds(evaluation), ["hold:9"]);
  assert.deepEqual(evaluation.state.lastRound.running.map((p) => p.number), [9]);
  assert.equal(evaluation.state.lastRound.used, 1);
});

test("a draft whose runs have not stopped keeps its slots, round after round, until they do", () => {
  // Round 1: #9 arrives running while #7 waits (budget 1): hold #9, release #7.
  const first = run({ state: state({ capacity: 1, queue: [queued(7)] }), openPulls: [pull(7, { draft: true }), pull(9)], runningShas: new Set([sha(9)]), arrival: 9 });
  // #7 is not released in the round that holds #9: #9's runs still show.
  assert.deepEqual(kinds(first), ["hold:9"]);
  const deferred = first.state;
  // Round 2: #9 is a draft whose runs still run. #7 must not be released beside them.
  const second = run({ state: deferred, openPulls: [pull(7, { draft: true }), pull(9, { draft: true })], runningShas: new Set([sha(9)]), nowMs: T0 + 60_000 });
  assert.deepEqual(kinds(second), ["cancel:9"]);
  // Round 3: #9's runs stopped. Now #7 goes.
  const third = run({ state: second.state, openPulls: [pull(7, { draft: true }), pull(9, { draft: true })], nowMs: T0 + 120_000 });
  assert.deepEqual(kinds(third), ["release:7"]);
});

test("a hold's cancellation does not free its slots in the same round", () => {
  // Budget 1: #9 arrives with its runs visible while #7 waits. #9 is held and
  // its runs cancelled, but #7 waits for a round that sees them stopped.
  const evaluation = run({ state: state({ capacity: 1, queue: [queued(7)] }), openPulls: [pull(7, { draft: true }), pull(9)], runningShas: new Set([sha(9)]), arrival: 9 });
  assert.deepEqual(kinds(evaluation), ["hold:9"]);
});

test("a ready pull request re-running an older head's run occupies its slots", () => {
  const evaluation = run({
    state: state({ capacity: 1, queue: [queued(7)] }),
    openPulls: [pull(7, { draft: true }), pull(5, { headSha: "5".repeat(39) + "a" })],
    running: new Set([ciRunKey(5, "5".repeat(40))]),
  });
  assert.deepEqual(kinds(evaluation), []);
  assert.equal(evaluation.used, 1);
});
