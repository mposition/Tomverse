import assert from "node:assert/strict";
import test from "node:test";

import {
  QA_RELEASE_TRAIN_CARGO_MAX,
  parseQaReleaseTrainCargoPick,
  qaReleaseTrainCargoCandidates,
  qaReleaseTrainCargoPickable,
  parseQaReleaseTrainEmergencyReason,
  qaReleaseTrainEmergencyAdmissible,
  qaReleaseTrainEmergencyFrom,
  qaReleaseTrainHiddenFrom,
  qaReleaseTrainHiddenUpdate,
  QA_RELEASE_TRAIN_HIDDEN_MAX,
  qaReleaseTrainCarried,
  qaReleaseTrainLastTrainFrom,
  qaReleaseTrainReferencedNumbers,
  qaReleaseTrainSelectionFrom,
  qaReleaseTrainFoundOnMain,
  qaReleaseTrainWithTrainVerdicts,
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
const THIS_REPOSITORY = { full_name: "mposition/Tomverse" };
const release = (number, body, merged = true) => ({
  number,
  title: `release: ${number}`,
  body,
  merged_at: merged ? "2026-10-22T05:00:00Z" : null,
  head: { ref: `release/r${number}`, repo: THIS_REPOSITORY },
});

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
    // A number inside an item's title is a reference, not a rider (review r-20261025-085135).
    "- #2844 AMUX Workers, follow up on #2800",
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
    openMainJson: [{ ...release(902, "No numbers.", false), head: { ref: "release/2026-10-23-train-picker", repo: THIS_REPOSITORY } }],
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
      { number: 2763, outcome: "conflict", why: "It needs #2598." },
      { number: 2742, outcome: "conflict", why: "" },
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
      { number: 2763, reason: "conflict", why: "It needs #2598." },
      { number: 2742, reason: "conflict", why: null },
      { number: 2950, reason: "over_capacity", why: null },
    ],
  });
  // A train that did not ask the model gives no why.
  assert.deepEqual(
    qaReleaseTrainLastTrainFrom({ slot: "20261024-2300", outcome: "opened", pullRequestNumber: 2964, picks: [{ number: 2913, outcome: "conflict" }] }).carried,
    [{ number: 2913, reason: "conflict", why: null }],
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

// Emergency trains (owner request 2026-10-25).
test("an emergency request waits until an emergency admission after it takes it; an empty one withdraws it", () => {
  const at = new Date("2026-10-25T03:00:00Z");
  const request = { id: "req-1", numbers: [2988], reason: "  app sign-in\n fix ", at, by: "owner@example.com" };
  assert.deepEqual(qaReleaseTrainEmergencyFrom({ request: null, admission: null }), { pending: null, departedWith: null });
  assert.deepEqual(qaReleaseTrainEmergencyFrom({ request, admission: { slot: "20261025-1000", at: new Date("2026-10-25T00:00:00Z") } }), {
    pending: { id: "req-1", numbers: [2988], reason: "app sign-in fix", requestedAt: at.toISOString(), requestedBy: "owner@example.com" },
    departedWith: null,
  });
  assert.deepEqual(qaReleaseTrainEmergencyFrom({ request, admission: { slot: "20261025-1305", at: new Date("2026-10-25T03:05:00Z") } }), {
    pending: null,
    departedWith: "20261025-1305",
  });
  assert.equal(qaReleaseTrainEmergencyFrom({ request: { ...request, numbers: [] }, admission: null }).pending, null);
  // A row that does not parse is no request.
  assert.equal(qaReleaseTrainEmergencyFrom({ request: { ...request, reason: "x" }, admission: null }).pending, null);
  assert.equal(parseQaReleaseTrainEmergencyReason("four"), null);
  assert.equal(parseQaReleaseTrainEmergencyReason("x".repeat(301)), null);
  assert.equal(parseQaReleaseTrainEmergencyReason(" five! "), "five!");

  // Review r-20261025-053930: only the request the train read and assembled
  // from may be admitted -- not one replaced, withdrawn or spent since.
  const pending = qaReleaseTrainEmergencyFrom({ request, admission: null }).pending;
  assert.equal(qaReleaseTrainEmergencyAdmissible(pending, "req-1"), true);
  assert.equal(qaReleaseTrainEmergencyAdmissible(qaReleaseTrainEmergencyFrom({ request: { ...request, id: "req-2" }, admission: null }).pending, "req-1"), false);
  assert.equal(qaReleaseTrainEmergencyAdmissible(qaReleaseTrainEmergencyFrom({ request: { ...request, numbers: [] }, admission: null }).pending, "req-1"), false);
  assert.equal(qaReleaseTrainEmergencyAdmissible(null, "req-1"), false);
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

test("a train's Left out and skipped lists are not mentions: a left-out pull request stays available", () => {
  // 2026-10-27: #3041, left out of #3046 for a conflict, read as "mentioned · check".
  const body = [
    "Release train 20261027-0800 (AEST).",
    "",
    "## Included (1)",
    "",
    "- #3040 amux all providers",
    "",
    "## Left out (1)",
    "",
    "- #3041 mcp provider expansion — cherry-pick conflict on main",
    "",
    "Already on main, skipped: none.",
    "",
    "Already on an open train, skipped: #3039.",
  ].join("\n");
  const train = (merged) => ({
    number: 3046,
    title: "release: train 20261027-0800 (1 PR)",
    body,
    merged_at: merged ? "2026-10-22T05:00:00Z" : null,
    head: { ref: "release/train-20261027-0800", repo: THIS_REPOSITORY },
  });
  for (const merged of [true, false]) {
    const candidates = qaReleaseTrainCargoCandidates({
      mergedDevelopJson: [develop(3041, "2026-10-22T04:00:00Z"), develop(3040, "2026-10-22T03:00:00Z")],
      mergedMainJson: merged ? [train(true)] : [],
      openMainJson: merged ? [] : [train(false)],
      files: new Map([
        [3041, ["lib/a.ts"]],
        [3040, ["lib/b.ts"]],
      ]),
      nowMs: NOW,
    });
    assert.deepEqual(
      candidates.map((c) => [c.number, c.status, c.mainPullRequest]),
      [
        [3041, "available", null],
        [3040, merged ? "on_main" : "in_main_pull_request", 3046],
      ],
    );
  }
  // A hand-written release's body is still read for mentions.
  const handWritten = { ...train(true), head: { ref: "release/memory", repo: THIS_REPOSITORY } };
  const [left] = qaReleaseTrainCargoCandidates({
    mergedDevelopJson: [develop(3041, "2026-10-22T04:00:00Z")],
    mergedMainJson: [handWritten],
    openMainJson: [],
    files: new Map([[3041, ["lib/a.ts"]]]),
    nowMs: NOW,
  });
  assert.equal(left.status, "mentioned");
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

// Review r-20261025-085135: anyone can open a pull request on the public
// repository from a fork, with any title or body. A fork's open pull request
// never holds a candidate back as "in a main PR".
test("a fork's open main pull request is not believed for what it carries", () => {
  const fork = {
    number: 990,
    title: "release: train 20261025-1500 (1 PR) (#21)",
    body: "## Included (1)\n\n- #21 forged\n",
    merged_at: null,
    head: { ref: "release/train-20261025-1500", repo: { full_name: "someone/Tomverse" } },
  };
  const gone = { ...fork, number: 991, head: { ref: "release/train-20261025-1600", repo: null } };
  const candidates = qaReleaseTrainCargoCandidates({
    mergedDevelopJson: [develop(21, "2026-10-22T04:00:00Z")],
    mergedMainJson: [],
    openMainJson: [fork, gone],
    files: new Map([[21, ["lib/a.ts"]]]),
    nowMs: NOW,
  });
  assert.deepEqual(
    candidates.map((c) => [c.number, c.status]),
    [[21, "available"]],
  );
  // The same pull request from this repository's branch is.
  const ours = qaReleaseTrainCargoCandidates({
    mergedDevelopJson: [develop(21, "2026-10-22T04:00:00Z")],
    mergedMainJson: [],
    openMainJson: [{ ...fork, head: { ref: fork.head.ref, repo: THIS_REPOSITORY } }],
    files: new Map([[21, ["lib/a.ts"]]]),
    nowMs: NOW,
  });
  assert.deepEqual(
    ours.map((c) => [c.number, c.status, c.mainPullRequest]),
    [[21, "in_main_pull_request", 990]],
  );
});

test("an operator's hidden candidates: read back, hidden and shown again, malformed reads as none", () => {
  assert.deepEqual(qaReleaseTrainHiddenFrom(undefined), []);
  assert.deepEqual(qaReleaseTrainHiddenFrom(null), []);
  assert.deepEqual(qaReleaseTrainHiddenFrom("3042"), []);
  assert.deepEqual(qaReleaseTrainHiddenFrom([3042, -1, 1.5, "7", 3042, 2967]), [3042, 2967]);
  assert.deepEqual(qaReleaseTrainHiddenUpdate([3042], 2967, true), [3042, 2967]);
  // Hiding again moves it to the newest end; showing it removes it.
  assert.deepEqual(qaReleaseTrainHiddenUpdate([3042, 2967], 3042, true), [2967, 3042]);
  assert.deepEqual(qaReleaseTrainHiddenUpdate([3042, 2967], 3042, false), [2967]);
  assert.deepEqual(qaReleaseTrainHiddenUpdate([2967], 3042, false), [2967]);
  // Only the newest are kept.
  const full = Array.from({ length: QA_RELEASE_TRAIN_HIDDEN_MAX }, (_, i) => i + 1);
  const next = qaReleaseTrainHiddenUpdate(full, 9999, true);
  assert.equal(next.length, QA_RELEASE_TRAIN_HIDDEN_MAX);
  assert.equal(next[0], 2);
  assert.equal(next.at(-1), 9999);
});

test("a Dependabot package update is never a candidate: Dependabot opens its own main pull request", () => {
  const candidates = qaReleaseTrainCargoCandidates({
    mergedDevelopJson: [
      develop(3045),
      develop(2975, "2026-10-22T00:00:00Z", { user: { login: "dependabot[bot]" }, head: { ref: "dependabot/npm_and_yarn/develop/ajv-8.20.0" } }),
      develop(2974, "2026-10-22T00:00:00Z", { user: { login: "Dependabot" } }),
      develop(2973, "2026-10-22T00:00:00Z", { user: { login: "dependabot-preview[bot]" } }),
    ],
    mergedMainJson: [],
    openMainJson: [],
    files: new Map(),
    nowMs: NOW,
  });
  assert.deepEqual(candidates.map((candidate) => candidate.number), [3045, 2973]);
});

test("a pull request a train found already on main reads as on main, named by the newest train that found it", () => {
  // Newest report first, as the store reads them.
  const found = qaReleaseTrainFoundOnMain([
    { slot: "20261029-1100", report: { pullRequestNumber: null, picks: [{ number: 2979, outcome: "already_in_main" }, { number: 3001, outcome: "conflict" }] } },
    {
      slot: "20261028-2000",
      report: {
        pullRequestNumber: 3080,
        picks: [{ number: 2979, outcome: "already_in_main" }, { number: 2990, outcome: "already_in_main" }, { number: "x", outcome: "already_in_main" }],
      },
    },
    { slot: "20261028-1700", report: { pullRequestNumber: 3070, picks: "not a list" } },
  ]);
  assert.deepEqual([...found], [
    [2979, "20261029-1100"],
    [2990, "#3080"],
  ]);
  const candidate = (number, status, mainPullRequest = null) => ({ number, title: "t", author: "a", mergedAt: "2026-10-25T00:00:00Z", status, mainPullRequest });
  const verdicts = qaReleaseTrainWithTrainVerdicts(
    [candidate(2979, "available"), candidate(2990, "mentioned", 3050), candidate(3001, "unchecked"), candidate(2995, "in_main_pull_request", 3090)],
    new Map([...found, [2995, "#3080"]]),
  );
  assert.deepEqual(
    verdicts.map((c) => [c.number, c.status, c.mainPullRequest, c.foundByTrain]),
    [
      [2979, "on_main", null, "20261029-1100"],
      [2990, "on_main", null, "#3080"],
      [3001, "unchecked", null, undefined],
      // A status GitHub's records already settle is kept.
      [2995, "in_main_pull_request", 3090, undefined],
    ],
  );
  assert.equal(qaReleaseTrainCargoPickable(verdicts[0].status), false);
});
