/**
 * The freeze conditions are checked by CI, not by prose.
 *
 * `docs/ops/memory-extraction-eval-dataset.md` §7.2 makes freezing three
 * constant edits. What makes those edits legitimate is that same document's
 * freeze-condition list, which lived only
 * in a bulleted list until `scripts/check-memory-eval-freeze-conditions.mjs`.
 * A checker nobody runs is the same as no checker, so the wiring is pinned
 * here beside the behaviour.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
    MEMORY_EVAL_DATASET_FROZEN,
    MEMORY_EVAL_DATASET_VERSION,
} from "../lib/memoryExtractionEvalFixtures.ts";
import { CANDIDATE_BATCHES } from "../lib/memoryExtractionEvalCandidates/index.ts";

const SCRIPT = "scripts/check-memory-eval-freeze-conditions.mjs";

const run = () =>
    spawnSync(
        process.execPath,
        ["--import", "tsx", SCRIPT],
        { cwd: new URL("..", import.meta.url), encoding: "utf8" }
    );

test("the PR gate runs the freeze check", () => {
    const workflow = readFileSync(
        new URL("../.github/workflows/pr-fast-gate.yml", import.meta.url),
        "utf8"
    );
    assert.match(
        workflow,
        /npm run check:memory-eval-freeze/,
        "a freeze condition nothing runs is a sentence, not a gate"
    );
    const packageJson = JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8")
    );
    // A substring test, said as one. This was a regex built from `SCRIPT` with
    // `/` and `.` escaped, which is every metacharacter that path happens to
    // contain today and none of the ones a future path might -- a `+` or a `(`
    // in a renamed script would quietly change what the assertion matches, and
    // a backslash would make it a regex nobody wrote. The question here is only
    // whether the npm script names this file, and `includes` asks exactly that.
    const script = packageJson.scripts["check:memory-eval-freeze"] ?? "";
    assert.ok(
        script.includes(SCRIPT),
        `the npm script the workflow calls should reach ${SCRIPT}, got: ${script}`
    );
});

test("the check reports every freeze condition", () => {
    const result = run();
    // Every condition the freeze list names, in the output rather than folded into
    // a single pass/fail. A reader who cannot see which one is unmet has to
    // re-derive the list by hand, which is the work this replaced.
    for (const condition of [
        "cell floors",
        "no batch left unreviewed",
        "explicit adoption",
        "draft disagreement",
        "findDuplicateCases()",
        "초안 도구·모델·버전",
        "검수자 기록",
    ]) {
        assert.ok(
            result.stdout.includes(condition),
            `the report should name "${condition}"`
        );
    }
});

test("a successor batch does not block this dataset's freeze, and an ordinary one does", () => {
    // The interaction that broke the moment the first successor batch was
    // drafted: an unreviewed candidate blocks a freeze, but a successor batch
    // is not waiting to join this dataset -- it exists because this one is
    // finished and its scoring contract was superseded.
    //
    // The exemption is keyed on the batch declaring which version it replaces,
    // so a batch drafted FOR this dataset still blocks it.
    const stdout = run().stdout;
    assert.match(stdout, /no batch left unreviewed/);
    assert.match(
        stdout,
        /0 candidate batch\(es\)/,
        "no batch is pending for this dataset"
    );

    const successor = CANDIDATE_BATCHES.filter(
        (batch) => batch.successorTo === MEMORY_EVAL_DATASET_VERSION
    );
    const ordinary = CANDIDATE_BATCHES.filter(
        (batch) => batch.successorTo !== MEMORY_EVAL_DATASET_VERSION
    );
    assert.equal(
        ordinary.length,
        0,
        "a batch drafted for this dataset is still counted, and one is pending"
    );
    if (successor.length > 0) {
        assert.match(stdout, /for a successor version \(not counted\)/);
        // Named, not silent: a condition that quietly stops counting things
        // is a condition nobody can check.
        for (const batch of successor) {
            assert.equal(batch.successorTo, MEMORY_EVAL_DATASET_VERSION);
        }
    }
});

test("the check fails the build only when the constant claims a freeze", () => {
    const result = run();
    const missed = result.stdout.includes("MISS");
    // The asymmetry is the design: while the dataset is being authored the
    // script is a progress report, and a non-zero exit on a half-finished
    // dataset would take it out of CI on the day it starts being useful. It
    // turns into a gate the moment MEMORY_EVAL_DATASET_FROZEN says the
    // conditions were met.
    assert.equal(
        result.status,
        MEMORY_EVAL_DATASET_FROZEN && missed ? 1 : 0,
        result.stdout
    );
    if (MEMORY_EVAL_DATASET_FROZEN) {
        assert.equal(
            missed,
            false,
            "the shipped dataset is frozen, so every freeze condition must hold"
        );
    }
});
