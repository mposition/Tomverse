import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * The branch that decides a run overspent, executed rather than read.
 *
 * `exceededCostCeiling` was added to the harness and to the admissibility
 * checker on the same day, and neither side had a test that ran the producing
 * branch: the checker's truth table was extended with the field, which proves a
 * checker reads it, and nothing proved the harness ever sets it. A flag that is
 * only ever false is indistinguishable from a flag that is never computed.
 *
 * The harness is a 1,100-line script that reaches a provider, so the decision
 * is lifted out here as the expression it is and evaluated over the states a
 * run can end in. That is weaker than driving the script — it would not catch
 * the expression being deleted from the script — so the second test asserts the
 * script still contains it, which is the part reading can establish and
 * execution cannot.
 */

/**
 * The two facts about a spend ceiling, as the harness computes them.
 *
 * `costStopped` is set inside the loop, before dispatching a case, when the
 * accrued figure has already reached the ceiling. `ceilingExceeded` is computed
 * after the loop, because cost is added when a response returns and the last
 * call of a run is therefore never compared before it is spent.
 */
const ceilingState = ({ mode, accruedCostUsd, ceilingUsd, costStopped }) => {
    const ceilingExceeded = mode === "live" && accruedCostUsd > ceilingUsd;
    return {
        costStopped,
        ceilingExceeded,
        decisionGrade: mode === "live" && !costStopped && !ceilingExceeded,
    };
};

test("a run that finishes over its ceiling is refused", () => {
    // The case the pre-dispatch comparison cannot see: the last response
    // carries the run past the ceiling, the loop ends because the sample ended,
    // and nothing has compared anything since.
    const state = ceilingState({
        mode: "live",
        accruedCostUsd: 7.0001,
        ceilingUsd: 7,
        costStopped: false,
    });
    assert.equal(state.ceilingExceeded, true);
    assert.equal(state.costStopped, false, "it was not stopped — it ran to the end");
    assert.equal(state.decisionGrade, false);
});

test("the two ceiling facts are separate, and each refuses on its own", () => {
    const stopped = ceilingState({
        mode: "live",
        accruedCostUsd: 7,
        ceilingUsd: 7,
        costStopped: true,
    });
    assert.equal(stopped.costStopped, true);
    assert.equal(stopped.decisionGrade, false);

    // Exactly at the ceiling having finished is not an overrun: the comparison
    // is `>`, and a run that spent its budget to the cent spent what was
    // approved.
    const exact = ceilingState({
        mode: "live",
        accruedCostUsd: 7,
        ceilingUsd: 7,
        costStopped: false,
    });
    assert.equal(exact.ceilingExceeded, false);
    assert.equal(exact.decisionGrade, true);

    const under = ceilingState({
        mode: "live",
        accruedCostUsd: 4.2,
        ceilingUsd: 7,
        costStopped: false,
    });
    assert.equal(under.ceilingExceeded, false);
    assert.equal(under.decisionGrade, true);
});

test("a smoke run is never over its ceiling", () => {
    // Nothing is spent, and `accruedCostUsd` stays at zero. Guarded because the
    // comparison would otherwise be reading a ceiling that does not apply.
    const state = ceilingState({
        mode: "smoke",
        accruedCostUsd: 99,
        ceilingUsd: 7,
        costStopped: false,
    });
    assert.equal(state.ceilingExceeded, false);
});

test("the harness still computes it, and still gates on it", () => {
    // What the extracted expression cannot establish. If the script stops
    // computing `ceilingExceeded`, or stops folding it into `decisionGrade`,
    // every assertion above keeps passing over an expression nothing uses.
    const source = readFileSync(
        new URL("../scripts/evalImportedMemoryExtraction.mjs", import.meta.url),
        "utf8"
    );
    assert.match(
        source,
        /const ceilingExceeded =\s*\n?\s*runMode\.mode === "live" && accruedCostUsd > runMode\.ceilingUsd;/,
        "the harness no longer computes the overrun after the loop"
    );
    assert.match(source, /!ceilingExceeded,/, "decisionGrade no longer reads it");
    assert.match(source, /exceededCostCeiling: ceilingExceeded,/, "the artifact no longer records it");
    assert.match(source, /OVER CEILING/, "the summary no longer reports it");
});
