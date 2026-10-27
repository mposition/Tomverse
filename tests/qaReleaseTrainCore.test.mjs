import assert from "node:assert/strict";
import test from "node:test";

import {
  orderQaReleaseTrainCandidates,
  parseQaReleaseTrainSlots,
  qaReleaseTrainBranch,
  qaReleaseTrainDeparture,
  qaReleaseTrainEmergencySlot,
  qaReleaseTrainPullRequest,
  qaReleaseTrainSettleAdjacent,
  qaReleaseTrainShouldDepart,
  qaReleaseTrainNextDepartureMs,
} from "../lib/qaReleaseTrainCore.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

test("departure hours: the default, a custom list, and anything else refused", () => {
  assert.deepEqual(parseQaReleaseTrainSlots(undefined), [8, 11, 14, 17, 20]);
  assert.deepEqual(parseQaReleaseTrainSlots(""), [8, 11, 14, 17, 20]);
  assert.deepEqual(parseQaReleaseTrainSlots("20, 9"), [9, 20]);
  for (const bad of ["8,8", "24", "8;11", "x", "8,"]) assert.equal(parseQaReleaseTrainSlots(bad), null, bad);
});

test("a departure is AEST, lasts an hour, and is named by its AEST date and hour", () => {
  const hours = [8, 11, 14, 17, 20];
  // 2026-10-20 11:05 AEST = 01:05 UTC.
  assert.deepEqual(qaReleaseTrainDeparture(Date.parse("2026-10-20T01:05:00Z"), hours), {
    slot: "20261020-1100",
    departsAtMs: Date.parse("2026-10-20T01:00:00Z"),
  });
  // 10:59 AEST: the 08:00 departure's hour is over and 11:00 has not come.
  assert.equal(qaReleaseTrainDeparture(Date.parse("2026-10-20T00:59:00Z"), hours), null);
  // 11:59 AEST still belongs to 11:00; 12:00 does not.
  assert.equal(qaReleaseTrainDeparture(Date.parse("2026-10-20T01:59:00Z"), hours)?.slot, "20261020-1100");
  assert.equal(qaReleaseTrainDeparture(Date.parse("2026-10-20T02:00:00Z"), hours), null);
  // 08:30 AEST is 22:30 UTC the day before: the slot is named by the AEST date.
  assert.equal(qaReleaseTrainDeparture(Date.parse("2026-10-19T22:30:00Z"), hours)?.slot, "20261020-0800");
  assert.equal(qaReleaseTrainBranch("20261020-0800"), "release/train-20261020-0800");
  assert.throws(() => qaReleaseTrainBranch("2026-10-20"));
});

test("cargo rides in develop merge order, once, and malformed entries are dropped", () => {
  const ordered = orderQaReleaseTrainCandidates([
    { number: 3, title: "c", mergeCommitSha: C, mergedAt: "2026-10-20T02:00:00Z" },
    { number: 1, title: "a", mergeCommitSha: A, mergedAt: "2026-10-20T01:00:00Z" },
    { number: 1, title: "a again", mergeCommitSha: A, mergedAt: "2026-10-20T01:00:00Z" },
    { number: 2, title: "bad sha", mergeCommitSha: "nope", mergedAt: "2026-10-20T01:30:00Z" },
    { number: 4, title: "b", mergeCommitSha: B, mergedAt: "2026-10-20T01:30:00Z" },
  ]);
  assert.deepEqual(ordered.map((c) => c.number), [1, 4, 3]);
});

test("no departure, an open train, or no cargo means the round does not depart", () => {
  const slot = { slot: "20261020-1100" };
  assert.deepEqual(qaReleaseTrainShouldDepart({ departure: null, openTrainPullRequests: 0, candidates: 3 }), { depart: false, reason: "no_departure" });
  assert.deepEqual(qaReleaseTrainShouldDepart({ departure: slot, openTrainPullRequests: 1, candidates: 3 }), { depart: false, reason: "train_open" });
  assert.deepEqual(qaReleaseTrainShouldDepart({ departure: slot, openTrainPullRequests: 0, candidates: 0 }), { depart: false, reason: "no_cargo" });
  assert.deepEqual(qaReleaseTrainShouldDepart({ departure: slot, openTrainPullRequests: 0, candidates: 1 }), { depart: true });
});

