/**
 * The decision-grade run workflow spends money, so its guards are pinned.
 *
 * docs/ops/memory-extraction-decision-grade-run.md §2.5 explains why the run
 * belongs in CI rather than on a machine. That only holds while the workflow
 * keeps the four properties below; each one has already been the difference
 * between a citable run and a wasted budget somewhere in this programme.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
    new URL("../.github/workflows/memory-eval-decision-grade.yml", import.meta.url),
    "utf8"
);

test("it runs only on manual dispatch", () => {
    // A push trigger would spend the eval budget on every commit.
    const triggers = workflow.slice(
        workflow.indexOf("\non:"),
        workflow.indexOf("\npermissions:")
    );
    assert.match(triggers, /workflow_dispatch:/);
    for (const forbidden of ["push:", "pull_request:", "schedule:"]) {
        assert.ok(
            !triggers.includes(forbidden),
            `${forbidden} would spend the budget without anyone asking`
        );
    }
});

test("a dispatch has to be confirmed in words", () => {
    assert.match(workflow, /inputs\.confirm != 'SPEND'/);
    assert.match(workflow, /exit 1/);
});

test("the artifact is preserved even when a later step fails", () => {
    // A run that paid for 1,150 calls must not lose its records because the
    // admissibility check exited non-zero -- the records are what a re-reading
    // and the register entry are built from.
    const upload = workflow.indexOf("Preserve the artifact");
    const admissibility = workflow.indexOf("name: Admissibility");
    assert.ok(upload > 0 && admissibility > upload, "upload must come first");
    assert.match(
        workflow.slice(upload, admissibility),
        /if: always\(\)/,
        "the upload must not be skipped by an earlier failure"
    );
});

test("two runs cannot overlap, and neither is cancelled", () => {
    assert.match(workflow, /group: memory-eval-decision-grade/);
    // Cancelling mid-run abandons calls already paid for.
    assert.match(workflow, /cancel-in-progress: false/);
});

test("the free refusals run before the paid ones", () => {
    const preconditions = workflow.indexOf("name: Preconditions");
    const live = workflow.indexOf("name: Live run (this is the step that spends)");
    assert.ok(preconditions > 0 && live > preconditions);
    assert.match(
        workflow.slice(preconditions, live),
        /check:memory-eval-freeze/,
        "everything that can refuse for free should refuse before the key is used"
    );
});
