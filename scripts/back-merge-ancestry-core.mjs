/**
 * When an automated back-merge may resolve a conflict by keeping `develop`.
 *
 * A selective release cherry-picks, so `main` and `develop` hold the released
 * content under different commits and share no commit for it. The back-merge
 * that records the ancestry then conflicts on files `develop` has moved on
 * from, and on 2026-10-03 that happened for all four selective releases of
 * the day: the workflow refused, correctly, and a person resolved it by hand
 * in #2023. Every one of those resolutions was the same -- keep `develop` --
 * and the merged tree was byte-identical to `develop`.
 *
 * This module decides when that resolution is provably safe. The operator
 * authorised automating it on 2026-10-03.
 *
 * ## The danger, stated plainly
 *
 * "Keep `develop`" is `-s ours` by another name, and `-s ours` can erase a fix
 * that only `main` has. A hotfix goes to `main` first; if the back-merge threw
 * `main`'s side away, the hotfix would vanish from every future release and
 * nothing would be red. So the question is never "which side looks newer" but
 * "does `develop` already carry everything `main` changed".
 *
 * ## The criterion
 *
 * For each conflicting path, compare three texts: the merge base, `main`, and
 * `develop`. Keeping `develop` is admitted only when, line by line:
 *
 *   * every line `main` ADDED relative to the base is present in `develop`; and
 *   * every line `main` REMOVED relative to the base is absent from `develop`.
 *
 * If both hold, `develop` already reflects `main`'s change to that file and
 * keeping `develop` drops nothing. If either fails, the answer is `refuse` and
 * a person resolves it, exactly as today.
 *
 * ## What this criterion does NOT prove
 *
 * It is a line-set test, not a semantic one. It ignores order, nesting and
 * duplicate counts: a line `main` moved and `develop` also has elsewhere passes,
 * and a line `main` added twice passes on one occurrence. It therefore admits
 * some merges a human might resolve differently -- which is why the caller must
 * also require that the resulting tree is byte-identical to `develop`'s. Under
 * that pairing the automation can only ever record ancestry; it can never write
 * content, so the worst case is an ancestry merge a person would have written
 * the same way.
 *
 * Everything here is fail-closed: an unreadable side, a path the base does not
 * have, a binary file, or any doubt is `refuse`.
 */

/** A line that carries information. Pure whitespace is not evidence either way. */
const meaningful = (line) => line.trim().length > 0;

const lineSet = (text) => new Set(text.split("\n").filter(meaningful));

/**
 * The verdict for one conflicting path.
 *
 * `base`, `ours` (develop) and `theirs` (main) are the three texts, or `null`
 * where the path is absent or could not be read as text.
 */
export const pathVerdict = ({ path, base, ours, theirs }) => {
    if (typeof path !== "string" || path.length === 0) {
        return { path, admitted: false, reason: "no path given" };
    }
    if (ours === null || ours === undefined) {
        return {
            path,
            admitted: false,
            reason: "develop does not have this path, so keeping develop would delete it",
        };
    }
    if (theirs === null || theirs === undefined) {
        return {
            path,
            admitted: false,
            reason: "main does not have this path -- main may have deleted it, and keeping develop would resurrect it",
        };
    }
    if (base === null || base === undefined) {
        return {
            path,
            admitted: false,
            reason: "the merge base does not have this path, so what main changed cannot be computed",
        };
    }

    const baseLines = lineSet(base);
    const oursLines = lineSet(ours);
    const theirsLines = lineSet(theirs);

    const addedByMain = [...theirsLines].filter((line) => !baseLines.has(line));
    const removedByMain = [...baseLines].filter((line) => !theirsLines.has(line));

    const missing = addedByMain.filter((line) => !oursLines.has(line));
    if (missing.length > 0) {
        return {
            path,
            admitted: false,
            reason: `main added ${missing.length} line(s) that develop does not have, so keeping develop would drop main's change`,
            sample: missing.slice(0, 3),
        };
    }

    const resurrected = removedByMain.filter((line) => oursLines.has(line));
    if (resurrected.length > 0) {
        return {
            path,
            admitted: false,
            reason: `main removed ${resurrected.length} line(s) that develop still has, so keeping develop would resurrect them`,
            sample: resurrected.slice(0, 3),
        };
    }

    return {
        path,
        admitted: true,
        reason: "develop carries every line main added and none main removed",
    };
};

/**
 * Whether the whole conflict set may be resolved by keeping `develop`.
 *
 * All or nothing: one path that cannot be admitted makes the merge a person's
 * job, because a half-automated resolution is the state nobody can review.
 */
export const ancestryMergeDecision = ({ conflicts, treeEqualsDevelop }) => {
    if (!Array.isArray(conflicts) || conflicts.length === 0) {
        return {
            admitted: false,
            reason: "no conflict set was given, so there is nothing to admit",
            paths: [],
        };
    }

    const paths = conflicts.map(pathVerdict);
    const refused = paths.filter((verdict) => !verdict.admitted);

    if (refused.length > 0) {
        return {
            admitted: false,
            reason: `${refused.length} of ${paths.length} path(s) cannot be resolved by keeping develop`,
            paths,
        };
    }

    // The caller computes this by resolving every conflict to develop's side and
    // comparing the result with develop's tree. Without it the line-set test
    // above would be the only guard, and it is not strong enough alone.
    if (treeEqualsDevelop !== true) {
        return {
            admitted: false,
            reason: "the resolved tree is not byte-identical to develop's, so this merge would write content rather than record ancestry",
            paths,
        };
    }

    return {
        admitted: true,
        reason: `every one of ${paths.length} path(s) is already carried by develop, and the resolved tree is develop's`,
        paths,
    };
};

/** The decision as text, for a job log a person reads after the fact. */
export const describeDecision = (decision) =>
    [
        decision.admitted
            ? `Ancestry merge admitted: ${decision.reason}.`
            : `Ancestry merge refused: ${decision.reason}.`,
        "",
        ...decision.paths.map(
            (verdict) =>
                `  ${verdict.admitted ? "ok     " : "refused"} ${verdict.path}\n    ${verdict.reason}` +
                (verdict.sample ? `\n    e.g. ${verdict.sample.map((l) => l.trim()).join(" | ")}` : "")
        ),
        "",
        decision.admitted
            ? "The merge records ancestry and changes no file. A person still merges nothing by hand."
            : "A person resolves this one: branch from origin/develop, merge origin/main, resolve, and merge the pull request WITH A MERGE COMMIT.",
    ].join("\n");
