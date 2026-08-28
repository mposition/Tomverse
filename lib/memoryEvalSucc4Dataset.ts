/**
 * The canonical `succ-4` decision set.
 *
 * `.github/audits/memory-eval-gold-contract-2026-08-27.md` §12.10: 1,047
 * schema-3 relabellings plus 103 replacements, for 1,150 cases in the same
 * eight cells `succ-3` had.
 *
 * ## What is not here
 *
 * The 103 superseded originals, and nothing marks their absence inside a case.
 * They are excluded by construction -- `SUCC4_SUPERSEDED_CASE_IDS` is
 * subtracted before anything is assembled -- rather than carried with a flag,
 * because a flag is one careless loader away from being ignored, and a scorer
 * that reads a superseded case reports a number for a gold the contract has
 * already replaced.
 *
 * This module must not import `memoryEvalSucc4Regression`, and the regression
 * corpus must not import this. They hold different content for different
 * purposes and the only thing they share is the transition manifest, which
 * carries ids and reasons and no case content at all.
 * `tests/memoryEvalSucc4Dataset.test.mjs` walks the import graph and fails on
 * a path between them.
 *
 * ## Fail-closed at load
 *
 * `assembleCases()` refuses a gold with no reviewed anchor rather than
 * anchoring it on a proposal
 * (.github/audits/memory-eval-gold-contract-2026-08-27.md §12.11). A refusal here
 * is not a case to skip:
 * it means the review records and the fixtures disagree, and every count
 * downstream would be quietly wrong. So the module throws rather than
 * exporting a short dataset.
 */

import type { MemoryEvalCaseV3 } from "@/lib/memoryEvalDatasetSchemaV3";
import { MEMORY_EVAL_SUCC3_CASES } from "@/lib/memoryEvalSucc3Fixtures";
import { assembleCases } from "@/lib/memoryEvalSucc4Assembly";
import {
    SUCC4_SUPERSEDED_CASE_IDS,
    SUCC4_TRANSITIONS,
} from "@/lib/memoryEvalSucc4Transition";
import { SUCC4_TRANCHE_1 } from "@/lib/memoryEvalSucc4Replacements/tranche1";
import { SUCC4_TRANCHE_2 } from "@/lib/memoryEvalSucc4Replacements/tranche2";
import { SUCC4_TRANCHE_3 } from "@/lib/memoryEvalSucc4Replacements/tranche3";
import { SUCC4_TRANCHE_4 } from "@/lib/memoryEvalSucc4Replacements/tranche4";
import { SUCC4_TRANCHE_5 } from "@/lib/memoryEvalSucc4Replacements/tranche5";

export const MEMORY_EVAL_SUCC4_DATASET_VERSION = "mem-eval-succ-4";
export const MEMORY_EVAL_SUCC4_SUPERSEDES = "mem-eval-succ-3";

/**
 * Frozen, 2026-08-28.
 *
 * docs/ops/memory-extraction-eval-dataset.md §7.2 makes freezing a three-line
 * edit, and docs/ops/memory-extraction-eval-dataset.md §7.1 lists what
 * has to hold first. For a successor dataset the
 * docs/ops/memory-extraction-eval-dataset.md §7.1a terms apply
 * instead of the batch ones, and all nine of them hold:
 * `npm run check:memory-eval-freeze` reports them, and it now *fails the
 * build* rather than reporting progress, because this constant claims they
 * were met.
 *
 * The two that only a person could satisfy were satisfied by one:
 * docs/ops/memory-extraction-eval-succ4-adoption.md records @mposition
 * adopting all five replacement tranches on 2026-08-28, having reviewed them
 * in full. The transition manifest and the tranche report did not supply that
 * and could not -- they are provenance and review *results*, and adoption is a
 * person deciding.
 *
 * Unfreezing is not an edit to this line. Under
 * docs/ops/memory-extraction-eval-dataset.md §7.3 a sample or a gold
 * label changed after a result is seen needs a new `datasetVersion`, and the
 * old verdicts stop being citable.
 */
export const MEMORY_EVAL_SUCC4_DATASET_FROZEN = true;

/**
 * What a run may cite this for.
 *
 * `decision` since the freeze. The harness refuses `--live` against a dataset
 * that is not frozen; this says what a run against a frozen one is allowed to
 * be cited as, and the two move together because a frozen development sample
 * is a state nobody asked for.
 */
export const MEMORY_EVAL_SUCC4_DATASET_PURPOSE: "development" | "decision" =
    "decision";

/**
 * The replacements, in the order the manifest lists them.
 *
 * Ordered by the manifest rather than by tranche, so the dataset does not
 * carry the order the work happened in as if it meant something.
 */
const REPLACEMENTS_BY_ORIGINAL = new Map(
    [
        ...SUCC4_TRANCHE_1,
        ...SUCC4_TRANCHE_2,
        ...SUCC4_TRANCHE_3,
        ...SUCC4_TRANCHE_4,
        ...SUCC4_TRANCHE_5,
    ].map((entry) => [entry.originalId, entry.replacement])
);

const replacementCases: MemoryEvalCaseV3[] = SUCC4_TRANSITIONS.map(
    (transition) => {
        const replacement = REPLACEMENTS_BY_ORIGINAL.get(transition.originalId);
        if (!replacement) {
            throw new Error(
                `succ-4: the manifest names ${transition.originalId} and no tranche wrote its replacement`
            );
        }
        if (replacement.id !== transition.replacementId) {
            throw new Error(
                `succ-4: the manifest says ${transition.originalId} becomes ${transition.replacementId}, the tranche wrote ${replacement.id}`
            );
        }
        return replacement;
    }
);

const staying = MEMORY_EVAL_SUCC3_CASES.filter(
    (testCase) => !SUCC4_SUPERSEDED_CASE_IDS.has(testCase.id)
);

const { cases: relabelled, refusals } = assembleCases(staying);
if (refusals.length > 0) {
    throw new Error(
        `succ-4: ${refusals.length} case(s) could not be assembled; the review records and the fixtures disagree.\n` +
            refusals.slice(0, 10).join("\n")
    );
}

/** The relabelled `succ-3` cases that stay, without the replacements. */
export const MEMORY_EVAL_SUCC4_RELABELLED_CASES: readonly MemoryEvalCaseV3[] =
    relabelled;

/** The 103 replacements, without the relabellings. */
export const MEMORY_EVAL_SUCC4_REPLACEMENT_CASES: readonly MemoryEvalCaseV3[] =
    replacementCases;

/** The canonical decision set. */
export const MEMORY_EVAL_SUCC4_CASES: readonly MemoryEvalCaseV3[] = [
    ...relabelled,
    ...replacementCases,
];

/** Cases per cell, for the floor check. */
export function succ4CellCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const testCase of MEMORY_EVAL_SUCC4_CASES) {
        const cell = `${testCase.category}:${testCase.language}`;
        counts[cell] = (counts[cell] ?? 0) + 1;
    }
    return counts;
}
