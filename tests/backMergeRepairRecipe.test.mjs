import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const WORKFLOW = ".github/workflows/back-merge-main-to-develop.yml";

/**
 * The commands the "Report what diverged" step prints for a person to paste.
 *
 * Nothing held this text before 2026-10-13. It is pasted into a shell during an
 * incident, so a wrong verb here is not a documentation slip -- it runs.
 */
const recipeLines = () =>
    readFileSync(WORKFLOW, "utf8")
        .split("\n")
        .filter((line) => /^\s*echo "(git|npm run report:back-merge|#)/.test(line))
        .map((line) => line.replace(/^\s*echo "/, "").replace(/"$/, ""));

test("the repair creates the branch with a verb that refuses rather than overwrites", () => {
    const lines = recipeLines();
    const text = lines.join("\n");

    // `git checkout -B` force-moves an existing branch, and in this clone the
    // name is predictable -- `claude/back-merge-main-<short>` -- so another
    // session working the same release may already hold it. On 2026-10-13 one
    // did: the printed `-B` command failed because another worktree had the
    // branch, and the merge that followed ran on whatever branch was already
    // checked out, against a stale base. `switch -c` refuses instead, and the
    // refusal is the answer the operator wants.
    assert.match(text, /git switch -c claude\/back-merge-main-/);
    assert.doesNotMatch(text, /git checkout -B claude\/back-merge-main-/);
    assert.doesNotMatch(text, /git checkout -b claude\/back-merge-main-/);

    // The refusal has to say what it means, or it reads as a broken recipe.
    assert.match(
        readFileSync(WORKFLOW, "utf8"),
        /refuses if that branch already exists/,
        "the recipe must say that a refusal means someone may have done this already"
    );
});

test("the branch is created before the merge, not after", () => {
    const lines = recipeLines();
    const branchAt = lines.findIndex((line) => line.startsWith("git switch -c"));
    const mergeAt = lines.findIndex((line) => line.startsWith("git merge --no-ff"));

    assert.ok(branchAt !== -1, "the recipe names the branch command");
    assert.ok(mergeAt !== -1, "the recipe names the merge command");
    // Creating a branch while a merge is unresolved discards MERGE_HEAD, which
    // loses the merge the operator came to make.
    assert.ok(
        branchAt < mergeAt,
        "the branch must be created before the merge begins"
    );
});

test("the recipe stages before committing, and records ancestry", () => {
    const lines = recipeLines();
    const text = lines.join("\n");
    const addAt = lines.findIndex((line) => line.startsWith("git add -A"));
    const commitAt = lines.findIndex((line) => line.startsWith("git commit"));

    assert.ok(addAt !== -1 && commitAt !== -1, "the recipe stages and commits");
    // `git commit` refuses while the index holds unmerged entries, so omitting
    // this leaves the operator with a failed commit and a push of nothing.
    assert.ok(addAt < commitAt, "staging must come before the commit");

    // A squash records no ancestry, which is the one thing this merge exists for.
    assert.doesNotMatch(text, /--squash/);
    assert.doesNotMatch(text, /git rebase/);
    assert.match(text, /git merge --no-ff origin\/main/);
});

test("the undo block leaves the branch before deleting it", () => {
    const lines = recipeLines();
    const switchAway = lines.findIndex((line) => /^git switch develop$/.test(line));
    const deleteAt = lines.findIndex((line) => /^git branch -D /.test(line));

    assert.ok(switchAway !== -1, "the undo names the switch away");
    assert.ok(deleteAt !== -1, "the undo names the delete");
    // `git branch -D` refuses to delete the branch that is checked out, and the
    // operator finishes the repair standing on it.
    assert.ok(switchAway < deleteAt, "switch away before deleting the branch");
});

test("no printed line can run a command the step did not intend", () => {
    // Every recipe line is printed by `echo "..."` inside a bash step, where a
    // bare backtick opens command substitution. An earlier draft of this change
    // emitted one and would have run it at report time.
    const backtick = String.fromCharCode(96);
    const backslash = String.fromCharCode(92);

    for (const line of readFileSync(WORKFLOW, "utf8").split("\n")) {
        if (!/^\s*echo "/.test(line)) continue;
        let index = line.indexOf(backtick);
        while (index !== -1) {
            assert.equal(
                line[index - 1],
                backslash,
                `unescaped backtick in a double-quoted echo: ${line.trim()}`
            );
            index = line.indexOf(backtick, index + 1);
        }
    }
});
