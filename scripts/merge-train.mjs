#!/usr/bin/env node
// Operator-run merge train: merges the oldest green pull request into develop
// (and, with --include-main, into main), one at a time per environment, and
// holds while Railway has any deployment in flight for that environment.
//
//   npm run merge-train -- --dry-run --once     # read-only: say what would merge
//   npm run merge-train                          # develop -> staging only
//   npm run merge-train -- --include-main        # also main -> production
//
// Run it from a local PowerShell in the repository clone. It uses the
// operator's own `gh` login and `railway` CLI login; it holds no token of its
// own. It is a stopgap until the QA/Release agent exists, not that agent.
//
// Per lane, each poll:
//   1. If a merge from this run is still deploying, wait for it. A failed,
//      skipped, crashed or unrecognised deployment stops the whole train
//      (exit 1) -- it never retries and never merges past a broken deploy.
//   2. If any service in the environment has a deployment waiting for CI,
//      queued, building or deploying, hold.
//   3. Otherwise merge the oldest non-draft PR whose checks all finished green,
//      pinned to the head SHA that was checked (--match-head-commit).
//
// The decisions live in scripts/merge-train-core.mjs.

import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import {
  LANES,
  deploymentOutcome,
  inFlightDeployments,
  pickNextPullRequest,
} from "./merge-train-core.mjs";

const RAILWAY_PROJECT_ID = process.env.MERGE_TRAIN_RAILWAY_PROJECT_ID || "0c5f17ad-a42a-4fa8-a245-bcd6a3275a35";
const REPOSITORY = process.env.MERGE_TRAIN_REPOSITORY || "mposition/Tomverse";

const args = process.argv.slice(2);
const flag = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const dryRun = args.includes("--dry-run");
const once = args.includes("--once");
const includeMain = args.includes("--include-main");
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

const lanes = LANES.filter((lane) => lane.branch !== "main" || includeMain).map((lane) => ({
  ...lane,
  awaiting: null,
}));

// `railway` is an npm shim on Windows, which execFile cannot start without a
// shell. Every argument here is a constant or an id this script read back from
// the CLI itself, so the shell sees nothing an outsider wrote.
const useShell = process.platform === "win32";

function runJson(command, commandArgs) {
  const output = execFileSync(command, commandArgs, {
    encoding: "utf8",
    shell: useShell,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(output);
}

const log = (lane, message) => console.log(`${new Date().toISOString()} [${lane.branch}->${lane.environment}] ${message}`);

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
  return runJson("gh", [
    "pr", "list", "--repo", REPOSITORY, "--state", "open", "--base", branch, "--limit", "100",
    "--json", "number,title,isDraft,createdAt,baseRefName,headRefOid,mergeable,statusCheckRollup",
  ]);
}

const describeDeployments = (deployments) =>
  deployments.map((deployment) => `${deployment.serviceName}=${deployment.status}`).join(", ");

class TrainStop extends Error {}

function followAwaitedMerge(lane, deployments) {
  const { number, sha, mergedAt } = lane.awaiting;
  const outcome = deploymentOutcome(deployments, sha);
  const minutes = (Date.now() - mergedAt) / 60000;
  const label = `#${number} (${sha.slice(0, 9)})`;

  if (outcome.state === "succeeded") {
    log(lane, `${label} deployed: ${describeDeployments(outcome.deployments)}`);
    lane.awaiting = null;
    return;
  }
  if (outcome.state === "not_seen" && minutes < notSeenTimeoutMinutes) {
    log(lane, `${label} merged; Railway has not registered a deployment yet`);
    return;
  }
  if (outcome.state === "in_progress" && minutes < deployTimeoutMinutes) {
    log(lane, `${label} deploying: ${describeDeployments(outcome.deployments)}`);
    return;
  }
  throw new TrainStop(
    `${label} deployment ${outcome.state} after ${minutes.toFixed(0)} min` +
      (outcome.deployments.length ? `: ${describeDeployments(outcome.deployments)}` : "") +
      ". Stopping: check Railway and the PR's checks, then restart the train by hand.",
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
    execFileSync(
      "gh",
      ["pr", "merge", String(pick.number), "--repo", REPOSITORY, "--merge", "--match-head-commit", pick.headRefOid],
      { encoding: "utf8", shell: useShell, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    mergeError = error;
  }
  // Whatever gh said, ask GitHub what actually happened before going on: a
  // timed-out merge call can still have merged.
  const state = runJson("gh", ["pr", "view", String(pick.number), "--repo", REPOSITORY, "--json", "state,mergeCommit"]);
  if (state.state === "MERGED" && state.mergeCommit?.oid) {
    lane.awaiting = { number: pick.number, sha: state.mergeCommit.oid, mergedAt: Date.now() };
    log(lane, `#${pick.number} merged as ${state.mergeCommit.oid.slice(0, 9)}; waiting for its deployment`);
    return;
  }
  if (state.state === "OPEN" && mergeError) {
    // The head moved or GitHub refused; nothing changed, so the next poll
    // re-reads the PR from scratch.
    log(lane, `#${pick.number} not merged: ${String(mergeError.stderr || mergeError.message).trim().split("\n")[0]}`);
    return;
  }
  throw new TrainStop(`#${pick.number} is ${state.state} after the merge call; outcome unknown, stopping.`);
}

function tick(lane) {
  const deployments = environmentDeployments(lane.environment);
  if (lane.awaiting) {
    followAwaitedMerge(lane, deployments);
    if (lane.awaiting) return;
  }
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

console.log(
  `merge train: ${lanes.map((lane) => `${lane.branch}->${lane.environment}`).join(", ")}` +
    `${dryRun ? " (dry run)" : ""}, poll ${pollSeconds}s`,
);

try {
  for (;;) {
    for (const lane of lanes) tick(lane);
    if (once) break;
    await sleep(pollSeconds * 1000);
  }
} catch (error) {
  // A TrainStop is a deployment or merge outcome the train will not guess
  // past. Anything else is a failed read (gh, railway CLI, network), and acting
  // on a partial view of the environment is how a second deploy gets queued.
  console.error(`STOP${error instanceof TrainStop ? "" : " (read failed)"}: ${error.message}`);
  process.exit(1);
}
