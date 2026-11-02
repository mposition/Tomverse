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
 * person. testEditProblems holds the edit to exactly that.
 */
const TEST_CODE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Words an edited test line may not gain: each changes what runs, or whether it runs. */
const ADDED_WORDS_REFUSED = new Set([
  "return", "if", "else", "throw", "try", "catch", "finally", "void", "while", "for", "do", "switch", "case",
  "break", "continue", "delete", "skip", "todo", "only", "true", "false", "null", "undefined", "not",
  "typeof", "instanceof", "in", "of", "new", "yield", "function", "class", "var", "let", "const", "this",
]);
/** Punctuation an edited test line may gain: enough to wrap a call, `(await x.to("text")).value`. */
const ADDED_PUNCTUATION = new Set([".", "(", ")"]);
/**
 * Names an edited test line may not lose, nor any name in a member chain
 * that starts from one (`assert.strict.equal`, `expect(x).not.toBe`): what
 * the test checks.
 */
const REMOVED_WORDS_REFUSED = new Set(["assert", "expect", "test", "it", "describe", "suite", "t", "strict"]);

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * The name the member chain ending at the `.` at `dot` starts from, through
 * calls: `expect` for `expect(x).not.`. Null when the line does not show a
 * name there -- a chain continued from the line before, `.toBe(1)` -- which
 * the caller refuses: what it starts from is unknown.
 */
