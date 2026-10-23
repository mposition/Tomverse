import assert from "node:assert/strict";
import test from "node:test";

import { judgeQaReleaseMergeLaneExclusion, qaReleaseMergeLaneExcludingFiles } from "../lib/qaReleaseMergeLaneExclusionCore.ts";
import { runQaReleaseMergeLaneRound } from "../lib/qaReleaseMergeLaneServiceCore.ts";
import { qaReleaseLaneVerdicts } from "../lib/qaReleaseMergeLaneVerdictCore.ts";

const HEAD = "a".repeat(40);
const GREEN = [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "PR Fast Gate", name: "unit" }];
const RED = [
  ...GREEN,
  { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE", workflowName: "PR Fast Gate", name: "High-risk UI regression" },
];
const RUNNING = [{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null, workflowName: "PR Fast Gate", name: "unit" }];

const pull = (number, overrides = {}) => ({
  number,
  title: `PR ${number}`,
  createdAt: `2026-10-${String(number % 28 + 1).padStart(2, "0")}T00:00:00Z`,
  baseRefName: "develop",
  headRefName: `claude/to-develop/f${number}`,
  headRefOid: HEAD,
  isDraft: false,
  mergeable: "MERGEABLE",
  state: "OPEN",
  statusCheckRollup: GREEN,
  ...overrides,
});

const inputs = (files) => ({
  headBranch: "claude/to-develop/x",
  changedFiles: files.map((path) => ({ path })),
  changedFilesComplete: true,
  policyTestPaths: ["tests/mergeTrainCore.test.mjs"],
  agentOwnPatterns: ["lib/qaRelease*"],
});

test("the excluding files are exactly the ones the judgement stopped on, with why", () => {
  const input = inputs([".github/workflows/pr-fast-gate.yml", "components/chat/x.tsx", ".github/actions/setup/action.yml", "tests/mergeTrainCore.test.mjs", "lib/qaReleaseTrainCore.ts"]);
  assert.deepEqual(judgeQaReleaseMergeLaneExclusion(input), { excluded: true, reasons: ["agent_own_path", "gate_path", "policy_test"] });
  assert.deepEqual(qaReleaseMergeLaneExcludingFiles(input), [
    { path: ".github/workflows/pr-fast-gate.yml", reasons: ["gate_path"] },
    { path: ".github/actions/setup/action.yml", reasons: ["gate_path"] },
    { path: "tests/mergeTrainCore.test.mjs", reasons: ["policy_test"] },
    { path: "lib/qaReleaseTrainCore.ts", reasons: ["agent_own_path"] },
  ]);
  // A clear pull request names nothing; unread inputs name nothing rather than guess.
  assert.deepEqual(qaReleaseMergeLaneExcludingFiles(inputs(["components/chat/x.tsx"])), []);
  assert.deepEqual(qaReleaseMergeLaneExcludingFiles({ ...input, policyTestPaths: null }), []);
});

test("every open develop pull request gets one status, oldest first", () => {
  const pulls = [
    pull(1, { isDraft: true }),
    pull(2, { statusCheckRollup: RED }),
    pull(3, { statusCheckRollup: RUNNING }),
    pull(4, { mergeable: "CONFLICTING" }),
    pull(5),
    pull(6),
    pull(7),
    pull(8, { baseRefName: "main" }),
  ];
  const verdicts = qaReleaseLaneVerdicts({
    pulls,
    exclusions: new Map([
      [5, { excluded: true, reasons: ["gate_path"] }],
      [6, { excluded: false }],
    ]),
    excludingFiles: new Map([[5, [{ path: ".github/workflows/x.yml", reasons: ["gate_path"] }]]]),
    pickNumber: 6,
  });
  assert.deepEqual(
    verdicts.map((v) => [v.number, v.status, v.reasons]),
    [
      [1, "draft", []],
      [2, "fix", ["checks_failed"]],
      [3, "waiting", ["checks_pending"]],
      [4, "fix", ["mergeable_conflicting"]],
      [5, "human", ["gate_path"]],
      [6, "next", []],
      // Not judged: its turn comes after the pick, and the screen does not guess.
      [7, "queued", []],
    ],
  );
  assert.deepEqual(verdicts[1].failedChecks, ["PR Fast Gate › High-risk UI regression"]);
  assert.deepEqual(verdicts[4].files, [{ path: ".github/workflows/x.yml", reasons: ["gate_path"] }]);
  assert.equal(verdicts[0].title, "PR 1");
});

const ENV = {
  QA_RELEASE_MERGE_LANE_SECRET: "s".repeat(40),
  QA_RELEASE_MERGE_LANE_APP_ID: "123",
  QA_RELEASE_MERGE_LANE_APP_PRIVATE_KEY: "key",
  QA_RELEASE_MERGE_LANE_RAILWAY_TOKEN: "token",
  QA_RELEASE_MERGE_LANE_ENABLED: "true",
  QA_RELEASE_MERGE_LANE_KILL_SWITCH: "",
  QA_RELEASE_CONTROL_REVISION: "4",
};

const lanePorts = (pulls, filesOf, issue = { issued: false, reason: "lane_off" }) => {
  const calls = [];
  const record = (name, value) => async (...args) => {
    calls.push([name, ...args]);
    return typeof value === "function" ? value(...args) : value;
  };
  return {
    calls,
    ports: {
      app: {
        readState: record("readState", { dbNowMs: Date.now(), latched: false, openAttempt: null }),
        issue: record("issue", issue),
        consume: record("consume", { consumed: true }),
        report: record("report", { recorded: true }),
      },
      github: {
        listOpenDevelopPulls: record("list", pulls),
        exclusionInputs: record("exclusion", (p) => {
          if (filesOf(p) === null) throw new Error("github_500");
          return inputs(filesOf(p));
        }),
        readPull: record("readPull", (n) => ({ ...pull(n), merged: false, mergeCommitSha: null })),
        merge: record("merge", { result: "refused" }),
        onDevelop: record("onDevelop", true),
        commitsContaining: record("containing", new Set()),
        cancelledCommits: record("cancelled", new Set()),
      },
      railway: { developDeployments: record("deployments", []) },
    },
  };
};

test("the round shows people their pull requests, even behind the pick, without changing the pick", async () => {
  const files = { 2: [".github/workflows/a.yml"], 3: ["components/x.tsx"], 4: ["AGENTS.md"], 5: null };
  const { ports, calls } = lanePorts([pull(2), pull(3), pull(4), pull(5)], (p) => files[p.number]);
  let seen = null;
  const outcome = await runQaReleaseMergeLaneRound(ENV, ports, { verdicts: (list) => { seen = list; } });
  // The pick is the oldest clear one, exactly as without an observer.
  assert.equal(calls.find((c) => c[0] === "issue")[1].pullRequestNumber, 3);
  assert.equal(outcome.outcome, "instruction_refused");
  assert.deepEqual(
    seen.map((v) => [v.number, v.status]),
    [[2, "human"], [3, "next"], [4, "human"], [5, "queued"]],
  );
  assert.deepEqual(seen[2].files, [{ path: "AGENTS.md", reasons: ["gate_path"] }]);

  // Without an observer the round reads no more than it needs.
  const quiet = lanePorts([pull(2), pull(3), pull(4), pull(5)], (p) => files[p.number]);
  await runQaReleaseMergeLaneRound(ENV, quiet.ports);
  assert.deepEqual(quiet.calls.filter((c) => c[0] === "exclusion").map((c) => c[1].number), [2, 3]);
});

test("a round that holds for a deploy shows nothing new", async () => {
  const { ports } = lanePorts([pull(2)], () => ["components/x.tsx"]);
  ports.railway.developDeployments = async () => [{ status: "BUILDING", createdAt: new Date().toISOString(), serviceId: "s", meta: { branch: "develop", commitHash: HEAD } }];
  let seen = "untouched";
  const outcome = await runQaReleaseMergeLaneRound(ENV, ports, { verdicts: (list) => { seen = list; } });
  assert.equal(outcome.outcome, "hold");
  assert.equal(seen, "untouched");
});
