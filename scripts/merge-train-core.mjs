// Pure decisions for the operator-run merge train (scripts/merge-train.mjs).
//
// The train merges one pull request at a time per environment and never lets
// Railway hold more than one deployment in flight: while any service in the
// environment has a deployment that is waiting for CI, queued, building or
// deploying, nothing is merged into the branch that environment deploys from.
//
// Nothing here touches the network. Every function takes the shapes `gh` and
// the Railway CLI return and answers a question about them, so the whole
// decision table is testable without a token (tests/mergeTrainCore.test.mjs).

// A deployment in one of these states is a deployment Railway has not finished
// with. NEEDS_APPROVAL is included because it occupies the environment just as
// a waiting deployment does: merging past it stacks a second one behind it.
export const IN_FLIGHT_DEPLOYMENT_STATUSES = new Set([
  "WAITING",
  "NEEDS_APPROVAL",
  "QUEUED",
  "INITIALIZING",
  "BUILDING",
  "DEPLOYING",
]);

// SLEEPING is a deployment that succeeded and was then scaled to zero.
const SUCCEEDED_DEPLOYMENT_STATUSES = new Set(["SUCCESS", "SLEEPING"]);

// SKIPPED is a failure here, not a no-op: Railway skips a "Wait for CI"
// deployment when a check run on the commit failed.
const FAILED_DEPLOYMENT_STATUSES = new Set(["FAILED", "CRASHED", "SKIPPED"]);

export const LANES = [
  { branch: "develop", environment: "staging" },
  { branch: "main", environment: "production" },
];

// develop and main have no branch protection, so nothing on GitHub says which
// checks are required. A rollup made only of SKIPPED path-filtered checks, or
// one polled before the gate's runs were created, would otherwise read as
// green. At least one run of each of these workflows must have succeeded.
export const REQUIRED_WORKFLOWS = ["PR Fast Gate"];

export const SHA_PATTERN = /^[0-9a-f]{40}$/;

/** Deployments that keep the environment busy. Empty means the environment is free. */
export function inFlightDeployments(deployments) {
  return deployments.filter((deployment) => IN_FLIGHT_DEPLOYMENT_STATUSES.has(deployment.status));
}

const PASSING_CHECK_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/**
 * Collapses a `statusCheckRollup` into one answer: "failed", "pending",
 * "none", "missing_required" or "passed", in that order of precedence.
 *
 * "none" and "missing_required" are not "passed": a pull request whose gate
 * has not been created yet looks exactly like one that has no gate, and
 * merging it would merge something CI never saw. There is no branch
 * protection on develop or main, so this function is the only thing standing
 * in that gap.
 */
export function checksVerdict(rollup, requiredWorkflows = REQUIRED_WORKFLOWS) {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";
  let pending = false;
  for (const check of rollup) {
    if (check.__typename === "StatusContext") {
      if (check.state === "SUCCESS") continue;
      if (check.state === "PENDING" || check.state === "EXPECTED") {
        pending = true;
        continue;
      }
      return "failed";
    }
    if (check.status !== "COMPLETED") {
      pending = true;
      continue;
    }
    if (!PASSING_CHECK_CONCLUSIONS.has(check.conclusion)) return "failed";
  }
  if (pending) return "pending";
  const satisfied = requiredWorkflows.every((workflow) =>
    rollup.some((check) => check.workflowName === workflow && check.conclusion === "SUCCESS"),
  );
  return satisfied ? "passed" : "missing_required";
}

/** Why `pr` may not be merged into `branch` right now, or null if it may. */
export function refusalReason(pr, branch) {
  if (pr.state !== undefined && pr.state !== "OPEN") return `state_${String(pr.state).toLowerCase()}`;
  if (pr.baseRefName !== branch) return "base_changed";
  if (pr.isDraft) return "draft";
  if (!SHA_PATTERN.test(String(pr.headRefOid))) return "head_unreadable";
  const verdict = checksVerdict(pr.statusCheckRollup);
  if (verdict !== "passed") return `checks_${verdict}`;
  if (pr.mergeable !== "MERGEABLE") return `mergeable_${String(pr.mergeable).toLowerCase()}`;
  return null;
}

/**
 * Chooses the oldest pull request into `branch` that may be merged.
 *
 * Drafts are never merged. A pull request that is still running, failed, has
 * no gate result, or that GitHub has not computed mergeability for is skipped
 * with its reason, and the next oldest is considered -- an older red PR must
 * not stall every PR behind it.
 */
export function pickNextPullRequest(pullRequests, branch) {
  const ordered = pullRequests
    .filter((pr) => pr.baseRefName === branch)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number);

  const skipped = [];
  for (const pr of ordered) {
    const reason = refusalReason(pr, branch);
    if (reason === null) return { pick: pr, skipped };
    skipped.push({ number: pr.number, reason });
  }
  return { pick: null, skipped };
}

