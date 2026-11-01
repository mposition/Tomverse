/**
 * What the CI auto-fix (.github/workflows/pr-ci-auto-fix.yml) may push to a
 * pull request. The model proposes a diff; this decides whether it is pushed.
 *
 * Refused: any path the merge lane leaves to a person (gate files, policy and
 * contract documents, auth, package manifests -- the same judgement, so the
 * two cannot drift), any test file (a fix that edits the test it failed is
 * not a fix; a Dependabot head's API change is the one switchable exception,
 * testEditProblems), any deletion, an empty diff and a diff above the size cap.
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

/**
 * A dependency update that removes or renames an API breaks the tests that
 * call it as well as the app (owner 2026-11-01, #3192: officeparser 8 dropped
 * `toText()`). With the repository variable PR_AUTO_FIX_DEPENDABOT_TESTS_ENABLED
 * a fix to a Dependabot head may edit an existing test file to call the new
 * API -- never a fixture or snapshot, nor a test the merge lane leaves to a
 * person -- and the edit may take no test, assertion or expected value away
 * and may skip none (testEditProblems).
 */
const TEST_CODE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const ASSERTION = /\b(?:assert(?:\.\w+)*|expect)\s*\(/g;
const TEST_CASE = /\b(?:test|it|describe|suite)(?:\.\w+)*\s*\(/g;
const SKIP = /\.(?:skip|todo|only)\b|\b(?:skip|todo|only)\s*:/g;
/** String and number literals: an expected value is one of these. */
const LITERAL = /(["'`])(?:\\.|(?!\1)[^\\\n])*\1|(?<![\w.$])\d+(?:\.\d+)?(?![\w.])/g;

const count = (pattern: RegExp, lines: readonly string[]) => lines.reduce((sum, line) => sum + [...line.matchAll(pattern)].length, 0);

/**
 * What an edit of the named test files takes away, from `git diff -U0 HEAD`.
 * A file the patch does not show is a problem: its edit was not read.
 */
export function testEditProblems(patch: string, paths: ReadonlySet<string>): string[] {
  const files = new Map<string, { removed: string[]; added: string[] }>();
  let current: { removed: string[]; added: string[] } | null = null;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      current = paths.has(header[2]) && header[1] === header[2] ? { removed: [], added: [] } : null;
      if (current) files.set(header[2], current);
      inHunk = false;
    } else if (line.startsWith("@@")) {
      inHunk = true;
    } else if (current && inHunk && line.startsWith("-")) {
      current.removed.push(line.slice(1));
    } else if (current && inHunk && line.startsWith("+")) {
      current.added.push(line.slice(1));
    }
  }
  const problems = new Set<string>();
  for (const path of paths) {
    const file = files.get(path);
    if (!file) {
      problems.add("test_patch_unread");
      continue;
    }
    if (count(ASSERTION, file.added) < count(ASSERTION, file.removed)) problems.add("test_assertion_removed");
    if (count(TEST_CASE, file.added) < count(TEST_CASE, file.removed)) problems.add("test_case_removed");
    if (count(SKIP, file.added) > count(SKIP, file.removed)) problems.add("test_skipped");
    const kept = new Map<string, number>();
    for (const line of file.added) for (const [literal] of line.matchAll(LITERAL)) kept.set(literal, (kept.get(literal) ?? 0) + 1);
    for (const line of file.removed) {
      for (const [literal] of line.matchAll(LITERAL)) {
        const left = kept.get(literal) ?? 0;
        if (left === 0) problems.add("test_value_changed");
        else kept.set(literal, left - 1);
      }
    }
  }
  return [...problems];
}

export function judgePrCiAutoFixDiff(input: {
  nameStatus: string;
  numstat: string;
  /** The pull request's head branch; without it no root file is allowed. */
  headBranch?: string;
  /** The repository variable PR_AUTO_FIX_DEPENDABOT_TESTS_ENABLED is "true". */
  dependabotTests?: boolean;
  /** The tests the merge lane leaves to a person, from the trusted checkout; null when unread. */
  policyTestPaths?: readonly string[] | null;
  /** `git diff -U0 HEAD`, which an edited test is judged by. */
  patch?: string;
}): PrCiAutoFixVerdict {
  const dependabot = PR_CI_AUTO_FIX_DEPENDABOT_BRANCH.test(input.headBranch ?? "");
  const fencedRoot = (path: string) => !path.includes("/") && !(dependabot && PR_CI_AUTO_FIX_DEPENDABOT_ROOT_FILES.test(path));
  const testsEditable = dependabot && input.dependabotTests === true && Array.isArray(input.policyTestPaths)
    && typeof input.patch === "string";
  const policyTests = new Set(input.policyTestPaths ?? []);
  const reasons = new Set<string>();
  const changedFiles: { path: string; previousPath?: string }[] = [];
  const modified = new Set<string>();
  for (const line of input.nameStatus.split("\n").filter((l) => l.trim() !== "")) {
    const [status, ...paths] = line.split("\t");
    if (status.startsWith("D")) reasons.add("deletion");
    if (status.startsWith("R") || status.startsWith("C")) changedFiles.push({ previousPath: paths[0], path: paths[1] });
    else changedFiles.push({ path: paths[0] });
    if (status === "M") modified.add(paths[0]);
  }
  if (changedFiles.length === 0) reasons.add("no_change");
  const editedTests = new Set<string>();
  for (const file of changedFiles) {
    for (const path of [file.path, file.previousPath]) {
      if (path && TEST_PATH.test(path)) {
        if (testsEditable && modified.has(path) && TEST_CODE.test(path) && !policyTests.has(path)) editedTests.add(path);
        else reasons.add(testsEditable && policyTests.has(path) ? "policy_test" : "test_file");
      }
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
  if (editedTests.size > 0) for (const problem of testEditProblems(input.patch ?? "", editedTests)) reasons.add(problem);

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
