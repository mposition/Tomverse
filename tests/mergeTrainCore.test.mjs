import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checksVerdict,
  deploymentOutcome,
  inFlightDeployments,
  laneState,
  parseTrainState,
  pickNextPullRequest,
  refusalReason,
  servicesDeployingBranch,
  withLane,
} from "../scripts/merge-train-core.mjs";

const run = (status, conclusion = null, name = "check", workflowName = "Other") => ({
  __typename: "CheckRun",
  name,
  status,
  conclusion,
  workflowName,
});
const gate = run("COMPLETED", "SUCCESS", "Unit and API policy tests", "PR Fast Gate");
const green = [gate, run("COMPLETED", "SKIPPED", "e2e")];

const pr = (number, createdAt, overrides = {}) => ({
  number,
  createdAt,
  baseRefName: "develop",
  isDraft: false,
  mergeable: "MERGEABLE",
  headRefOid: String(number).padStart(40, "0"),
  statusCheckRollup: green,
  ...overrides,
});

test("checksVerdict separates none, pending, failed and passed", () => {
  assert.equal(checksVerdict([]), "none");
  assert.equal(checksVerdict(undefined), "none");
  assert.equal(checksVerdict(green), "passed");
  assert.equal(checksVerdict([...green, run("IN_PROGRESS")]), "pending");
  assert.equal(checksVerdict([...green, run("QUEUED")]), "pending");
  assert.equal(checksVerdict([run("IN_PROGRESS"), run("COMPLETED", "FAILURE")]), "failed");
  assert.equal(checksVerdict([run("COMPLETED", "CANCELLED")]), "failed");
  assert.equal(checksVerdict([run("COMPLETED", "TIMED_OUT")]), "failed");
  assert.equal(checksVerdict([gate, run("COMPLETED", "NEUTRAL")]), "passed");
  assert.equal(checksVerdict([gate, { __typename: "StatusContext", state: "PENDING" }]), "pending");
  assert.equal(checksVerdict([gate, { __typename: "StatusContext", state: "ERROR" }]), "failed");
  assert.equal(checksVerdict([gate, { __typename: "StatusContext", state: "SUCCESS" }]), "passed");
});

test("a rollup without a successful PR Fast Gate run is not green", () => {
  // No branch protection names a required check, so a rollup of skipped
  // path-filtered checks -- or one read before the gate's runs exist -- would
  // otherwise pass.
  assert.equal(checksVerdict([run("COMPLETED", "SKIPPED", "promotion-pr")]), "missing_required");
  assert.equal(checksVerdict([run("COMPLETED", "SUCCESS", "scan", "Secret History Scan")]), "missing_required");
  assert.equal(
    checksVerdict([run("COMPLETED", "SKIPPED", "Report", "PR Fast Gate")]),
    "missing_required",
    "a skipped gate run is not a passed gate",
  );
  assert.equal(checksVerdict([run("QUEUED", null, "x", "PR Fast Gate")]), "pending");
});

test("refusalReason re-checks a PR read just before merging", () => {
  const ok = pr(1, "2026-10-02T00:00:00Z", { state: "OPEN" });
  assert.equal(refusalReason(ok, "develop"), null);
  assert.equal(refusalReason({ ...ok, state: "MERGED" }, "develop"), "state_merged");
  assert.equal(refusalReason({ ...ok, baseRefName: "main" }, "develop"), "base_changed");
  assert.equal(refusalReason({ ...ok, headRefOid: "x & calc" }, "develop"), "head_unreadable");
  assert.equal(
    refusalReason({ ...ok, statusCheckRollup: [gate, run("COMPLETED", "FAILURE")] }, "develop"),
    "checks_failed",
  );
});

