/**
 * Near-duplicate report over memory-eval cases
 * (docs/ops/memory-extraction-eval-dataset.md §6.5).
 *
 * A thin CLI over lib/memoryEvalNearDuplicates.ts, which is where the scoring
 * and the reasoning behind it live. Advisory: it ranks where to look and
 * decides nothing — diversity is the reviewer's judgement.
 *
 * Usage:
 *   npm run report:memory-eval-near-duplicates -- [--top=N] [--candidates]
 *
 * Without `--candidates` it reads the adopted dataset (MEMORY_EVAL_CASES).
 * With it, the pending candidate batches too, which is what a batch under
 * review needs.
 */

import { MEMORY_EVAL_CASES } from "../lib/memoryExtractionEvalFixtures.ts";
import { CANDIDATE_BATCHES } from "../lib/memoryExtractionEvalCandidates/index.ts";
import { nearDuplicatePairs } from "../lib/memoryEvalNearDuplicates.ts";

const argValue = (name, fallback) => {
    const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
    return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const top = Number(argValue("top", "15"));
if (!Number.isFinite(top) || top <= 0) {
    console.error("--top must be a positive number.");
    process.exit(1);
}
const includeCandidates = process.argv.includes("--candidates");

const cases = includeCandidates
    ? [...MEMORY_EVAL_CASES, ...CANDIDATE_BATCHES.flatMap((batch) => batch.cases)]
    : [...MEMORY_EVAL_CASES];

const pairs = nearDuplicatePairs(cases);

console.log(
    `Near-duplicate report — ${cases.length} case(s), ${pairs.length} within-cell pair(s)` +
        `${includeCandidates ? ", candidates included" : ""}.`
);
console.log(
    "Advisory only: this ranks where to look. Diversity is the reviewer's judgement (section 6.5).\n"
);
console.log("  token  shape  cell                      pair");
for (const pair of pairs.slice(0, top)) {
    console.log(
        `  ${pair.token.toFixed(2)}   ${pair.shape.toFixed(2)}   ` +
            `${pair.cell.padEnd(24)}  ${pair.a} ~ ${pair.b}`
    );
}
if (pairs.length === 0) console.log("  (no pair shares a cell)");
