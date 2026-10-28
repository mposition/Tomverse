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

/** One conflicted file as git left it: the text outside its conflicts, and each conflict's sides. */
type MergedFile = { outside: string[][]; hunks: { sides: string[] }[] };

/**
 * Splits a file git left with conflict markers into the text outside the
 * conflicts (one more piece than there are conflicts) and each conflict's
 * lines (the branch's, develop's and, in diff3 style, the base's). Null when
 * the markers do not nest as git writes them.
 */
export function parseConflictMarkers(text: string): MergedFile | null {
  const outside: string[][] = [[]];
  const hunks: { sides: string[] }[] = [];
  let state: "outside" | "ours" | "base" | "theirs" = "outside";
  for (const line of text.split("\n")) {
    const bare = line.replace(/\r$/, "");
    if (/^<{7}( |$)/.test(bare)) {
      if (state !== "outside") return null;
      state = "ours";
      hunks.push({ sides: [] });
    } else if (/^\|{7}( |$)/.test(bare) && state === "ours") {
      state = "base";
    } else if (bare === "=======" && (state === "ours" || state === "base")) {
      state = "theirs";
    } else if (/^>{7}( |$)/.test(bare)) {
      if (state !== "theirs") return null;
      state = "outside";
      outside.push([]);
    } else if (state === "outside") {
      outside[outside.length - 1].push(line);
    } else {
      hunks[hunks.length - 1].sides.push(line);
    }
  }
  return state === "outside" && hunks.length > 0 ? { outside, hunks } : null;
}

// Exact, whitespace included: a trailing space can carry meaning (a shell
// line continuation, a multi-line string).
const sameLine = (a: string, b: string) => a === b;
const startsAt = (lines: string[], at: number, piece: string[]) =>
  at + piece.length <= lines.length && piece.every((line, index) => sameLine(lines[at + index], line));

/**
 * Whether a resolution of a conflict with develop may be committed. The
 * workflow has merged develop itself; `files` is every conflicted path with
 * the text git left in it (`merged`, with its markers), whether both sides
 * are regular files (`regular`), and the proposed content (`resolved`), and
 * `proposed` every path the resolution names.
 *
 * The resolution must keep everything git merged outside the conflicts, in
 * order and unchanged: only the conflicts themselves are replaced. Inside a
 * conflict a line on none of its sides is new; a gate path may take none
 * (the merge lane's list, the test-free fence aside: a merge brings tests in),
 * and all files together at most PR_CI_AUTO_FIX_MAX_NEW_CONFLICT_LINES.
 * Refused as well: a resolution for any path that is not conflicted, or none
 * for one that is; a conflict a side deleted, or a side that is not a regular
 * file; markers git did not write; a marker or a NUL byte left.
 */
export function judgePrCiAutoFixConflict(input: {
  files: readonly { path: string; regular: boolean; merged: string | null; resolved: string | null }[];
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
    if (!file.regular) {
      reasons.add("not_regular_file");
      continue;
    }
    if (file.merged === null) {
      reasons.add("deleted_side");
      continue;
    }
    if (file.resolved === null) {
      reasons.add("unresolved");
      continue;
    }
    if (CONFLICT_MARKER.test(file.resolved)) reasons.add("marker_left");
    if (file.resolved.includes("\u0000")) reasons.add("binary");
    const merged = parseConflictMarkers(file.merged);
    if (merged === null) {
      reasons.add("markers_unreadable");
      continue;
    }
    // Walk the resolution: each piece of outside text in turn, unchanged; what
    // lies between two pieces replaced the conflict between them.
    const lines = file.resolved.split("\n");
    const last = merged.outside.length - 1;
    const tail = merged.outside[last];
    const tailAt = lines.length - tail.length;
    let kept = startsAt(lines, 0, merged.outside[0]) && tailAt >= merged.outside[0].length;
    let at = merged.outside[0].length;
    let added = 0;
    for (let index = 0; kept && index < merged.hunks.length; index += 1) {
      let end: number;
      if (index + 1 === last) {
        end = tailAt;
        kept = end >= at && startsAt(lines, end, tail);
      } else {
        const next = merged.outside[index + 1];
        end = at;
        while (end <= tailAt - next.length && !startsAt(lines, end, next)) end += 1;
        kept = end <= tailAt - next.length;
      }
      if (!kept) break;
      const sides = new Set(merged.hunks[index].sides);
      added += lines.slice(at, end).filter((line) => !sides.has(line)).length;
      at = end + (index + 1 === last ? tail.length : merged.outside[index + 1].length);
    }
    if (!kept) {
      reasons.add("outside_conflict_changed");
      continue;
    }
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
