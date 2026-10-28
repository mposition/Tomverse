#!/usr/bin/env node
// Operator-run merge train: merges the oldest green pull request into develop
// (and, with --include-main, into main), one at a time per environment, and
// holds while Railway has any deployment in flight for that environment.
//
//   npm run merge-train -- --dry-run --once      # read-only: say what would merge
//   npm run merge-train                           # develop -> dev only
//   npm run merge-train -- --include-main         # also main -> production
//   npm run merge-train -- --pr=1916 --once       # consider only this PR
//   npm run merge-train -- --clear-latch=develop  # a person clears a stop
//   npm run merge-train -- --forget-merge=develop # ...and stops following its merge
//   npm run merge-train -- --break-lock           # a person removes a dead train's lock
//
// Run it from a local PowerShell in the repository clone. It uses the
// operator's own `gh` login and `railway` CLI login; it holds no token of its
// own. It is a stopgap until the QA/Release agent exists, not that agent.
//
// Per lane, each poll:
//   1. A merge the train started but never confirmed is resolved first, from
//      GitHub's own record of the PR -- even on a latched lane.
//   2. A latched lane does nothing more until a person clears it.
//   3. If a merge made by the train is still deploying, wait until every
//      service that deploys the branch has deployed it. A failed, crashed or
//      unrecognised deployment, or three SKIPPED in a row among the merge's
//      own and later ones containing it, latches the lane and stops the train
//      (exit 1) -- it never retries and never merges past a broken deploy. A
//      single SKIPPED (often a CI run a later push cancelled) is a wait.
//   4. If any service in the environment has a deployment waiting for CI,
//      queued, building or deploying, hold.
//   5. Otherwise pick the oldest non-draft PR whose checks all finished green
//      (including at least one successful PR Fast Gate run), re-read both the
//      PR and Railway, and merge it pinned to the head SHA that was checked.
//
// State and lock live in ~/.tomverse-merge-train/, shared by every clone and
// worktree on this machine. Two machines running trains at once are not
// detected: run one. A dry run reads neither and writes nothing.
//
// The decisions live in scripts/merge-train-core.mjs.

import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  LANES,
  SHA_PATTERN,
  deploymentOutcome,
  inFlightDeployments,
  laneState,
  parseTrainState,
  pickNextPullRequest,
  refusalReason,
  replacementCommits,
  skippedCommits,
  withLane,
} from "./merge-train-core.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const RAILWAY_PROJECT_ID = process.env.MERGE_TRAIN_RAILWAY_PROJECT_ID || "0c5f17ad-a42a-4fa8-a245-bcd6a3275a35";
const REPOSITORY = process.env.MERGE_TRAIN_REPOSITORY || "mposition/Tomverse";
// Per service. A waiting deployment older than this many newer ones would be
// invisible to the hold; Railway queues behind it, so that many is implausible.
const DEPLOYMENTS_PER_SERVICE = 25;

const args = process.argv.slice(2);
const flag = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const dryRun = args.includes("--dry-run");
const once = args.includes("--once");
const includeMain = args.includes("--include-main");
const breakLock = args.includes("--break-lock");
const clearLatch = flag("clear-latch");
const forgetMerge = flag("forget-merge");
const onlyPr = flag("pr") === undefined ? null : Number(flag("pr"));
const pollSeconds = Number(flag("poll-seconds") ?? 60);
// How long a merge commit may go without Railway registering any deployment
// for it before the train treats the outcome as unknown and stops.
const notSeenTimeoutMinutes = Number(flag("not-seen-timeout-minutes") ?? 15);
// How long a deployment may stay in flight (CI wait included) before stopping.
const deployTimeoutMinutes = Number(flag("deploy-timeout-minutes") ?? 120);
// A merge call that failed while the PR still reads OPEN may yet land; the
// lane waits this long before believing it did not.
const UNCONFIRMED_GRACE_MINUTES = 5;

function usage(message) {
  console.error(message);
  process.exit(2);
}

