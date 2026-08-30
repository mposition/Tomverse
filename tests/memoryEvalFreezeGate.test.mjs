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
import { MEMORY_EVAL_SUCCESSOR_DATASET_FROZEN } from "../lib/memoryEvalSuccessorFixtures.ts";
import { MEMORY_EVAL_SUCC3_DATASET_FROZEN } from "../lib/memoryEvalSucc3Fixtures.ts";
import { MEMORY_EVAL_SUCC4_DATASET_FROZEN } from "../lib/memoryEvalSucc4Dataset.ts";
import { MEMORY_EVAL_SUCC5_DATASET_FROZEN } from "../lib/memoryEvalSucc5.ts";
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

test("the check fails the build only when a dataset that claims a freeze has a gap", () => {
    const result = run();
    // The asymmetry is the design: while a dataset is being authored the
    // script is a progress report, and a non-zero exit on a half-finished
    // dataset would take it out of CI on the day it starts being useful. It
    // turns into a gate the moment that dataset's frozen constant says the
    // conditions were met.
    //
    // Read per dataset rather than over the whole output, because there are
    // five now and they are not in the same state. A single
    // `stdout.includes("MISS")` would have made one dataset's progress report
    // fail the build for another dataset's freeze.
    //
    // The count is asserted rather than derived: a dataset whose section
    // stopped printing would otherwise be a dataset nobody checked, and the
    // output would look exactly as clean.
    const sections = result.stdout.split(/Freeze conditions for /).slice(1);
    assert.equal(sections.length, 5, result.stdout);
    for (const version of [
        "mem-eval-seed-11",
        "mem-eval-succ-2",
        "mem-eval-succ-3",
        "mem-eval-succ-4",
        "mem-eval-succ-5",
    ]) {
        assert.ok(
            sections.some((section) => section.startsWith(version)),
            `${version} printed no section`
        );
    }

    const frozenByVersion = {
        "mem-eval-seed-11": MEMORY_EVAL_DATASET_FROZEN,
        "mem-eval-succ-2": MEMORY_EVAL_SUCCESSOR_DATASET_FROZEN,
        "mem-eval-succ-3": MEMORY_EVAL_SUCC3_DATASET_FROZEN,
        "mem-eval-succ-4": MEMORY_EVAL_SUCC4_DATASET_FROZEN,
        "mem-eval-succ-5": MEMORY_EVAL_SUCC5_DATASET_FROZEN,
    };
    let shouldFail = false;
    for (const section of sections) {
        const version = section.split(/\s/)[0];
        const frozen = frozenByVersion[version];
        assert.notEqual(frozen, undefined, `unrecognised dataset ${version}`);
        // The script says which state it read; a section whose header
        // disagreed with the constant would mean the two had drifted.
        assert.match(
            section,
            frozen ? /\(currently frozen\)/ : /\(currently not frozen\)/,
            version
        );
        const missed = section.includes("MISS");
        if (frozen) {
            assert.equal(
                missed,
                false,
                `${version} is frozen, so every freeze condition must hold`
            );
        }
        if (frozen && missed) shouldFail = true;
    }
    assert.equal(result.status, shouldFail ? 1 : 0, result.stdout);
});
