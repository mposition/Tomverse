/**
 * Diagnosing a conflicted back-merge of `main` into `develop`.
 *
 * A selective release cherry-picks, so `main` and `develop` hold the released
 * content under different commits and share no commit for it. The back-merge
 * that records the ancestry then conflicts on files `develop` has moved on
 * from. On 2026-10-03 that happened for all four selective releases of the day;
 * a person resolved the fourth by hand in #2023, and in every case the answer
 * was "keep develop" and the merged tree was byte-identical to `develop`.
 *
 * ## This module does not decide. It reports.
 *
 * Automating that resolution was authorised on 2026-10-03, attempted twice, and
 * **withdrawn on the evidence**. Two rounds of independent review each produced
 * a counterexample, and the second one cannot be fixed by refining a line
 * comparison. Both are pinned in `tests/backMergeAncestryCore.test.mjs` so the
 * reasoning is not lost and the attempt is not repeated from scratch.
 *
 * 1. **The blank line.** `main` inserts a blank line between A and B; `develop`
 *    inserts C there. The inserts conflict. A line-*set* criterion that filtered
 *    whitespace saw `main` as adding nothing, and the resolved tree still equals
 *    `develop`'s — so both guards passed while `main`'s edit was dropped. Fixed
 *    by comparing whole line sequences instead, blank lines included.
 * 2. **The commented-out `throw`.** `main` inserts a `throw` statement;
 *    `develop` inserts the same lines wrapped in a block comment. Now `main`'s
 *    lines genuinely *are* a subsequence of `develop`'s, nothing is deleted, and
 *    the tree is `develop`'s — every test passes, and `main`'s exception never
 *    executes. **No line-based criterion can see this**, because the lines are
 *    all present; only their execution context changed.
 *
 * The second counterexample is the end of the idea. Recording `main` as a parent
 * tells git the change is merged, so a dropped fix never returns and nothing
 * goes red — and the fixes that reach `main` first are hotfixes. The only
 * conflict an automation could resolve soundly is one git merges without
 * conflict, which the ordinary back-merge already handles.
 *
 * ## What is left, and why it is worth having
 *
 * Working out what diverged took reading four job logs and reproducing the merge
 * in a throwaway worktree. That is what this replaces: the job says which paths
 * conflict, what each side did to them, and whether the resolution would change
 * any file — so the person who resolves it starts from the answer instead of the
 * investigation. Nothing here authorises a push.
 */

const lines = (text) => text.split("\n");

/** Is `inner` a subsequence of `outer` — every line, in order, nothing dropped? */
const isSubsequence = (inner, outer) => {
    let i = 0;
    for (const line of outer) {
        if (i < inner.length && inner[i] === line) i += 1;
    }
    return i === inner.length;
};

/** How many times each line occurs. */
const counts = (list) => {
    const map = new Map();
    for (const line of list) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
};

/**
 * What the two sides did to one conflicting path.
 *
 * `base`, `ours` (develop) and `theirs` (main) are the three texts, or `null`
 * where the path is absent or is not text. Every field is an observation; none
 * of them is permission.
 */
