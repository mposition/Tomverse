/**
 * The 103 superseded cases, kept as history rather than as a decision set.
 *
 * `.github/audits/memory-eval-gold-contract-2026-08-27.md` §12.2: a gold whose
 * match target or evidence anchor changed is not left in the decision set. It
 * is preserved here with the correction recorded beside it, the provenance
 * says why it moved and under which rule, and the decision set takes a 1:1
 * replacement.
 *
 * ## This module is not importable from the decision set
 *
 * `memoryEvalSucc4Dataset` must never reach this file, directly or through
 * anything it imports. The two share only the transition manifest, which
 * carries ids and reasons and no case content.
 * `tests/memoryEvalSucc4Dataset.test.mjs` walks the import graph both ways and
 * fails on a path between them. That check is the whole reason the superseded
 * cases are not simply flagged inside `succ-4`: a flag has to be honoured by
 * every reader, and an import boundary has to be honoured by none of them.
 *
 * ## What "in corrected form" means here
 *
 * Eleven of the 103 had something about the gold changed -- nine by a reading
 * (`readings.ts`) and two in a batch. For those, `corrections` holds the
 * reading as written: the polarity assigned, the fact values kept, and the
 * anchor moved to, each with the note that says why. The case content itself
 * is preserved as it stood in `succ-3`, unaltered, because a record that
 * silently rewrote what it is a record of would answer no question anyone
 * brings to it. Both halves are here; neither is inferred from the other.
 *
 * The remaining 92 were not corrected. They moved because a contract rule was
 * formed while they were in front of a reviewer
 * (.github/audits/memory-eval-gold-contract-2026-08-27.md §12.1), which changes
 * nothing about the case and everything about whether it can score the rule.
 */

import type { MemoryEvalCaseV2 } from "@/lib/memoryEvalDatasetSchema";
import { MEMORY_EVAL_SUCC3_CASES } from "@/lib/memoryEvalSucc3Fixtures";
import { SUCC4_B_PLUS_MOVES } from "@/lib/memoryEvalSucc4Review/bPlusMoves";
import {
    SUCC4_READINGS,
    type Succ4GoldReading,
} from "@/lib/memoryEvalSucc4Review/readings";
import {
    SUCC4_TRANSITIONS,
    type Succ4Transition,
} from "@/lib/memoryEvalSucc4Transition";

/**
 * Supersessions that predate this manifest.
 *
 * `succ-durable-en-316` was itself written to replace `succ-durable-en-57` in
 * the `succ-2` -> `succ-3` step, so its history runs en-57 -> en-316 -> its
 * `succ-4` replacement. That earlier step is not a `succ-4` transition and is
 * not a field of one; it is a separate recorded fact, and rule 5 of
 * .github/audits/memory-eval-gold-contract-2026-08-27.md §12.11 requires it be
 * carried rather than dropped when the chain is extended.
 *
 * It is written out because nothing in the fixtures holds it: `en-316` carries
 * no `sourceCaseId`, so the link exists only in the audit and in the move
 * record's own note.
 */
export const SUCC4_PRIOR_SUPERSESSIONS: readonly {
    superseded: string;
    supersededBy: string;
    auditRef: string;
}[] = [
    {
        superseded: "succ-durable-en-57",
        supersededBy: "succ-durable-en-316",
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.8",
    },
];

export type Succ4RegressionProvenance = {
    supersededBy: string;
    grounds: Succ4Transition["grounds"];
    /** Where the case was found, not why it moved. */
    foundAt: Succ4Transition["from"];
    /** The review record's own rule id, kept alongside the audit grounds. */
    ruleId: string;
    auditRef: string;
    /**
     * Oldest first, ending at the `succ-4` replacement.
     *
     * One entry longer than the pair for `succ-durable-en-316`, which had a
     * supersession of its own before this one.
     */
    chain: readonly string[];
    /** The move record's note, where the reviewer left one. */
    note?: string;
};

export type Succ4RegressionEntry = {
    /** The case exactly as `succ-3` held it. */
    supersededCase: MemoryEvalCaseV2;
    /** The readings that changed a gold of this case, if any. */
    corrections: readonly Succ4GoldReading[];
    provenance: Succ4RegressionProvenance;
};

const succ3ById = new Map(MEMORY_EVAL_SUCC3_CASES.map((c) => [c.id, c]));
const moveById = new Map(SUCC4_B_PLUS_MOVES.map((m) => [m.originalId, m]));
const priorBySuccessor = new Map(
    SUCC4_PRIOR_SUPERSESSIONS.map((row) => [row.supersededBy, row.superseded])
);

export const SUCC4_REGRESSION_CORPUS: readonly Succ4RegressionEntry[] =
    SUCC4_TRANSITIONS.map((transition) => {
        const supersededCase = succ3ById.get(transition.originalId);
        if (!supersededCase) {
            throw new Error(
                `succ-4 regression: ${transition.originalId} is not a succ-3 case`
            );
        }
        const move = moveById.get(transition.originalId);
        if (!move) {
            throw new Error(
                `succ-4 regression: ${transition.originalId} has no move record`
            );
        }
        const prior = priorBySuccessor.get(transition.originalId);
        return {
            supersededCase,
            corrections: SUCC4_READINGS.filter(
                (reading) => reading.caseId === transition.originalId
            ),
            provenance: {
                supersededBy: transition.replacementId,
                grounds: transition.grounds,
                foundAt: transition.from,
                ruleId: move.ruleId,
                auditRef: transition.auditRef,
                chain: [
                    ...(prior ? [prior] : []),
                    transition.originalId,
                    transition.replacementId,
                ],
                ...(move.note ? { note: move.note } : {}),
            },
        };
    });

/** The regression entry for one superseded id, or `undefined`. */
export function succ4RegressionEntryFor(
    originalId: string
): Succ4RegressionEntry | undefined {
    return SUCC4_REGRESSION_CORPUS.find(
        (entry) => entry.supersededCase.id === originalId
    );
}
