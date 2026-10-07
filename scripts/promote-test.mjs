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
// operator's own git credentials and holds no token of its own. The candidate
// must already be on develop -- dev has run it and PR Fast Gate has seen it --
// or, for a selective release, on the `release/**` branch named by --source;
// and a move that is not a fast-forward (an older candidate, a side branch)
// needs --allow-rewind, because it takes commits off the environment somebody
// may be verifying. The push is pinned with --force-with-lease to the `test`
// that was read, so a concurrent move is refused rather than overwritten.
//
// Railway's Wait for CI still decides whether staging deploys the commit; this
// script only reports what `/api/build-info` answers. The decisions live in
// scripts/promote-test-core.mjs (.github/RELEASE_CHECKLIST.md 7.9).

import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import {
  DEFAULT_POLL_SECONDS,
  DEFAULT_WAIT_MINUTES,
  buildInfoServes,
  classifyMove,
  parseCandidate,
  parseSourceBranch,
  pushArguments,
  refusalReason,
} from "./promote-test-core.mjs";
import { classifyBuildInfoResponse } from "./report-deployed-commit-drift-core.mjs";

const STAGING_APP_URL = process.env.STAGING_APP_URL || "https://staging.tomverse.app";

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

const candidate = parseCandidate(flag("sha"));
if (!candidate) usage("--sha must be a commit SHA (7 to 40 hex characters)");
const source = parseSourceBranch(flag("source"));
if (!source) usage("--source must be develop (the default) or a release/** branch");
for (const [name, value] of [["wait-minutes", waitMinutes], ["poll-seconds", pollSeconds]]) {
  if (!Number.isFinite(value) || value <= 0) usage(`--${name} must be a positive number`);
}

const git = (...argv) => execFileSync("git", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitSucceeds = (...argv) => {
  try {
    git(...argv);
    return true;
  } catch {
    return false;
  }
};

// `test` may not exist yet; that is the first promotion, not an error.
git("fetch", "origin", source, "--quiet");
const testExists = git("ls-remote", "--heads", "origin", "test") !== "";
if (testExists) git("fetch", "origin", "test", "--quiet");

let targetSha;
try {
  targetSha = git("rev-parse", "--verify", "--quiet", `${candidate}^{commit}`);
} catch {
  usage(`${candidate} is not a commit in this clone, or names more than one`);
}
const currentSha = testExists ? git("rev-parse", "origin/test") : null;

const move = classifyMove({
  currentSha,
  targetSha,
  currentIsAncestorOfTarget: currentSha !== null && gitSucceeds("merge-base", "--is-ancestor", currentSha, targetSha),
});
const refusal = refusalReason({
  move,
  onSource: gitSucceeds("merge-base", "--is-ancestor", targetSha, `origin/${source}`),
  allowRewind,
});

const subject = git("log", "-1", "--format=%h %s", targetSha);
console.log(`test: ${currentSha ? currentSha.slice(0, 9) : "(does not exist)"} -> ${targetSha.slice(0, 9)} (${move})`);
console.log(`  ${subject}`);

if (refusal === "not_on_source") {
  console.error(
    `refused: ${targetSha.slice(0, 9)} is not on origin/${source}. A release candidate is a develop commit, ` +
      "or a commit on the release/** branch passed as --source.",
  );
  process.exit(1);
}
if (refusal === "rewind_needs_allow_rewind") {
  console.error(
    `refused: ${currentSha.slice(0, 9)} is not in ${targetSha.slice(0, 9)}'s history, so this move takes commits ` +
      "off Test. If nobody is verifying the current candidate, run again with --allow-rewind.",
  );
  process.exit(1);
}

if (dryRun) {
  console.log("dry run: nothing pushed.");
  process.exit(0);
}

if (move === "noop") {
  console.log("test already points there; nothing to push.");
} else {
  // Inherited stdio: git's own refusal ("stale info") is the clearest message.
  execFileSync("git", pushArguments({ targetSha, currentSha }), { stdio: "inherit" });
  console.log(`pushed: test is now ${targetSha.slice(0, 9)}.`);
}

if (noWait) process.exit(0);

async function readBuildInfo() {
  const endpoint = new URL("/api/build-info", STAGING_APP_URL).toString();
  const response = await fetch(endpoint, {
    headers: { accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text().catch(() => "");
  const { reason } = classifyBuildInfoResponse({
    requestUrl: endpoint,
    status: response.status,
    location: response.headers.get("location"),
  });
  if (reason) return { error: `${reason} (HTTP ${response.status})` };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { error: `not JSON (HTTP ${response.status})` };
  }
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

console.error(
  `Test did not serve ${targetSha.slice(0, 9)} within ${waitMinutes} minutes. Check staging's Tomverse deployment ` +
    "in Railway: Wait for CI marks it SKIPPED when the commit's checks did not pass.",
);
process.exit(1);