export const pathDivergence = ({ path, base, ours, theirs }) => {
    if (typeof path !== "string" || path.length === 0) {
        return { path, note: "no path given" };
    }

    // A side is a string, or `{ unavailable }` saying why there is no text. The
    // three reasons read very differently and were collapsed to one once: a
    // binary file present on both sides was reported as a path develop would
    // delete. Only `absent` is a statement about the file existing.
    const why = (side) => (typeof side === "string" ? null : (side?.unavailable ?? "unreadable"));
    const explain = {
        absent: "does not have this path",
        binary: "has this path but it is not text, so a line comparison cannot say anything about it",
        unreadable: "could not be read, so nothing is claimed about it",
    };

    for (const [name, side] of [
        ["develop", ours],
        ["main", theirs],
        ["the merge base", base],
    ]) {
        const reason = why(side);
        if (reason === null) continue;
        const tail =
            reason === "absent" && name === "develop"
                ? "; keeping develop would delete it"
                : reason === "absent" && name === "main"
                  ? "; main may have deleted it, and keeping develop would resurrect it"
                  : reason === "absent"
                    ? ", so what main changed cannot be computed"
                    : "";
        return { path, undetermined: true, note: `${name} ${explain[reason]}${tail}` };
    }

    const baseLines = lines(base);
    const oursLines = lines(ours);
    const theirsLines = lines(theirs);

    const mainLinesPresent = isSubsequence(theirsLines, oursLines);

    const baseCount = counts(baseLines);
    const theirsCount = counts(theirsLines);
    const oursCount = counts(oursLines);
    let resurrects = null;
    for (const [line, before] of baseCount) {
        const kept = theirsCount.get(line) ?? 0;
        if (kept >= before) continue;
        if ((oursCount.get(line) ?? 0) > kept) {
            resurrects = line;
            break;
        }
    }

    return {
        path,
        mainLinesPresent,
        resurrects,
        note: !mainLinesPresent
            ? "develop does not contain main's lines in main's order, so keeping develop would visibly drop something main has"
            : resurrects !== null
              ? "develop still holds a line main removed, so keeping develop would resurrect it"
              : "develop contains main's lines in order and resurrects nothing — but see the module comment: that is not proof that main's change still takes effect",
    };
};

/**
 * The report for a whole conflict set.
 *
 * There is no `admitted` field, on purpose. A caller that wanted one would be
 * asking this module for permission to push, which is the thing two review
 * rounds refused.
 */
export const divergenceReport = ({ conflicts, treeWouldEqualDevelop }) => {
    const paths = (Array.isArray(conflicts) ? conflicts : []).map(pathDivergence);
    // Three states, not two. A git command that failed, or a structural conflict
    // `-X ours` does not resolve, leaves this unknown -- and "unknown" was being
    // printed as "files would change", which is a claim nobody had checked.
    const contentNeutral =
        treeWouldEqualDevelop === true ? true : treeWouldEqualDevelop === false ? false : null;
    return { paths, contentNeutral };
};

/** The report as text, for the job log a person reads before resolving. */
export const describeDivergence = (report) =>
    [
        `${report.paths.length} conflicting path(s). Resolving every one to develop's side ` +
            (report.contentNeutral === true
                ? "would change no file — the merge would record ancestry only."
                : report.contentNeutral === false
                  ? "would still change files, so it is not an ancestry-only merge."
                  : "may or may not change files: that comparison could not be made here."),
        "",
        ...report.paths.map((entry) => `  ${entry.path}\n    ${entry.note}`),
        "",
        "This is a diagnosis, not a go-ahead. Resolve it by hand: branch from",
        "origin/develop, merge origin/main, resolve, and merge the pull request",
        "WITH A MERGE COMMIT. A squash records no ancestry.",
        "",
        "Why this is not automated: scripts/back-merge-ancestry-core.mjs, and the",
        "two counterexamples in tests/backMergeAncestryCore.test.mjs.",
    ].join("\n");

/**
 * Which kind of "no text" a side is, from the tree lookup rather than from the
 * failure of `git show`.
 *
 * `git show` and `git cat-file -e` both fail for a path a revision does not have
 * AND for a missing or corrupt object, an unreadable repository, a bad ref. An
 * earlier version read every such failure as `absent`, which printed "keeping
 * develop would delete it" over what was really "this could not be read" --
 * a deletion risk asserted as fact.
 *
 * `listed` is whether a tree lookup found an entry for the path; `listFailed` is
 * whether the lookup itself failed. Absence is claimed only when the lookup
 * succeeded and found nothing.
 */
export const classifyUnavailable = ({ listed, listFailed }) => {
    if (listFailed === true) return "unreadable";
    return listed === true ? "unreadable" : "absent";
};
