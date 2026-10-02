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
//
// Run it from a local PowerShell in the repository clone. It uses the
// operator's own `gh` login and `railway` CLI login; it holds no token of its
// own. It is a stopgap until the QA/Release agent exists, not that agent.
//
// Per lane, each poll:
//   1. A latched lane does nothing until a person clears it.
//   2. If a merge made by the train is still deploying, wait for it. A failed,
//      skipped, crashed or unrecognised deployment latches the lane and stops
//      the train (exit 1) -- it never retries and never merges past a broken
//      deploy.
//   3. If any service in the environment has a deployment waiting for CI,
//      queued, building or deploying, hold.
//   4. Otherwise merge the oldest non-draft PR whose checks all finished green,
//      pinned to the head SHA that was checked (--match-head-commit).
//
// The merge being followed and the latch survive a restart: they live in
// merge-train-state.json in the repository's common git directory, shared by
// every worktree and never committed. One train runs at a time per clone
// (merge-train.lock beside it). A dry run reads neither and writes nothing.
//
// The decisions live in scripts/merge-train-core.mjs.

import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  LANES,
  deploymentOutcome,
  inFlightDeployments,
  laneState,
  parseTrainState,
  pickNextPullRequest,
  withLane,
} from "./merge-train-core.mjs";

const RAILWAY_PROJECT_ID = process.env.MERGE_TRAIN_RAILWAY_PROJECT_ID || "0c5f17ad-a42a-4fa8-a245-bcd6a3275a35";
const REPOSITORY = process.env.MERGE_TRAIN_REPOSITORY || "mposition/Tomverse";

const args = process.argv.slice(2);
const flag = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const dryRun = args.includes("--dry-run");
const once = args.includes("--once");
const includeMain = args.includes("--include-main");
const clearLatch = flag("clear-latch");
const onlyPr = flag("pr") === undefined ? null : Number(flag("pr"));
const pollSeconds = Number(flag("poll-seconds") ?? 60);
// How long a merge commit may go without Railway registering any deployment
// for it before the train treats the outcome as unknown and stops.
const notSeenTimeoutMinutes = Number(flag("not-seen-timeout-minutes") ?? 15);
// How long a deployment may stay in flight (CI wait included) before stopping.
const deployTimeoutMinutes = Number(flag("deploy-timeout-minutes") ?? 120);

for (const [name, value] of [
  ["poll-seconds", pollSeconds],
  ["not-seen-timeout-minutes", notSeenTimeoutMinutes],
  ["deploy-timeout-minutes", deployTimeoutMinutes],
]) {
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`--${name} must be a positive number`);
    process.exit(2);
  }
}
if (onlyPr !== null && !(Number.isInteger(onlyPr) && onlyPr > 0)) {
  console.error("--pr must be a pull request number");
  process.exit(2);
}

const lanes = LANES.filter((lane) => lane.branch !== "main" || includeMain);

// `railway` is an npm shim on Windows, which execFile cannot start without a
// shell. Every argument here is a constant, a number checked above, or an id
// this script read back from the CLI itself, so the shell sees nothing an
// outsider wrote.
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

const gitDir = resolve(runText("git", ["rev-parse", "--git-common-dir"]).trim());
const STATE_PATH = join(gitDir, "merge-train-state.json");
const LOCK_PATH = join(gitDir, "merge-train.lock");

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

function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(LOCK_PATH, "wx");
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      process.on("exit", () => rmSync(LOCK_PATH, { force: true }));
      for (const signal of ["SIGINT", "SIGTERM"]) {
        process.on(signal, () => process.exit(130));
      }
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const holder = Number(readFileSync(LOCK_PATH, "utf8").trim());
    if (Number.isInteger(holder) && holder > 0 && processAlive(holder)) {
      console.error(`another merge train is running (pid ${holder}); refusing to start a second one`);
      process.exit(2);
    }
    // The holder is gone without cleaning up (killed, crashed). Its lock
    // protects nothing now; its state file still holds what it was doing.
    rmSync(LOCK_PATH, { force: true });
  }
  console.error(`could not take ${LOCK_PATH}`);
  process.exit(2);
}

// ---- reads ----------------------------------------------------------------

function environmentDeployments(environment) {
  const services = runJson("railway", ["service", "list", "-p", RAILWAY_PROJECT_ID, "-e", environment, "--json"]);
  const deployed = services.filter((service) => service.source?.repo === REPOSITORY);
  if (deployed.length === 0) {
    throw new Error(`no ${environment} service deploys from ${REPOSITORY}; refusing to treat that as an idle environment`);
  }
  return deployed.flatMap((service) =>
    runJson("railway", [
      "deployment", "list", "-p", RAILWAY_PROJECT_ID, "-e", environment, "-s", service.id, "--limit", "10", "--json",
    ]).map((deployment) => ({ ...deployment, serviceId: service.id, serviceName: service.name })),
  );
}

