#!/usr/bin/env node
// Operator-run merge train: merges the oldest green pull request into develop
// (and, with --include-main, into main), one at a time per environment, and
// holds while Railway has any deployment in flight for that environment.
//
//   npm run merge-train -- --dry-run --once      # read-only: say what would merge
//   npm run merge-train                           # develop -> staging only
//   npm run merge-train -- --include-main         # also main -> production
//   npm run merge-train -- --pr=1916 --once       # consider only this PR
//   npm run merge-train -- --clear-latch=develop  # a person clears a stop
//   npm run merge-train -- --break-lock           # a person removes a dead train's lock
//
// Run it from a local PowerShell in the repository clone. It uses the
// operator's own `gh` login and `railway` CLI login; it holds no token of its
// own. It is a stopgap until the QA/Release agent exists, not that agent.
//
// Per lane, each poll:
//   1. A latched lane does nothing until a person clears it.
//   2. A merge the train started but never confirmed is resolved first, from
//      GitHub's own record of the PR.
//   3. If a merge made by the train is still deploying, wait until every
//      service that deploys the branch has deployed it. A failed, skipped,
//      crashed or unrecognised deployment latches the lane and stops the train
//      (exit 1) -- it never retries and never merges past a broken deploy.
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
  servicesDeployingBranch,
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
const onlyPr = flag("pr") === undefined ? null : Number(flag("pr"));
const pollSeconds = Number(flag("poll-seconds") ?? 60);
// How long a merge commit may go without Railway registering any deployment
// for it before the train treats the outcome as unknown and stops.
const notSeenTimeoutMinutes = Number(flag("not-seen-timeout-minutes") ?? 15);
// How long a deployment may stay in flight (CI wait included) before stopping.
const deployTimeoutMinutes = Number(flag("deploy-timeout-minutes") ?? 120);

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

function runText(command, commandArgs) {
  return execFileSync(command, commandArgs, {
    encoding: "utf8",
    shell: useShell,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
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
  if (breakLock) rmSync(LOCK_PATH, { force: true });
  const mine = `${process.pid}\n`;
  try {
    const fd = openSync(LOCK_PATH, "wx");
    writeFileSync(fd, mine);
    closeSync(fd);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const holder = Number(readFileSync(LOCK_PATH, "utf8").trim());
    const alive = Number.isInteger(holder) && holder > 0 && processAlive(holder);
    usage(
      alive
        ? `another merge train is running (pid ${holder}); refusing to start a second one`
        : `${LOCK_PATH} is held by pid ${holder || "unknown"}, which is not running. ` +
            "If no merge train is running, rerun with --break-lock.",
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
    log(lane, `#${merging.number} was merged as ${pr.mergeCommit.oid.slice(0, 9)} before the last stop; following it`);
    save(lane.branch, {
      merging: null,
      awaiting: { number: merging.number, sha: pr.mergeCommit.oid, mergedAt: merging.startedAt },
    });
    return;
  }
  if (pr.state === "OPEN") {
    log(lane, `#${merging.number} was not merged before the last stop`);
    save(lane.branch, { merging: null });
    return;
  }
  throw new TrainStop(lane.branch, `#${merging.number} is ${pr.state} after an unconfirmed merge; outcome unknown`);
}

function followAwaitedMerge(lane, awaiting, deployments) {
  const expected = servicesDeployingBranch(deployments, lane.branch);
  const outcome = deploymentOutcome(deployments, awaiting.sha, expected);
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
  const pr = viewPullRequest(candidate.number, PR_FIELDS);
  const refusal = refusalReason(pr, lane.branch);
  if (refusal !== null || pr.headRefOid !== candidate.headRefOid) {
    log(lane, `#${pr.number} changed before merging (${refusal ?? "new head"}); re-reading next poll`);
    return;
  }
  const busy = inFlightDeployments(environmentDeployments(lane.environment));
  if (busy.length > 0) {
    log(lane, `hold (appeared before merging #${pr.number}): ${describeDeployments(busy)}`);
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
    runText("gh", ["pr", "merge", String(pr.number), "--repo", REPOSITORY, "--merge", "--match-head-commit", pr.headRefOid]);
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
    // GitHub refused (head moved, conflict); nothing changed.
    save(lane.branch, { merging: null });
    log(lane, `#${pr.number} not merged: ${String(mergeError.stderr || mergeError.message).trim().split("\n")[0]}`);
    return;
  }
  throw new TrainStop(lane.branch, `#${pr.number} is ${result.state} after the merge call; outcome unknown`);
}

function tick(lane) {
  const { latch, merging } = laneState(state, lane.branch);
  if (latch) {
    log(lane, `latched since ${latch.at}: ${latch.reason} -- clear with --clear-latch=${lane.branch}`);
    return;
  }
  if (merging) resolveUnconfirmedMerge(lane, merging);

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

if (clearLatch !== undefined) {
  if (!LANES.some((lane) => lane.branch === clearLatch)) {
    usage(`--clear-latch takes one of: ${LANES.map((lane) => lane.branch).join(", ")}`);
  }
  acquireLock();
  const current = readState();
  const { latch, awaiting, merging } = laneState(current, clearLatch);
  if (!latch) {
    // Nothing a person has looked at: a merge still being followed or
    // confirmed is left exactly as it is.
    console.log(`${clearLatch} was not latched; nothing changed`);
    process.exit(0);
  }
  // The merge the latch was about is dropped with it: a person clearing the
  // latch has looked at that deployment, and following it again would only
  // re-latch on the same failure.
  writeState(withLane(current, clearLatch, { latch: null, awaiting: null, merging: null }));
  const dropped = awaiting ?? merging;
  console.log(`cleared ${clearLatch} latch (${latch.reason})${dropped ? `; no longer following #${dropped.number}` : ""}`);
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

let current = null;
try {
  for (;;) {
    for (const lane of lanes) {
      current = lane;
      tick(lane);
    }
    if (once) break;
    await sleep(pollSeconds * 1000);
  }
} catch (error) {
  const unconfirmed = current && laneState(state, current.branch).merging;
  if (error instanceof TrainStop || unconfirmed) {
    // An outcome the train will not guess past -- or a failure while a merge
    // was unconfirmed, which is the same thing. The latch outlives this
    // process, so a restart cannot merge on top of it.
    const branch = error instanceof TrainStop ? error.branch : current.branch;
    if (!dryRun) save(branch, { latch: { reason: error.message, at: new Date().toISOString() } });
    console.error(`STOP: ${error.message}. Check Railway and the PR, then --clear-latch=${branch}.`);
    process.exit(1);
  }
  // A failed read (gh, railway CLI, network) is not an outcome, so it does
  // not latch; but acting on a partial view of the environment is how a second
  // deploy gets queued, so the train stops.
  console.error(`STOP (read failed): ${error.message}`);
  process.exit(1);
}
