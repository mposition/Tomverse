import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEPLOYMENT_SAMPLES_PER_PASS,
  DEPLOYMENT_STABILISATION_WINDOW_MS,
  isFreshResponse,
  judgeDeploymentObservation,
  servingDeployment,
  type DeploymentPassObservation,
} from "../lib/feedbackAutoFixDeploymentObservation";

/**
 * Deployment observation (independent review round 1 N2/N6, round 2 N1/N3).
 * What must hold:
 *   - the real control plane shape -- one SUCCESS beside REMOVED history and a
 *     WAITING/SKIPPED newer deployment -- has exactly one serving deployment;
 *   - a draining old deployment beside the new one never verifies;
 *   - a later deployment that contains the expected commit counts, one that
 *     does not (or whose containment is unknown) does not;
 *   - every sample of a pass must agree with the serving deployment;
 *   - a cached response is never a sample;
 *   - one good pass only opens a window; nothing here reports failure.
 */

const EXPECTED = "a".repeat(40);
const DEPLOYED = "c".repeat(40);
const OLD = "b".repeat(40);
const t0 = new Date("2026-09-15T12:00:00Z");
const later = (ms: number) => new Date(t0.getTime() + ms);

const good = (): DeploymentPassObservation => ({
  controlPlane: [
    { id: "dep-next", status: "WAITING", commitSha: "d".repeat(40) },
    { id: "dep-new", status: "SUCCESS", commitSha: DEPLOYED },
    { id: "dep-old", status: "REMOVED", commitSha: OLD },
  ],
  buildInfo: Array.from({ length: DEPLOYMENT_SAMPLES_PER_PASS }, () => ({
    commitSha: DEPLOYED,
    deploymentId: "dep-new",
    deploymentStatus: "success",
  })),
  ready: Array.from({ length: DEPLOYMENT_SAMPLES_PER_PASS }, () => true),
});

const judge = (
  observation: DeploymentPassObservation,
  {
    previous = null,
    now = t0,
    requireReady = true,
    containsExpected = true,
  }: {
    previous?: { deploymentId: string; firstSeenAt: Date } | null;
    now?: Date;
    requireReady?: boolean;
    containsExpected?: boolean | null;
  } = {}
) =>
  judgeDeploymentObservation({
    expectedSha: EXPECTED,
    observation,
    containsExpected,
    previous,
    requireReady,
    now,
  });

test("the real staging control plane has exactly one serving deployment", () => {
  const fixture = JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "fixtures", "railwayDeploymentsStaging.json"),
      "utf8"
    )
  ) as { deployments: Array<{ id: string; status: string; commitSha: string }> };
  const serving = servingDeployment(fixture.deployments);
  assert.ok("deployment" in serving, JSON.stringify(serving));
  assert.equal(serving.deployment.status, "SUCCESS");
  assert.equal(serving.deployment.commitSha, "fd7af39caa390ddcb1d1e1eb0ade7f7e6652578d");
});

test("a good pass opens a window; the same deployment after it verifies", () => {
  assert.equal(judge(good()).kind, "window_opened");
  const previous = { deploymentId: "dep-new", firstSeenAt: t0 };
  assert.equal(
    judge(good(), { previous, now: later(DEPLOYMENT_STABILISATION_WINDOW_MS - 1) }).kind,
    "window_open"
  );
  assert.equal(
    judge(good(), { previous, now: later(DEPLOYMENT_STABILISATION_WINDOW_MS) }).kind,
    "verified"
  );
});

test("a deployment that contains the fix counts; one that does not, or unknown, does not", () => {
  const previous = { deploymentId: "dep-new", firstSeenAt: t0 };
  const now = later(DEPLOYMENT_STABILISATION_WINDOW_MS);
  assert.equal(judge(good(), { previous, now, containsExpected: true }).kind, "verified");
  const missing = judge(good(), { previous, now, containsExpected: false });
  assert.equal(missing.kind === "not_observed" && missing.reason, "expected_commit_not_deployed");
  const unknown = judge(good(), { previous, now, containsExpected: null });
  assert.equal(unknown.kind === "not_observed" && unknown.reason, "containment_unknown");
});

