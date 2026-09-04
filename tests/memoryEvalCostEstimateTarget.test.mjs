/**
 * The cost estimate reports the dataset a run would actually use.
 *
 * `scripts/report-memory-eval-cost-estimate.mjs` measures prompt tokens over
 * "the adopted cases", and an operator reads its total before approving a
 * budget. If it measured one sample while the harness ran another, the number
 * would be an estimate for a run nobody was about to make — and the two came
 * that close to diverging on 2026-08-31, when the harness target moved from
 * `mem-eval-succ-5` to the frozen `mem-eval-succ-6`, and on to
 * `mem-eval-succ-8`.
 *
 * The script derives its target from `harnessTarget()` rather than naming a
 * dataset, so it followed the switch for free. This test is what stops that
 * from being an accident: it runs the real command and reads the real output,
 * because the property worth holding is what an operator sees, not which
 * module the script happens to import today.
 */

import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
    HARNESS_TARGET_DATASET_VERSION,
    harnessTarget,
} from "../lib/memoryEvalHarnessTarget.ts";
import { MEMORY_EXTRACTION_PROMPT_VERSION } from "../lib/memoryExtractionPrompt.ts";

const REPO = path.resolve(import.meta.dirname, "..");

const runEstimate = () =>
    execFileSync(
        process.execPath,
        [
            // The flag the package script carries. Dropping it makes
            // `server-only` throw, which is the transcription mistake
            // AGENTS.md records as having already happened once.
            "--conditions=react-server",
            "--import",
            "tsx",
            path.join(REPO, "scripts/report-memory-eval-cost-estimate.mjs"),
        ],
        { cwd: REPO, encoding: "utf8" }
    );

test("the estimate names mem-eval-succ-9 and the shipped pair", () => {
    const output = runEstimate();
    assert.match(output, /mem-eval-succ-9/);
    assert.match(
        output,
        new RegExp(`gpt-5-6-luna\\s*::\\s*${MEMORY_EXTRACTION_PROMPT_VERSION}`)
    );
    // The previous targets must not be what it measures. Asserted as an
    // absence because the failure this guards against is silent: an estimate
    // over an older sample is still a plausible-looking number.
    assert.doesNotMatch(output, /mem-eval-succ-5/);
    assert.doesNotMatch(output, /mem-eval-succ-6/);
    assert.doesNotMatch(output, /mem-eval-succ-7/);
    assert.doesNotMatch(output, /mem-eval-succ-8/);
});

test("the case count it measures is the target's, not a constant", () => {
    // 1,150 is the same in every target since succ-6. succ-8 inherits
    // succ-7's cases by reference, and succ-9 replaces five of succ-8's one
    // for one, so the count is identical by construction across all of them
    // and would not have caught a single switch. The dataset name beside it is
    // what does, and this asserts they appear together rather than each being
    // right on its own.
    const target = harnessTarget();
    const output = runEstimate();
    assert.match(
        output,
        new RegExp(
            `${target.cases.length} adopted case\\(s\\) of ${HARNESS_TARGET_DATASET_VERSION}`
        )
    );
    assert.equal(HARNESS_TARGET_DATASET_VERSION, "mem-eval-succ-9");
});

test("it stays an estimate, and says so", () => {
    // A number an operator reads before approving money must not read as a
    // quote. Kept here because this file is the one that runs the command.
    assert.match(runEstimate(), /NOT a quote/i);
});