function chainRoot(list: readonly string[], dot: number): string | null {
  let i = dot - 1;
  for (;;) {
    if (list[i] === ")") {
      for (let depth = 0; i >= 0; i -= 1) {
        if (list[i] === ")") depth += 1;
        else if (list[i] === "(" && --depth === 0) break;
      }
      i -= 1;
    }
    if (i < 0 || !IDENTIFIER.test(list[i])) return null;
    if (list[i - 1] !== ".") return list[i];
    i -= 2;
  }
}
const QUOTED = /^(["'])[\s\S]*\1$/;
const REGEX_MAY_FOLLOW = new Set(["", "(", ",", "=", ":", "[", "!", "&&", "||", "\x3f\x3f", "?", "{", "}", ";", "=>", "return"]);

/**
 * Which tokens of a line call a test or an assertion: every chain from
 * assert, expect, test, ... up to its calls' parentheses (`assert.equal(`,
 * `expect(` `).not.toBe(`), not what those calls are given. An edit may
 * rewrite the arguments -- that is the API change -- but may add nothing to
 * what is called, so `test.bind(` or `assert.equal.bind(` cannot stop the
 * call from running. The shape is each call's name and how many arguments
 * it is given, which must not change: `assert.ok((x, message))` gives one.
 * Whether rewritten arguments read the same value is for the person who
 * merges the update.
 */
function callees(list: readonly string[]): { mark: boolean[]; shape: string } {
  const mark = new Array<boolean>(list.length).fill(false);
  const shape: string[] = [];
  list.forEach((token, root) => {
    if (!REMOVED_WORDS_REFUSED.has(token) || list[root - 1] === ".") return;
    mark[root] = true;
    shape.push(token);
    for (let i = root + 1; i < list.length; ) {
      if (list[i] === "." && IDENTIFIER.test(list[i + 1] ?? "")) {
        mark[i] = mark[i + 1] = true;
        shape.push(`.${list[i + 1]}`);
        i += 2;
      } else if (list[i] === "(") {
        mark[i] = true;
        let depth = 0;
        let commas = 0;
        const open = i;
        for (; i < list.length; i += 1) {
          if (list[i] === "(" || list[i] === "[" || list[i] === "{") depth += 1;
          else if ((list[i] === ")" || list[i] === "]" || list[i] === "}") && --depth === 0) break;
          else if (list[i] === "," && depth === 1) commas += 1;
        }
        if (i < list.length) mark[i] = true;
        // `()` gives none; otherwise one more than its top-level commas.
        shape.push(`(${i === open + 1 ? 0 : commas + 1})`);
        i += 1;
      } else break;
    }
    shape.push(";");
  });
  return { mark, shape: shape.join("") };
}

/**
 * Whether a line is a statement of its own: it starts with a name (not `.`,
 * `(` or `,`, which would continue the line before) and closes every bracket
 * it opens, unless it ends by opening a block (`test("x", async () => {`,
 * which leaves the call open around the block): what follows is then a
 * statement of its own.
 */
function complete(list: readonly string[]): boolean {
  if (list.length === 0 || !IDENTIFIER.test(list[0])) return false;
  let depth = 0;
  for (const token of list) {
    if (token === "(" || token === "[" || token === "{") depth += 1;
    else if (token === ")" || token === "]" || token === "}") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0 || list.at(-1) === "{";
}

/** A line's tokens: comments, strings, templates and regular expressions each one token. */
function tokens(line: string): string[] {
  const out: string[] = [];
  let at = 0;
  const take = (pattern: RegExp) => {
    pattern.lastIndex = at;
    const match = pattern.exec(line);
    if (!match) return false;
    out.push(match[0]);
    at = pattern.lastIndex;
    return true;
  };
  while (at < line.length) {
    if (/\s/.test(line[at])) {
      at += 1;
      continue;
    }
    if (take(/\/\/.*|\/\*[\s\S]*?(?:\*\/|$)/y)) continue;
    if (take(/(["'`])(?:\\.|(?!\1)[^\\])*(?:\1|$)/y)) continue;
    if (line[at] === "/" && REGEX_MAY_FOLLOW.has(out.at(-1) ?? "")
      && take(/\/(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[A-Za-z]*/y)) continue;
    if (take(/[A-Za-z_$][\w$]*|\d[\w.]*|=>|\?\?|\?\.|&&|\|\||[=!]==?|\.\.\./y)) continue;
    out.push(line[at]);
    at += 1;
  }
  return out;
}

/** Which tokens of a and of b a longest common subsequence keeps. */
function kept(a: readonly string[], b: readonly string[]): { a: boolean[]; b: boolean[] } {
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const keepA = new Array<boolean>(a.length).fill(false);
  const keepB = new Array<boolean>(b.length).fill(false);
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) {
      keepA[i] = true;
      keepB[j] = true;
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) i += 1;
    else j += 1;
  }
  return { a: keepA, b: keepB };
}

/**
 * Whether the edit of the named test files only moves calls to another API,
 * from `git diff -U0 HEAD`. Each hunk replaces as many lines as it removes,
 * paired in order; a pair may lose only a property or method name (never an
 * assertion's, a variable, a literal, a regular expression, a comment or
 * punctuation) and may gain only names that change no control flow, `.(),`
 * and quoted strings. So
 * no assertion is commented out, weakened or loosened, no test is skipped
 * and no line is added or dropped. A file the patch does not show was not read.
 */
export function testEditProblems(patch: string, paths: ReadonlySet<string>): string[] {
  const files = new Map<string, { removed: string[]; added: string[] }[]>();
  let hunks: { removed: string[]; added: string[] }[] | null = null;
  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      hunks = paths.has(header[2]) && header[1] === header[2] ? [] : null;
      if (hunks) files.set(header[2], hunks);
    } else if (hunks && line.startsWith("@@")) {
      hunks.push({ removed: [], added: [] });
    } else if (hunks && hunks.length > 0 && line.startsWith("-")) {
      hunks.at(-1)!.removed.push(line.slice(1));
    } else if (hunks && hunks.length > 0 && line.startsWith("+")) {
      hunks.at(-1)!.added.push(line.slice(1));
    }
  }
  const problems = new Set<string>();
  for (const path of paths) {
    const file = files.get(path);
    if (!file || file.length === 0) {
      problems.add("test_patch_unread");
      continue;
    }
    for (const hunk of file) {
      if (hunk.removed.length !== hunk.added.length) {
        problems.add("test_edit_shape");
        continue;
      }
      hunk.removed.forEach((removedLine, index) => {
        const before = tokens(removedLine);
        const after = tokens(hunk.added[index]);
        const keep = kept(before, after);
        before.forEach((token, i) => {
          if (keep.a[i]) return;
          const member = before[i - 1] === ".";
          const root = member ? chainRoot(before, i - 1) : null;
          const assertionName = member && (root === null || REMOVED_WORDS_REFUSED.has(root));
          if (!IDENTIFIER.test(token) || !member || REMOVED_WORDS_REFUSED.has(token) || assertionName) problems.add("test_edit_removed");
        });
        // A line that continues another, or that the next could continue, is judged without what it joins.
        if (!complete(before) || before[0] !== after[0] || before.at(-1) !== after.at(-1)) problems.add("test_edit_context");
        const called = callees(after);
        if (called.shape !== callees(before).shape) problems.add("test_edit_added");
        after.forEach((token, j) => {
          if (keep.b[j]) return;
          const allowed = ADDED_PUNCTUATION.has(token) || QUOTED.test(token) || (IDENTIFIER.test(token) && !ADDED_WORDS_REFUSED.has(token));
          // `foo.test(` makes a test or an assertion a member of something else.
          const demotes = token === "." && REMOVED_WORDS_REFUSED.has(after[j + 1] ?? "");
          if (!allowed || called.mark[j] || demotes) problems.add("test_edit_added");
        });
      });
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

/**
 * A resolution sent as the lines that replace each conflict, in order, put
 * back into the file git left here: a lockfile conflict is a few lines, the
 * whole file is megabytes and does not fit in a dispatch. Null unless the
 * markers parse and there is exactly one replacement, of string lines, per
 * conflict; the result is then judged like any other resolution.
 */
export function rebuildConflictResolution(merged: string, hunks: unknown): string | null {
  const parsed = parseConflictMarkers(merged);
  if (parsed === null || !Array.isArray(hunks) || hunks.length !== parsed.hunks.length) return null;
  if (!hunks.every((hunk) => Array.isArray(hunk) && hunk.every((line) => typeof line === "string"))) return null;
  const lines: string[] = [...parsed.outside[0]];
  hunks.forEach((hunk: string[], index) => lines.push(...hunk, ...parsed.outside[index + 1]));
  return lines.join("\n");
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
