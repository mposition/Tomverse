// Decides whether a conflicted back-merge of `main` into `develop` may be
// resolved by keeping `develop`, and reports why. Reads git; writes nothing.
//
//   node scripts/back-merge-ancestry.mjs [--ours <ref>] [--theirs <ref>]
//
// Exit 0 admitted, 1 refused, 2 could not decide. See
// scripts/back-merge-ancestry-core.mjs for the criterion and its limits, and
// .github/workflows/back-merge-main-to-develop.yml for the caller.
//
// This runs on a checkout with both refs fetched. It needs no credential.

import { execFileSync } from "node:child_process";

import { ancestryMergeDecision, describeDecision } from "./back-merge-ancestry-core.mjs";

const flag = (name) => {
    const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
    if (hit !== undefined) return hit.slice(`--${name}=`.length);
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? undefined : process.argv[index + 1];
};

const ours = flag("ours") ?? "origin/develop";
const theirs = flag("theirs") ?? "origin/main";

const git = (args) =>
    execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/** A blob as text, or null when the path is absent or is not text. */
const blob = (rev, path) => {
    try {
        const text = git(["show", `${rev}:${path}`]);
        // A NUL byte means this is not a file a line-set test may reason about.
        return text.includes("\0") ? null : text;
    } catch {
        return null;
    }
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
const treeEqualsDevelop = (() => {
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
        return false;
    }
})();

const decision = ancestryMergeDecision({ conflicts, treeEqualsDevelop });

console.log(`base:    ${base}`);
console.log(`ours:    ${ours} (${git(["rev-parse", "--short", ours]).trim()})`);
console.log(`theirs:  ${theirs} (${git(["rev-parse", "--short", theirs]).trim()})`);
console.log(`tree of the -X ours merge equals ${ours}'s tree: ${treeEqualsDevelop}`);
console.log("");
console.log(describeDecision(decision));

process.exit(decision.admitted ? 0 : 1);