test("a draining old deployment beside the new one never verifies", () => {
  for (const status of ["REMOVING", "DEPLOYING", "SLEEPING", "SUCCESS"]) {
    const rolling = good();
    rolling.controlPlane = [
      { id: "dep-new", status: "SUCCESS", commitSha: DEPLOYED },
      { id: "dep-old", status, commitSha: OLD },
    ];
    const judgement = judge(rolling, {
      previous: { deploymentId: "dep-new", firstSeenAt: t0 },
      now: later(DEPLOYMENT_STABILISATION_WINDOW_MS * 5),
    });
    assert.equal(
      judgement.kind === "not_observed" && judgement.reason,
      "multiple_serving_deployments",
      status
    );
  }
});

test("any disagreeing sample or missing signal clears the window", () => {
  const previous = { deploymentId: "dep-new", firstSeenAt: t0 };
  const now = later(DEPLOYMENT_STABILISATION_WINDOW_MS * 2);
  const mutate = (reason: string, change: (observation: DeploymentPassObservation) => void) => {
    const observation = good();
    change(observation);
    const judgement = judge(observation, { previous, now });
    assert.equal(judgement.kind, "not_observed", reason);
    assert.equal(judgement.kind === "not_observed" && judgement.reason, reason);
  };
  mutate("control_plane_unavailable", (o) => { o.controlPlane = null; });
  mutate("no_serving_deployment", (o) => { o.controlPlane = [{ id: "dep-new", status: "CRASHED", commitSha: DEPLOYED }]; });
  mutate("deployment_not_successful", (o) => { o.controlPlane = [{ id: "dep-new", status: "DEPLOYING", commitSha: DEPLOYED }]; });
  mutate("deployment_commit_unknown", (o) => { o.controlPlane = [{ id: "dep-new", status: "SUCCESS", commitSha: null }]; });
  mutate("too_few_samples", (o) => { o.buildInfo = o.buildInfo.slice(1); });
  mutate("unreachable", (o) => { o.buildInfo[2] = null; });
  mutate("sample_different_deployment", (o) => { o.buildInfo[0] = { ...o.buildInfo[0]!, deploymentId: "dep-old" }; });
  mutate("sample_different_commit", (o) => { o.buildInfo[4] = { ...o.buildInfo[4]!, commitSha: OLD }; });
  mutate("sample_not_successful", (o) => { o.buildInfo[1] = { ...o.buildInfo[1]!, deploymentStatus: "unknown" }; });
  mutate("not_ready", (o) => { o.ready[3] = false; });
  mutate("too_few_ready_samples", (o) => { o.ready = []; });
});

test("a redeploy of the same commit restarts the window", () => {
  const redeployed = good();
  redeployed.controlPlane = [{ id: "dep-2", status: "SUCCESS", commitSha: DEPLOYED }];
  redeployed.buildInfo = redeployed.buildInfo.map((sample) => ({ ...sample!, deploymentId: "dep-2" }));
  const judgement = judge(redeployed, {
    previous: { deploymentId: "dep-new", firstSeenAt: t0 },
    now: later(DEPLOYMENT_STABILISATION_WINDOW_MS * 3),
  });
  assert.equal(judgement.kind, "window_opened");
});

test("readiness is only required where it can be observed", () => {
  const staging = good();
  staging.ready = [];
  assert.equal(
    judge(staging, {
      previous: { deploymentId: "dep-new", firstSeenAt: t0 },
      now: later(DEPLOYMENT_STABILISATION_WINDOW_MS),
      requireReady: false,
    }).kind,
    "verified"
  );
});

test("only an uncached 200 is a fresh response", () => {
  const response = (status: number, age: string | null) => ({
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "age" ? age : null) },
  });
  assert.equal(isFreshResponse(response(200, null)), true);
  assert.equal(isFreshResponse(response(200, "0")), true);
  for (const age of ["30", "1", "-1", "0.5", "abc", "0, 30", ""]) {
    assert.equal(isFreshResponse(response(200, age)), false, `Age: ${age}`);
  }
  for (const status of [204, 301, 302, 304, 503]) {
    assert.equal(isFreshResponse(response(status, null)), false, String(status));
  }
});
