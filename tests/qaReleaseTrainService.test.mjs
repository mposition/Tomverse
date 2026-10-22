import assert from "node:assert/strict";
import test from "node:test";

import { qaReleaseTrainReadFailure, runQaReleaseTrainRound } from "../lib/qaReleaseTrainService.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const MAIN = "d".repeat(40);
const HEAD = "e".repeat(40);
// 2026-10-20 11:05 AEST.
const NOW = Date.parse("2026-10-20T01:05:00Z");

const env = (overrides = {}) => ({
  QA_RELEASE_MERGE_LANE_SECRET: "s".repeat(40),
  QA_RELEASE_MERGE_LANE_APP_ID: "1",
  QA_RELEASE_MERGE_LANE_APP_PRIVATE_KEY: "k",
  QA_RELEASE_CONTROL_REVISION: "3",
  QA_RELEASE_TRAIN_ENABLED: "true",
  ...overrides,
});

const cargo = [
  { number: 11, title: "fix: two", mergeCommitSha: B, mergedAt: "2026-10-20T00:10:00Z" },
  { number: 10, title: "feat: one", mergeCommitSha: A, mergedAt: "2026-10-20T00:00:00Z" },
  { number: 12, title: "feat: three", mergeCommitSha: C, mergedAt: "2026-10-20T00:20:00Z" },
];

function ports(overrides = {}) {
  const calls = [];
  const note = (name, value) => (calls.push([name, value]), value);
  const p = {
    github: {
      branchExists: async (branch) => note("branchExists", overrides.branchExists ?? false) && branch,
      openTrains: async () => note("openTrains", overrides.openTrains ?? 0),
      cargo: async (numbers) => note("cargo", (overrides.cargo ?? cargo).filter((c) => numbers.includes(c.number))),
      openPullRequest: async (pr) => {
        note("openPullRequest", pr);
        if (overrides.prFails) throw new Error("github_422");
        return 4242;
      },
    },
    git: {
      assemble: async (branch, list, capacity) => {
        note("assemble", { branch, numbers: list.map((c) => c.number), capacity });
        const outcomes = overrides.outcomes ?? {};
        return { mainSha: MAIN, headSha: HEAD, picks: list.map((c) => ({ number: c.number, outcome: outcomes[c.number] ?? "included" })) };
      },
      push: async (branch) => {
        note("push", branch);
        if (overrides.pushFails) throw new Error("git_failed");
      },
    },
    app: {
      selection: async () => note("selection", overrides.selection ?? (overrides.cargo ?? cargo).map((c) => c.number)),
      admit: async (slot) => note("admit", overrides.admit ?? { admitted: true }) && (calls.push(["admitSlot", slot]), overrides.admit ?? { admitted: true }),
      report: async (report) => void note("report", report),
    },
  };
  return { p, calls, names: () => calls.map(([n]) => n) };
}

test("off, or a bad departure list, does nothing at all", async () => {
  for (const overrides of [{ QA_RELEASE_TRAIN_ENABLED: "false" }, { QA_RELEASE_TRAIN_ENABLED: undefined }]) {
    const { p, calls } = ports();
    assert.deepEqual(await runQaReleaseTrainRound(env(overrides), p, NOW), { exitCode: 0, train: "disabled" });
    assert.deepEqual(calls, []);
  }
  const { p, calls } = ports();
  assert.deepEqual(await runQaReleaseTrainRound(env({ QA_RELEASE_TRAIN_SLOTS: "8,8" }), p, NOW), { exitCode: 1, train: "refused_to_start" });
  assert.deepEqual(calls, []);
});

test("outside a departure hour, after this departure's branch exists, with an open train, or with no cargo, nothing is written", async () => {
  const outside = ports();
  assert.equal((await runQaReleaseTrainRound(env(), outside.p, Date.parse("2026-10-20T00:59:00Z"))).train, "no_departure");
  assert.deepEqual(outside.calls, []);
  for (const [overrides, expected] of [
    [{ branchExists: true }, "departure_done"],
    [{ openTrains: 1 }, "train_open"],
    [{ cargo: [] }, "no_cargo"],
  ]) {
    const { p, names } = ports(overrides);
    assert.equal((await runQaReleaseTrainRound(env(), p, NOW)).train, expected);
    assert.ok(!names().includes("admit") && !names().includes("push") && !names().includes("report"), expected);
  }
});

test("a refused admission stops before git", async () => {
  const { p, names } = ports({ admit: { admitted: false, reason: "latched" } });
  assert.deepEqual(await runQaReleaseTrainRound(env(), p, NOW), { exitCode: 0, train: "not_admitted", reason: "latched" });
  assert.ok(!names().includes("assemble"));
});

