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
 * So this one edits a real case file, runs the real command, and asserts a
 * non-zero exit — then puts the file back. The edit is one string inside one
 * conversation, restored from bytes read before the test began, in a `finally`
 * so a failing assertion cannot leave the tree dirty.
 */

import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const REPO = path.resolve(import.meta.dirname, "..");
const TARGET = path.join(REPO, "lib/memoryEvalSucc6CompositionRepairs.ts");
const CHECK = path.join(REPO, "scripts/check-memory-eval-succ6.mjs");

const runCheck = () =>
    spawnSync(process.execPath, ["--import", "tsx", CHECK], {
        cwd: REPO,
        encoding: "utf8",
    });

test("the check command fails when a case in the frozen sample changes", () => {
    const original = readFileSync(TARGET, "utf8");
    // A message the fingerprint covers, in a case this module owns.
    const marker = "계기판에 타이어 공기압 경고등이 떴는데 지금 바로 정비소에 가야 하나요?";
    assert.ok(original.includes(marker), "the case this test edits has moved");

    const clean = runCheck();
    assert.equal(
        clean.status,
        0,
        `the check fails before this test touches anything:\n${clean.stdout}${clean.stderr}`
    );

    try {
        writeFileSync(TARGET, original.replace(marker, `${marker} (drift)`), "utf8");
        const dirty = runCheck();
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
    } finally {
        writeFileSync(TARGET, original, "utf8");
    }

    // And the tree is back exactly as it was, byte for byte.
    assert.equal(readFileSync(TARGET, "utf8"), original);
    assert.equal(runCheck().status, 0, "the restore did not restore");
});