function openPullRequests(branch) {
  const pullRequests = runJson("gh", [
    "pr", "list", "--repo", REPOSITORY, "--state", "open", "--base", branch, "--limit", "100",
    "--json", "number,title,isDraft,createdAt,baseRefName,headRefOid,mergeable,statusCheckRollup",
  ]);
  return onlyPr === null ? pullRequests : pullRequests.filter((pr) => pr.number === onlyPr);
}

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

function followAwaitedMerge(lane, awaiting, deployments) {
  const outcome = deploymentOutcome(deployments, awaiting.sha);
  const minutes = (Date.now() - awaiting.mergedAt) / 60000;
  const label = `#${awaiting.number} (${awaiting.sha.slice(0, 9)})`;

  if (outcome.state === "succeeded") {
    log(lane, `${label} deployed: ${describeDeployments(outcome.deployments)}`);
    state = withLane(state, lane.branch, { awaiting: null });
    writeState(state);
    return true;
  }
  if (outcome.state === "not_seen" && minutes < notSeenTimeoutMinutes) {
    log(lane, `${label} merged; Railway has not registered a deployment yet`);
    return false;
  }
  if (outcome.state === "in_progress" && minutes < deployTimeoutMinutes) {
    log(lane, `${label} deploying: ${describeDeployments(outcome.deployments)}`);
    return false;
  }
  throw new TrainStop(
    lane.branch,
    `${label} deployment ${outcome.state} after ${minutes.toFixed(0)} min` +
      (outcome.deployments.length ? `: ${describeDeployments(outcome.deployments)}` : ""),
  );
}

function mergeOne(lane, pick) {
  if (dryRun) {
    log(lane, `would merge #${pick.number} ${pick.title} at ${pick.headRefOid.slice(0, 9)} (dry run)`);
    return;
  }
  log(lane, `merging #${pick.number} ${pick.title} at ${pick.headRefOid.slice(0, 9)}`);
  let mergeError = null;
  try {
    runText("gh", ["pr", "merge", String(pick.number), "--repo", REPOSITORY, "--merge", "--match-head-commit", pick.headRefOid]);
  } catch (error) {
    mergeError = error;
  }
  // Whatever gh said, ask GitHub what actually happened before going on: a
  // timed-out merge call can still have merged.
  const result = runJson("gh", ["pr", "view", String(pick.number), "--repo", REPOSITORY, "--json", "state,mergeCommit"]);
  if (result.state === "MERGED" && result.mergeCommit?.oid) {
    state = withLane(state, lane.branch, {
      awaiting: { number: pick.number, sha: result.mergeCommit.oid, mergedAt: Date.now() },
    });
    writeState(state);
    log(lane, `#${pick.number} merged as ${result.mergeCommit.oid.slice(0, 9)}; waiting for its deployment`);
    return;
  }
  if (result.state === "OPEN" && mergeError) {
    // The head moved or GitHub refused; nothing changed, so the next poll
    // re-reads the PR from scratch.
    log(lane, `#${pick.number} not merged: ${String(mergeError.stderr || mergeError.message).trim().split("\n")[0]}`);
    return;
  }
  throw new TrainStop(lane.branch, `#${pick.number} is ${result.state} after the merge call; outcome unknown`);
}

function tick(lane) {
  const { awaiting, latch } = laneState(state, lane.branch);
  if (latch) {
    log(lane, `latched since ${latch.at}: ${latch.reason} -- clear with --clear-latch=${lane.branch}`);
    return;
  }
  const deployments = environmentDeployments(lane.environment);
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
    console.error(`--clear-latch takes one of: ${LANES.map((lane) => lane.branch).join(", ")}`);
    process.exit(2);
  }
  acquireLock();
  const current = readState();
  const { latch, awaiting } = laneState(current, clearLatch);
  // The merge the latch was about is dropped with it: a person clearing the
  // latch has looked at that deployment, and following it again would only
  // re-latch on the same failure.
  writeState(withLane(current, clearLatch, { latch: null, awaiting: null }));
  console.log(
    latch
      ? `cleared ${clearLatch} latch (${latch.reason})${awaiting ? `, no longer following #${awaiting.number}` : ""}`
      : `${clearLatch} was not latched`,
  );
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
    // A deployment or merge outcome the train will not guess past. The latch
    // outlives this process, so a restart cannot merge on top of it.
    if (!dryRun) {
      state = withLane(state, error.branch, { latch: { reason: error.message, at: new Date().toISOString() } });
      writeState(state);
    }
    console.error(`STOP: ${error.message}. Check Railway and the PR, then --clear-latch=${error.branch}.`);
    process.exit(1);
  }
  // A failed read (gh, railway CLI, network) is not an outcome, so it does
  // not latch; but acting on a partial view of the environment is how a second
  // deploy gets queued, so the train stops.
  console.error(`STOP (read failed): ${error.message}`);
  process.exit(1);
}