/**
 * The train's memory between runs, per branch: a merge it has started but not
 * confirmed (`merging`), the merge it is following (`awaiting`), and the latch
 * set when it stopped.
 *
 * Without it a restart forgets that the last merge's deployment failed, sees
 * an idle environment and merges the next PR on top of the broken one. So an
 * unreadable state is an error, not an empty state: a corrupt file must not
 * be the thing that clears a latch.
 */
export function parseTrainState(text) {
  if (text === null || text === undefined) return { lanes: {} };
  const state = JSON.parse(text);
  const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (!isRecord(state) || !isRecord(state.lanes)) throw new Error("merge train state has no lanes object");
  for (const [branch, lane] of Object.entries(state.lanes)) {
    if (!isRecord(lane)) throw new Error(`merge train state for ${branch} is not an object`);
    const { awaiting, latch, merging } = lane;
    if (
      awaiting != null &&
      !(isRecord(awaiting) && Number.isInteger(awaiting.number) && SHA_PATTERN.test(awaiting.sha) && Number.isFinite(awaiting.mergedAt))
    ) {
      throw new Error(`merge train state for ${branch} has a malformed awaiting merge`);
    }
    if (
      merging != null &&
      !(isRecord(merging) && Number.isInteger(merging.number) && SHA_PATTERN.test(merging.headSha) && Number.isFinite(merging.startedAt))
    ) {
      throw new Error(`merge train state for ${branch} has a malformed merge in progress`);
    }
    if (latch != null && !(isRecord(latch) && typeof latch.reason === "string" && typeof latch.at === "string")) {
      throw new Error(`merge train state for ${branch} has a malformed latch`);
    }
  }
  return state;
}

export function laneState(state, branch) {
  return { awaiting: null, latch: null, merging: null, ...state.lanes[branch] };
}

export function withLane(state, branch, patch) {
  return { ...state, lanes: { ...state.lanes, [branch]: { ...laneState(state, branch), ...patch } } };
}

const commitOf = (deployment) => String(deployment.meta?.commitHash ?? "").toLowerCase();

/**
 * The services that deploy `branch` in this environment: every service with a
 * deployment of that branch in the window read. A merge has not deployed until
 * each of them has deployed it -- the cron services finish in seconds while
 * the web service is still waiting for CI.
 */
export function servicesDeployingBranch(deployments, branch) {
  return [...new Set(deployments.filter((deployment) => deployment.meta?.branch === branch).map((d) => d.serviceId))];
}

/**
 * What happened to the deployments Railway made for one merge commit, across
 * `expectedServiceIds`.
 *
 * "not_seen" (no service has it yet) and "partial" (some have) are not
 * success; the caller decides how long they may last. A failure anywhere wins
 * over everything else. REMOVED and any status this table does not know are
 * "unknown" -- the train stops on them rather than guessing.
 */
export function deploymentOutcome(deployments, commitSha, expectedServiceIds) {
  const sha = commitSha.toLowerCase();
  const forCommit = deployments.filter((deployment) => commitOf(deployment) === sha);
  if (forCommit.some((deployment) => FAILED_DEPLOYMENT_STATUSES.has(deployment.status))) {
    return { state: "failed", deployments: forCommit };
  }
  // Railway marks a deployment REMOVED when a newer one for the same service
  // replaces it -- someone else merged after this commit. The newer commit
  // contains this one, so that service has moved past it; the hold covers the
  // newer deployment. A REMOVED with nothing newer is still unexplained.
  const superseded = (deployment) =>
    deployment.status === "REMOVED" &&
    deployments.some(
      (other) =>
        other.serviceId === deployment.serviceId &&
        commitOf(other) !== sha &&
        Date.parse(other.createdAt) > Date.parse(deployment.createdAt),
    );
  const known = (deployment) =>
    IN_FLIGHT_DEPLOYMENT_STATUSES.has(deployment.status) ||
    SUCCEEDED_DEPLOYMENT_STATUSES.has(deployment.status) ||
    superseded(deployment);
  if (forCommit.some((deployment) => !known(deployment))) return { state: "unknown", deployments: forCommit };
  if (forCommit.length === 0) return { state: "not_seen", deployments: [] };
  const deployed = new Set(forCommit.map((deployment) => deployment.serviceId));
  if (expectedServiceIds.some((serviceId) => !deployed.has(serviceId))) {
    return { state: "partial", deployments: forCommit };
  }
  if (forCommit.some((deployment) => IN_FLIGHT_DEPLOYMENT_STATUSES.has(deployment.status))) {
    return { state: "in_progress", deployments: forCommit };
  }
  return { state: "succeeded", deployments: forCommit };
}
