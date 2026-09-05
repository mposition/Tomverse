import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
    exceededSpendCeiling,
    manifestExceededSpendCeiling,
} from "../lib/memoryEvalSpendCeiling.mjs";

/**
 * The decision that a run overspent, executed rather than reimplemented.
 *
 * The first version of this file defined its own `ceilingState()` beside the
 * script and asserted against that, which tests the copy: the production
 * expression could have been deleted, inverted or never reached and every
 * assertion would still have passed. So the comparison now lives in
 * `lib/memoryEvalSpendCeiling.mjs`, the harness and the admissibility checker
 * both call it, and this file calls the same function they do.
 *
 * What reading is still needed for is the wiring — that the harness folds the
 * result into `decisionGrade`, records it and prints it. A function can be
 * correct and unused, and the last test here is the one that would notice.
 */

/* ------------------------------------------------------- the decision -- */

test("a run that finishes over its ceiling is over it", () => {
    // The case the pre-dispatch comparison cannot see: the last response
    // carries the run past the ceiling, the loop ends because the sample
    // ended, and nothing has compared anything since.
    assert.equal(
        exceededSpendCeiling({ live: true, accruedCostUsd: 7.0001, ceilingUsd: 7 }),
        true
    );
});

test("spending the budget exactly is not overspending it", () => {
    // `>` rather than `>=`: a run that spent its budget to the cent spent what
    // was approved.
    assert.equal(
        exceededSpendCeiling({ live: true, accruedCostUsd: 7, ceilingUsd: 7 }),
        false
    );
    assert.equal(
        exceededSpendCeiling({ live: true, accruedCostUsd: 4.2, ceilingUsd: 7 }),
        false
    );
});

test("a smoke run has no ceiling to exceed", () => {
    // Nothing is spent and `accruedCostUsd` stays at zero, so comparing would
    // read a number that does not apply.
    assert.equal(
        exceededSpendCeiling({ live: false, accruedCostUsd: 99, ceilingUsd: 7 }),
        false
    );
});

test("a figure that is not a number answers false, and says nothing", () => {
    // Deliberate, and worth stating: `false` here means "this cannot be
    // decided", not "this run was fine". An unpriced run is reported by
    // `spendCeilingReliable`, which is its own rule — folding the two together
    // would either discard a sound run or pass an unbounded one as bounded.
    for (const accruedCostUsd of [undefined, null, NaN, Infinity, "7.5"]) {
        assert.equal(
            exceededSpendCeiling({ live: true, accruedCostUsd, ceilingUsd: 7 }),
            false
        );
    }
    for (const ceilingUsd of [undefined, null, NaN, "7"]) {
        assert.equal(
            exceededSpendCeiling({ live: true, accruedCostUsd: 99, ceilingUsd }),
            false
        );
    }
});

/* ------------------------------------------- the same question of an artifact -- */

test("an artifact from before the flag existed is still caught", () => {
    // The bypass this fallback closes. `exceededCostCeiling` was added on
    // 2026-09-05; every artifact this project has produced predates it, and
    // reading the flag alone let one carrying `accruedCostUsd: 7.0001` beside
    // `runCeilingUsd: 7` pass as an ordinary run.
    const legacy = {
        mode: "live",
        accruedCostUsd: 7.0001,
        runCeilingUsd: 7,
        decisionGrade: true,
    };
    assert.deepEqual(manifestExceededSpendCeiling(legacy), {
        exceeded: true,
        source: "derived",
    });
});

test("the flag is preferred, and its absence is not an answer", () => {
    assert.deepEqual(
        manifestExceededSpendCeiling({
            mode: "live",
            exceededCostCeiling: true,
            accruedCostUsd: 1,
            runCeilingUsd: 7,
        }),
        { exceeded: true, source: "flag" }
    );
    assert.deepEqual(
        manifestExceededSpendCeiling({
            mode: "live",
            exceededCostCeiling: false,
            accruedCostUsd: 1,
            runCeilingUsd: 7,
        }),
        { exceeded: false, source: "flag" }
    );
    // No flag and nothing to derive from: `unknown`, so a reader can tell "did
    // not overspend" from "cannot say".
    assert.deepEqual(manifestExceededSpendCeiling({ mode: "live" }), {
        exceeded: false,
        source: "unknown",
    });
});

/* ----------------------------------------------------------- the wiring -- */

test("the harness computes it with this function and gates on the result", () => {
    // What executing the function cannot establish. If the script stops calling
    // it, or stops folding the answer into `decisionGrade`, every assertion
    // above keeps passing over a function nothing uses.
    const source = readFileSync(
        new URL("../scripts/evalImportedMemoryExtraction.mjs", import.meta.url),
        "utf8"
    );
    assert.match(
        source,
        /import \{ exceededSpendCeiling \} from "\.\.\/lib\/memoryEvalSpendCeiling\.mjs";/,
        "the harness no longer shares the decision"
    );
    assert.match(
        source,
        /const ceilingExceeded = exceededSpendCeiling\(\{/,
        "the harness computes the overrun some other way"
    );
    assert.match(source, /!ceilingExceeded,/, "decisionGrade no longer reads it");
    assert.match(
        source,
        /exceededCostCeiling: ceilingExceeded,/,
        "the artifact no longer records it"
    );
    assert.match(source, /OVER CEILING/, "the summary no longer reports it");
});

test("the admissibility checker asks the same function", () => {
    const source = readFileSync(
        new URL("../scripts/check-memory-eval-run-admissibility.mjs", import.meta.url),
        "utf8"
    );
    assert.match(
        source,
        /import \{ manifestExceededSpendCeiling \} from "\.\.\/lib\/memoryEvalSpendCeiling\.mjs";/
    );
    assert.match(source, /fails: \(m\) => manifestExceededSpendCeiling\(m\)\.exceeded,/);
});
