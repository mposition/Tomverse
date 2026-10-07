#!/usr/bin/env node
// Moves the `test` branch to a release candidate, then waits until staging
// (shown to people as Test) serves it.
//
//   npm run promote:test -- --sha=<commit> --dry-run   # read-only: say what would move
//   npm run promote:test -- --sha=<commit>             # move, then wait for Test
//   npm run promote:test -- --sha=<commit> --no-wait   # move only
//   npm run promote:test -- --sha=<commit> --allow-rewind
//   npm run promote:test -- --sha=<commit> --source=release/<date>-<subject>
//
// Run it from a local PowerShell in the repository clone. It pushes with the
// operator's own git credentials and reads check suites with the operator's
// own `gh` login; it holds no token of its own.
//
// What it refuses (scripts/promote-test-core.mjs holds the decisions):
// - a candidate that is not on the source branch's first-parent history. On
//   develop that is a merge commit develop actually pointed at, which dev
//   deployed; a pull request's head or a commit inside a merged branch is not.
// - a candidate whose GitHub Actions suites concluded otherwise than success,
//   cancelled included: Railway's Wait for CI would skip it on Test.
// - a move that is not a fast-forward, without --allow-rewind: it takes
//   commits off the environment somebody may be verifying.
// The push is pinned with --force-with-lease to the `test` that was read, so a
// concurrent move is refused rather than overwritten
// (.github/RELEASE_CHECKLIST.md 7.9, docs/ops/dev-test-lanes.md).

import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import {
  DEFAULT_POLL_SECONDS,
  DEFAULT_WAIT_MINUTES,
  buildInfoServes,
  checkSuitesVerdict,
  classifyMove,
  parseCandidate,
  parseSourceBranch,
  pushArguments,
  refusalReason,
} from "./promote-test-core.mjs";
import { classifyBuildInfoResponse } from "./report-deployed-commit-drift-core.mjs";

const STAGING_APP_URL = process.env.STAGING_APP_URL || "https://staging.tomverse.app";
const REPOSITORY = process.env.PROMOTE_TEST_REPOSITORY || "mposition/Tomverse";
const MAX_SAME_ORIGIN_REDIRECTS = 3;

const args = process.argv.slice(2);
const flag = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const dryRun = args.includes("--dry-run");
const noWait = args.includes("--no-wait");
const allowRewind = args.includes("--allow-rewind");
const waitMinutes = Number(flag("wait-minutes") ?? DEFAULT_WAIT_MINUTES);
const pollSeconds = Number(flag("poll-seconds") ?? DEFAULT_POLL_SECONDS);

function usage(message) {
  console.error(message);
  console.error(
    "usage: npm run promote:test -- --sha=<commit> [--source=release/<name>] [--dry-run] [--no-wait] [--allow-rewind]",
  );
  process.exit(2);
}

function stop(message) {
  console.error(message);
  process.exit(1);
}

const candidate = parseCandidate(flag("sha"));
if (!candidate) usage("--sha must be a commit SHA (7 to 40 hex characters)");
const source = parseSourceBranch(flag("source"));
if (!source) usage("--source must be develop (the default) or a release/** branch");
for (const [name, value] of [["wait-minutes", waitMinutes], ["poll-seconds", pollSeconds]]) {
  if (!Number.isFinite(value) || value <= 0) usage(`--${name} must be a positive number`);
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(REPOSITORY)) usage("PROMOTE_TEST_REPOSITORY must look like owner/name");