test("picks the oldest green, non-draft, mergeable pull request into the branch", () => {
  const { pick, skipped } = pickNextPullRequest(
    [
      pr(30, "2026-10-02T03:00:00Z"),
      pr(10, "2026-10-02T01:00:00Z", { isDraft: true }),
      pr(20, "2026-10-02T02:00:00Z", { statusCheckRollup: [run("IN_PROGRESS")] }),
      pr(5, "2026-10-01T00:00:00Z", { baseRefName: "main" }),
      pr(40, "2026-10-02T04:00:00Z"),
    ],
    "develop",
  );
  assert.equal(pick.number, 30);
  assert.deepEqual(skipped, [
    { number: 10, reason: "draft" },
    { number: 20, reason: "checks_pending" },
  ]);
});

test("never picks a draft even when it is the only green pull request", () => {
  const { pick } = pickNextPullRequest([pr(1, "2026-10-02T00:00:00Z", { isDraft: true })], "develop");
  assert.equal(pick, null);
});

test("skips failed, check-less, conflicting and not-yet-computed pull requests", () => {
  const { pick, skipped } = pickNextPullRequest(
    [
      pr(1, "2026-10-02T00:00:00Z", { statusCheckRollup: [run("COMPLETED", "FAILURE")] }),
      pr(2, "2026-10-02T00:01:00Z", { statusCheckRollup: [] }),
      pr(3, "2026-10-02T00:02:00Z", { mergeable: "CONFLICTING" }),
      pr(4, "2026-10-02T00:03:00Z", { mergeable: "UNKNOWN" }),
    ],
    "develop",
  );
  assert.equal(pick, null);
  assert.deepEqual(
    skipped.map((entry) => entry.reason),
    ["checks_failed", "checks_none", "mergeable_conflicting", "mergeable_unknown"],
  );
});

test("equal creation times fall back to PR number", () => {
  const { pick } = pickNextPullRequest(
    [pr(9, "2026-10-02T00:00:00Z"), pr(8, "2026-10-02T00:00:00Z")],
    "develop",
  );
  assert.equal(pick.number, 8);
});

const commit = "c".repeat(40);
const deployment = (status, commitHash = commit, serviceId = "svc", branch = "develop") => ({
  status,
  serviceId,
  meta: { commitHash, branch },
});

test("any waiting, queued, building or deploying deployment holds the environment", () => {
  for (const status of ["WAITING", "NEEDS_APPROVAL", "QUEUED", "INITIALIZING", "BUILDING", "DEPLOYING"]) {
    assert.equal(inFlightDeployments([deployment("SUCCESS"), deployment(status)]).length, 1, status);
  }
  assert.equal(
    inFlightDeployments([deployment("SUCCESS"), deployment("FAILED"), deployment("REMOVED"), deployment("SKIPPED")]).length,
    0,
  );
});

test("deploymentOutcome needs every service that deploys the branch", () => {
  const both = ["web", "cron"];
  assert.equal(deploymentOutcome([deployment("WAITING", "d".repeat(40), "web")], commit, both).state, "not_seen");
  // The cron service finishes in seconds; the web service has not started.
  assert.equal(deploymentOutcome([deployment("SUCCESS", commit, "cron")], commit, both).state, "partial");
  assert.equal(
    deploymentOutcome([deployment("SUCCESS", commit, "cron"), deployment("WAITING", commit, "web")], commit, both).state,
    "in_progress",
  );
  assert.equal(
    deploymentOutcome([deployment("SUCCESS", commit, "cron"), deployment("SLEEPING", commit, "web")], commit, both).state,
    "succeeded",
  );
  for (const status of ["FAILED", "SKIPPED", "CRASHED"]) {
    assert.equal(
      deploymentOutcome([deployment("WAITING", commit, "cron"), deployment(status, commit, "web")], commit, both).state,
      "failed",
      status,
    );
  }
  assert.equal(deploymentOutcome([deployment("REMOVED", commit, "web")], commit, both).state, "unknown");
  assert.equal(deploymentOutcome([deployment("SOMETHING_NEW", commit, "web")], commit, both).state, "unknown");
});

