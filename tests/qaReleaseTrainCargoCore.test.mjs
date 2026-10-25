import assert from "node:assert/strict";
import test from "node:test";

import {
  QA_RELEASE_TRAIN_CARGO_MAX,
  parseQaReleaseTrainCargoPick,
  qaReleaseTrainCargoCandidates,
  qaReleaseTrainCargoPickable,
  qaReleaseTrainCarried,
  qaReleaseTrainLastTrainFrom,
  qaReleaseTrainReferencedNumbers,
  qaReleaseTrainSelectionFrom,
} from "../lib/qaReleaseTrainCargoCore.ts";

const NOW = Date.parse("2026-10-23T00:00:00Z");
const develop = (number, mergedAt = "2026-10-22T00:00:00Z", overrides = {}) => ({
  number,
  title: `PR ${number}`,
  user: { login: "codex" },
  base: { ref: "develop" },
  merged_at: mergedAt,
  ...overrides,
});
let commitCount = 0;
const commit = (message, sha = (++commitCount).toString(16).padStart(40, "c")) => ({ sha, message });
const release = (number, body, merged = true) => ({ number, title: `release: ${number}`, body, merged_at: merged ? "2026-10-22T05:00:00Z" : null });

test("without its commits, a release carries what its title names and a train's Included section; free text in a body is not read", () => {
  assert.deepEqual(qaReleaseTrainReferencedNumbers({ title: "release: two (#2873)", body: "Brings #2862 and #2873.\nSee #2873." }), [2873]);
  assert.deepEqual(qaReleaseTrainReferencedNumbers({ title: null, body: null }), []);
  // A train names what it left out and skipped too; only its Included section is carried (#2906).
  const train = [
    "Release train 20261023-1400 (AEST), opened by the QA-release agent.",
    "",
    "## Included (2)",
    "",
    "- #2789 feat(agents): ci-budget subagent",
    "- #2844 AMUX Workers",
    "",
    "## Left out (1)",
    "",
    "- #2776 feat(amux): price — cherry-pick conflict on main",
    "",
    "Already on main, skipped: #2824, #2872.",
  ].join("\n");
  assert.deepEqual(qaReleaseTrainReferencedNumbers({ title: "release: train 20261023-1400 (3 PRs)", body: train }), [2789, 2844]);
  // An Included section at the end of the body counts to its end.
  assert.deepEqual(qaReleaseTrainReferencedNumbers({ title: "x", body: "## Included (1)\n\n- #11 a" }), [11]);
});

test("candidates: merged develop pull requests in the window, newest first, each with whether it can ride", () => {
  const candidates = qaReleaseTrainCargoCandidates({
    mergedDevelopJson: [
      develop(1, "2026-10-22T01:00:00Z"),
      develop(2, "2026-10-22T02:00:00Z"),
      develop(3, "2026-10-22T03:00:00Z"),
      develop(4, "2026-10-22T04:00:00Z"),
      develop(5, "2026-10-22T05:00:00Z"),
      develop(6, "2026-10-01T00:00:00Z"),
      develop(7, null),
      develop(8, "2026-10-22T06:00:00Z", { base: { ref: "main" } }),
    ],
    // #2 is on main; a closed-unmerged release carrying #3 does not count.
    mergedMainJson: [release(900, "Brings #2"), release(901, "Brings #3", false)],
    openMainJson: [release(902, "Brings #3", false)],
    mainCommits: new Map([
      [900, [commit("Merge pull request #2 from mposition/b2")]],
      [901, [commit("Merge pull request #3 from mposition/b3")]],
      [902, [commit("Merge pull request #3 from mposition/b3")]],
    ]),
    files: new Map([
      [1, ["lib/a.ts"]],
      [3, ["lib/c.ts"]],
      [4, [".github/workflows/ci.yml", "lib/d.ts"]],
    ]),
    nowMs: NOW,
  });
  assert.deepEqual(
    candidates.map((c) => [c.number, c.status, c.mainPullRequest]),
    [
      [5, "unchecked", null],
      [4, "changes_workflows", null],
      [3, "in_main_pull_request", 902],
      [2, "on_main", 900],
      [1, "available", null],
    ],
  );
  assert.equal(candidates[0].author, "codex");
  assert.deepEqual(
    candidates.filter((c) => qaReleaseTrainCargoPickable(c.status)).map((c) => c.number),
    [5, 1],
  );
});

