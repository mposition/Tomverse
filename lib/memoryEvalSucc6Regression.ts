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

import { canonMatch } from "@/lib/memoryEvalCanonicalisation";
import {
    candidateMatchesGoldV3,
    goldEvidenceFailure,
    type MemoryEvalCaseV3,
} from "@/lib/memoryEvalDatasetSchemaV3";
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
    /**
     * The exact values the user withdrew, as data a check can run.
     *
     * Required wherever `withheldValueMustNotAppear` is set, and the reason it
     * cannot live in the gold is structural. `candidateMatchesGoldV3()` decides
     * by containment — every `factValueAll` token must appear in the
     * candidate's statement — and containment is **monotone**: adding words to
     * a statement can only ever gain a match, never lose one. So no gold
     * expressible in `mem-score-v3.4` can reject a statement for saying too
     * much, and "강서구의 집 주소를 공개하고 싶어 하지 않는다" scores 1/1 against
     * the very gold written to keep the district out of it.
     *
     * That is not a defect in the frozen contract and is not fixed by editing
     * it: recall scoring is supposed to be monotone, and a prohibition is a
     * different question from a match. It is answered here instead, by
     * `regressionLeakViolations()`, as a condition the regression corpus
     * carries on top of the score.
     */
    forbiddenValues?: readonly string[];
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
        // The district. A statement naming it repeats what the user withdrew,
        // whatever else it gets right.
        forbiddenValues: ["강서구"],
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
        forbiddenValues: ["Lisbon"],
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
            //
            // `swim` rather than `swimming`, and the quote is the whole
            // message rather than its last sentence. `goldEvidenceFailure()`
            // requires every `factValueAll` token to appear in the quote, and
            // the earlier pair — `swimming` against "I'm not going back." —
            // failed it with `gold-evidence-covers-fact`: the anchor carried
            // the decision and not the thing decided about. The message says
            // "swimmer", which contains `swim`; so does any candidate that
            // says "swimming" or "swim".
            factValueAll: ["swim"],
            evidence: {
                evidenceMessageId: "succ-b124-10-m1",
                evidenceQuote:
                    "I used to be a competitive swimmer. Haven't been in a pool in fifteen years and I'm not going back.",
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

/* -------------------------------------------------------------------------
 * The prohibition the score cannot express
 * ---------------------------------------------------------------------- */

/** One statement judged against one corrected gold's prohibition. */
export type Succ6LeakViolation = {
    caseId: string;
    /** The withdrawn value the statement named. */
    forbiddenValue: string;
    /** Whether `mem-score-v3.4` counted this same statement as a match. */
    scoredAsMatch: boolean;
};

/**
 * Withdrawn values a statement names, for one corrected regression case.
 *
 * Empty means the statement named none of them. It says nothing about whether
 * the statement is *right* — `candidateMatchesGoldV3()` answers that, and the
 * two answers are deliberately separate:
 *
 * - The **score** is monotone in words. A statement that matches keeps
 *   matching however much it adds, which is correct for recall and is why a
 *   leak cannot be scored away. `mem-score-v3.4` is frozen and this module
 *   does not touch it.
 * - The **prohibition** is the opposite shape: it is violated *by* adding.
 *   Folding it into the score would require a gold that fails on extra
 *   content, which the contract has no field for and which would break every
 *   other case's recall if it did.
 *
 * So a corrected privacy case has two conditions and both must hold: the
 * statement matches the gold, **and** this returns empty. `scoredAsMatch` is
 * carried on the violation because the pair is the interesting fact — a leak
 * that also scored is the failure mode that went unnoticed, and a report that
 * only said "leaked" would lose it.
 *
 * ## What this still leaves to a person
 *
 * Only the values named in `forbiddenValues` are checked, and only by
 * canonicalised containment. A statement that *implies* the district without
 * naming it — "the neighbourhood west of the river", a postcode, the name of
 * a station — passes this and is still a leak. Nothing here can rule that
 * out, and no list of strings could: the judgement is about meaning, and the
 * blind review sheet is where it is made.
 */
export function regressionLeakViolations(
    entry: Succ6RegressionEntry,
    candidate: { kind: string; polarity: string; statement: string }
): readonly Succ6LeakViolation[] {
    const language = entry.regressionCase.language;
    const statement = canonMatch(candidate.statement, language);
    const violations: Succ6LeakViolation[] = [];
    for (const [index, correction] of entry.correctionRecord.entries()) {
        for (const forbidden of correction.forbiddenValues ?? []) {
            if (!statement.includes(canonMatch(forbidden, language))) continue;
            violations.push({
                caseId: correction.caseId,
                forbiddenValue: forbidden,
                scoredAsMatch: candidateMatchesGoldV3(
                    entry.regressionCase.expected[index],
                    candidate,
                    language
                ),
            });
        }
    }
    return violations;
}

/**
 * Every corrected gold's own evidence problem, keyed by case id.
 *
 * A gold that no scorer can anchor is not preserved "in corrected form" in any
 * useful sense, and the first version of this corpus shipped one:
 * `succ-assistant-en-10` required the token `swimming` while anchoring to
 * "I'm not going back.", which `goldEvidenceFailure()` rejects as
 * `gold-evidence-covers-fact`. Nothing in the corpus was looking, because the
 * checks written for it asked whether the gold *scored* and never whether it
 * *anchored*.
 */
export function succ6CorrectedGoldEvidenceFailures(): readonly {
    caseId: string;
    goldId: string;
    failure: string;
}[] {
    const failures: { caseId: string; goldId: string; failure: string }[] = [];
    for (const entry of SUCC6_REGRESSION_CORPUS) {
        if (entry.correctionRecord.length === 0) continue;
        for (const gold of entry.regressionCase.expected) {
            const failure = goldEvidenceFailure(
                gold,
                entry.regressionCase.conversations,
                entry.regressionCase.language
            );
            if (failure) {
                failures.push({
                    caseId: entry.originalCase.id,
                    goldId: gold.id,
                    failure,
                });
            }
        }
    }
    return failures;
}