test("cargo rides in develop merge order; a conflict is left out and named; the pull request is opened and reported", async () => {
  const { p, calls } = ports({ outcomes: { 11: "conflict", 12: "already_in_main" } });
  const outcome = await runQaReleaseTrainRound(env(), p, NOW);
  assert.deepEqual(outcome, { exitCode: 0, train: "opened", slot: "20261020-1100", pullRequestNumber: 4242, included: 1, leftOut: 1 });
  const get = (name) => calls.find(([n]) => n === name)[1];
  // Every picked pull request goes to assembly; capacity counts riders there.
  assert.deepEqual(get("assemble"), { branch: "release/train-20261020-1100", numbers: [10, 11, 12], capacity: 30 });
  assert.equal(get("push"), "release/train-20261020-1100");
  const pr = get("openPullRequest");
  assert.equal(pr.head, "release/train-20261020-1100");
  assert.match(pr.body, /- #11 fix: two — cherry-pick conflict/);
  assert.match(pr.body, new RegExp(`Rollback SHA: +${MAIN}`));
  assert.deepEqual(get("report"), {
    slot: "20261020-1100",
    outcome: "opened",
    pullRequestNumber: 4242,
    branch: "release/train-20261020-1100",
    rcSha: HEAD,
    failure: null,
    picks: [
      { number: 10, outcome: "included" },
      { number: 11, outcome: "conflict" },
      { number: 12, outcome: "already_in_main" },
    ],
  });
});

test("a train with nothing to carry after assembly opens nothing and reports empty", async () => {
  const { p, names } = ports({ outcomes: { 10: "already_in_main", 11: "conflict", 12: "already_in_main" } });
  assert.deepEqual(await runQaReleaseTrainRound(env(), p, NOW), { exitCode: 0, train: "empty", slot: "20261020-1100" });
  assert.ok(!names().includes("push") && !names().includes("openPullRequest"));
});

test("a failed push or pull request is reported with a code and never retried in the round", async () => {
  const push = ports({ pushFails: true });
  assert.deepEqual(await runQaReleaseTrainRound(env(), push.p, NOW), { exitCode: 1, train: "failed", failure: "push_failed" });
  assert.ok(!push.names().includes("openPullRequest"));
  assert.equal(push.calls.find(([n]) => n === "report")[1].branch, null);
  const pr = ports({ prFails: true });
  assert.deepEqual(await runQaReleaseTrainRound(env(), pr.p, NOW), { exitCode: 1, train: "failed", failure: "pull_request_failed" });
  assert.equal(pr.calls.find(([n]) => n === "report")[1].branch, "release/train-20261020-1100");
});

test("a read failure names the step and the port's code, and nothing else", async () => {
  const failing = (where, error) => {
    const { p } = ports();
    if (where === "cargo") p.github.cargo = async () => { throw error; };
    if (where === "selection") p.app.selection = async () => { throw error; };
    if (where === "open_trains") p.github.openTrains = async () => { throw error; };
    if (where === "admit") p.app.admit = async () => { throw error; };
    return p;
  };
  assert.deepEqual(await runQaReleaseTrainRound(env(), failing("cargo", new Error("github_403")), NOW), {
    exitCode: 1,
    train: "read_failed",
    failure: "cargo:github_403",
  });
  assert.equal((await runQaReleaseTrainRound(env(), failing("open_trains", new Error("github_shape")), NOW)).failure, "open_trains:github_shape");
  assert.equal((await runQaReleaseTrainRound(env(), failing("admit", new Error("app_503")), NOW)).failure, "admit:app_503");
  assert.equal((await runQaReleaseTrainRound(env(), failing("selection", new Error("app_401")), NOW)).failure, "selection:app_401");
  // A network error's own text (which may carry a URL) never reaches the log.
  assert.equal(qaReleaseTrainReadFailure("cargo", new Error("fetch failed: https://api.github.com/x?token=1")), "cargo:unknown");
  assert.equal(qaReleaseTrainReadFailure("branch", "not an error"), "branch:unknown");
});

test("nothing picked in Admin is no cargo: no GitHub read of pull requests, no admission", async () => {
  const { p, names } = ports({ selection: [] });
  assert.deepEqual(await runQaReleaseTrainRound(env(), p, NOW), { exitCode: 0, train: "no_cargo" });
  assert.ok(!names().includes("cargo"));
  assert.ok(!names().includes("admit"));
});

test("only the picked pull requests ride, in develop merge order", async () => {
  const { p, calls } = ports({ selection: [12, 10] });
  await runQaReleaseTrainRound(env(), p, NOW);
  assert.deepEqual(calls.find(([n]) => n === "assemble")[1].numbers, [10, 12]);
});