test("a deployment REMOVED by a newer one for the same service is superseded, not unknown", () => {
  const at = (deployment, createdAt) => ({ ...deployment, createdAt });
  const newer = "e".repeat(40);
  const deployments = [
    at(deployment("SUCCESS", commit, "web"), "2026-10-02T01:00:00Z"),
    at(deployment("REMOVED", commit, "cron"), "2026-10-02T01:00:00Z"),
    at(deployment("SUCCESS", newer, "cron"), "2026-10-02T02:00:00Z"),
  ];
  assert.equal(deploymentOutcome(deployments, commit, ["web", "cron"]).state, "succeeded");
  // Nothing newer for that service: still unexplained.
  assert.equal(deploymentOutcome(deployments.slice(0, 2), commit, ["web", "cron"]).state, "unknown");
});

test("deploymentOutcome compares commit hashes case-insensitively", () => {
  const upper = commit.toUpperCase();
  assert.equal(deploymentOutcome([deployment("FAILED", upper, "web")], commit, ["web"]).state, "failed");
  assert.equal(deploymentOutcome([deployment("SUCCESS", commit, "web")], upper, ["web"]).state, "succeeded");
});

test("servicesDeployingBranch names services by the branch they deploy", () => {
  const deployments = [
    deployment("SUCCESS", commit, "web", "develop"),
    deployment("SUCCESS", commit, "cron", "develop"),
    deployment("SUCCESS", commit, "web", "develop"),
    deployment("SUCCESS", commit, "validation", "amux-validation"),
  ];
  assert.deepEqual(servicesDeployingBranch(deployments, "develop"), ["web", "cron"]);
});

const sha = "a".repeat(40);

test("a missing state file is an empty state, a corrupt one is an error", () => {
  assert.deepEqual(parseTrainState(null), { lanes: {} });
  // A corrupt file must never be what clears a latch.
  assert.throws(() => parseTrainState("{"));
  assert.throws(() => parseTrainState("{}"));
  assert.throws(() => parseTrainState(JSON.stringify({ lanes: { develop: { awaiting: { number: 1, sha: "short", mergedAt: 1 } } } })));
  assert.throws(() => parseTrainState(JSON.stringify({ lanes: { develop: { latch: { reason: 1 } } } })));
  // Arrays are objects to typeof; read as an empty state they would clear a latch.
  assert.throws(() => parseTrainState(JSON.stringify({ lanes: [] })));
  assert.throws(() => parseTrainState(JSON.stringify({ lanes: { develop: [] } })));
  assert.throws(() => parseTrainState(JSON.stringify({ lanes: { develop: { merging: { number: 1 } } } })));
  const valid = {
    lanes: {
      develop: {
        awaiting: { number: 1, sha, mergedAt: 1 },
        merging: { number: 2, headSha: sha, startedAt: 2 },
        latch: { reason: "x", at: "t" },
      },
    },
  };
  assert.deepEqual(parseTrainState(JSON.stringify(valid)), valid);
});

test("lane updates keep the other lane and the untouched fields", () => {
  let state = withLane({ lanes: {} }, "develop", { awaiting: { number: 7, sha, mergedAt: 1 } });
  state = withLane(state, "main", { latch: { reason: "failed", at: "t" } });
  state = withLane(state, "develop", { latch: { reason: "deploy failed", at: "t" } });
  assert.deepEqual(laneState(state, "develop"), {
    awaiting: { number: 7, sha, mergedAt: 1 },
    latch: { reason: "deploy failed", at: "t" },
    merging: null,
  });
  assert.deepEqual(laneState(state, "main"), { awaiting: null, latch: { reason: "failed", at: "t" }, merging: null });
  assert.deepEqual(laneState({ lanes: {} }, "develop"), { awaiting: null, latch: null, merging: null });
  // What is written must read back through the same validation.
  assert.deepEqual(parseTrainState(JSON.stringify(state)), state);
});
