import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checksVerdict,
  deploymentOutcome,
  inFlightDeployments,
  LANES,
  laneState,
  parseTrainState,
  pickNextPullRequest,
  refusalReason,
  replacementCommits,
  SKIPPED_RUN_FAILURE,
  servicesDeployingBranch,
  skippedCommits,
  withLane,
} from "../scripts/merge-train-core.mjs";

test("develop merges wait on dev, and the train never merges into what staging deploys", () => {
  // The lane switch (2026-10-07): staging serves the `test` branch's release
  // candidate. Holding develop merges on staging's deployments would bring back
  // the wait the split removed, and a lane into `test` would replace the
  // candidate a person chose.
  assert.deepEqual(LANES, [
    { branch: "develop", environment: "dev" },
    { branch: "main", environment: "production" },
  ]);
  assert.ok(!LANES.some((lane) => lane.environment === "staging" || lane.branch === "test"));
});

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
const older = "b".repeat(40);
const newer = "e".repeat(40);
let clock = 0;
// Each deployment is created after the previous one unless given a time.
const deployment = (status, commitHash = commit, serviceId = "svc", branch = "develop", createdAt) => ({
  status,
  serviceId,
  createdAt: createdAt ?? new Date(Date.UTC(2026, 9, 2, 0, 0, clock++)).toISOString(),
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

test("deploymentOutcome needs every service that currently deploys the branch", () => {
  const before = [deployment("SUCCESS", older, "web"), deployment("SUCCESS", older, "cron")];
  assert.equal(deploymentOutcome(before, commit, "develop").state, "not_seen");
  // The cron service finishes in seconds; the web service has not started.
  assert.equal(deploymentOutcome([...before, deployment("SUCCESS", commit, "cron")], commit, "develop").state, "partial");
  assert.equal(
    deploymentOutcome([...before, deployment("SUCCESS", commit, "cron"), deployment("WAITING", commit, "web")], commit, "develop").state,
    "in_progress",
  );
  assert.equal(
    deploymentOutcome([...before, deployment("SUCCESS", commit, "cron"), deployment("SLEEPING", commit, "web")], commit, "develop").state,
    "succeeded",
  );
  for (const status of ["FAILED", "CRASHED"]) {
    assert.equal(
      deploymentOutcome([...before, deployment("WAITING", commit, "cron"), deployment(status, commit, "web")], commit, "develop").state,
      "failed",
      status,
    );
  }
  assert.equal(deploymentOutcome([deployment("SOMETHING_NEW", commit, "web")], commit, "develop").state, "unknown");
});

test("a service whose newest deployment is of another branch is not waited for", () => {
  const deployments = [
    deployment("SUCCESS", older, "worker", "develop"),
    deployment("SUCCESS", older, "worker", "amux-validation"),
    deployment("SUCCESS", commit, "web"),
  ];
  assert.deepEqual(servicesDeployingBranch(deployments, "develop"), ["web"]);
  assert.equal(deploymentOutcome(deployments, commit, "develop").state, "succeeded");
});

test("a redeploy of the same commit replaces the earlier attempt", () => {
  const deployments = [deployment("REMOVED", commit, "web"), deployment("SUCCESS", commit, "web")];
  assert.equal(deploymentOutcome(deployments, commit, "develop").state, "succeeded");
  const failedThenFixed = [deployment("FAILED", commit, "web"), deployment("SUCCESS", commit, "web")];
  assert.equal(deploymentOutcome(failedThenFixed, commit, "develop").state, "succeeded");
});

test("a REMOVED deployment counts through its replacement only when that commit contains the merge", () => {
  const replaced = (replacementStatus) => [
    deployment("SUCCESS", commit, "web"),
    deployment("REMOVED", commit, "cron"),
    deployment(replacementStatus, newer, "cron"),
  ];
  assert.deepEqual(replacementCommits(replaced("SUCCESS"), commit), [newer]);
  assert.equal(deploymentOutcome(replaced("SUCCESS"), commit, "develop", new Set([newer])).state, "succeeded");
  // The newer deployment's own result is what this merge got.
  assert.equal(deploymentOutcome(replaced("BUILDING"), commit, "develop", new Set([newer])).state, "in_progress");
  assert.equal(deploymentOutcome(replaced("FAILED"), commit, "develop", new Set([newer])).state, "failed");
  // A rollback, or a replacement GitHub could not place after the merge.
  assert.equal(deploymentOutcome(replaced("SUCCESS"), commit, "develop", new Set()).state, "unknown");
  // Nothing newer at all.
  assert.equal(deploymentOutcome(replaced("SUCCESS").slice(0, 2), commit, "develop", new Set([newer])).state, "unknown");
});

test("a serving replacement wins over newer waiting or skipped attempts beside it", () => {
  // The staging shape of 2026-09-15: the merge's own deployment REMOVED, one
  // later SUCCESS serving, and newer SKIPPED and WAITING attempts next to it.
  const later = ["1", "2", "3"].map((digit) => digit.repeat(40));
  const deployments = [
    deployment("REMOVED", commit, "web"),
    deployment("SUCCESS", later[0], "web"),
    deployment("SKIPPED", later[1], "web"),
    deployment("WAITING", later[2], "web"),
  ];
  assert.deepEqual(replacementCommits(deployments, commit).sort(), [...later].sort());
  assert.equal(deploymentOutcome(deployments, commit, "develop", new Set(later)).state, "succeeded");
  // Without the serving one, the waiting attempt is a wait, not a failure.
  const pending = deployments.filter((d) => d.status !== "SUCCESS");
  assert.equal(deploymentOutcome(pending, commit, "develop", new Set(later)).state, "in_progress");
});

test("a REMOVING deployment is treated as replaced, not unknown", () => {
  const deployments = [deployment("REMOVING", commit, "web"), deployment("DEPLOYING", newer, "web")];
  assert.deepEqual(replacementCommits(deployments, commit), [newer]);
  assert.equal(deploymentOutcome(deployments, commit, "develop", new Set([newer])).state, "in_progress");
});

test("one SKIPPED deployment is a wait, not a failure", () => {
  // Railway skips a Wait-for-CI deployment when a later push cancelled the
  // commit's CI run; nothing has failed yet.
  assert.equal(deploymentOutcome([deployment("SKIPPED", commit, "web")], commit, "develop").state, "in_progress");
});

test("#1939 on 2026-10-02: SKIPPED, then a later commit containing it deployed", () => {
  // 0ef8c98e2 SKIPPED (its CI cancelled by #1931's push), 020c93a6a REMOVED,
  // cc97e1f22 SUCCESS -- the merge was serving.
  const [first, second] = ["2".repeat(40), "3".repeat(40)];
  const deployments = [
    deployment("SKIPPED", commit, "web"),
    deployment("REMOVED", first, "web"),
    deployment("SUCCESS", second, "web"),
  ];
  assert.deepEqual(replacementCommits(deployments, commit).sort(), [first, second].sort());
  assert.equal(deploymentOutcome(deployments, commit, "develop", new Set([first, second])).state, "succeeded");
});

test(`SKIPPED is a failure only ${SKIPPED_RUN_FAILURE} times in a row`, () => {
  const later = ["4", "5", "6"].map((digit) => digit.repeat(40));
  const run = (...statuses) =>
    statuses.map((status, index) => deployment(status, index === 0 ? commit : later[index - 1], "web"));
  const outcome = (deployments) => deploymentOutcome(deployments, commit, "develop", new Set(later)).state;
  assert.equal(outcome(run("SKIPPED", "SKIPPED")), "in_progress");
  assert.equal(outcome(run("SKIPPED", "SKIPPED", "SKIPPED")), "failed");
  // REMOVED neither extends nor breaks the run.
  assert.equal(outcome(run("SKIPPED", "REMOVED", "SKIPPED")), "in_progress");
  assert.equal(outcome(run("SKIPPED", "REMOVED", "SKIPPED", "SKIPPED")), "failed");
  // A later deployment in flight is a wait; a later build failure is a failure.
  assert.equal(outcome(run("SKIPPED", "SKIPPED", "WAITING")), "in_progress");
  assert.equal(outcome(run("SKIPPED", "FAILED")), "failed");
  // Later SKIPPED deployments that do not contain the merge do not count.
  const unrelated = run("SKIPPED", "SKIPPED", "SKIPPED");
  assert.equal(deploymentOutcome(unrelated, commit, "develop", new Set()).state, "in_progress");
});

test("a SKIPPED whose CI a later push cancelled does not count towards the run", () => {
  // #1965 on 2026-10-03: f421304c9 and 3ffe966b7 SKIPPED with cancelled CI,
  // 1da560122 SKIPPED with no check runs at all -- one counted SKIPPED, a wait.
  const [noChecks, cancelledLater] = ["7".repeat(40), "8".repeat(40)];
  const deployments = [
    deployment("SKIPPED", commit, "web"),
    deployment("SKIPPED", noChecks, "web"),
    deployment("SKIPPED", cancelledLater, "web"),
  ];
  const containing = new Set([noChecks, cancelledLater]);
  assert.deepEqual(skippedCommits(deployments, commit, containing).sort(), [commit, noChecks, cancelledLater].sort());
  assert.equal(deploymentOutcome(deployments, commit, "develop", containing).state, "failed");
  assert.equal(
    deploymentOutcome(deployments, commit, "develop", containing, new Set([commit, cancelledLater])).state,
    "in_progress",
  );
  // A cancelled SKIPPED neither extends nor breaks a run of real ones.
  const real = ["9", "a", "d"].map((digit) => digit.repeat(40));
  const run = [
    deployment("SKIPPED", commit, "web"),
    deployment("SKIPPED", real[0], "web"),
    deployment("SKIPPED", real[1], "web"),
    deployment("SKIPPED", real[2], "web"),
  ];
  assert.equal(deploymentOutcome(run, commit, "develop", new Set(real), new Set([real[0]])).state, "failed");
  // A SKIPPED of a commit that does not contain the merge is not asked about.
  assert.deepEqual(skippedCommits([deployment("SKIPPED", older, "web")], commit, new Set()), []);
});

test("deploymentOutcome compares commit hashes case-insensitively", () => {
  const upper = commit.toUpperCase();
  assert.equal(deploymentOutcome([deployment("FAILED", upper, "web")], commit, "develop").state, "failed");
  assert.equal(deploymentOutcome([deployment("SUCCESS", commit, "web")], upper, "develop").state, "succeeded");
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
