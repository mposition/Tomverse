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

const newestFirst = (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt);

/**
 * The services that currently deploy `branch`: those whose newest deployment
 * in the window is of that branch. A merge has not deployed until each of them
 * has deployed it -- the cron services finish in seconds while the web service
 * is still waiting for CI. A service that once deployed the branch and has
 * since moved to another is not waited for.
 */
export function servicesDeployingBranch(deployments, branch) {
  const newest = new Map();
  for (const deployment of [...deployments].sort(newestFirst)) {
    if (!newest.has(deployment.serviceId)) newest.set(deployment.serviceId, deployment);
  }
  return [...newest.values()].filter((deployment) => deployment.meta?.branch === branch).map((d) => d.serviceId);
}

/** The newest deployment of the same service created after `deployment` for another commit. */
function replacementOf(deployments, deployment) {
  const sha = commitOf(deployment);
  return [...deployments]
    .sort(newestFirst)
    .find(
      (other) =>
        other.serviceId === deployment.serviceId &&
        commitOf(other) !== sha &&
        Date.parse(other.createdAt) > Date.parse(deployment.createdAt),
    );
}

/**
 * Commits whose deployments replaced one of `commitSha`'s (Railway marks the
 * replaced one REMOVED). The caller asks GitHub which of them contain
 * `commitSha` and passes that set back to deploymentOutcome.
 */
export function replacementCommits(deployments, commitSha) {
  const sha = commitSha.toLowerCase();
  const commits = new Set();
  for (const deployment of deployments) {
    if (commitOf(deployment) !== sha || deployment.status !== "REMOVED") continue;
    const replacement = replacementOf(deployments, deployment);
    if (replacement) commits.add(commitOf(replacement));
  }
  return [...commits];
}

function serviceState(status) {
  if (FAILED_DEPLOYMENT_STATUSES.has(status)) return "failed";
  if (IN_FLIGHT_DEPLOYMENT_STATUSES.has(status)) return "in_progress";
  if (SUCCEEDED_DEPLOYMENT_STATUSES.has(status)) return "done";
  return "unknown";
}

// Worst first: the outcome is the worst state any expected service is in.
const OUTCOME_ORDER = ["failed", "unknown", "missing", "in_progress", "done"];

/**
 * What happened to one merge commit across every service that deploys the
 * branch (plus any service that has a deployment of the commit).
 *
 * Per service only the newest deployment of the commit counts, so a redeploy
 * of the same commit replaces the earlier attempt. A deployment REMOVED by a
 * newer one counts through that newer one -- but only when the newer commit is
 * in `containing` (it includes this merge); a rollback to an older commit, or
 * a replacement nobody could place, is "unknown". The train stops on
 * "failed" and "unknown"; "not_seen" and "partial" are waits whose length the
 * caller decides.
 */
export function deploymentOutcome(deployments, commitSha, branch, containing = new Set()) {
  const sha = commitSha.toLowerCase();
  const forCommit = deployments.filter((deployment) => commitOf(deployment) === sha);
  if (forCommit.length === 0) return { state: "not_seen", deployments: [] };
  const expected = new Set([
    ...servicesDeployingBranch(deployments, branch),
    ...forCommit.map((deployment) => deployment.serviceId),
  ]);

  let worst = "done";
  for (const serviceId of expected) {
    const newest = forCommit.filter((deployment) => deployment.serviceId === serviceId).sort(newestFirst)[0];
    let state;
    if (!newest) {
      state = "missing";
    } else if (newest.status === "REMOVED") {
      const replacement = replacementOf(deployments, newest);
      state = replacement && containing.has(commitOf(replacement)) ? serviceState(replacement.status) : "unknown";
    } else {
      state = serviceState(newest.status);
    }
    if (OUTCOME_ORDER.indexOf(state) < OUTCOME_ORDER.indexOf(worst)) worst = state;
  }
  const outcome = { failed: "failed", unknown: "unknown", missing: "partial", in_progress: "in_progress", done: "succeeded" };
  return { state: outcome[worst], deployments: forCommit };
}
