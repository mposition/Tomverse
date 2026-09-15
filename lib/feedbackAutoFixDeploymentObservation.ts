/**
 * When a deployment counts as observed.
 *
 * A response from `/api/build-info` naming the expected commit proves that one
 * process answered with it. During a rolling deploy that can be the first new
 * replica while old ones still serve traffic, or a deployment about to fail
 * its health check -- and two such responses ten minutes apart can both land
 * on the new replica (independent review, round 1 N2/N6). So a pass counts
 * only when all of these hold at once:
 *
 *  1. Railway's control plane lists exactly one deployment of the service in
 *     that environment that can be serving traffic, it is SUCCESS, and its
 *     commit *contains* the expected commit. Railway replicas belong to a
 *     deployment, so no other serving deployment means no replica runs other
 *     code.
 *  2. Every build-info sample of the pass (several, uncached) names that same
 *     deployment and its commit, with deployment status success.
 *  3. Where readiness is observable (production), every readiness sample was
 *     a fresh 200.
 *
 * One such pass opens a window; a later pass that still satisfies all three
 * for the same deployment, after the window, verifies. Anything else resets.
 *
 * "Contains", not "equals": staging and production keep moving. On
 * 2026-09-15 staging received six develop merges in two and a half hours, so
 * a rule that waited for the exact merge commit to be the live deployment for
 * ten minutes would, on a busy day, never observe a fix that is plainly live.
 * The containment answer comes from GitHub (is the expected commit an
 * ancestor of the deployed one) and is passed in, which keeps this pure.
 *
 * Which Railway statuses can serve traffic was read from the real control
 * plane on 2026-09-15 (tests/fixtures/railwayDeploymentsStaging.json): a
 * replaced deployment becomes REMOVED, exactly one SUCCESS remains, and a
 * deployment still waiting for CI (WAITING) or skipped (SKIPPED) sits beside
 * it without serving anything.
 *
 * A timeout is deliberately not a state here: a deployment slow to settle is
 * shown as "observation delayed" with its age, and nothing is marked failed
 * on the strength of not having seen something yet.
 *
 * docs/policy/trace-feedback-automation.md §9.3.
 */

export const DEPLOYMENT_STABILISATION_WINDOW_MS = 10 * 60 * 1000;
/** Build-info and readiness samples taken per observer pass. */
export const DEPLOYMENT_SAMPLES_PER_PASS = 5;

/**
 * Railway statuses of a deployment whose replicas can be serving requests:
 * the active one, one being switched in, one draining out, one asleep (it
 * serves when woken). Not QUEUED, WAITING, BUILDING or INITIALIZING (nothing
 * of it runs yet), and not FAILED, CRASHED, REMOVED or SKIPPED.
 */
export const RAILWAY_SERVING_DEPLOYMENT_STATUSES = new Set([
  "SUCCESS",
  "DEPLOYING",
  "REMOVING",
  "SLEEPING",
]);

export type BuildInfoSample = {
  commitSha: string | null;
  deploymentId: string | null;
  deploymentStatus: string | null;
};

export type ControlPlaneDeployment = {
  id: string;
  status: string;
  commitSha: string | null;
};

export type DeploymentPassObservation = {
  /** Null when the control plane could not be read. */
  controlPlane: ControlPlaneDeployment[] | null;
  /** Null entries are failed samples (unreachable, redirected, cached). */
  buildInfo: Array<BuildInfoSample | null>;
  /** Readiness samples: true only for a fresh 200. Empty where unobservable. */
  ready: boolean[];
};

export type DeploymentSighting = {
  deploymentId: string;
  firstSeenAt: Date;
};

export type DeploymentJudgement =
  | { kind: "not_observed"; reason: string; sighting: null }
  | { kind: "window_opened"; sighting: DeploymentSighting }
  | { kind: "window_open"; sighting: DeploymentSighting }
  | { kind: "verified"; sighting: DeploymentSighting };

const FULL_SHA = /^[0-9a-f]{40}$/;
const lower = (value: string | null | undefined) => (value || "").toLowerCase();

