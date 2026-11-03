/**
 * What the CI auto-fix (.github/workflows/pr-ci-auto-fix.yml) may push to a
 * pull request. The model proposes a diff; this decides whether it is pushed.
 *
 * The auto-fix fixes CI on every pull request, with no exception (owner
 * 2026-11-03): any base, any branch, drafts too, and any file -- tests,
 * deletions, policy documents, scripts, package files and root config
 * included. A person still merges: the merge lane leaves Dependabot branches
 * and gate paths to the operator. Refused are only what a push cannot take
 * back or the dispatch cannot carry: a change to the workflows or actions
 * (they read the repository's secrets by name), a binary, an empty diff, a
 * fork's branch, and more than PR_CI_AUTO_FIX_MAX_ATTEMPTS tries of a kind.
 * Pure: the caller passes `git diff --name-status` and `--numstat` output.
 */

export const PR_CI_AUTO_FIX_MAX_ATTEMPTS = 2;
export const PR_CI_AUTO_FIX_COMMIT_PREFIX = "auto-fix(ci): ";
/**
 * A conflict with the pull request's base resolved by the auto-fix (owner
 * 2026-10-27): a merge commit of the base into the branch. Off unless the
 * repository variable PR_AUTO_FIX_CONFLICTS_ENABLED is "true".
 */
export const PR_CI_AUTO_FIX_CONFLICT_PREFIX = "auto-fix(conflict): ";
const CONFLICT_MARKER = /^(<{7}|>{7})( |$)|^={7}$|^\|{7}( |$)/m;

/** The workflows and actions: what CI runs with the repository's secrets. */
export const PR_CI_AUTO_FIX_SECRET_PATH = /^\.github\/(workflows|actions)\//;

export type PrCiAutoFixVerdict = { push: true } | { push: false; reasons: string[] };

export function judgePrCiAutoFixDiff(input: { nameStatus: string; numstat: string }): PrCiAutoFixVerdict {
  const reasons = new Set<string>();
  let changed = 0;
  for (const line of input.nameStatus.split("\n").filter((l) => l.trim() !== "")) {
    const [, ...paths] = line.split("\t");
    changed += 1;
    // A rename names both sides; either one in the workflows refuses it.
    if (paths.some((path) => PR_CI_AUTO_FIX_SECRET_PATH.test(path))) reasons.add("gate_path");
  }
  if (changed === 0) reasons.add("no_change");
  for (const line of input.numstat.split("\n").filter((l) => l.trim() !== "")) {
    const [added, removed] = line.split("\t");
    // Binary files report "-": refused, a model has no business writing them.
    if (added === "-" || removed === "-") reasons.add("binary");
  }
  return reasons.size === 0 ? { push: true } : { push: false, reasons: [...reasons].sort() };
}

/** Whether a pull request's branch can take the auto-fix's push, and still has attempts left. */
export function judgePrCiAutoFixTarget(input: {
  sameRepository: boolean;
  commitMessages: readonly string[];
  /** The number of commits GitHub says the pull request has; the attempt count is only trusted when every one was read. */
  commitCount: number;
  /** A failed CI (the default) or a conflict with the base. */
  kind?: "ci" | "conflict";
}): PrCiAutoFixVerdict {
  const reasons: string[] = [];
  if (!input.sameRepository) reasons.push("fork");
  if (!Number.isInteger(input.commitCount) || input.commitMessages.length !== input.commitCount) reasons.push("commits_incomplete");
  const prefix = input.kind === "conflict" ? PR_CI_AUTO_FIX_CONFLICT_PREFIX : PR_CI_AUTO_FIX_COMMIT_PREFIX;
  const attempts = input.commitMessages.filter((m) => m.startsWith(prefix)).length;
  if (attempts >= PR_CI_AUTO_FIX_MAX_ATTEMPTS) reasons.push("attempts_exhausted");
  return reasons.length === 0 ? { push: true } : { push: false, reasons };
}

/** One conflicted file as git left it: the text outside its conflicts, and each conflict's sides. */
type MergedFile = { outside: string[][]; hunks: { sides: string[] }[] };

/**
 * Splits a file git left with conflict markers into the text outside the
 * conflicts (one more piece than there are conflicts) and each conflict's
 * lines (the branch's, the base's and, in diff3 style, the merge base's). Null
 * when the markers do not nest as git writes them.
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
  // Joined without spreading a piece into a call: a lockfile's is past the argument limit.
  const pieces: string[][] = [parsed.outside[0]];
  hunks.forEach((hunk: string[], index) => pieces.push(hunk, parsed.outside[index + 1]));
  return pieces.flat().join("\n");
}

// Exact, whitespace included: a trailing space can carry meaning (a shell
// line continuation, a multi-line string).
const startsAt = (lines: string[], at: number, piece: string[]) =>
  at + piece.length <= lines.length && piece.every((line, index) => lines[at + index] === line);

/**
 * Whether a resolution of a conflict with the base may be committed. The
 * workflow has merged the base itself; `files` is every conflicted path with
 * the text git left in it (`merged`, with its markers), whether both sides
 * are regular files (`regular`), and the proposed content (`resolved`), and
 * `proposed` every path the resolution names.
 *
 * The resolution must keep everything git merged outside the conflicts, in
 * order and unchanged: only the conflicts themselves are replaced. Inside a
 * conflict a workflow or action may take only its sides' lines.
 * Refused as well: a resolution for any path that is not conflicted, or none
 * for one that is; a conflict a side deleted, or a side that is not a regular
 * file; markers git did not write; a marker or a NUL byte left.
 */
export function judgePrCiAutoFixConflict(input: {
  files: readonly { path: string; regular: boolean; merged: string | null; resolved: string | null }[];
  proposed: readonly string[];
}): PrCiAutoFixVerdict {
  const reasons = new Set<string>();
  const conflicted = new Set(input.files.map((file) => file.path));
  if (conflicted.size === 0) reasons.add("no_conflict");
  for (const path of input.proposed) if (!conflicted.has(path)) reasons.add("not_conflicted");
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
    if (PR_CI_AUTO_FIX_SECRET_PATH.test(file.path) && added > 0) reasons.add("gate_path_new_line");
  }
  return reasons.size === 0 ? { push: true } : { push: false, reasons: [...reasons].sort() };
}
