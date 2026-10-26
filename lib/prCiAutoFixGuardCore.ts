/**
 * What the CI auto-fix (.github/workflows/pr-ci-auto-fix.yml) may push to a
 * pull request. The model proposes a diff; this decides whether it is pushed.
 *
 * Refused: any path the merge lane leaves to a person (gate files, policy and
 * contract documents, auth, package manifests -- the same judgement, so the
 * two cannot drift), any test file (a fix that edits the test it failed is
 * not a fix), any deletion, an empty diff and a diff above the size cap.
 * Pure: the caller passes `git diff --name-status` and `--numstat` output.
 */
import { judgeQaReleaseMergeLaneExclusion } from "./qaReleaseMergeLaneExclusionCore.ts";

export const PR_CI_AUTO_FIX_MAX_CHANGED_LINES = 400;
export const PR_CI_AUTO_FIX_MAX_ATTEMPTS = 2;
/**
 * Head branches the auto-fix serves: agent sessions that open develop pull
 * requests, and Dependabot's updates into develop (owner 2026-10-26).
 */
export const PR_CI_AUTO_FIX_BRANCH = /^((claude|codex)\/to-develop|dependabot)\/[A-Za-z0-9._/-]+$/;
export const PR_CI_AUTO_FIX_DEPENDABOT_BRANCH = /^dependabot\/[A-Za-z0-9._/-]+$/;
/**
 * Root files a fix to a Dependabot update may change (owner 2026-10-26): how
 * the app itself is built and instrumented, which a major update of Next.js
 * or Sentry can require. Every other root file -- how the checks run --
 * stays fenced, and so does proxy.ts (request handling and auth redirects).
 */
export const PR_CI_AUTO_FIX_DEPENDABOT_ROOT_FILES =
  /^(next\.config\.(ts|mjs|js)|sentry\.(client|server|edge)\.config\.ts|instrumentation(-client)?\.ts)$/;
export const PR_CI_AUTO_FIX_COMMIT_PREFIX = "auto-fix(ci): ";

export type PrCiAutoFixVerdict = { push: true } | { push: false; reasons: string[] };

const TEST_PATH = /(^|\/)(tests?|__tests__|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

const CONTRACT_DOCUMENT = /^docs\/(policy|ui-contracts|release-gates)\//;

/**
 * What the model may not touch although the merge lane may merge it when a
 * person or an agent session wrote it (owner 2026-10-23 narrowed the lane to
 * the minimum; the auto-fix keeps the wider fence): everything under
 * .github/ and scripts/ (the checks and what they run), any file at the
 * repository root (how checks run and are configured; a Dependabot fix may
 * change PR_CI_AUTO_FIX_DEPENDABOT_ROOT_FILES only), and every package
 * manifest or npm config wherever it sits (`npm ci` runs install scripts).
 */
const AUTO_FIX_FENCE = /^(\.github|scripts)\//;
const PACKAGE_FILE = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|\.npmrc)$/i;

export function judgePrCiAutoFixDiff(input: {
  nameStatus: string;
  numstat: string;
  /** The pull request's head branch; without it no root file is allowed. */
  headBranch?: string;
}): PrCiAutoFixVerdict {
  const dependabot = PR_CI_AUTO_FIX_DEPENDABOT_BRANCH.test(input.headBranch ?? "");
  const fencedRoot = (path: string) => !path.includes("/") && !(dependabot && PR_CI_AUTO_FIX_DEPENDABOT_ROOT_FILES.test(path));
  const reasons = new Set<string>();
  const changedFiles: { path: string; previousPath?: string }[] = [];
  for (const line of input.nameStatus.split("\n").filter((l) => l.trim() !== "")) {
    const [status, ...paths] = line.split("\t");
    if (status.startsWith("D")) reasons.add("deletion");
    if (status.startsWith("R") || status.startsWith("C")) changedFiles.push({ previousPath: paths[0], path: paths[1] });
    else changedFiles.push({ path: paths[0] });
  }
  if (changedFiles.length === 0) reasons.add("no_change");
  for (const file of changedFiles) {
    for (const path of [file.path, file.previousPath]) {
      if (path && TEST_PATH.test(path)) reasons.add("test_file");
      // Contract documents stay off-limits to the model even though the merge
      // lane may merge one a person wrote (owner 2026-10-23): a model fixing
      // CI must not rewrite another feature's policy to make its change pass.
      if (path && CONTRACT_DOCUMENT.test(path)) reasons.add("gate_path");
      if (path && (AUTO_FIX_FENCE.test(path) || fencedRoot(path) || PACKAGE_FILE.test(path))) reasons.add("gate_path");
    }
  }
  const lane = judgeQaReleaseMergeLaneExclusion({
    headBranch: "auto-fix",
    changedFiles,
    changedFilesComplete: true,
    policyTestPaths: [],
    agentOwnPatterns: [],
  });
  if (lane.excluded) for (const reason of lane.reasons) if (reason !== "changed_files_empty") reasons.add(reason);

  let lines = 0;
  for (const line of input.numstat.split("\n").filter((l) => l.trim() !== "")) {
    const [added, removed] = line.split("\t");
    // Binary files report "-": refused, a model has no business writing them.
    if (added === "-" || removed === "-") reasons.add("binary");
    else lines += Number(added) + Number(removed);
  }
  if (lines > PR_CI_AUTO_FIX_MAX_CHANGED_LINES) reasons.add("too_large");
  return reasons.size === 0 ? { push: true } : { push: false, reasons: [...reasons].sort() };
}

/** Whether a pull request is one the auto-fix serves, and still has attempts left. */
export function judgePrCiAutoFixTarget(input: {
  headBranch: string;
  baseBranch: string;
  draft: boolean;
  sameRepository: boolean;
  commitMessages: readonly string[];
  /** The number of commits GitHub says the pull request has; the attempt count is only trusted when every one was read. */
  commitCount: number;
}): PrCiAutoFixVerdict {
  const reasons: string[] = [];
  if (!input.sameRepository) reasons.push("fork");
  if (input.baseBranch !== "develop") reasons.push("base_not_develop");
  if (input.draft) reasons.push("draft");
  if (!PR_CI_AUTO_FIX_BRANCH.test(input.headBranch)) reasons.push("branch_not_served");
  if (!Number.isInteger(input.commitCount) || input.commitMessages.length !== input.commitCount) reasons.push("commits_incomplete");
  const attempts = input.commitMessages.filter((m) => m.startsWith(PR_CI_AUTO_FIX_COMMIT_PREFIX)).length;
  if (attempts >= PR_CI_AUTO_FIX_MAX_ATTEMPTS) reasons.push("attempts_exhausted");
  return reasons.length === 0 ? { push: true } : { push: false, reasons };
}
