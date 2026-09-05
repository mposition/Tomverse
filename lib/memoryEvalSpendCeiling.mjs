/**
 * Did a run spend more than its approved ceiling?
 *
 * One implementation, three callers: the harness computes it from live state
 * at the end of a run, the admissibility checker derives it from a finished
 * artifact, and the tests execute *this* rather than a copy.
 *
 * Each of those had gone wrong on its own. The harness compared spend against
 * the ceiling only before dispatching the next case, so the last call of a run
 * was never checked before it was spent. The checker then read the flag the
 * harness writes and nothing else, so an artifact written before that flag
 * existed — carrying the two numbers and no verdict — read as admissible. And
 * the first test of the branch reimplemented the comparison beside the script
 * and asserted against its own arithmetic, which is a test of the copy.
 *
 * ## Plain JavaScript, deliberately
 *
 * `scripts/check-memory-eval-run-admissibility.mjs` runs under bare `node`
 * with no loader: it is pointed at an artifact, sometimes on a machine that is
 * not this repository's development environment, and adding a TypeScript
 * dependency to it would make the check harder to run than the thing it
 * checks. So this module is `.mjs` and imports nothing.
 *
 * ## What it is not
 *
 * A guarantee. The comparison happens after a response has been paid for, so
 * it refuses the *citation* rather than the spend: where pricing resolves, the
 * overrun it permits is bounded by one call's cost, and where pricing fails
 * `spendCeilingReliable` goes false and that bound goes with it. Preventing
 * the spend would mean reserving the next call's cost before dispatch, which
 * is separate work.
 */

/**
 * @param {{
 *   live: boolean,
 *   accruedCostUsd: unknown,
 *   ceilingUsd: unknown,
 * }} input
 * @returns {boolean} true when the run is known to have gone over.
 */
export function exceededSpendCeiling(input) {
    // A smoke run spends nothing and has no ceiling to exceed; comparing
    // anyway would read a number that does not apply to it.
    if (!input.live) return false;
    const accrued = input.accruedCostUsd;
    const ceiling = input.ceilingUsd;
    // Unknown is not "no". A missing or non-finite figure on either side means
    // the question cannot be answered here, and answering it `false` is the
    // direction that lets an overrun through — so the caller is told nothing
    // rather than told it was fine. `spendCeilingReliable` is the field that
    // reports an unpriced run, and it is a separate rule.
    if (typeof accrued !== "number" || !Number.isFinite(accrued)) return false;
    if (typeof ceiling !== "number" || !Number.isFinite(ceiling)) return false;
    // Strictly greater: a run that spent its budget to the cent spent what was
    // approved.
    return accrued > ceiling;
}

/**
 * The same question asked of a finished artifact's manifest.
 *
 * Prefers the flag the harness wrote, and falls back to deriving it from the
 * two figures every artifact has carried since long before the flag existed.
 * That fallback is the whole point: `exceededCostCeiling` was added on
 * 2026-09-05, and every artifact from before it would otherwise present an
 * overrun as an ordinary run.
 *
 * @param {Record<string, unknown>} manifest
 * @returns {{ exceeded: boolean, source: "flag" | "derived" | "unknown" }}
 */
export function manifestExceededSpendCeiling(manifest) {
    if (manifest.exceededCostCeiling === true) {
        return { exceeded: true, source: "flag" };
    }
    const derived = exceededSpendCeiling({
        live: manifest.mode === "live",
        accruedCostUsd: manifest.accruedCostUsd,
        ceilingUsd: manifest.runCeilingUsd,
    });
    if (derived) return { exceeded: true, source: "derived" };
    // `false` from the flag is an answer; its absence is not, and saying which
    // is what lets a reader tell "this run did not overspend" from "this
    // artifact cannot say".
    return {
        exceeded: false,
        source: manifest.exceededCostCeiling === false ? "flag" : "unknown",
    };
}
