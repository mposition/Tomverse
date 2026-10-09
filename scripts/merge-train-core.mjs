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

// A build or runtime failure. SKIPPED is not here: Railway skips a "Wait for
// CI" deployment when a check run on the commit did not pass, and that run is
// often one a later push cancelled (cancel-in-progress) rather than one that
// failed. See SKIPPED_RUN_FAILURE.
const FAILED_DEPLOYMENT_STATUSES = new Set(["FAILED", "CRASHED"]);

// SKIPPED deployments in a row, among the merge's own and the later ones that
// contain it, that count as a failure (operator decision 2026-10-03). Fewer
// is a wait for the next deployment that contains the merge. A SKIPPED whose
// commit has a cancelled check run is not counted at all: a later push
// cancelled its CI, so it says nothing about whether the code passes. On
// 2026-10-03 #1965 latched on three SKIPPED in a row, two of them cancelled by
// merges a minute apart, and deployed with #1969 half an hour later.
export const SKIPPED_RUN_FAILURE = 3;

// staging is no lane: it deploys the `test` branch, which the promotion script
// moves to a release candidate a person chose (scripts/promote-test.mjs). The
// train never merges into `test`.
export const LANES = [
  { branch: "develop", environment: "dev" },
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

// Railway's states for a deployment that has been, or is being, replaced.
const REPLACED_DEPLOYMENT_STATUSES = new Set(["REMOVED", "REMOVING"]);

/** Every deployment of the same service created after `deployment` for another commit. */
function replacementsOf(deployments, deployment) {
  const sha = commitOf(deployment);
  return deployments.filter(
    (other) =>
      other.serviceId === deployment.serviceId &&
      commitOf(other) !== sha &&
      Date.parse(other.createdAt) > Date.parse(deployment.createdAt),
  );
}

/**
 * Commits whose deployments came after a replaced deployment of `commitSha`
 * on the same service. The caller asks GitHub which of them contain
 * `commitSha` and passes that set back to deploymentOutcome.
 */
export function replacementCommits(deployments, commitSha) {
  const sha = commitSha.toLowerCase();
  const commits = new Set();
  for (const deployment of deployments) {
    if (commitOf(deployment) !== sha) continue;
    if (!REPLACED_DEPLOYMENT_STATUSES.has(deployment.status) && deployment.status !== "SKIPPED") continue;
    for (const replacement of replacementsOf(deployments, deployment)) commits.add(commitOf(replacement));
  }
  return [...commits];
}

/**
 * Commits with a SKIPPED deployment among the merge's own and those of later
 * commits in `containing`. The caller asks GitHub which of them had a check
 * run cancelled and passes that set back to deploymentOutcome.
 */
export function skippedCommits(deployments, commitSha, containing = new Set()) {
  const sha = commitSha.toLowerCase();
  const commits = new Set();
  for (const deployment of deployments) {
    const commit = commitOf(deployment);
    if (deployment.status === "SKIPPED" && (commit === sha || containing.has(commit))) commits.add(commit);
  }
  return [...commits];
}

const oldestFirst = (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt);

/**
 * One service's answer for the merge, from `newest` -- the newest deployment
 * of the merge commit on that service.
 *
 * A SKIPPED or replaced (REMOVED/REMOVING) deployment is followed through the
 * later deployments of the service whose commit is in `containing`, oldest
 * first: any success means the merge is serving; a build or runtime failure is
 * a failure; SKIPPED_RUN_FAILURE SKIPPED in a row is a failure (REMOVED, and a
 * SKIPPED whose commit is in `cancelled`, neither extends nor breaks the
 * run); one in flight, or a SKIPPED run still
 * short of it, is a wait. A replaced deployment with nothing after it that
 * contains the merge -- a rollback, or a replacement GitHub could not place --
 * is "unknown".
 */
function serviceState(deployments, newest, containing, cancelled) {
  if (SUCCEEDED_DEPLOYMENT_STATUSES.has(newest.status)) return "done";
  if (IN_FLIGHT_DEPLOYMENT_STATUSES.has(newest.status)) return "in_progress";
  if (FAILED_DEPLOYMENT_STATUSES.has(newest.status)) return "failed";
  const skipped = newest.status === "SKIPPED";
  if (!skipped && !REPLACED_DEPLOYMENT_STATUSES.has(newest.status)) return "unknown";

  const later = replacementsOf(deployments, newest).filter((deployment) => containing.has(commitOf(deployment)));
  const sequence = [newest, ...later].sort(oldestFirst);
  if (sequence.some((deployment) => SUCCEEDED_DEPLOYMENT_STATUSES.has(deployment.status))) return "done";
  if (sequence.some((deployment) => FAILED_DEPLOYMENT_STATUSES.has(deployment.status))) return "failed";
  let run = 0;
  for (const deployment of sequence) {
    if (deployment.status === "SKIPPED" && cancelled.has(commitOf(deployment))) {
      continue;
    } else if (deployment.status === "SKIPPED") {
      run += 1;
      if (run >= SKIPPED_RUN_FAILURE) return "failed";
    } else if (!REPLACED_DEPLOYMENT_STATUSES.has(deployment.status)) {
      run = 0;
    }
  }
  if (sequence.some((deployment) => IN_FLIGHT_DEPLOYMENT_STATUSES.has(deployment.status))) return "in_progress";
  return skipped || later.length > 0 ? "in_progress" : "unknown";
}

// Worst first: the outcome is the worst state any expected service is in.
const OUTCOME_ORDER = ["failed", "unknown", "missing", "in_progress", "done"];

/**
 * What happened to one merge commit across every service that deploys the
 * branch (plus any service that has a deployment of the commit).
 *
 * Per service only the newest deployment of the commit counts, so a redeploy
 * of the same commit replaces the earlier attempt; serviceState says how a
 * SKIPPED or replaced one is followed through later deployments that contain
 * the merge. The train stops on
 * "failed" and "unknown"; "not_seen" and "partial" are waits whose length the
 * caller decides.
 */
export function deploymentOutcome(deployments, commitSha, branch, containing = new Set(), cancelled = new Set()) {
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
    const state = newest ? serviceState(deployments, newest, containing, cancelled) : "missing";
    if (OUTCOME_ORDER.indexOf(state) < OUTCOME_ORDER.indexOf(worst)) worst = state;
  }
  const outcome = { failed: "failed", unknown: "unknown", missing: "partial", in_progress: "in_progress", done: "succeeded" };
  return { state: outcome[worst], deployments: forCommit };
}