test("the main pull request names what rode, what was left out and why, and the 7.9.1 fields", () => {
  const candidates = [
    { number: 10, title: "feat: one", mergeCommitSha: A, mergedAt: "2026-10-20T01:00:00Z" },
    { number: 11, title: "fix: two", mergeCommitSha: B, mergedAt: "2026-10-20T01:10:00Z" },
    { number: 12, title: "feat: three", mergeCommitSha: C, mergedAt: "2026-10-20T01:20:00Z" },
  ];
  const { title, body } = qaReleaseTrainPullRequest({
    slot: "20261020-1100",
    candidates,
    picks: [
      { number: 10, outcome: "included" },
      { number: 11, outcome: "conflict" },
      { number: 12, outcome: "already_in_main" },
    ],
    rcSha: B,
    rollbackSha: C,
  });
  assert.equal(title, "release: train 20261020-1100 (1 PR)");
  assert.match(body, /## Included \(1\)\n\n- #10 feat: one/);
  assert.match(body, /## Left out \(1\)\n\n- #11 fix: two — cherry-pick conflict on main/);
  assert.match(body, /Already on main, skipped: #12\./);
  assert.match(body, new RegExp(`RC SHA: +${B}`));
  assert.match(body, new RegExp(`Rollback SHA: +${C}`));
  for (const field of ["Verified on:", "Verified by / how:", "Back-merge run:"]) assert.ok(body.includes(field), field);
});

test("the next departure is the first hour after now in AEST, today's or tomorrow's", () => {
  const at = (iso) => new Date(qaReleaseTrainNextDepartureMs(Date.parse(iso), [8, 11, 14, 17, 20])).toISOString();
  // 09:30 AEST -> 11:00 AEST (01:00Z).
  assert.equal(at("2026-10-24T23:30:00Z"), "2026-10-25T01:00:00.000Z");
  // Exactly 11:00 AEST has departed: next is 14:00 AEST.
  assert.equal(at("2026-10-25T01:00:00Z"), "2026-10-25T04:00:00.000Z");
  // 21:00 AEST -> tomorrow 08:00 AEST (22:00Z the same UTC day).
  assert.equal(at("2026-10-25T11:00:00Z"), "2026-10-25T22:00:00.000Z");
  assert.equal(qaReleaseTrainNextDepartureMs(0, []), null);
});

test("an emergency train is named by its AEST minute, never a scheduled departure's", () => {
  const hours = [8, 11, 14, 17, 20];
  // 12:37 AEST.
  assert.equal(qaReleaseTrainEmergencySlot(Date.parse("2026-10-20T02:37:00Z"), hours), "20261020-1237");
  // 11:00 AEST is the 11:00 train's own slot: the emergency takes 11:01.
  assert.equal(qaReleaseTrainEmergencySlot(Date.parse("2026-10-20T01:00:30Z"), hours), "20261020-1101");
  // 12:00 is not a departure hour, so it keeps 12:00.
  assert.equal(qaReleaseTrainEmergencySlot(Date.parse("2026-10-20T02:00:00Z"), hours), "20261020-1200");
  // The AEST date, not UTC's: 23:50 UTC is 09:50 the next day.
  assert.equal(qaReleaseTrainEmergencySlot(Date.parse("2026-10-20T23:50:00Z"), hours), "20261021-0950");
  assert.equal(qaReleaseTrainBranch(qaReleaseTrainEmergencySlot(Date.parse("2026-10-20T02:37:00Z"), hours)), "release/train-20261020-1237");
});

test("an adjacent-line hunk settles to main's lines plus the pick's added ones; any changed or removed line does not", () => {
  // #3042: two scripts added after lines main has differently.
  assert.deepEqual(qaReleaseTrainSettleAdjacent({ main: ["m1", "m2"], base: ["d1"], pick: ["d1", "new1", "new2"] }), ["m1", "m2", "new1", "new2"]);
  // Added before develop's lines: before main's.
  assert.deepEqual(qaReleaseTrainSettleAdjacent({ main: ["m1"], base: ["d1"], pick: ["new", "d1"] }), ["new", "m1"]);
  // Both appended at the same place (#3032's .gitleaksignore): main's first.
  assert.deepEqual(qaReleaseTrainSettleAdjacent({ main: ["", "main entry"], base: [], pick: ["", "pick entry"] }), ["", "main entry", "", "pick entry"]);
  // Main already has what it adds (#2867, #2916): main stands.
  assert.deepEqual(qaReleaseTrainSettleAdjacent({ main: ["m1", "new"], base: ["d1"], pick: ["d1", "new"] }), ["m1", "new"]);
  // A changed or removed line is a real conflict.
  assert.equal(qaReleaseTrainSettleAdjacent({ main: ["m1"], base: ["d1"], pick: ["D1"] }), null);
  assert.equal(qaReleaseTrainSettleAdjacent({ main: ["m1"], base: ["d1", "d2"], pick: ["d1"] }), null);
  assert.equal(qaReleaseTrainSettleAdjacent({ main: ["m1"], base: ["d1", "d2"], pick: ["d1", "x", "d2"] }), null);
});

test("a settled rider is named in the body with its files, to be checked", () => {
  const { body } = qaReleaseTrainPullRequest({
    slot: "20261027-1100",
    candidates: [{ number: 3042, title: "ai review", mergeCommitSha: A, mergedAt: "2026-10-27T00:00:00Z" }],
    picks: [{ number: 3042, outcome: "included" }],
    rcSha: B,
    rollbackSha: C,
    settled: [{ number: 3042, files: ["package.json"] }],
  });
  assert.match(body, /^- #3042 ai review \(conflicted only beside lines main has differently in `package\.json`: main's lines kept, its own added lines placed next to them; check\)$/m);
});