for (const [name, value] of [
  ["poll-seconds", pollSeconds],
  ["not-seen-timeout-minutes", notSeenTimeoutMinutes],
  ["deploy-timeout-minutes", deployTimeoutMinutes],
]) {
  if (!Number.isFinite(value) || value <= 0) usage(`--${name} must be a positive number`);
}
if (onlyPr !== null && !(Number.isInteger(onlyPr) && onlyPr > 0)) usage("--pr must be a pull request number");
// These reach a Windows shell (see useShell below), so they are checked for
// shape rather than trusted because they came from the environment.
if (!UUID_PATTERN.test(RAILWAY_PROJECT_ID)) usage("MERGE_TRAIN_RAILWAY_PROJECT_ID must be a UUID");
if (!REPOSITORY_PATTERN.test(REPOSITORY)) usage("MERGE_TRAIN_REPOSITORY must look like owner/name");

const lanes = LANES.filter((lane) => lane.branch !== "main" || includeMain);

// `railway` is an npm shim on Windows, which execFile cannot start without a
// shell, and cmd.exe joins the arguments unquoted. Every argument is therefore
// a constant or a value checked against a strict pattern before it gets here:
// project id and service ids (UUID), repository (owner/name), PR numbers
// (integer) and head SHAs (40 hex).
const useShell = process.platform === "win32";

