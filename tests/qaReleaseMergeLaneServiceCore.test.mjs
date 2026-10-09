import assert from "node:assert/strict";
import test from "node:test";

import { runQaReleaseMergeLaneRound } from "../lib/qaReleaseMergeLaneServiceCore.ts";

const SECRET = "s".repeat(40);
const ENV = {
  QA_RELEASE_MERGE_LANE_SECRET: SECRET,
  QA_RELEASE_MERGE_LANE_APP_ID: "123",
  QA_RELEASE_MERGE_LANE_APP_PRIVATE_KEY: "key",
  QA_RELEASE_MERGE_LANE_RAILWAY_TOKEN: "token",
  QA_RELEASE_MERGE_LANE_ENABLED: "true",
  QA_RELEASE_MERGE_LANE_KILL_SWITCH: "",
  QA_RELEASE_CONTROL_REVISION: "4",
};
const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);
const NOW = Date.parse("2026-10-05T00:00:00Z");
const GREEN = [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "PR Fast Gate" }];

const pull = (number, overrides = {}) => ({
  number,
  createdAt: "2026-10-04T00:00:00Z",
  baseRefName: "develop",
  headRefName: `claude/to-develop/f${number}`,
  headRefOid: HEAD,
  isDraft: false,
  mergeable: "MERGEABLE",
  state: "OPEN",
  statusCheckRollup: GREEN,
  merged: false,
  mergeCommitSha: null,
  ...overrides,
});

const CLEAR_INPUTS = (p) => ({
  headBranch: p.headRefName,
  changedFiles: [{ path: "components/x.tsx" }],
  changedFilesComplete: true,
  policyTestPaths: [],
  agentOwnPatterns: [],
});

/** Fake ports recording every call; `overrides` replaces any answer. */
const ports = (overrides = {}) => {
  const calls = [];
  const record = (name, value) => async (...args) => {
    calls.push([name, ...args]);
    return typeof value === "function" ? value(...args) : value;
  };
  const p = {
    app: {
      readState: record("readState", overrides.state ?? { dbNowMs: NOW, latched: false, openAttempt: null }),
      issue: record("issue", overrides.issue ?? { issued: true, attemptId: "att-1" }),
      consume: record("consume", overrides.consume ?? { consumed: true }),
      report: record("report", overrides.report ?? { recorded: true }),
    },
    github: {
      listOpenDevelopPulls: record("list", overrides.pulls ?? [pull(7)]),
      exclusionInputs: record("exclusion", overrides.exclusionInputs ?? CLEAR_INPUTS),
      readPull: record("readPull", overrides.readPull ?? ((n) => pull(n))),
      merge: record("merge", overrides.merge ?? { result: "merged", sha: MERGE }),
      onDevelop: record("onDevelop", "onDevelop" in overrides ? overrides.onDevelop : true),
      commitsContaining: record("containing", overrides.containing ?? new Set()),
      cancelledCommits: record("cancelled", overrides.cancelled ?? new Set()),
    },
    railway: { stagingDeployments: record("deployments", overrides.deployments === undefined ? [] : overrides.deployments) },
  };
  return { ports: p, calls };
};

const names = (calls) => calls.map((call) => call[0]);
const reports = (calls) => calls.filter((call) => call[0] === "report").map((call) => call[2]);

test("a switched-off or misconfigured service does nothing", async () => {
  const off = ports();
  assert.deepEqual(await runQaReleaseMergeLaneRound({ ...ENV, QA_RELEASE_MERGE_LANE_KILL_SWITCH: "stop" }, off.ports), { exitCode: 0, outcome: "disabled" });
  assert.deepEqual(off.calls, []);
  const extra = ports();
  assert.deepEqual(await runQaReleaseMergeLaneRound({ ...ENV, DATABASE_URL: "x" }, extra.ports), { exitCode: 1, outcome: "refused_to_start" });
  assert.deepEqual(extra.calls, []);
});

test("a free lane merges the oldest clear candidate with the head pinned and reports where it landed", async () => {
  const { ports: p, calls } = ports({ readPull: (n) => (calls.filter((c) => c[0] === "merge").length ? pull(n, { merged: true, mergeCommitSha: MERGE }) : pull(n)) });
  const outcome = await runQaReleaseMergeLaneRound(ENV, p);
  assert.deepEqual(outcome, { exitCode: 0, outcome: "merged", pullRequestNumber: 7 });
  assert.deepEqual(names(calls), ["readState", "deployments", "list", "exclusion", "issue", "readPull", "deployments", "consume", "merge", "readPull", "onDevelop", "report"]);
  assert.deepEqual(calls.find((c) => c[0] === "merge").slice(1), [7, HEAD]);
  assert.deepEqual(reports(calls), [{ kind: "merge", result: "merged", mergeCommitSha: MERGE }]);
});