const notObserved = (reason: string): DeploymentJudgement => ({
  kind: "not_observed",
  reason,
  sighting: null,
});

/** The one deployment that can be serving, or why there is not exactly one. */
export const servingDeployment = (
  controlPlane: ControlPlaneDeployment[] | null
): { deployment: ControlPlaneDeployment } | { reason: string } => {
  if (!controlPlane) return { reason: "control_plane_unavailable" };
  const serving = controlPlane.filter((deployment) =>
    RAILWAY_SERVING_DEPLOYMENT_STATUSES.has(deployment.status)
  );
  if (serving.length === 0) return { reason: "no_serving_deployment" };
  if (serving.length > 1) return { reason: "multiple_serving_deployments" };
  const [deployment] = serving;
  if (deployment.status !== "SUCCESS") return { reason: "deployment_not_successful" };
  if (!FULL_SHA.test(lower(deployment.commitSha))) return { reason: "deployment_commit_unknown" };
  return { deployment };
};

export const judgeDeploymentObservation = (input: {
  expectedSha: string;
  observation: DeploymentPassObservation;
  /**
   * Whether the serving deployment's commit contains the expected commit
   * (identical, or the expected commit is its ancestor). Null when that could
   * not be determined -- which is never a yes.
   */
  containsExpected: boolean | null;
  previous: DeploymentSighting | null;
  requireReady: boolean;
  now: Date;
  windowMs?: number;
  minSamples?: number;
}): DeploymentJudgement => {
  const windowMs = input.windowMs ?? DEPLOYMENT_STABILISATION_WINDOW_MS;
  const minSamples = input.minSamples ?? DEPLOYMENT_SAMPLES_PER_PASS;
  const expected = lower(input.expectedSha);
  const { controlPlane, buildInfo, ready } = input.observation;
  if (!FULL_SHA.test(expected)) return notObserved("expected_sha_invalid");

  // 1. Control plane: exactly one serving deployment, successful, containing
  //    the expected commit.
  const serving = servingDeployment(controlPlane);
  if ("reason" in serving) return notObserved(serving.reason);
  const active = serving.deployment;
  if (input.containsExpected === null) return notObserved("containment_unknown");
  if (!input.containsExpected) return notObserved("expected_commit_not_deployed");

  // 2. Every build-info sample: that deployment, its commit, success.
  if (buildInfo.length < minSamples) return notObserved("too_few_samples");
  for (const sample of buildInfo) {
    if (!sample) return notObserved("unreachable");
    if (sample.deploymentId !== active.id) return notObserved("sample_different_deployment");
    if (lower(sample.commitSha) !== lower(active.commitSha)) {
      return notObserved("sample_different_commit");
    }
    if (sample.deploymentStatus !== "success") return notObserved("sample_not_successful");
  }

  // 3. Readiness, where observable: every sample a fresh 200.
  if (input.requireReady) {
    if (ready.length < minSamples) return notObserved("too_few_ready_samples");
    if (ready.some((value) => value !== true)) return notObserved("not_ready");
  }

  const previous = input.previous;
  if (!previous || previous.deploymentId !== active.id) {
    return {
      kind: "window_opened",
      sighting: { deploymentId: active.id, firstSeenAt: input.now },
    };
  }
  if (input.now.getTime() - previous.firstSeenAt.getTime() >= windowMs) {
    return { kind: "verified", sighting: previous };
  }
  return { kind: "window_open", sighting: previous };
};

/**
 * A response that may be a cached copy is not a current observation. `Age`
 * absent is fresh; `Age: 0` is fresh; anything else -- positive, negative,
 * fractional, not a number, repeated -- is not (independent review round 2,
 * N1). Shared by the build-info and readiness samples so the two cannot drift.
 */
export const isFreshResponse = (response: {
  status: number;
  headers: { get(name: string): string | null };
}) => {
  if (response.status !== 200) return false;
  const age = response.headers.get("age");
  if (age === null) return true;
  return /^\s*0\s*$/.test(age);
};
