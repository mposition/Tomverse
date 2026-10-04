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
 * `develop`. Keeping `develop` is admitted only when both hold:
 *
 *   * **`main`'s entire line sequence is a subsequence of `develop`'s.** Every
 *     line `main` has appears in `develop`, in `main`'s order, counting blank
 *     lines and counting duplicates separately. So nothing `main` added is
 *     absent and nothing was reordered away.
 *   * **Nothing `main` deleted is resurrected.** Where `main` kept fewer
 *     occurrences of a line than the base had, `develop` must not hold more than
 *     `main` kept.
 *
 * If either fails the answer is `refuse` and a person resolves it, exactly as
 * today.
 *
 * ## What this criterion does NOT prove
 *
 * It reasons about lines, not meaning. It cannot see that two differently
 * spelled lines express the same change, so it refuses a reformatting `develop`
 * applied to a line `main` also touched -- a false refusal, which costs a person
 * one merge and loses nothing.
 *
 * The caller must ALSO require that the resulting tree is byte-identical to
 * `develop`'s. That is not a second proof of the same thing: it only guarantees
 * no file changes, and review round 0 showed a case where that guard passed
 * while `main`'s edit was dropped. It is here so that an admitted merge can only
 * ever record ancestry, never write content.
 *
 * Everything is fail-closed: an unreadable side, a path the base does not have,
 * a binary file, or any doubt is `refuse`.
 */

const lines = (text) => text.split("\n");

/**
 * Is `inner` a subsequence of `outer` -- every line, in order, nothing dropped?
 *
 * This replaced a line-set comparison that ignored blank lines, order and
 * duplicate counts, and review round 0 produced the counterexample that killed
 * it: main inserts a blank line between A and B while develop inserts C there.
 * The two inserts conflict, the set test saw main as having added nothing
 * because the line was blank, and `-X ours` still yields develop's tree -- so
 * both guards passed while main's edit was dropped. Recording main as a parent
 * then tells git the edit is merged, and it never comes back.
 *
 * A subsequence test has no such hole: a blank line is a line, order is checked
 * because matching is left to right, and a duplicate must match an occurrence of
 * its own.
 */
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

/** The first line of `inner` that the left-to-right walk could not place. */
const firstUnplaced = (inner, outer) => {
    let i = 0;
    for (const line of outer) {
        if (i < inner.length && inner[i] === line) i += 1;
    }
    return inner[i];
};

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

    const baseLines = lines(base);
    const oursLines = lines(ours);
    const theirsLines = lines(theirs);

    // Every line main has, in main's order: nothing it added can be missing and
    // nothing can have been reordered away.
    if (!isSubsequence(theirsLines, oursLines)) {
        const unplaced = firstUnplaced(theirsLines, oursLines);
        return {
            path,
            admitted: false,
            reason:
                "main's lines are not a subsequence of develop's, so keeping develop would drop or reorder something main has",
            sample: [unplaced === undefined ? "(end of file)" : unplaced],
        };
    }

    // A deletion is the other direction, and needs counting rather than ordering:
    // if main removed some occurrences of a line, develop must not hold more than
    // main kept, or keeping develop resurrects what main deleted.
    const baseCount = counts(baseLines);
    const theirsCount = counts(theirsLines);
    const oursCount = counts(oursLines);
    for (const [line, before] of baseCount) {
        const kept = theirsCount.get(line) ?? 0;
        if (kept >= before) continue;
        const held = oursCount.get(line) ?? 0;
        if (held > kept) {
            return {
                path,
                admitted: false,
                reason: `main removed an occurrence of a line that develop still has ${held} of (main kept ${kept}), so keeping develop would resurrect it`,
                sample: [line],
            };
        }
    }

    return {
        path,
        admitted: true,
        reason: "every line main has appears in develop in main's order, and develop resurrects nothing main removed",
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
