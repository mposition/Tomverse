import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checksVerdict,
  deploymentOutcome,
  inFlightDeployments,
  pickNextPullRequest,
} from "../scripts/merge-train-core.mjs";

const run = (status, conclusion = null, name = "check") => ({ __typename: "CheckRun", name, status, conclusion });
const green = [run("COMPLETED", "SUCCESS", "lint"), run("COMPLETED", "SKIPPED", "e2e")];

const pr = (number, createdAt, overrides = {}) => ({
  number,
  createdAt,
  baseRefName: "develop",
  isDraft: false,
  mergeable: "MERGEABLE",
  headRefOid: `head${number}`,
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
  assert.equal(checksVerdict([run("COMPLETED", "NEUTRAL")]), "passed");
  assert.equal(checksVerdict([{ __typename: "StatusContext", state: "PENDING" }]), "pending");
  assert.equal(checksVerdict([{ __typename: "StatusContext", state: "ERROR" }]), "failed");
  assert.equal(checksVerdict([{ __typename: "StatusContext", state: "SUCCESS" }]), "passed");
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

const deployment = (status, commitHash = "abc", serviceId = "svc") => ({ status, serviceId, meta: { commitHash } });

test("any waiting, queued, building or deploying deployment holds the environment", () => {
  for (const status of ["WAITING", "NEEDS_APPROVAL", "QUEUED", "INITIALIZING", "BUILDING", "DEPLOYING"]) {
    assert.equal(inFlightDeployments([deployment("SUCCESS"), deployment(status)]).length, 1, status);
  }
  assert.equal(
    inFlightDeployments([deployment("SUCCESS"), deployment("FAILED"), deployment("REMOVED"), deployment("SKIPPED")]).length,
    0,
  );
});

test("deploymentOutcome follows only the merge commit's deployments", () => {
  assert.equal(deploymentOutcome([deployment("WAITING", "old")], "abc").state, "not_seen");
  assert.equal(deploymentOutcome([deployment("SUCCESS"), deployment("WAITING")], "abc").state, "in_progress");
  assert.equal(deploymentOutcome([deployment("SUCCESS"), deployment("SLEEPING")], "abc").state, "succeeded");
  assert.equal(deploymentOutcome([deployment("SUCCESS"), deployment("FAILED")], "abc").state, "failed");
  assert.equal(deploymentOutcome([deployment("SUCCESS"), deployment("SKIPPED")], "abc").state, "failed");
  assert.equal(deploymentOutcome([deployment("SUCCESS"), deployment("CRASHED")], "abc").state, "failed");
  assert.equal(deploymentOutcome([deployment("REMOVED")], "abc").state, "unknown");
  assert.equal(deploymentOutcome([deployment("SOMETHING_NEW")], "abc").state, "unknown");
});