test("a hotfix cut from the same branch name is on main, and a back-merge never rides", () => {
  const candidates = qaReleaseTrainCargoCandidates({
    mergedDevelopJson: [
      develop(10, "2026-10-22T01:00:00Z", { head: { ref: "claude/to-develop/ci-admission-fast-webhook" } }),
      develop(11, "2026-10-22T02:00:00Z", { head: { ref: "claude/to-develop/back-merge-main-20261022" } }),
      develop(12, "2026-10-22T03:00:00Z", { head: { ref: "main" } }),
      develop(13, "2026-10-22T04:00:00Z", { head: { ref: "codex/to-develop/x" }, title: "Back-merge main into develop" }),
      develop(14, "2026-10-22T05:00:00Z", { head: { ref: "claude/to-develop/train-picker" } }),
      develop(15, "2026-10-22T06:00:00Z", { head: { ref: "claude/to-develop/fast-webhook" } }),
    ],
    // A hotfix whose body names no number; an open release cut from #14's branch name.
    mergedMainJson: [{ ...release(865, "Answer webhooks at once."), head: { ref: "hotfix/2026-10-21-ci-admission-fast-webhook" } }],
    openMainJson: [{ ...release(902, "No numbers.", false), head: { ref: "release/2026-10-23-train-picker" } }],
    files: new Map([[15, ["lib/a.ts"]]]),
    nowMs: NOW,
  });
  assert.deepEqual(
    candidates.map((c) => [c.number, c.status, c.mainPullRequest]),
    [
      // Only the whole last segment matches: "fast-webhook" is not "ci-admission-fast-webhook".
      [15, "available", null],
      [14, "in_main_pull_request", 902],
      [13, "back_merge", null],
      [12, "back_merge", null],
      [11, "back_merge", null],
      [10, "on_main", 865],
    ],
  );
  assert.deepEqual(candidates.filter((c) => qaReleaseTrainCargoPickable(c.status)).map((c) => c.number), [15]);
});

test("a pick is distinct positive numbers, at most the train's capacity", () => {
  assert.deepEqual(parseQaReleaseTrainCargoPick([3, 1]), [3, 1]);
  assert.deepEqual(parseQaReleaseTrainCargoPick([]), []);
  for (const bad of [null, "1", [1, 1], [0], [1.5], Array.from({ length: QA_RELEASE_TRAIN_CARGO_MAX + 1 }, (_, i) => i + 1)]) {
    assert.equal(parseQaReleaseTrainCargoPick(bad), null, JSON.stringify(bad));
  }
});

test("the newest pick is the next train's cargo until a train is admitted after it", () => {
  const pickAt = new Date("2026-10-22T10:00:00Z");
  assert.deepEqual(qaReleaseTrainSelectionFrom({ pick: null, admission: null, lastTrain: null }), {
    numbers: [],
    savedAt: null,
    savedBy: null,
    departedWith: null,
    lastTrain: null,
  });
  const waiting = qaReleaseTrainSelectionFrom({
    pick: { numbers: [2, 1], at: pickAt, by: "owner@example.com" },
    admission: { slot: "20261022-0800", at: new Date("2026-10-22T09:00:00Z") },
    lastTrain: null,
  });
  assert.deepEqual(waiting, { numbers: [2, 1], savedAt: pickAt.toISOString(), savedBy: "owner@example.com", departedWith: null, lastTrain: null });
  const spent = qaReleaseTrainSelectionFrom({
    pick: { numbers: [2, 1], at: pickAt, by: "owner@example.com" },
    admission: { slot: "20261022-1100", at: new Date("2026-10-22T11:00:00Z") },
    lastTrain: null,
  });
  assert.deepEqual(spent.numbers, []);
  assert.equal(spent.departedWith, "20261022-1100");
  // A stored row that does not parse carries nothing.
  assert.deepEqual(qaReleaseTrainSelectionFrom({ pick: { numbers: "x", at: pickAt, by: null }, admission: null, lastTrain: null }).numbers, []);
});

