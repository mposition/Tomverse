/**
 * Does `npm run check:memory-eval-succ6` actually fail when a case changes?
 *
 * Every other test drives `verifySucc6Manifest()` directly with arguments it
 * chooses. That proves the function can report drift; it does not prove the
 * command an operator runs will. The two came apart once: the record side
 * defaulted to `buildSucc6Manifest()`, the check script called it with no
 * argument, and the result was a clean bill over a comparison of the tree with
 * itself. A unit test on the function would not have caught it, because the
 * unit tests all passed a manifest in.
 *
 * So this one edits a case file, runs the real command, and asserts a non-zero
 * exit.
 *
 * ## The edit happens in a copy, and that is the whole of this note
 *
 * The first version edited the file **in the working tree** and restored it in
 * a `finally`. Byte-for-byte correct, and wrong anyway: the unit suite runs its
 * files concurrently, so for as long as that window was open every other
 * process that loaded `memoryEvalSucc6CompositionRepairs.ts` read a case with
 * `(drift)` appended to it.
 *
 * That is not hypothetical. It cost most of 2026-09-05. Runs of the whole suite
 * reported `mem-eval-succ-6`, `-7`, `-8` and `-9` all computing dataset digests
 * their manifests never recorded — succ-4 and succ-5 unaffected, because they
 * sit upstream of this module — with the *same* wrong digest every time, since
 * the mutation is always the same string. I read "stable wrong value" as a
 * stale transpile cache, wrote that into a comment as a diagnosis, and was
 * wrong: clearing the cache changed the timing, which changed which test
 * happened to overlap the window, which is why cold runs looked clean and warm
 * ones did not.
 *
 * `succ-7`'s sheet tests had already solved this — copy the tree, link
 * `node_modules`, edit the copy — and this now uses the same sandbox. A test
 * that mutates the working tree is a test that lies to every other test in the
 * run, and no `finally` narrows that window to zero.
 */

import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { tmpdir } from "node:os";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const REPO = path.resolve(import.meta.dirname, "..");
const TARGET = "lib/memoryEvalSucc6CompositionRepairs.ts";

/**
 * A copy of the tree this test may edit.
 *
 * The same shape as `memoryEvalSucc7Adoption`'s, including the reason for the
 * junction: a plain directory symlink needs privileges this repository's
 * development machine does not run with, and the first version of that helper
 * threw EPERM on Windows while staying green on Linux CI.
 */
const sandbox = () => {
    const root = mkdtempSync(path.join(tmpdir(), "succ6-drift-"));
    for (const entry of ["lib", "scripts", "tsconfig.json", "package.json"]) {
        cpSync(path.join(REPO, entry), path.join(root, entry), { recursive: true });
    }
    symlinkSync(
        path.join(REPO, "node_modules"),
        path.join(root, "node_modules"),
        process.platform === "win32" ? "junction" : "dir"
    );
    return root;
};

const runCheck = (root) =>
    spawnSync(process.execPath, ["--import", "tsx", "scripts/check-memory-eval-succ6.mjs"], {
        cwd: root,
        encoding: "utf8",
    });

test("the check command fails when a case in the frozen sample changes", (t) => {
    const root = sandbox();
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const target = path.join(root, TARGET);
    const original = readFileSync(target, "utf8");
    // A message the fingerprint covers, in a case this module owns.
    const marker = "계기판에 타이어 공기압 경고등이 떴는데 지금 바로 정비소에 가야 하나요?";
    assert.ok(original.includes(marker), "the case this test edits has moved");

    // Unpatched first. Without this half a refusal below is not evidence of
    // anything — the sandbox itself could be broken.
    const clean = runCheck(root);
    assert.equal(
        clean.status,
        0,
        `the check fails in an unedited sandbox:\n${clean.stdout}${clean.stderr}`
    );

    writeFileSync(target, original.replace(marker, `${marker} (drift)`), "utf8");
    const dirty = runCheck(root);
    assert.notEqual(
        dirty.status,
        0,
        "a changed case left the check reporting success — the frozen manifest " +
            "is not being compared against the tree"
    );
    assert.ok(
        /datasetDigest: recorded/.test(dirty.stdout + dirty.stderr),
        `the failure does not name the digest that moved:\n${dirty.stdout}${dirty.stderr}`
    );

    // The working tree was never a party to any of this.
    assert.equal(
        readFileSync(path.join(REPO, TARGET), "utf8").includes("(drift)"),
        false,
        "the edit reached the real tree"
    );
});
