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
 * Are these two figures a spend and a ceiling that can be compared?
 *
 * `Number.isFinite` was the whole test, and finite is not the same as
 * meaningful: `accruedCostUsd: -1` is finite, compares below any ceiling, and
 * is not a cost — a run cannot spend a negative amount, so an artifact saying
 * it did is reporting something other than what it spent. `runCeilingUsd: 0`
 * is finite too, and a zero ceiling is not a ceiling any live run was approved
 * under.
 *
 * Both are rejected as *uncomparable* rather than answered. The distinction
 * matters at the call site: a caller that fails closed on "cannot compare"
 * discards the run, which is right, while an answer of `false` would have said
 * the run stayed inside a budget nobody can read.
 *
 * Zero accrued is allowed. A live run that reached no provider — refused at
 * admission, aborted before its first dispatch — really did spend nothing.
 *
 * @param {unknown} accrued
 * @param {unknown} ceiling
 * @returns {boolean}
 */
function comparableSpend(accrued, ceiling) {
    if (typeof accrued !== "number" || !Number.isFinite(accrued)) return false;
    if (typeof ceiling !== "number" || !Number.isFinite(ceiling)) return false;
    if (accrued < 0) return false;
    if (ceiling <= 0) return false;
    return true;
}

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
    // Unknown is not "no". A figure that is missing, non-finite or outside the
    // range a cost and a ceiling can take means the question cannot be answered
    // here, and answering it `false` is the direction that lets an overrun
    // through — so the caller is told nothing rather than told it was fine.
    // `spendCeilingReliable` is the field that reports an unpriced run, and it
    // is a separate rule.
    if (!comparableSpend(input.accruedCostUsd, input.ceilingUsd)) return false;
    // Strictly greater: a run that spent its budget to the cent spent what was
    // approved.
    return input.accruedCostUsd > input.ceilingUsd;
}

/**
 * The same question asked of a finished artifact's manifest.
 *
 * ## Which source wins, and why it is not symmetric
 *
 * An earlier version of this note said the flag is preferred and the figures
 * are a fallback for artifacts written before the flag existed. That is not
 * what this does, and it should not be:
 *
 *   figures say over            → over, whatever the flag says
 *   figures say under, flag true → over — a `true` flag is agreed with
 *   figures say under, no flag   → under
 *   figures stated but unusable  → `unknown`, whatever the flag says
 *   no figures, flag present     → the flag
 *   no figures, no flag          → `unknown`
 *
 * The asymmetry is deliberate. An artifact whose own numbers say it went over
 * did go over; a `false` flag beside them is a claim the numbers contradict.
 * A `true` flag is agreed with rather than overridden, so the two directions
 * cannot cancel each other out. And a manifest that *states* figures which
 * cannot be a spend and a ceiling is not answered by a flag either — the flag
 * would be describing a comparison that cannot be reproduced.
 *
 * The fallback to figures is still what catches the artifacts that matter:
 * `exceededCostCeiling` was added on 2026-09-05, and every artifact this
 * project has produced predates it.
 *
 * `unknown` is a third answer, not a quiet `false`. A caller that fails closed
 * on it discards the run, which is right — nothing in such an artifact can say
 * whether the run stayed within its approval.
 *
 * @param {Record<string, unknown>} manifest
 * @returns {{ exceeded: boolean, source: "flag" | "derived" | "unknown" }}
 */
export function manifestExceededSpendCeiling(manifest) {
    const live = manifest.mode === "live";
    const accrued = manifest.accruedCostUsd;
    const ceiling = manifest.runCeilingUsd;
    // "Stated" and "comparable" are different questions, and conflating them
    // is how `accruedCostUsd: -1` beside `exceededCostCeiling: false` came back
    // admissible: the figures were stated, they were not comparable, and the
    // flag answered for them.
    const stated = accrued !== undefined || ceiling !== undefined;
    const comparable = live && comparableSpend(accrued, ceiling);

    if (comparable) {
        const exceeded = exceededSpendCeiling({
            live,
            accruedCostUsd: accrued,
            ceilingUsd: ceiling,
        });
        if (exceeded) return { exceeded: true, source: "derived" };
        if (manifest.exceededCostCeiling === true) {
            return { exceeded: true, source: "flag" };
        }
        return { exceeded: false, source: "derived" };
    }

    if (manifest.exceededCostCeiling === true) {
        return { exceeded: true, source: "flag" };
    }
    // Figures that are there and unusable are worse than figures that are
    // absent: something wrote them. `unknown` rather than the flag, so the
    // artifact is discarded instead of vouched for.
    if (live && stated) return { exceeded: false, source: "unknown" };
    // Nothing stated. A `false` flag is an answer here — the harness wrote it,
    // and it says what that run did.
    return {
        exceeded: false,
        source: manifest.exceededCostCeiling === false ? "flag" : "unknown",
    };
}
