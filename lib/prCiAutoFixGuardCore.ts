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
/** The only author a dependabot/ head is served for. */
export const PR_CI_AUTO_FIX_DEPENDABOT_AUTHOR = "dependabot[bot]";
/**
 * Root files a fix to a Dependabot update may change (owner 2026-10-26): how
 * the app itself is built and instrumented, which a major update of Next.js
 * or Sentry can require. Every other root file -- how the checks run --
 * stays fenced, and so does proxy.ts (request handling and auth redirects).
 */
export const PR_CI_AUTO_FIX_DEPENDABOT_ROOT_FILES =
  /^(next\.config\.(ts|mjs|js)|sentry\.(client|server|edge)\.config\.ts|instrumentation(-client)?\.ts)$/;
export const PR_CI_AUTO_FIX_COMMIT_PREFIX = "auto-fix(ci): ";
/**
 * A conflict with develop resolved by the auto-fix (owner 2026-10-27): a
 * merge commit of develop into the branch. Off unless the repository
 * variable PR_AUTO_FIX_CONFLICTS_ENABLED is "true".
 */
export const PR_CI_AUTO_FIX_CONFLICT_PREFIX = "auto-fix(conflict): ";
/**
 * Lines a conflict resolution may write that are on neither side, in all its
 * files: joining two edits of one line takes a few. Gate paths may take none.
 */
export const PR_CI_AUTO_FIX_MAX_NEW_CONFLICT_LINES = 40;
const CONFLICT_MARKER = /^(<{7}|>{7})( |$)|^={7}$|^\|{7}( |$)/m;

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
  /** The pull request's author login as GitHub reports it. */
  author: string;
  commitMessages: readonly string[];
  /** The number of commits GitHub says the pull request has; the attempt count is only trusted when every one was read. */
  commitCount: number;
  /** A failed CI (the default) or a conflict with develop, which a draft may have too. */
  kind?: "ci" | "conflict";
}): PrCiAutoFixVerdict {
  const conflict = input.kind === "conflict";
  const reasons: string[] = [];
  if (!input.sameRepository) reasons.push("fork");
  if (input.baseBranch !== "develop") reasons.push("base_not_develop");
  if (input.draft && !conflict) reasons.push("draft");
  if (!PR_CI_AUTO_FIX_BRANCH.test(input.headBranch)) reasons.push("branch_not_served");
  // A dependabot/ name alone is not Dependabot: a person with push access can
  // name a branch so, and the root allowance follows the name.
  if (PR_CI_AUTO_FIX_DEPENDABOT_BRANCH.test(input.headBranch) && input.author !== PR_CI_AUTO_FIX_DEPENDABOT_AUTHOR) {
    reasons.push("dependabot_branch_not_by_dependabot");
  }
  if (!Number.isInteger(input.commitCount) || input.commitMessages.length !== input.commitCount) reasons.push("commits_incomplete");
  const prefix = conflict ? PR_CI_AUTO_FIX_CONFLICT_PREFIX : PR_CI_AUTO_FIX_COMMIT_PREFIX;
  const attempts = input.commitMessages.filter((m) => m.startsWith(prefix)).length;
  if (attempts >= PR_CI_AUTO_FIX_MAX_ATTEMPTS) reasons.push("attempts_exhausted");
  return reasons.length === 0 ? { push: true } : { push: false, reasons };
}

/**
 * Whether a resolution of a conflict with develop may be committed. The
 * workflow has merged develop itself; `files` is every conflicted path with
 * the branch's side (`ours`), develop's (`theirs`) and the proposed content
 * (`resolved`), and `proposed` every path the resolution names.
 *
 * Refused: a resolution for any path that is not conflicted, or none for one
 * that is; a conflict a side deleted (a resolution can only be content); a
 * conflict marker or a NUL byte left; a line on neither side in a gate path
 * (the merge lane's list, the test-free fence aside: a merge brings tests in);
 * more than PR_CI_AUTO_FIX_MAX_NEW_CONFLICT_LINES such lines in all.
 */
export function judgePrCiAutoFixConflict(input: {
  files: readonly { path: string; ours: string | null; theirs: string | null; resolved: string | null }[];
  proposed: readonly string[];
  headBranch?: string;
}): PrCiAutoFixVerdict {
  const reasons = new Set<string>();
  const conflicted = new Set(input.files.map((file) => file.path));
  if (conflicted.size === 0) reasons.add("no_conflict");
  for (const path of input.proposed) if (!conflicted.has(path)) reasons.add("not_conflicted");
  const dependabot = PR_CI_AUTO_FIX_DEPENDABOT_BRANCH.test(input.headBranch ?? "");
  let newLines = 0;
  for (const file of input.files) {
    if (file.ours === null || file.theirs === null) {
      reasons.add("deleted_side");
      continue;
    }
    if (file.resolved === null) {
      reasons.add("unresolved");
      continue;
    }
    if (CONFLICT_MARKER.test(file.resolved)) reasons.add("marker_left");
    if (file.resolved.includes("\u0000")) reasons.add("binary");
    const known = new Set([...file.ours.split("\n"), ...file.theirs.split("\n")].map((line) => line.trimEnd()));
    const added = file.resolved.split("\n").filter((line) => !known.has(line.trimEnd())).length;
    newLines += added;
    const gate =
      CONTRACT_DOCUMENT.test(file.path) ||
      AUTO_FIX_FENCE.test(file.path) ||
      PACKAGE_FILE.test(file.path) ||
      (!file.path.includes("/") && !(dependabot && PR_CI_AUTO_FIX_DEPENDABOT_ROOT_FILES.test(file.path))) ||
      judgeQaReleaseMergeLaneExclusion({
        headBranch: "auto-fix",
        changedFiles: [{ path: file.path }],
        changedFilesComplete: true,
        policyTestPaths: [],
        agentOwnPatterns: [],
      }).excluded;
    if (gate && added > 0) reasons.add("gate_path_new_line");
  }
  if (newLines > PR_CI_AUTO_FIX_MAX_NEW_CONFLICT_LINES) reasons.add("too_many_new_lines");
  return reasons.size === 0 ? { push: true } : { push: false, reasons: [...reasons].sort() };
}
