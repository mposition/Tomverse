#!/usr/bin/env node
// Reports which commit each environment is actually serving, against the branch
// it deploys from.
//
//   npm run report:deployed-commit-drift
//   npm run report:deployed-commit-drift -- --gate
//   npm run report:deployed-commit-drift -- --environment=production
//   npm run report:deployed-commit-drift -- --threshold-minutes=90
//   npm run report:deployed-commit-drift -- --fetch
//
// Reads `/api/build-info`, which is public and unauthenticated by design
// (STG-F010) -- no token, no dashboard, and nothing here can change a
// deployment. The comparison itself lives in
// scripts/report-deployed-commit-drift-core.mjs so it is testable without a
// network.
//
// `--gate` exits non-zero when an environment is past the threshold, which is
// what makes a scheduled run into a signal instead of a log nobody opens.
// Without it the command always exits 0 and simply says what it found: a merge
// that has not deployed yet is normal, and a report that fails on normal is a
// report people switch off.

import { execFileSync } from "node:child_process";
import {
  deployedCommitDrift,
  describeDrift,
  BEHIND,
  DIVERGED,
  UNKNOWN,
} from "./report-deployed-commit-drift-core.mjs";

// Both hosts already appear in lib/ (accountEmails, robotsPolicyCore). They are
// the public addresses of the two environments, not configuration -- but the
// overrides exist so a review app or a renamed host does not need a code change.
const ENVIRONMENTS = [
  {
    name: "production",
    url: process.env.PRODUCTION_APP_URL || "https://tomverse.app",
    branch: "main",
  },
  {
    name: "staging",
    url: process.env.STAGING_APP_URL || "https://staging.tomverse.app",
    branch: "develop",
  },
];

const DEFAULT_THRESHOLD_MINUTES = 60;

const args = process.argv.slice(2);
const flag = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const gate = args.includes("--gate");
const onlyEnvironment = flag("environment");
// Off by default: a report should not quietly rewrite the checkout it is run
// in. CI passes it because a fresh clone has no remote-tracking branches yet,
// and a stale checkout answers "not in this checkout" for every environment --
// true, and useless.
const shouldFetch = args.includes("--fetch");
const thresholdMinutes = Number(flag("threshold-minutes") ?? DEFAULT_THRESHOLD_MINUTES);

if (!Number.isFinite(thresholdMinutes) || thresholdMinutes < 0) {
  console.error(`--threshold-minutes must be a non-negative number, got "${flag("threshold-minutes")}"`);
  process.exit(2);
}

// stderr is swallowed rather than inherited: `cat-file -e` on a commit this
// checkout does not have is an expected answer here, and letting git print
// "fatal:" above a line that then explains the situation calmly reads as a
// crash.
const git = (...argv) =>
  execFileSync("git", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const commitExists = (sha) => {
  try {
    // `^{commit}` so a sha that happens to name a tree or a blob is not
    // mistaken for a commit this checkout can reason about.
    git("cat-file", "-e", `${sha}^{commit}`);
    return true;
  } catch {
    return false;
  }
};

const headOf = (branch) => {
  for (const ref of [`origin/${branch}`, branch]) {
    try {
      return git("rev-parse", ref);
    } catch {
      // Try the next one: a CI checkout may have only one of them.
    }
  }
  return null;
};

/** Commits reachable from the head but not from what is deployed, newest first. */
const undeployedCommits = (deployedSha, headSha) => {
  const output = git("rev-list", "--format=%H %cI", `${deployedSha}..${headSha}`);
  return output
    .split("\n")
    // `rev-list --format` emits a "commit <sha>" line before each formatted
    // line. Dropping it here rather than using --pretty keeps the parse to one
    // shape.
    .filter((line) => line && !line.startsWith("commit "))
    .map((line) => {
      const [sha, committedAt] = line.trim().split(" ");
      return { sha, committedAt };
    });
};

const fetchDeployedSha = async (url) => {
  const endpoint = new URL("/api/build-info", url).toString();
  try {
    const response = await fetch(endpoint, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      return { sha: null, error: `HTTP ${response.status}` };
    }
    const body = await response.json();
    return { sha: typeof body?.commitSha === "string" ? body.commitSha : null, error: null };
  } catch (cause) {
    return { sha: null, error: cause?.message || String(cause) };
  }
};

const selected = onlyEnvironment
  ? ENVIRONMENTS.filter((environment) => environment.name === onlyEnvironment)
  : ENVIRONMENTS;

if (selected.length === 0) {
  console.error(
    `--environment "${onlyEnvironment}" matches none of ${ENVIRONMENTS.map((e) => e.name).join(", ")}`
  );
  process.exit(2);
}

if (shouldFetch) {
  for (const branch of new Set(selected.map((environment) => environment.branch))) {
    try {
      git("fetch", "origin", branch, "--quiet");
    } catch (cause) {
      console.error(`could not fetch origin/${branch}: ${cause?.message || cause}`);
      process.exit(2);
    }
  }
}

const now = new Date().toISOString();
let past = 0;

for (const environment of selected) {
  const headSha = headOf(environment.branch);
  const { sha: deployedSha, error } = await fetchDeployedSha(environment.url);
  const deployedShaKnown = Boolean(deployedSha) && commitExists(deployedSha);
  const drift = deployedCommitDrift({
    deployedSha,
    headSha,
    deployedShaKnown,
    undeployed:
      deployedShaKnown && headSha && deployedSha !== headSha
        ? undeployedCommits(deployedSha, headSha)
        : [],
    now,
    thresholdMinutes,
  });

  console.log(describeDrift(environment.name, drift));
  if (error) console.log(`  ${environment.url}/api/build-info: ${error}`);
  console.log(`  branch ${environment.branch}, threshold ${thresholdMinutes} minutes`);

  // Three things reach a person, and the third is the one this exists for.
  //
  // Past the threshold, because the gap has stopped being ordinary. Diverged,
  // whatever its age, because that is not a gap that closes on its own and no
  // threshold is about it. And unknown -- because "I could not check" is not
  // "fine", and reading the absence of a signal as the absence of a problem is
  // precisely what let production serve an hour-old commit unnoticed.
  if (drift.exceedsThreshold || drift.state === DIVERGED || drift.state === UNKNOWN) {
    past += 1;
  }
  if (drift.state === BEHIND && !drift.exceedsThreshold) {
    console.log("  within the threshold; a merge that has not deployed yet is ordinary.");
  }
}

if (gate && past > 0) {
  console.error(
    `\n${past} environment${past === 1 ? "" : "s"} need${past === 1 ? "s" : ""} attention. ` +
      "Check the deployment platform: with Wait for CI a deployment waits for the commit's " +
      "check suite, and a failing suite means it never runs at all."
  );
  process.exit(1);
}