const run = (command, argv) => execFileSync(command, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const git = (...argv) => run("git", argv);
const gitSucceeds = (...argv) => {
  try {
    git(...argv);
    return true;
  } catch {
    return false;
  }
};
const stderrOf = (error) => String(error?.stderr || error?.message || error).trim();

// The exact ref, not a pattern: `ls-remote origin test` would also match
// `refs/heads/feature/test`. Exit status 2 is "no such ref"; anything else is
// a failure to ask.
function remoteHead(branch) {
  try {
    return git("ls-remote", "--exit-code", "origin", `refs/heads/${branch}`).split(/\s+/)[0];
  } catch (error) {
    if (error?.status === 2) return null;
    stop(`could not read origin's ${branch}: ${stderrOf(error)}`);
  }
}

// Explicit refspecs, so a tag or local branch of the same name cannot stand in.
function fetchBranch(branch) {
  try {
    git("fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  } catch (error) {
    stop(`could not fetch origin's ${branch}: ${stderrOf(error)}`);
  }
}

if (remoteHead(source) === null) stop(`origin has no branch ${source}.`);
fetchBranch(source);
const currentSha = remoteHead("test");
if (currentSha !== null) fetchBranch("test");

let targetSha;
try {
  targetSha = git("rev-parse", "--verify", "--quiet", `${candidate}^{commit}`);
} catch {
  usage(`${candidate} is not a commit in this clone, or names more than one`);
}

const firstParentHistory = new Set(git("rev-list", "--first-parent", `refs/remotes/origin/${source}`).split("\n"));

let suites;
try {
  const lines = run("gh", [
    "api",
    "--paginate",
    `repos/${REPOSITORY}/commits/${targetSha}/check-suites`,
    "--jq",
    ".check_suites[] | {app: .app.slug, status: .status, conclusion: .conclusion}",
  ]);
  suites = checkSuitesVerdict(lines ? lines.split("\n").map((line) => JSON.parse(line)) : []);
} catch (error) {
  stop(`could not read the candidate's check suites with gh (is it installed and logged in?): ${stderrOf(error)}`);
}

const move = classifyMove({
  currentSha,
  targetSha,
  currentIsAncestorOfTarget: currentSha !== null && gitSucceeds("merge-base", "--is-ancestor", currentSha, targetSha),
});
const refusal = refusalReason({ move, onSource: firstParentHistory.has(targetSha), allowRewind, suites });

console.log(`test: ${currentSha ? currentSha.slice(0, 9) : "(does not exist)"} -> ${targetSha.slice(0, 9)} (${move})`);
console.log(`  ${git("log", "-1", "--format=%h %s", targetSha)}`);
console.log(`  GitHub Actions suites: ${suites}`);

if (refusal === "not_on_source") {
  stop(
    `refused: ${targetSha.slice(0, 9)} is not a commit origin/${source} pointed at (its first-parent history). ` +
      "Use the merge commit, not a pull request's head or a commit inside a merged branch.",
  );
}
if (refusal === "checks_failed") {
  stop(
    `refused: a GitHub Actions suite on ${targetSha.slice(0, 9)} did not succeed (a cancelled one counts), so ` +
      "Railway's Wait for CI would skip it on Test. Choose a commit whose suites all finished green.",
  );
}
if (refusal === "rewind_needs_allow_rewind") {
  stop(
    `refused: ${currentSha.slice(0, 9)} is not in ${targetSha.slice(0, 9)}'s history, so this move takes commits ` +
      "off Test. If nobody is verifying the current candidate, run again with --allow-rewind.",
  );
}
if (suites === "pending") console.log("  some suites are still running; Railway holds Test's deployment until they finish.");
if (suites === "none") console.log("  no GitHub Actions suite on this commit; Railway's Wait for CI has nothing to wait for.");

if (dryRun) {
  console.log("dry run: nothing pushed.");
  process.exit(0);
}

if (move === "noop") {
  console.log("test already points there; nothing to push.");
} else {
  try {
    git(...pushArguments({ targetSha, currentSha }));
  } catch (error) {
    const detail = stderrOf(error);
    stop(
      /stale info|rejected/.test(detail)
        ? `refused by origin: test moved after it was read. Run again to see where it is now.\n${detail}`
        : `push failed: ${detail}`,
    );
  }
  console.log(`pushed: test is now ${targetSha.slice(0, 9)}.`);
}

if (noWait) process.exit(0);

// Same-origin redirects are the app's own routing and are followed; one that
// leaves the origin is a gate, reported rather than followed (as in
// scripts/report-deployed-commit-drift.mjs).
async function readBuildInfo() {
  let endpoint = new URL("/api/build-info", STAGING_APP_URL).toString();
  for (let hop = 0; hop <= MAX_SAME_ORIGIN_REDIRECTS; hop += 1) {
    const response = await fetch(endpoint, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text().catch(() => "");
    const { reason, followTo } = classifyBuildInfoResponse({
      requestUrl: endpoint,
      status: response.status,
      location: response.headers.get("location"),
    });
    if (reason) return { error: `${reason} (HTTP ${response.status})` };
    if (followTo) {
      endpoint = followTo;
      continue;
    }
    try {
      return { body: JSON.parse(text) };
    } catch {
      return { error: `not JSON (HTTP ${response.status})` };
    }
  }
  return { error: "redirect loop" };
}

console.log(`waiting up to ${waitMinutes} minutes for ${STAGING_APP_URL} to serve ${targetSha.slice(0, 9)}...`);
const deadline = Date.now() + waitMinutes * 60_000;
let last = "";
while (Date.now() < deadline) {
  let state;
  try {
    const { body, error } = await readBuildInfo();
    if (body && buildInfoServes(body, targetSha)) {
      console.log(`Test serves ${targetSha.slice(0, 9)} (deployed ${body.deployedAt ?? "at an unknown time"}).`);
      process.exit(0);
    }
    state = error ? `build-info: ${error}` : `serving ${String(body?.commitSha ?? "?").slice(0, 9)}`;
  } catch (cause) {
    state = `build-info unreachable: ${cause?.message || cause}`;
  }
  if (state !== last) console.log(`  ${new Date().toISOString()} ${state}`);
  last = state;
  await sleep(pollSeconds * 1000);
}

stop(
  `Test did not serve ${targetSha.slice(0, 9)} within ${waitMinutes} minutes. Open staging's Tomverse service in ` +
    "Railway: WAITING is Wait for CI, SKIPPED is a suite that did not pass, and a branch other than test means " +
    "the service was never switched (docs/ops/dev-test-lanes.md).",
);