test("a latch, a staging deployment in flight or no candidate merges nothing", async () => {
  const latched = ports({ state: { dbNowMs: NOW, latched: true, openAttempt: null } });
  assert.equal((await runQaReleaseMergeLaneRound(ENV, latched.ports)).outcome, "latched");
  const busy = ports({ deployments: [{ serviceId: "web", serviceName: "web", status: "BUILDING", createdAt: "2026-10-04T23:00:00Z" }] });
  assert.equal((await runQaReleaseMergeLaneRound(ENV, busy.ports)).outcome, "hold");
  const none = ports({ pulls: [pull(7, { isDraft: true })] });
  assert.equal((await runQaReleaseMergeLaneRound(ENV, none.ports)).outcome, "idle");
  for (const run of [latched, busy, none]) assert.equal(names(run.calls).includes("merge"), false);
});

test("an excluded candidate is skipped for the next, and its exclusion is judged only once readiness passes", async () => {
  const { ports: p, calls } = ports({
    pulls: [pull(5, { createdAt: "2026-10-03T00:00:00Z", headRefName: "dependabot/npm/x" }), pull(6, { mergeable: "CONFLICTING" }), pull(7)],
    readPull: (n) => (calls.filter((c) => c[0] === "merge").length ? pull(n, { merged: true, mergeCommitSha: MERGE }) : pull(n)),
  });
  const outcome = await runQaReleaseMergeLaneRound(ENV, p);
  assert.equal(outcome.outcome, "merged");
  assert.equal(outcome.pullRequestNumber, 7);
  assert.deepEqual(calls.filter((c) => c[0] === "exclusion").map((c) => c[1].number), [5, 7]);
});

test("a pull request that moved between issue and consume, a busy staging or a switch pulled closes the attempt unmerged", async () => {
  for (const [label, overrides, env] of [
    ["head moved", { readPull: (n) => pull(n, { headRefOid: "c".repeat(40) }) }, ENV],
    ["base moved", { readPull: (n) => pull(n, { baseRefName: "main" }) }, ENV],
    ["went red", { readPull: (n) => pull(n, { statusCheckRollup: [{ ...GREEN[0], conclusion: "FAILURE" }] }) }, ENV],
  ]) {
    const { ports: p, calls } = ports(overrides);
    assert.deepEqual(await runQaReleaseMergeLaneRound(env, p), { exitCode: 0, outcome: "abandoned" }, label);
    assert.deepEqual(reports(calls), [{ kind: "reread", result: "not_merged" }], label);
    assert.equal(names(calls).includes("consume"), false, label);
  }
  // A refused consume closes it the same way.
  const refused = ports({ consume: { consumed: false, reason: "revision_moved" } });
  assert.equal((await runQaReleaseMergeLaneRound(ENV, refused.ports)).outcome, "abandoned");
  assert.equal(names(refused.calls).includes("merge"), false);
});

test("the merge call's refusal and its unknown answer are each reported, never retried", async () => {
  const refused = ports({ merge: { result: "refused" } });
  assert.equal((await runQaReleaseMergeLaneRound(ENV, refused.ports)).outcome, "reported");
  assert.deepEqual(reports(refused.calls), [{ kind: "merge", result: "refused" }]);
  const unknown = ports({ merge: async () => { throw new Error("timeout"); } });
  assert.equal((await runQaReleaseMergeLaneRound(ENV, unknown.ports)).outcome, "reported");
  assert.deepEqual(reports(unknown.calls), [{ kind: "merge", result: "unknown" }]);
  assert.equal(names(unknown.calls).filter((n) => n === "merge").length, 1);
});

test("a merge that did not land on develop is reported unknown, which latches", async () => {
  for (const [label, after, onDevelop] of [
    ["other base", pull(7, { merged: true, mergeCommitSha: MERGE, baseRefName: "release/x" }), true],
    ["off develop", pull(7, { merged: true, mergeCommitSha: MERGE }), false],
    ["unread", null, true],
  ]) {
    const { ports: p, calls } = ports({
      readPull: (n) => (calls.filter((c) => c[0] === "merge").length ? after : pull(n)),
      onDevelop,
    });
    await runQaReleaseMergeLaneRound(ENV, p);
    assert.deepEqual(reports(calls), [{ kind: "merge", result: "unknown" }], label);
  }
});