function runText(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, {
    encoding: "utf8",
    shell: useShell,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}
const runJson = (command, commandArgs) => JSON.parse(runText(command, commandArgs));

const log = (lane, message) => console.log(`${new Date().toISOString()} [${lane.branch}->${lane.environment}] ${message}`);

// ---- state and lock -------------------------------------------------------

const STATE_DIR = join(homedir(), ".tomverse-merge-train");
const STATE_PATH = join(STATE_DIR, "state.json");
const LOCK_PATH = join(STATE_DIR, "train.lock");

function readState() {
  let text = null;
  try {
    text = readFileSync(STATE_PATH, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    return parseTrainState(text);
  } catch (error) {
    // Not repaired here: the file may hold a latch, and a train that rewrote
    // it would be the thing that cleared it. A person reads it and deletes it.
    console.error(`STOP: ${STATE_PATH} is unreadable (${error.message}). Inspect it, then fix or delete it by hand.`);
    process.exit(1);
  }
}

function writeState(next) {
  const temporary = `${STATE_PATH}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(temporary, STATE_PATH);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * One train per machine. A lock left by a dead train is not taken over
 * automatically: two trains that both saw it dead could each remove the
 * other's fresh lock. A person confirms no train is running and passes
 * --break-lock.
 */
function acquireLock() {
  mkdirSync(STATE_DIR, { recursive: true });
  const holderOf = () => Number(readFileSync(LOCK_PATH, "utf8").trim());
  const holderAlive = (holder) => Number.isInteger(holder) && holder > 0 && processAlive(holder);
  if (breakLock) {
    let holder = null;
    try {
      holder = holderOf();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (holder !== null && holderAlive(holder)) {
      usage(
        `--break-lock refused: pid ${holder} is still running. If that process is not a merge train ` +
          `(the pid was reused), delete ${LOCK_PATH} by hand.`,
      );
    }
    rmSync(LOCK_PATH, { force: true });
  }
  const mine = `${process.pid}\n`;
  try {
    const fd = openSync(LOCK_PATH, "wx");
    writeFileSync(fd, mine);
    closeSync(fd);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const holder = holderOf();
    const alive = holderAlive(holder);
    usage(
      alive
        ? `another merge train is running (pid ${holder}); refusing to start a second one`
        : `${LOCK_PATH} is held by pid ${holder || "unknown"}, which is not running. ` +
            "If no merge train is running, rerun with --break-lock.",
    // A reused pid reads as a running train; a person who has checked deletes
    // the lock file by hand.
    );
  }
  // Removes the lock only while it is still this process's own.
  process.on("exit", () => {
    try {
      if (readFileSync(LOCK_PATH, "utf8") === mine) rmSync(LOCK_PATH, { force: true });
    } catch {
      // Already gone.
    }
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(130));
}

// ---- reads ----------------------------------------------------------------

/**
 * Every deployment of every service in the environment. The hold looks at all
 * of them, not only services built from this repository: a service deploying
 * from elsewhere still occupies the environment.
 */
function environmentDeployments(environment) {
  const services = runJson("railway", ["service", "list", "-p", RAILWAY_PROJECT_ID, "-e", environment, "--json"]);
  if (!services.some((service) => service.source?.repo === REPOSITORY)) {
    throw new Error(`no ${environment} service deploys from ${REPOSITORY}; refusing to treat that as an idle environment`);
  }
  return services.flatMap((service) => {
    if (!UUID_PATTERN.test(String(service.id))) throw new Error(`Railway returned a service id that is not a UUID`);
    return runJson("railway", [
      "deployment", "list", "-p", RAILWAY_PROJECT_ID, "-e", environment, "-s", service.id,
      "--limit", String(DEPLOYMENTS_PER_SERVICE), "--json",
    ]).map((deployment) => ({ ...deployment, serviceId: service.id, serviceName: service.name }));
  });
}

const PR_FIELDS = "number,title,state,isDraft,createdAt,baseRefName,headRefOid,mergeable,statusCheckRollup";

function openPullRequests(branch) {
  const pullRequests = runJson("gh", [
    "pr", "list", "--repo", REPOSITORY, "--state", "open", "--base", branch, "--limit", "100", "--json", PR_FIELDS,
  ]);
  return onlyPr === null ? pullRequests : pullRequests.filter((pr) => pr.number === onlyPr);
}

const viewPullRequest = (number, fields) =>
  runJson("gh", ["pr", "view", String(number), "--repo", REPOSITORY, "--json", fields]);

const describeDeployments = (deployments) =>
  deployments.map((deployment) => `${deployment.serviceName}=${deployment.status}`).join(", ");

// ---- one poll -------------------------------------------------------------

class TrainStop extends Error {
  constructor(branch, message) {
    super(message);
    this.branch = branch;
  }
}

let state = { lanes: {} };

function save(branch, patch) {
  state = withLane(state, branch, patch);
  writeState(state);
}

/**
 * A merge the train started and never confirmed: the process died between
 * `gh pr merge` and recording the result. GitHub's record decides.
 */
function resolveUnconfirmedMerge(lane, merging) {
  const pr = viewPullRequest(merging.number, "state,mergeCommit");
  if (pr.state === "MERGED" && SHA_PATTERN.test(String(pr.mergeCommit?.oid))) {
    log(lane, `#${merging.number} was merged as ${pr.mergeCommit.oid.slice(0, 9)}; following it`);
    // The clock starts now: time the train was down is not time Railway had.
    save(lane.branch, {
      merging: null,
      awaiting: { number: merging.number, sha: pr.mergeCommit.oid, mergedAt: Date.now() },
    });
    return true;
  }
  if (pr.state === "OPEN") {
    const minutes = (Date.now() - merging.startedAt) / 60000;
    if (minutes < UNCONFIRMED_GRACE_MINUTES) {
      log(lane, `#${merging.number} still reads OPEN after a failed merge call; waiting before believing it`);
      return false;
    }
    log(lane, `#${merging.number} was not merged`);
    save(lane.branch, { merging: null });
    return true;
  }
  throw new TrainStop(lane.branch, `#${merging.number} is ${pr.state} after an unconfirmed merge; outcome unknown`);
}

/**
 * The replacement commits that include `sha`, per GitHub's compare. A
 * compare that fails (an unknown SHA, a diff GitHub refuses to build) leaves
 * that commit out, which makes the outcome "unknown" and latches -- the train
 * stops on it once rather than crashing on it at every start.
 */
function commitsContaining(sha, candidates) {
  const containing = new Set();
  for (const candidate of candidates) {
    if (!SHA_PATTERN.test(candidate)) continue;
    try {
      // per_page=1 keeps the response to the status, not the whole diff.
      const status = runText("gh", [
        "api", `repos/${REPOSITORY}/compare/${sha}...${candidate}?per_page=1`, "--jq", ".status",
      ]).trim();
      if (status === "ahead" || status === "identical") containing.add(candidate);
    } catch {
      // Left out: see above.
    }
  }
  return containing;
}

/**
 * The commits whose CI had a check run cancelled -- a later push cut it short
 * (cancel-in-progress). A failed lookup leaves the commit out, so its SKIPPED
 * still counts towards the run: not knowing is not a reason to wait longer.
 */
function commitsWithCancelledChecks(candidates) {
  const cancelled = new Set();
  for (const candidate of candidates) {
    if (!SHA_PATTERN.test(candidate)) continue;
    try {
      // Parsed here rather than with --jq: a filter with spaces and pipes would
      // not survive the Windows shell (see useShell).
      const { check_runs: runs } = runJson("gh", [
        "api", `repos/${REPOSITORY}/commits/${candidate}/check-runs?per_page=100`,
      ]);
      if (runs.some((run) => run.conclusion === "cancelled")) cancelled.add(candidate);
    } catch {
      // Left out: see above.
    }
  }
  return cancelled;
}

function followAwaitedMerge(lane, awaiting, deployments) {
  const containing = commitsContaining(awaiting.sha, replacementCommits(deployments, awaiting.sha));
  const cancelled = commitsWithCancelledChecks(skippedCommits(deployments, awaiting.sha, containing));
  const outcome = deploymentOutcome(deployments, awaiting.sha, lane.branch, containing, cancelled);
  const minutes = (Date.now() - awaiting.mergedAt) / 60000;
  const label = `#${awaiting.number} (${awaiting.sha.slice(0, 9)})`;
  const seen = outcome.deployments.length ? `: ${describeDeployments(outcome.deployments)}` : "";

  if (outcome.state === "succeeded") {
    log(lane, `${label} deployed${seen}`);
    save(lane.branch, { awaiting: null });
    return true;
  }
  if (outcome.state === "not_seen" && minutes < notSeenTimeoutMinutes) {
    log(lane, `${label} merged; Railway has not registered a deployment yet`);
    return false;
  }
  if ((outcome.state === "in_progress" || outcome.state === "partial") && minutes < deployTimeoutMinutes) {
    log(lane, `${label} deploying${seen}`);
    return false;
  }
  throw new TrainStop(lane.branch, `${label} deployment ${outcome.state} after ${minutes.toFixed(0)} min${seen}`);
}

function mergeOne(lane, candidate) {
  // Re-read both sides right before merging. The pick came from a rollup and
  // a Railway snapshot that are a poll old; a late failing check or a push
  // that queued a deployment in between must stop this merge.
  // Railway first because it is the slow read (one call per service); the PR
  // is read last so the window between its checks and the merge is one call.
  const busy = inFlightDeployments(environmentDeployments(lane.environment));
  if (busy.length > 0) {
    log(lane, `hold (appeared before merging #${candidate.number}): ${describeDeployments(busy)}`);
    return;
  }
  const pr = viewPullRequest(candidate.number, PR_FIELDS);
  const refusal = refusalReason(pr, lane.branch);
  if (refusal !== null || pr.headRefOid !== candidate.headRefOid) {
    log(lane, `#${pr.number} changed before merging (${refusal ?? "new head"}); re-reading next poll`);
    return;
  }
  if (dryRun) {
    log(lane, `would merge #${pr.number} ${pr.title} at ${pr.headRefOid.slice(0, 9)} (dry run)`);
    return;
  }

  log(lane, `merging #${pr.number} ${pr.title} at ${pr.headRefOid.slice(0, 9)}`);
  // Recorded before the call, so a process that dies after GitHub merged and
  // before the result is written still knows on restart to go and look.
  save(lane.branch, { merging: { number: pr.number, headSha: pr.headRefOid, startedAt: Date.now() } });
  let mergeError = null;
  try {
    runText(
      "gh",
      ["pr", "merge", String(pr.number), "--repo", REPOSITORY, "--merge", "--match-head-commit", pr.headRefOid],
      { timeout: 2 * 60 * 1000 },
    );
  } catch (error) {
    mergeError = error;
  }
  // Whatever gh said, ask GitHub what actually happened: a timed-out merge
  // call can still have merged.
  const result = viewPullRequest(pr.number, "state,mergeCommit");
  if (result.state === "MERGED" && SHA_PATTERN.test(String(result.mergeCommit?.oid))) {
    save(lane.branch, {
      merging: null,
      awaiting: { number: pr.number, sha: result.mergeCommit.oid, mergedAt: Date.now() },
    });
    log(lane, `#${pr.number} merged as ${result.mergeCommit.oid.slice(0, 9)}; waiting for its deployment`);
    return;
  }
  if (result.state === "OPEN" && mergeError) {
    // Probably refused (head moved, conflict), but a timed-out call can still
    // land after this read. The merging record stays, its grace period counted
    // from now rather than from before the call; the next polls resolve it,
    // and nothing else merges on this lane meanwhile.
    save(lane.branch, { merging: { number: pr.number, headSha: pr.headRefOid, startedAt: Date.now() } });
    log(lane, `#${pr.number} not merged yet: ${String(mergeError.stderr || mergeError.message).trim().split("\n")[0]}`);
    return;
  }
  throw new TrainStop(lane.branch, `#${pr.number} is ${result.state} after the merge call; outcome unknown`);
}

function tick(lane) {
  const { merging } = laneState(state, lane.branch);
  // Before the latch: resolving only reads GitHub and turns "maybe merged"
  // into a merge to follow, which is what a person clearing the latch needs.
  if (merging && !resolveUnconfirmedMerge(lane, merging)) return;
  const { latch } = laneState(state, lane.branch);
  if (latch) {
    log(lane, `latched since ${latch.at}: ${latch.reason} -- clear with --clear-latch=${lane.branch}`);
    return;
  }

  const deployments = environmentDeployments(lane.environment);
  const { awaiting } = laneState(state, lane.branch);
  if (awaiting && !followAwaitedMerge(lane, awaiting, deployments)) return;

  const busy = inFlightDeployments(deployments);
  if (busy.length > 0) {
    log(lane, `hold: ${describeDeployments(busy)}`);
    return;
  }
  const { pick, skipped } = pickNextPullRequest(openPullRequests(lane.branch), lane.branch);
  if (skipped.length > 0) {
    log(lane, `skipped ${skipped.map((entry) => `#${entry.number}:${entry.reason}`).join(" ")}`);
  }
  if (!pick) {
    log(lane, "nothing to merge");
    return;
  }
  mergeOne(lane, pick);
}

// ---- main -----------------------------------------------------------------

for (const [name, value] of [["clear-latch", clearLatch], ["forget-merge", forgetMerge]]) {
  if (value !== undefined && !LANES.some((lane) => lane.branch === value)) {
    usage(`--${name} takes one of: ${LANES.map((lane) => lane.branch).join(", ")}`);
  }
}

if (clearLatch !== undefined || forgetMerge !== undefined) {
  acquireLock();
  let next = readState();
  if (clearLatch !== undefined) {
    const { latch, awaiting, merging } = laneState(next, clearLatch);
    // Only the latch. A merge still being followed or confirmed stays: if its
    // deployment really failed the lane latches again, and a person who has
    // dealt with that says so separately with --forget-merge.
    next = withLane(next, clearLatch, { latch: null });
    const following = merging ?? awaiting;
    console.log(
      (latch ? `cleared ${clearLatch} latch (${latch.reason})` : `${clearLatch} was not latched`) +
        (following ? `; still following #${following.number} (--forget-merge=${clearLatch} to stop)` : ""),
    );
  }
  if (forgetMerge !== undefined) {
    const { latch, awaiting, merging } = laneState(next, forgetMerge);
    if (latch) usage(`--forget-merge refused: ${forgetMerge} is latched; look at the latch and clear it first`);
    const following = merging ?? awaiting;
    next = withLane(next, forgetMerge, { awaiting: null, merging: null });
    console.log(following ? `no longer following #${following.number} on ${forgetMerge}` : `${forgetMerge} was following nothing`);
  }
  writeState(next);
  process.exit(0);
}

if (!dryRun) {
  acquireLock();
  state = readState();
}

console.log(
  `merge train: ${lanes.map((lane) => `${lane.branch}->${lane.environment}`).join(", ")}` +
    `${dryRun ? " (dry run)" : ""}${onlyPr === null ? "" : `, only #${onlyPr}`}, poll ${pollSeconds}s`,
);

try {
  for (;;) {
    for (const lane of lanes) tick(lane);
    if (once) break;
    await sleep(pollSeconds * 1000);
  }
} catch (error) {
  if (error instanceof TrainStop) {
    // An outcome the train will not guess past. The latch outlives this
    // process, so a restart cannot merge on top of it.
    if (!dryRun) save(error.branch, { latch: { reason: error.message, at: new Date().toISOString() } });
    const { awaiting, merging } = laneState(state, error.branch);
    const following = merging ?? awaiting;
    console.error(
      `STOP: ${error.message}. Check Railway and the PR, then --clear-latch=${error.branch}` +
        (following
          ? ` -- adding --forget-merge=${error.branch} in the same command if you have dealt with #${following.number}.`
          : "."),
    );
    process.exit(1);
  }
  // A failed read (gh, railway CLI, network) is not an outcome, so it does not
  // latch. A merge left unconfirmed by it is still on record and is resolved
  // from GitHub on the next start; acting on a partial view of the
  // environment is how a second deploy gets queued, so the train stops.
  console.error(`STOP (read failed): ${error.message}`);
  process.exit(1);
}
