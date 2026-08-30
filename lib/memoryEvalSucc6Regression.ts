/**
 * The ten cases `succ-6` moves out of the decision set, kept as history.
 *
 * ## Two halves, preserved differently
 *
 * Five of the ten had gold this decision found wrong
 * (.github/audits/memory-boundary-decision-2026-08-30.md §1.1, §3.2), and
 * their corrected labels are recorded here in `corrections`. Five had correct
 * gold and moved only because the rule was formed while a reviewer was reading
 * them; those carry no correction, because there was nothing to correct.
 *
 * The case content itself is preserved **exactly as `succ-5` held it**, in
 * both halves. `.github/audits/memory-eval-gold-contract-2026-08-27.md` §12.2
 * keeps the record and the correction as separate facts rather than folding
 * one into the other: a history that quietly rewrote what it is a history of
 * would answer no question anyone brings to it.
 *
 * `succ-assistant-ko-23` produced two candidates and the decision judged them
 * differently — the retraction candidate is a violation, the
 * privacy-preference candidate is the gold defect. It is still one case and
 * one entry. Its correction adds the preference gold and nothing else: the
 * retracted location keeps no gold, which is the point of the retraction
 * clause.
 *
 * ## This module is not importable from the decision set
 *
 * `memoryEvalSucc6` must never reach this file. The two share only the
 * transition record, which carries ids and grounds and no case content.
 * `tests/memoryEvalSucc6.test.mjs` walks the import graph and fails on a path
 * between them — a flag has to be honoured by every reader, an import boundary
 * by none of them.
 */

import type { MemoryEvalCaseV3 } from "@/lib/memoryEvalDatasetSchemaV3";
import { MEMORY_EVAL_SUCC5_CASES } from "@/lib/memoryEvalSucc5";
import {
    SUCC6_TRANSITIONS,
    type Succ6Transition,
} from "@/lib/memoryEvalSucc6Transition";

/**
 * A gold the 2026-08-30 decision says the case should have carried.
 *
 * Written out rather than derived: the decision named each one, and a
 * corrected label inferred from the conversation would be this file guessing
 * at what a person decided.
 */
export type Succ6GoldCorrection = {
    caseId: string;
    kind: string;
    polarity: "affirmed" | "negated";
    /** What the user established, in the reviewer's words. */
    establishes: string;
    /**
     * Set where the corrected gold may not name a value the user withheld.
     *
     * .github/audits/memory-boundary-decision-2026-08-30.md §1.1 allows the
     * privacy preference and forbids the statement repeating, inferring or
     * narrowing the location it was withdrawing. A gold written without this
     * note would be satisfied by a sentence that leaks it.
     */
    withheldValueMustNotAppear?: true;
    auditRef: string;
};

export const SUCC6_GOLD_CORRECTIONS: readonly Succ6GoldCorrection[] = [
    {
        caseId: "succ-assistant-ko-23",
        kind: "preference",
        polarity: "affirmed",
        establishes: "집 주소를 공개하고 싶어 하지 않는다",
        withheldValueMustNotAppear: true,
        auditRef: `.github/audits/memory-boundary-decision-2026-08-30.md §3.2`,
    },
    {
        caseId: "succ-assistant-en-311",
        kind: "preference",
        polarity: "affirmed",
        establishes: "prefers not to share their own location",
        withheldValueMustNotAppear: true,
        auditRef: `.github/audits/memory-boundary-decision-2026-08-30.md §3.2`,
    },
    {
        caseId: "succ-assistant-en-92",
        kind: "identity",
        polarity: "affirmed",
        establishes: "is thirty years old",
        auditRef: `.github/audits/memory-boundary-decision-2026-08-30.md §3.2`,
    },
    {
        caseId: "succ-assistant-en-10",
        kind: "decision",
        polarity: "affirmed",
        establishes: "has decided not to return to competitive swimming",
        auditRef: `.github/audits/memory-boundary-decision-2026-08-30.md §3.2`,
    },
    {
        caseId: "succ-assistant-en-27",
        kind: "relationship",
        polarity: "negated",
        establishes: "has no children",
        auditRef: `.github/audits/memory-boundary-decision-2026-08-30.md §3.2`,
    },
];

export type Succ6RegressionProvenance = {
    supersededBy: string;
    grounds: Succ6Transition["grounds"];
    clause?: Succ6Transition["clause"];
    auditRef: string;
    /** Oldest first, ending at the `succ-6` replacement. */
    chain: readonly string[];
};

export type Succ6RegressionEntry = {
    /** The case exactly as `succ-5` held it. */
    supersededCase: MemoryEvalCaseV3;
    /** The corrected gold this decision assigned, where it assigned one. */
    corrections: readonly Succ6GoldCorrection[];
    provenance: Succ6RegressionProvenance;
};

const succ5ById = new Map(MEMORY_EVAL_SUCC5_CASES.map((c) => [c.id, c]));

export const SUCC6_REGRESSION_CORPUS: readonly Succ6RegressionEntry[] =
    SUCC6_TRANSITIONS.map((transition) => {
        const supersededCase = succ5ById.get(transition.originalId);
        if (!supersededCase) {
            throw new Error(
                `succ-6 regression: ${transition.originalId} is not a succ-5 case`
            );
        }
        return {
            supersededCase,
            corrections: SUCC6_GOLD_CORRECTIONS.filter(
                (correction) => correction.caseId === transition.originalId
            ),
            provenance: {
                supersededBy: transition.replacementId,
                grounds: transition.grounds,
                ...(transition.clause ? { clause: transition.clause } : {}),
                auditRef: transition.auditRef,
                chain: [transition.originalId, transition.replacementId],
            },
        };
    });

/** The regression entry for one superseded id, or `undefined`. */
export function succ6RegressionEntryFor(
    originalId: string
): Succ6RegressionEntry | undefined {
    return SUCC6_REGRESSION_CORPUS.find(
        (entry) => entry.supersededCase.id === originalId
    );
}