// Owner request 2026-10-24: what a train left out must not drop out of sight.
test("what the last train left out rides the next one until a new pick is saved", () => {
  const report = {
    slot: "20261024-1100",
    outcome: "opened",
    pullRequestNumber: 2948,
    picks: [
      { number: 2912, outcome: "included" },
      { number: 2763, outcome: "conflict", predecessors: [2598, 2341] },
      { number: 2742, outcome: "conflict", predecessors: [] },
      { number: 2950, outcome: "over_capacity" },
      { number: 2900, outcome: "changes_workflows" },
      { number: 2759, outcome: "already_in_main" },
    ],
  };
  const lastTrain = qaReleaseTrainLastTrainFrom(report);
  assert.deepEqual(lastTrain, {
    slot: "20261024-1100",
    pullRequestNumber: 2948,
    carried: [
      { number: 2763, reason: "conflict", predecessors: [2598, 2341] },
      // It looked and found none.
      { number: 2742, reason: "conflict", predecessors: [] },
      { number: 2950, reason: "over_capacity", predecessors: null },
    ],
  });
  // A train assembled before predecessors were looked up (#2964) named none:
  // unknown, not "none found".
  assert.deepEqual(
    qaReleaseTrainLastTrainFrom({ slot: "20261024-2300", outcome: "opened", pullRequestNumber: 2964, picks: [{ number: 2913, outcome: "conflict" }] }).carried,
    [{ number: 2913, reason: "conflict", predecessors: null }],
  );
  // A train that failed before its pull request opened carries what it had included too.
  assert.deepEqual(
    qaReleaseTrainLastTrainFrom({ ...report, outcome: "failed", pullRequestNumber: null }).carried.map((c) => [c.number, c.reason]),
    [
      [2912, "train_failed"],
      [2763, "conflict"],
      [2742, "conflict"],
      [2950, "over_capacity"],
    ],
  );
  assert.equal(qaReleaseTrainLastTrainFrom({ slot: "x" }), null);
  assert.equal(qaReleaseTrainLastTrainFrom(null), null);

  const pick = { numbers: [2912, 2763, 2742, 2950, 2900, 2759], at: new Date("2026-10-24T00:00:00Z"), by: "owner@example.com" };
  const admittedAt = new Date("2026-10-24T01:00:00Z");
  // The train that took the pick reported: what it left out is the next cargo.
  const carried = qaReleaseTrainSelectionFrom({ pick, admission: { slot: "20261024-1100", at: admittedAt }, lastTrain });
  assert.deepEqual(carried.numbers, [2763, 2742, 2950]);
  assert.equal(carried.departedWith, "20261024-1100");
  // A later train still running (its report not in) carries nothing yet.
  const running = qaReleaseTrainSelectionFrom({ pick, admission: { slot: "20261024-1400", at: new Date("2026-10-24T04:00:00Z") }, lastTrain });
  assert.deepEqual(running.numbers, []);
  // A pick saved after the train replaces the carry; the report stays for Admin to mark rows.
  const repicked = qaReleaseTrainSelectionFrom({
    pick: { numbers: [2598, 2763], at: new Date("2026-10-24T02:00:00Z"), by: "owner@example.com" },
    admission: { slot: "20261024-1100", at: admittedAt },
    lastTrain,
  });
  assert.deepEqual(repicked.numbers, [2598, 2763]);
  assert.equal(repicked.lastTrain, lastTrain);
});

