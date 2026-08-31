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
    /** The gold the corrected case carries, ready for a scorer. */
    expected: MemoryEvalCaseV3["expected"][number];
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
        // The withheld value is the district. `factValueAll` names the words
        // the preference is *about*, and deliberately not `강서구`: a gold that
        // required the district would only be satisfied by a sentence that
        // repeats what the user withdrew.
        expected: {
            id: "e1",
            kind: "preference",
            polarity: "affirmed",
            // `주소` alone, and deliberately not `강서구`: the district is the
            // value the user withdrew, and a gold that required it would only
            // be satisfied by a sentence that repeats it.
            factValueAll: ["주소"],
            evidence: {
                evidenceMessageId: "succ-b121-23-m3",
                evidenceQuote: "집 주소는 말하고 싶지 않습니다.",
            },
            expectedDisposition: "bulk_safe",
        },
        withheldValueMustNotAppear: true,
        auditRef: ".github/audits/memory-boundary-decision-2026-08-30.md §3.2",
    },
    {
        caseId: "succ-assistant-en-311",
        kind: "preference",
        polarity: "affirmed",
        establishes: "prefers not to share their own location",
        // Not `lisbon`, for the same reason: the city is the thing withheld.
        expected: {
            id: "e1",
            kind: "preference",
            polarity: "affirmed",
            factValueAll: ["location"],
            evidence: {
                evidenceMessageId: "succ-b165-11-m3",
                evidenceQuote: "I'd rather not give my own location.",
            },
            expectedDisposition: "bulk_safe",
        },
        withheldValueMustNotAppear: true,
        auditRef: ".github/audits/memory-boundary-decision-2026-08-30.md §3.2",
    },
    {
        caseId: "succ-assistant-en-92",
        kind: "identity",
        polarity: "affirmed",
        establishes: "is thirty years old",
        expected: {
            id: "e1",
            kind: "identity",
            polarity: "affirmed",
            factValueAll: ["thirty"],
            evidence: {
                evidenceMessageId: "succ-b126-13-m1",
                evidenceQuote: "It's thirty.",
            },
            expectedDisposition: "bulk_safe",
        },
        auditRef: ".github/audits/memory-boundary-decision-2026-08-30.md §3.2",
    },
    {
        caseId: "succ-assistant-en-10",
        kind: "decision",
        polarity: "affirmed",
        establishes: "has decided not to return to competitive swimming",
        expected: {
            id: "e1",
            kind: "decision",
            polarity: "affirmed",
            // The sport, not the phrasing: "not going back" and "not return"
            // are both correct readings and only one of them contains either
            // wording.
            factValueAll: ["swimming"],
            evidence: {
                evidenceMessageId: "succ-b124-10-m1",
                evidenceQuote: "I'm not going back.",
            },
            expectedDisposition: "bulk_safe",
        },
        auditRef: ".github/audits/memory-boundary-decision-2026-08-30.md §3.2",
    },
    {
        caseId: "succ-assistant-en-27",
        kind: "relationship",
        polarity: "negated",
        establishes: "has no children",
        expected: {
            id: "e1",
            kind: "relationship",
            polarity: "negated",
            // `.github/audits/memory-eval-gold-contract-2026-08-27.md` §12.3:
            // a finite set of lexical alternatives is `factValueAny`, not a
            // required token. A correct extraction says children or kids, and
            // requiring either one alone would fail the other.
            factValueAll: [],
            factValueAny: ["children", "kids"],
            evidence: {
                evidenceMessageId: "succ-b124-27-m1",
                evidenceQuote: "I have three kids and I don't have any",
            },
            expectedDisposition: "bulk_safe",
        },
        auditRef: ".github/audits/memory-boundary-decision-2026-08-30.md §3.2",
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
    /** The case exactly as `succ-5` held it. Never edited. */
    originalCase: MemoryEvalCaseV3;
    /**
     * The case a scorer can actually run: the same conversation, with the
     * corrected `expected`.
     *
     * `.github/audits/memory-eval-gold-contract-2026-08-27.md` §12.2 asks for
     * the corrected gold to be preserved *in corrected form*, and a `kind`
     * and a `polarity` in a metadata row are not that — nothing can score
     * them. Where nothing was corrected this is the original object itself,
     * by reference, so the two halves are told apart by identity rather than
     * by a flag.
     */
    regressionCase: MemoryEvalCaseV3;
    /** Why the gold changed, and under whose decision. Empty where it did not. */
    correctionRecord: readonly Succ6GoldCorrection[];
    provenance: Succ6RegressionProvenance;
};

const succ5ById = new Map(MEMORY_EVAL_SUCC5_CASES.map((c) => [c.id, c]));

export const SUCC6_REGRESSION_CORPUS: readonly Succ6RegressionEntry[] =
    SUCC6_TRANSITIONS.map((transition) => {
        const originalCase = succ5ById.get(transition.originalId);
        if (!originalCase) {
            throw new Error(
                `succ-6 regression: ${transition.originalId} is not a succ-5 case`
            );
        }
        const correctionRecord = SUCC6_GOLD_CORRECTIONS.filter(
            (correction) => correction.caseId === transition.originalId
        );
        return {
            originalCase,
            // Same object where nothing was corrected: identity is what tells
            // the two halves apart, and a spread copy would make them look
            // different while being the same.
            regressionCase:
                correctionRecord.length === 0
                    ? originalCase
                    : {
                          ...originalCase,
                          expected: correctionRecord.map(
                              (correction) => correction.expected
                          ),
                      },
            correctionRecord,
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
        (entry) => entry.originalCase.id === originalId
    );
}
