// Pure decisions for moving the `test` branch to a release candidate
// (scripts/promote-test.mjs).
//
// staging (shown to people as Test) deploys `test` and nothing else moves it:
// the merge train merges into develop and main only, and develop lands on dev.
// So whatever `test` points at is what a person chose to verify, and the two
// mistakes worth stopping are the ones that change that choice by accident --
// a candidate develop never had, and a move that drops a candidate somebody is
// still verifying.
//
// Nothing here touches git or the network; tests/promoteTestCore.test.mjs
// covers the whole table.

export const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA_PREFIX = /^[0-9a-f]{7,40}$/;

export const DEFAULT_WAIT_MINUTES = 45;
export const DEFAULT_POLL_SECONDS = 30;

/** The candidate, as typed. A full SHA or an unambiguous prefix; git resolves it. */
export function parseCandidate(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return SHA_PREFIX.test(text) ? text : null;
}

/**
 * What moving `test` from `current` to `target` would do.
 *
 * - `create`: `test` does not exist yet.
 * - `noop`: it already points there.
 * - `forward`: the current candidate is in the new one's history, so nothing
 *   it contained is dropped.
 * - `rewind`: anything else -- an older candidate, or one from a side of
 *   develop the current one is not on. Refused unless a person says so, since
 *   it takes commits off the environment somebody may be verifying.
 */
export function classifyMove({ currentSha, targetSha, currentIsAncestorOfTarget }) {
  if (!FULL_SHA.test(String(targetSha))) throw new Error("targetSha must be a full SHA");
  if (currentSha === null) return "create";
  if (!FULL_SHA.test(String(currentSha))) throw new Error("currentSha must be a full SHA or null");
  if (currentSha === targetSha) return "noop";
  return currentIsAncestorOfTarget ? "forward" : "rewind";
}

const RELEASE_BRANCH = /^release\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/**
 * Where a candidate may come from: develop (an ordinary release, the history
 * dev already ran), or a `release/**` branch (a selective release cut from
 * main, .github/RELEASE_CHECKLIST.md 7.9.1). Anything else is null -- a hotfix
 * takes its own path to main (7.9.2) and a feature branch is not a candidate.
 */
export function parseSourceBranch(value) {
  const text = String(value ?? "develop").trim();
  if (text === "develop") return text;
  return RELEASE_BRANCH.test(text) && !text.includes("..") ? text : null;
}

/**
 * The GitHub Actions check suites on the candidate, as Railway's Wait for CI
 * reads them: it looks at Actions suites only, holds a deployment while any
 * is unfinished, and skips it when any concluded otherwise
 * (.github/RELEASE_CHECKLIST.md 7.9.4).
 *
 * "failed" includes `cancelled`: a develop push cancels the previous push's
 * runs, so a commit merged a minute before another often carries cancelled
 * suites, and Test would never deploy it.
 */
const PASSING_SUITE_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
export function checkSuitesVerdict(suites) {
  const actions = (Array.isArray(suites) ? suites : []).filter((suite) => suite?.app === "github-actions");
  if (actions.length === 0) return "none";
  if (actions.some((suite) => suite.status === "completed" && !PASSING_SUITE_CONCLUSIONS.has(suite.conclusion))) {
    return "failed";
  }
  return actions.some((suite) => suite.status !== "completed") ? "pending" : "passed";
}

/**
 * Why the move must not happen, or null.
 *
 * `onSource` means the candidate is on the source branch's first-parent
 * history -- a merge commit develop actually pointed at, which dev deployed.
 * Mere ancestry would also admit a pull request's head or a commit inside a
 * merged branch: a tree develop never had.
 */
export function refusalReason({ move, onSource, allowRewind, suites }) {
  if (!onSource) return "not_on_source";
  if (suites === "failed") return "checks_failed";
  if (move === "rewind" && !allowRewind) return "rewind_needs_allow_rewind";
  return null;
}

/**
 * The push, pinned to what was read: `--force-with-lease` with the expected
 * old value, so a `test` that moved since the read is refused rather than
 * overwritten. An empty expected value means "must not exist yet".
 */
export function pushArguments({ remote = "origin", targetSha, currentSha }) {
  if (!FULL_SHA.test(String(targetSha))) throw new Error("targetSha must be a full SHA");
  return [
    "push",
    `--force-with-lease=refs/heads/test:${currentSha ?? ""}`,
    remote,
    `${targetSha}:refs/heads/test`,
  ];
}

/**
 * Whether a parsed `/api/build-info` body comes from a process built from the
 * candidate. The process answering is the evidence; `deploymentStatus` is a
 * Railway lookup that may honestly say "unknown", so it is not consulted.
 */
export function buildInfoServes(body, targetSha) {
  return typeof body?.commitSha === "string" && body.commitSha === targetSha;
}