test("what a release carries is its commits: a merge subject or a cherry-picked merge commit, never a number its body mentions", () => {
  const picked = "a".repeat(40);
  assert.deepEqual(
    qaReleaseTrainCarried([
      `Merge pull request #2919 from mposition/codex/memory01\n\nx\n\n(cherry picked from commit ${picked})`,
      "Merge main into release/x",
      "test(e2e): re-record goldens for #2940",
    ]),
    { numbers: new Set([2919]), shas: new Set([picked]) },
  );
  // 2026-10-25: #2941 carried #2919 and #2934; its body told staging to run
  // the checklist from #2940, which stayed on develop.
  const body = "Selective release of #2919 and #2934.\n\nStaging is still to do: run docs/ops/memory-launch-staging-checklist.md (#2940) there before merge.";
  const memoryRelease = { number: 2941, title: "release: account memory owner launch (#2919, #2934)", body, merged_at: "2026-10-22T05:00:00Z" };
  const reworded = { ...develop(2934, "2026-10-22T03:00:00Z"), merge_commit_sha: "b".repeat(40) };
  const candidates = qaReleaseTrainCargoCandidates({
    mergedDevelopJson: [develop(2940, "2026-10-22T04:00:00Z"), reworded, develop(2919, "2026-10-22T02:00:00Z")],
    mergedMainJson: [memoryRelease],
    openMainJson: [],
    files: new Map([[2940, ["docs/ops/memory-launch-staging-checklist.md"]]]),
    // #2934 rides as a cherry-pick whose subject was reworded: its merge commit still matches.
    mainCommits: new Map([
      [2941, [commit("Merge pull request #2919 from mposition/codex/x"), commit(`memory owner launch\n\n(cherry picked from commit ${"b".repeat(40)})`)]],
    ]),
    developCommits: new Map([[2940, ["d".repeat(40), "e".repeat(40)]]]),
    nowMs: NOW,
  });
  // #2940 is only mentioned: it can be picked, with a word to check.
  assert.deepEqual(
    candidates.map((c) => [c.number, c.status, c.mainPullRequest]),
    [
      [2940, "mentioned", 2941],
      [2934, "on_main", 2941],
      [2919, "on_main", 2941],
    ],
  );
  assert.equal(qaReleaseTrainCargoPickable("mentioned"), true);
  // Its commits unread, the title still names what it carries -- and only that.
  const fallback = qaReleaseTrainCargoCandidates({
    mergedDevelopJson: [develop(2940, "2026-10-22T04:00:00Z"), develop(2919, "2026-10-22T02:00:00Z")],
    mergedMainJson: [memoryRelease],
    openMainJson: [],
    files: new Map([[2940, ["docs/a.md"]]]),
    nowMs: NOW,
  });
  assert.deepEqual(
    fallback.map((c) => [c.number, c.status]),
    [
      [2940, "mentioned"],
      [2919, "on_main"],
    ],
  );
});

test("a release that cherry-picks a pull request's own commits one by one carries it once every one is there", () => {
  const [a, b, c] = ["a", "b", "c"].map((x) => x.repeat(40));
  const release2943 = { number: 2943, title: "release(mobile): voice", body: "Carries the voice work from #2937.", merged_at: "2026-10-22T05:00:00Z" };
  const candidates = qaReleaseTrainCargoCandidates({
    mergedDevelopJson: [develop(2937, "2026-10-22T04:00:00Z"), develop(2936, "2026-10-22T03:00:00Z")],
    mergedMainJson: [release2943],
    openMainJson: [],
    files: new Map([
      [2937, ["lib/a.ts"]],
      [2936, ["lib/b.ts"]],
    ]),
    // #2937's two commits are both there (one as a cherry-pick); only one of #2936's.
    mainCommits: new Map([[2943, [commit("fix: a", a), commit(`fix: b\n\n(cherry picked from commit ${b})`)]]]),
    developCommits: new Map([
      [2937, [a, b]],
      [2936, [a, c]],
    ]),
    nowMs: NOW,
  });
  assert.deepEqual(
    candidates.map((x) => [x.number, x.status, x.mainPullRequest]),
    [
      [2937, "on_main", 2943],
      [2936, "available", null],
    ],
  );
});
