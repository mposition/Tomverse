// Reports what diverged when a back-merge of `main` into `develop` conflicts.
// Reads git; writes nothing; grants nothing.
//
//   npm run report:back-merge-divergence
//   node scripts/report-back-merge-divergence.mjs --ours <ref> --theirs <ref>
//
// Exit 0 when it had something to report, 1 when the refs merge cleanly (the
// ordinary back-merge handles that), 2 when it could not tell.
//
// Resolving the conflict is a person's job, and
// scripts/back-merge-ancestry-core.mjs says why it is not automated. This runs
// on a checkout with both refs fetched and needs no credential.

import { execFileSync } from "node:child_process";

import {
    classifyUnavailable,
    describeDivergence,
    divergenceReport,
} from "./back-merge-ancestry-core.mjs";

const flag = (name) => {
    const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
    if (hit !== undefined) return hit.slice(`--${name}=`.length);
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? undefined : process.argv[index + 1];
};

const ours = flag("ours") ?? "origin/develop";
const theirs = flag("theirs") ?? "origin/main";

// A NUL byte means the blob is not text. Written as a code point rather than
// a literal control character, which check:encoding:strict refuses in source.
const NUL = String.fromCharCode(0);

/**
 * Runs git with its stderr captured rather than inherited.
 *
 * Several of the reads here are expected to fail -- `git show <base>:<path>`
 * for a path the base does not have is how `blob()` learns the path is new, and
 * `git merge-tree` exits non-zero on the very conflict this report exists to
 * describe. With stderr inherited, each of those printed a `fatal:` line into
 * the job log: on 2026-10-08 one run emitted ten of them above its own output.
 * The report's whole purpose is a log a person can read, so the noise was not
 * cosmetic.
 *
 * Nothing is lost by capturing. Every call that must not fail already catches
 * its own error and prints a sentence of its own, and a captured stderr is
 * still on the thrown error for a caller that wants it.
 */
const git = (args) =>
    execFileSync("git", args, {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
    });

/**
 * One side of a path: its text, or why there is none.
 *
 * The three reasons are kept apart. Collapsing them to null once made a binary
 * file present on both sides read as a path develop would delete.
 */
const blob = (rev, path) => {
    let text;
    try {
        text = git(["show", `${rev}:${path}`]);
    } catch {
        // git show fails for a path the revision lacks AND for a missing or
        // corrupt object, a bad ref, an unreadable repository. A tree lookup
        // settles which: absence is claimed only when the lookup SUCCEEDS and
        // finds no entry.
        let listed = false;
        let listFailed = false;
        try {
            listed = git(["ls-tree", "-r", "--name-only", rev, "--", path]).trim().length > 0;
        } catch {
            listFailed = true;
        }
        return { unavailable: classifyUnavailable({ listed, listFailed }) };
    }
    return text.includes(NUL) ? { unavailable: "binary" } : text;
};

let base;
try {
    base = git(["merge-base", ours, theirs]).trim();
} catch {
    console.error(`Could not find a merge base for ${ours} and ${theirs}. Fetch both first.`);
    process.exit(2);
}

/**
 * The conflicting paths, from git's own three-way merge rather than a guess.
 *
 * `merge-tree --write-tree --name-only` prints the tree, then one conflicting
 * path per line, then a blank line, then its own prose ("Auto-merging ...",
 * "CONFLICT (content): ..."). Reading past the blank line turns those sentences
 * into paths, and every blob read then fails.
 */
const conflictPathsFrom = (text) => {
    const [, ...rest] = text.split("\n");
    const paths = [];
    for (const line of rest) {
        if (line.trim().length === 0) break;
        paths.push(line.trim());
    }
    return paths;
};

let conflictPaths;
try {
    conflictPaths = conflictPathsFrom(
        git(["merge-tree", "--write-tree", "--name-only", ours, theirs])
    );
} catch (error) {
    // merge-tree exits non-zero on conflict and still prints the tree and paths.
    conflictPaths = conflictPathsFrom(`${error.stdout ?? ""}`);
    if (conflictPaths.length === 0) {
        console.error("git merge-tree failed and named no conflicting path.");
        process.exit(2);
    }
}

if (conflictPaths.length === 0) {
    console.log(
        `${theirs} merges into ${ours} with no conflict. The ordinary back-merge handles this; nothing to admit.`
    );
    process.exit(1);
}

const conflicts = conflictPaths.map((path) => ({
    path,
    base: blob(base, path),
    ours: blob(ours, path),
    theirs: blob(theirs, path),
}));

/**
 * Would resolving every conflict to develop's side leave develop's tree?
 *
 * Asked of git, not inferred: the non-conflicting half of the merge may still
 * bring content from main, and that content would make this a merge that writes
 * files rather than one that records ancestry.
 */
const treeWouldEqualDevelop = (() => {
    try {
        const merged = git([
            "merge-tree",
            "--write-tree",
            "-X",
            "ours",
            "--name-only",
            ours,
            theirs,
        ])
            .split("\n")[0]
            .trim();
        const develop = git(["rev-parse", `${ours}^{tree}`]).trim();
        return merged === develop;
    } catch {
        // Unknown, not false: a failed command is not evidence of a change.
        return null;
    }
})();

const report = divergenceReport({ conflicts, treeWouldEqualDevelop });

console.log(`base:    ${base}`);
console.log(`ours:    ${ours} (${git(["rev-parse", "--short", ours]).trim()})`);
console.log(`theirs:  ${theirs} (${git(["rev-parse", "--short", theirs]).trim()})`);
console.log(`tree of the -X ours merge equals ${ours}'s tree: ${treeWouldEqualDevelop ?? "could not be determined"}`);
console.log("");
console.log(describeDivergence(report));

process.exit(0);