const awaiting = (overrides = {}) => ({
  dbNowMs: NOW,
  latched: false,
  openAttempt: {
    id: "att-9",
    state: "awaiting_deploy",
    pullRequestNumber: 9,
    headSha: HEAD,
    mergeCommitSha: MERGE,
    issuedAtMs: NOW - 10 * 60 * 1000,
    mergeNotBeforeMs: NOW - 9 * 60 * 1000,
    ...overrides,
  },
});
const deployment = (status, minutesAgo = 5, sha = MERGE) => ({
  serviceId: "web",
  serviceName: "tomverse-web",
  status,
  createdAt: new Date(NOW - minutesAgo * 60 * 1000).toISOString(),
  meta: { commitHash: sha, branch: "develop" },
});

test("an attempt awaiting deploy is judged by deploymentOutcome, with the observation, and nothing else happens that round", async () => {
  for (const [status, expected] of [["SUCCESS", "succeeded"], ["FAILED", "failed"]]) {
    const { ports: p, calls } = ports({ state: awaiting(), deployments: [deployment(status)] });
    await runQaReleaseMergeLaneRound(ENV, p);
    assert.deepEqual(reports(calls), [
      { kind: "deploy", outcome: expected, observation: [{ service: "tomverse-web", status, commitSha: MERGE }] },
    ]);
    assert.equal(names(calls).includes("issue"), false);
  }
  // A deploy in progress inside its limit is a wait: no report.
  const waiting = ports({ state: awaiting(), deployments: [deployment("BUILDING")] });
  assert.deepEqual(await runQaReleaseMergeLaneRound(ENV, waiting.ports), { exitCode: 0, outcome: "waiting" });
  assert.deepEqual(reports(waiting.calls), []);
  // Not seen past fifteen minutes is a wait exceeded.
  const unseen = ports({ state: awaiting({ mergeNotBeforeMs: NOW - 16 * 60 * 1000 }), deployments: [] });
  await runQaReleaseMergeLaneRound(ENV, unseen.ports);
  assert.deepEqual(reports(unseen.calls), [{ kind: "deploy", outcome: "wait_exceeded", observation: [] }]);
  // Railway unreadable latches without closing.
  const dark = ports({ state: awaiting(), deployments: null });
  await runQaReleaseMergeLaneRound(ENV, dark.ports);
  assert.deepEqual(reports(dark.calls), [{ kind: "deploy", outcome: "unreadable", observation: [] }]);
});

test("a latched lane still judges its open attempt", async () => {
  const { ports: p, calls } = ports({ state: { ...awaiting(), latched: true }, deployments: [deployment("SUCCESS")] });
  await runQaReleaseMergeLaneRound(ENV, p);
  assert.equal(reports(calls)[0].outcome, "succeeded");
});

test("an issued or consumed attempt waits twelve minutes, then latches once as unreported, then is re-read in order", async () => {
  const young = ports({ state: awaiting({ state: "consumed", issuedAtMs: NOW - 5 * 60 * 1000 }) });
  assert.equal((await runQaReleaseMergeLaneRound(ENV, young.ports)).outcome, "attempt_in_flight");
  const old = { state: "consumed", issuedAtMs: NOW - 13 * 60 * 1000, mergeCommitSha: null };
  const first = ports({ state: awaiting(old) });
  await runQaReleaseMergeLaneRound(ENV, first.ports);
  assert.deepEqual(reports(first.calls), [{ kind: "unreported" }]);

  const latchedOld = (overrides) => ports({ state: { ...awaiting(old), latched: true }, ...overrides });
  for (const [label, readPull, onDevelop, expected] of [
    ["unread", () => null, true, []],
    ["not merged", (n) => pull(n), true, [{ kind: "reread", result: "not_merged" }]],
    ["other base", (n) => pull(n, { merged: true, baseRefName: "main", mergeCommitSha: MERGE }), true, [{ kind: "reread", result: "merged_off_develop" }]],
    ["on develop", (n) => pull(n, { merged: true, mergeCommitSha: MERGE }), true, [{ kind: "reread", result: "merged_on_develop", mergeCommitSha: MERGE }]],
    ["not an ancestor", (n) => pull(n, { merged: true, mergeCommitSha: MERGE }), false, [{ kind: "reread", result: "merge_commit_off_develop" }]],
    ["compare silent", (n) => pull(n, { merged: true, mergeCommitSha: MERGE }), null, [{ kind: "reread", result: "merge_commit_off_develop" }]],
  ]) {
    const run = latchedOld({ readPull, onDevelop });
    await runQaReleaseMergeLaneRound(ENV, run.ports);
    assert.deepEqual(reports(run.calls), expected, label);
  }
});

test("a report the app did not record, or an unreadable state, ends the round as a failure", async () => {
  const notRecorded = ports({ state: awaiting(), deployments: [deployment("SUCCESS")], report: { recorded: false, reason: "state_moved" } });
  assert.deepEqual(await runQaReleaseMergeLaneRound(ENV, notRecorded.ports), { exitCode: 1, outcome: "report_not_recorded" });
  const unread = ports({ state: undefined });
  unread.ports.app.readState = async () => {
    throw new Error("timeout");
  };
  assert.deepEqual(await runQaReleaseMergeLaneRound(ENV, unread.ports), { exitCode: 1, outcome: "state_unknown" });
});

