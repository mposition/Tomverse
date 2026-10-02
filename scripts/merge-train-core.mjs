// Pure decisions for the operator-run merge train (scripts/merge-train.mjs).
//
// The train merges one pull request at a time per environment and never lets
// Railway hold more than one deployment in flight: while any service in the
// environment has a deployment that is waiting for CI, queued, building or
// deploying, nothing is merged into the branch that environment deploys from.
//
// Nothing here touches the network. Every function takes the shapes `gh` and
// the Railway API return and answers a question about them, so the whole
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

/** Deployments that keep the environment busy. Empty means the environment is free. */
export function inFlightDeployments(deployments) {
  return deployments.filter((deployment) => IN_FLIGHT_DEPLOYMENT_STATUSES.has(deployment.status));
}

const PASSING_CHECK_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/**
 * Collapses a `statusCheckRollup` into one of four answers.
 *
 * "none" is its own answer rather than "passed": a pull request whose checks
 * have not been created yet looks exactly like one with no checks, and merging
 * it would merge something CI never saw. There is no branch protection on
 * develop or main, so this function is the only thing standing in that gap.
 */
export function checksVerdict(rollup) {
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
  return pending ? "pending" : "passed";
}

/**
 * Chooses the oldest pull request into `branch` whose CI has finished green.
 *
 * Drafts are never merged. A pull request that is still running, failed, has
 * no checks, or that GitHub has not computed mergeability for is skipped with
 * its reason, and the next oldest is considered -- an older red PR must not
 * stall every PR behind it.
 */
export function pickNextPullRequest(pullRequests, branch) {
  const ordered = pullRequests
    .filter((pr) => pr.baseRefName === branch)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number);

  const skipped = [];
  for (const pr of ordered) {
    if (pr.isDraft) {
      skipped.push({ number: pr.number, reason: "draft" });
      continue;
    }
    const verdict = checksVerdict(pr.statusCheckRollup);
    if (verdict !== "passed") {
      skipped.push({ number: pr.number, reason: `checks_${verdict}` });
      continue;
    }
    if (pr.mergeable !== "MERGEABLE") {
      skipped.push({ number: pr.number, reason: `mergeable_${String(pr.mergeable).toLowerCase()}` });
      continue;
    }
    return { pick: pr, skipped };
  }
  return { pick: null, skipped };
}

/**
 * The train's memory between runs, per branch: the merge it is still
 * following, and the latch set when it stopped.
 *
 * Without it a restart forgets that the last merge's deployment failed, sees
 * an idle environment and merges the next PR on top of the broken one. So an
 * unreadable state is an error, not an empty state: a corrupt file must not
 * be the thing that clears a latch.
 */
export function parseTrainState(text) {
  if (text === null || text === undefined) return { lanes: {} };
  const state = JSON.parse(text);
  if (!state || typeof state !== "object" || !state.lanes || typeof state.lanes !== "object") {
    throw new Error("merge train state has no lanes object");
  }
  for (const [branch, lane] of Object.entries(state.lanes)) {
    if (!lane || typeof lane !== "object") throw new Error(`merge train state for ${branch} is not an object`);
    const { awaiting, latch } = lane;
    if (
      awaiting != null &&
      !(Number.isInteger(awaiting.number) && /^[0-9a-f]{40}$/.test(awaiting.sha) && Number.isFinite(awaiting.mergedAt))
    ) {
      throw new Error(`merge train state for ${branch} has a malformed awaiting merge`);
    }
    if (latch != null && !(typeof latch.reason === "string" && typeof latch.at === "string")) {
      throw new Error(`merge train state for ${branch} has a malformed latch`);
    }
  }
  return state;
}

export function laneState(state, branch) {
  return { awaiting: null, latch: null, ...state.lanes[branch] };
}

export function withLane(state, branch, patch) {
  return { ...state, lanes: { ...state.lanes, [branch]: { ...laneState(state, branch), ...patch } } };
}

/**
 * What happened to the deployments Railway made for one merge commit.
 *
 * "not_seen" is not success: Railway may not have registered the push yet,
 * and the caller decides how long that is allowed to last. REMOVED and any
 * status this table does not know are "unknown" -- the train stops on them
 * rather than guessing.
 */
export function deploymentOutcome(deployments, commitSha) {
  const forCommit = deployments.filter((deployment) => deployment.meta?.commitHash === commitSha);
  if (forCommit.length === 0) return { state: "not_seen", deployments: [] };
  if (forCommit.some((deployment) => IN_FLIGHT_DEPLOYMENT_STATUSES.has(deployment.status))) {
    return { state: "in_progress", deployments: forCommit };
  }
  if (forCommit.some((deployment) => FAILED_DEPLOYMENT_STATUSES.has(deployment.status))) {
    return { state: "failed", deployments: forCommit };
  }
  if (forCommit.every((deployment) => SUCCEEDED_DEPLOYMENT_STATUSES.has(deployment.status))) {
    return { state: "succeeded", deployments: forCommit };
  }
  return { state: "unknown", deployments: forCommit };
}
