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

test("the figures decide when they can, and a false flag does not overrule them", () => {
    // An earlier version of this test was called "the flag is preferred", which
    // is not what the code does and not what it should do: when the numbers are
    // present they decide, and a `false` flag beside numbers that say otherwise
    // loses. A `true` flag is agreed with rather than overridden, so the two
    // directions cannot cancel each other out.
    assert.deepEqual(
        manifestExceededSpendCeiling({
            mode: "live",
            exceededCostCeiling: false,
            accruedCostUsd: 7.1,
            runCeilingUsd: 7,
        }),
        { exceeded: true, source: "derived" }
    );
    assert.deepEqual(
        manifestExceededSpendCeiling({
            mode: "live",
            exceededCostCeiling: true,
            accruedCostUsd: 1,
            runCeilingUsd: 7,
        }),
        { exceeded: true, source: "flag" }
    );
    // Figures present and under: `derived`, not `unknown`. The first version
    // reported `derived` only when the derivation was true, so a bounded run
    // looked indistinguishable from an artifact that could say nothing — and a
    // caller failing closed on `unknown` discarded it.
    assert.deepEqual(
        manifestExceededSpendCeiling({
            mode: "live",
            accruedCostUsd: 6.9,
            runCeilingUsd: 7,
        }),
        { exceeded: false, source: "derived" }
    );
});

test("a figure can be finite and still not be a cost or a ceiling", () => {
    // `Number.isFinite` was the whole test, and it admits values that are not
    // what the field means. A run cannot spend a negative amount, so an
    // artifact saying it did is reporting something other than its spend; and a
    // zero ceiling is not a ceiling any live run was approved under.
    //
    // Reproduced before it was fixed: `accruedCostUsd: -1` beside
    // `runCeilingUsd: 7` and `exceededCostCeiling: false` came back Admissible
    // with exit 0.
    for (const [accruedCostUsd, ceilingUsd] of [
        [-1, 7],
        [-0.0001, 7],
        [1, 0],
        [1, -7],
    ]) {
        assert.equal(
            exceededSpendCeiling({ live: true, accruedCostUsd, ceilingUsd }),
            false,
            `${accruedCostUsd} vs ${ceilingUsd} answered instead of declining`
        );
        // And declining is not the same as answering: the manifest form has to
        // say `unknown`, and it must not let a `false` flag answer for figures
        // that are there and unusable.
        assert.deepEqual(
            manifestExceededSpendCeiling({
                mode: "live",
                accruedCostUsd,
                runCeilingUsd: ceilingUsd,
                exceededCostCeiling: false,
            }),
            { exceeded: false, source: "unknown" },
            `${accruedCostUsd} vs ${ceilingUsd} was answered by the flag`
        );
    }
    // Zero spend is real: a live run refused at admission, or aborted before
    // its first dispatch, reached no provider.
    assert.deepEqual(
        manifestExceededSpendCeiling({
            mode: "live",
            accruedCostUsd: 0,
            runCeilingUsd: 7,
        }),
        { exceeded: false, source: "derived" }
    );
});

test("a false flag never rescues, and a true flag can always condemn", () => {
    // The contract, pinned in both directions because the code and its
    // description disagreed about one corner of it: unusable figures beside
    // `exceededCostCeiling: true` returned `flag`, while the note above the
    // function said `unknown` regardless of the flag.
    //
    // Either behaviour discards the run, so what the choice decides is the
    // reason that ends up in the record — "it overspent" or "nobody can tell".
    // The `true` flag wins, because the harness wrote it from its own live
    // state and unusable figures make the derivation impossible without making
    // that statement false.
    for (const [accruedCostUsd, runCeilingUsd] of [
        [-1, 7],
        [1, 0],
        ["4.2", 7],
    ]) {
        assert.deepEqual(
            manifestExceededSpendCeiling({
                mode: "live",
                accruedCostUsd,
                runCeilingUsd,
                exceededCostCeiling: true,
            }),
            { exceeded: true, source: "flag" },
            `a true flag did not survive ${accruedCostUsd} vs ${runCeilingUsd}`
        );
        assert.deepEqual(
            manifestExceededSpendCeiling({
                mode: "live",
                accruedCostUsd,
                runCeilingUsd,
                exceededCostCeiling: false,
            }),
            { exceeded: false, source: "unknown" },
            `a false flag rescued ${accruedCostUsd} vs ${runCeilingUsd}`
        );
    }
    // And with figures that read fine, the same asymmetry: `true` is agreed
    // with, `false` is overruled by numbers that disagree.
    assert.deepEqual(
        manifestExceededSpendCeiling({
            mode: "live",
            accruedCostUsd: 1,
            runCeilingUsd: 7,
            exceededCostCeiling: true,
        }),
        { exceeded: true, source: "flag" }
    );
    assert.deepEqual(
        manifestExceededSpendCeiling({
            mode: "live",
            accruedCostUsd: 7.1,
            runCeilingUsd: 7,
            exceededCostCeiling: false,
        }),
        { exceeded: true, source: "derived" }
    );
});

test("a live run whose spend cannot be compared says so, and is not a pass", () => {
    // The hole this closes. `{ exceeded: false, source: "unknown" }` was read
    // by the checker as `.exceeded === false`, printed `OK`, and exited 0 — a
    // live run whose spend nobody could compare against its ceiling, presented
    // as one that stayed inside it.
    for (const manifest of [
        { mode: "live" },
        { mode: "live", accruedCostUsd: "7.5", runCeilingUsd: 7 },
        { mode: "live", accruedCostUsd: 7.5 },
        { mode: "live", runCeilingUsd: 7 },
        { mode: "live", accruedCostUsd: NaN, runCeilingUsd: 7 },
    ]) {
        assert.deepEqual(
            manifestExceededSpendCeiling(manifest),
            { exceeded: false, source: "unknown" },
            JSON.stringify(manifest)
        );
    }
    // A `false` flag is still an answer with nothing to compare: the harness
    // wrote it, and it says what that run did.
    assert.deepEqual(
        manifestExceededSpendCeiling({ mode: "live", exceededCostCeiling: false }),
        { exceeded: false, source: "flag" }
    );
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
    // And reads the source, not only the verdict. Reading `.exceeded` alone is
    // what let an uncomparable live run print OK.
    assert.match(
        source,
        /manifestExceededSpendCeiling\(m\)\.source === "unknown"/,
        "the checker no longer refuses a live run it cannot compare"
    );
    assert.match(source, /key: "spendComparableToCeiling"/);
});