test("a pull request merged by someone else before the consume is tracked, and an unreadable one is left open", async () => {
  const mergedMeanwhile = ports({ readPull: (n) => pull(n, { merged: true, mergeCommitSha: MERGE }) });
  await runQaReleaseMergeLaneRound(ENV, mergedMeanwhile.ports);
  assert.deepEqual(reports(mergedMeanwhile.calls), [{ kind: "reread", result: "merged_on_develop", mergeCommitSha: MERGE }]);
  assert.equal(names(mergedMeanwhile.calls).includes("consume"), false);

  const mergedElsewhere = ports({ readPull: (n) => pull(n, { merged: true, baseRefName: "main", mergeCommitSha: MERGE }) });
  await runQaReleaseMergeLaneRound(ENV, mergedElsewhere.ports);
  assert.deepEqual(reports(mergedElsewhere.calls), [{ kind: "reread", result: "merged_off_develop" }]);

  const unread = ports({ readPull: () => null });
  assert.deepEqual(await runQaReleaseMergeLaneRound(ENV, unread.ports), { exitCode: 0, outcome: "attempt_in_flight" });
  assert.deepEqual(reports(unread.calls), []);
  assert.equal(names(unread.calls).includes("consume"), false);
});

test("a latched lane re-reads its unknown attempt at once, without the twelve-minute wait", async () => {
  const run = ports({
    state: { ...awaiting({ state: "consumed", issuedAtMs: NOW - 60 * 1000, mergeCommitSha: null }), latched: true },
    readPull: (n) => pull(n, { merged: true, mergeCommitSha: MERGE }),
  });
  await runQaReleaseMergeLaneRound(ENV, run.ports);
  assert.deepEqual(reports(run.calls), [{ kind: "reread", result: "merged_on_develop", mergeCommitSha: MERGE }]);
});

test("with the lane switch off (S-M1) the round names the pull request it would have merged, and touches nothing", async () => {
  const shadow = ports({ issue: { issued: false, reason: "lane_switch_off" } });
  const outcome = await runQaReleaseMergeLaneRound(ENV, shadow.ports);
  assert.equal(outcome.outcome, "instruction_refused");
  assert.equal(outcome.reason, "lane_switch_off");
  assert.equal(typeof outcome.pullRequestNumber, "number");
  assert.equal(outcome.headSha, HEAD);
  for (const name of ["consume", "merge", "report"]) assert.equal(names(shadow.calls).includes(name), false, name);
});

test("a status or service name outside the report's closed form never stops the deploy report from being recorded", async () => {
  const { qaReleaseDeployObservation } = await import("../lib/qaReleaseMergeLaneReportCore.ts");
  const odd = { ...deployment("MIGRATING"), serviceId: "svc-odd", serviceName: "web" };
  const named = { ...deployment("SUCCESS"), serviceName: "🚀 web/api (prod)" };
  const run = ports({ state: awaiting(), deployments: [named, odd] });
  await runQaReleaseMergeLaneRound(ENV, run.ports);
  const [report] = reports(run.calls);
  // The judgement comes from the raw list: an unknown status reads as unknown, which latches.
  assert.equal(report.kind, "deploy");
  assert.equal(report.outcome, "unknown");
  // The observation the route validates holds only entries in its closed form.
  assert.notEqual(qaReleaseDeployObservation(report.observation), null);
  assert.deepEqual(report.observation, [{ service: "s_ web_api _prod_", status: "SUCCESS", commitSha: MERGE }]);
});

test("a merge refused because someone else merged it meanwhile is followed through the re-read, not closed as refused", async () => {
  const merged = ports({
    merge: { result: "refused" },
    readPull: (n) => (merged.calls.some((c) => c[0] === "merge") ? pull(n, { merged: true, mergeCommitSha: MERGE }) : pull(n)),
  });
  await runQaReleaseMergeLaneRound(ENV, merged.ports);
  assert.deepEqual(reports(merged.calls), [{ kind: "reread", result: "merged_on_develop", mergeCommitSha: MERGE }]);
});

test("a merge refused while the pull request cannot be re-read is unknown, which latches, never refused", async () => {
  const unread = ports({
    merge: { result: "refused" },
    readPull: (n) => (unread.calls.some((c) => c[0] === "merge") ? null : pull(n)),
  });
  await runQaReleaseMergeLaneRound(ENV, unread.ports);
  assert.deepEqual(reports(unread.calls), [{ kind: "merge", result: "unknown" }]);
});
