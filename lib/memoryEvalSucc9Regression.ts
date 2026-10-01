import type { MemoryEvalCaseV3 } from "@/lib/memoryEvalDatasetSchemaV3";
import { MEMORY_EVAL_SUCC8_CASES } from "@/lib/memoryEvalSucc8";
import {
    SUCC9_TRANSITION,
    type Succ9TransitionRow,
} from "@/lib/memoryEvalSucc9Transition";

/**
 * The five cases `mem-eval-succ-9` retired, preserved exactly as succ-8 held
 * them.
 *
 * Retiring a case removes it from the *decision* set. It does not make the
 * case wrong, and every one of these five encodes a judgement somebody made
 * and nobody has withdrawn: a relationship stated as absent, three absences of
 * skill, and a goal paired with the gap between it and present ability.
 *
 * They leave because they were counted when `mem-extract-v8`'s example kind
 * was chosen, and a case that helped select a prompt cannot measure it. That
 * is a fact about their *role*, not about their content — so the content is
 * kept, runnable, here.
 *
 * Nothing in this module is scored by a run. It exists so that "the case was
 * retired" and "the case was deleted" stay different things, and so a later
 * reader can see what the replacement was replacing.
 */
export type Succ9RegressionEntry = {
    /** The case exactly as succ-8 held it. Never edited. */
    originalCase: MemoryEvalCaseV3;
    /** Why it left the decision set. */
    basis: Succ9TransitionRow["basis"];
    /** The succ-9 case that took its place. */
    replacementId: string;
    /** Whether that replacement tests this case's boundary. */
    transitionType: Succ9TransitionRow["transitionType"];
    /** The gold that appeared in the selection count, `caseId#goldId`. */
    countedGold: string;
    /** Where the decision is written down. */
    auditRef: string;
};

const AUDIT_REF =
    ".github/audits/mem-extract-v8-implementation-2026-09-04.md";

const BY_ID = new Map(MEMORY_EVAL_SUCC8_CASES.map((entry) => [entry.id, entry]));

/**
 * Built from succ-8 rather than transcribed.
 *
 * A hand-copied original is a second copy that has to be kept identical by
 * hand, and the first edit to either makes the preservation a claim rather
 * than a fact. Reading succ-8 makes "exactly as succ-8 held it" true by
 * construction.
 */
export const SUCC9_REGRESSION_CORPUS: readonly Succ9RegressionEntry[] =
    SUCC9_TRANSITION.map((row) => {
        const originalCase = BY_ID.get(row.retired);
        if (!originalCase) {
            throw new Error(
                `succ-9 regression: ${row.retired} is not in mem-eval-succ-8, so ` +
                    "the case it claims to preserve does not exist"
            );
        }
        return {
            originalCase,
            basis: row.basis,
            replacementId: row.replacement,
            transitionType: row.transitionType,
            countedGold: row.countedGold,
            auditRef: AUDIT_REF,
        };
    });

/**
 * What a reader can check about this corpus without running anything.
 *
 * Reported rather than thrown so the check script can print every problem at
 * once, which is the shape the succ-7 and succ-8 checks already use.
 */
export function succ9RegressionProblems(): readonly string[] {
    const problems: string[] = [];
    if (SUCC9_REGRESSION_CORPUS.length !== SUCC9_TRANSITION.length) {
        problems.push(
            `${SUCC9_REGRESSION_CORPUS.length} preserved against ` +
                `${SUCC9_TRANSITION.length} transitions`
        );
    }
    for (const entry of SUCC9_REGRESSION_CORPUS) {
        const counted = entry.countedGold.split("#")[0];
        if (counted !== entry.originalCase.id) {
            problems.push(
                `${entry.originalCase.id} preserves a counted gold belonging to ${counted}`
            );
        }
        const goldId = entry.countedGold.split("#")[1];
        if (!(entry.originalCase.expected ?? []).some((gold) => gold.id === goldId)) {
            problems.push(
                `${entry.originalCase.id} has no gold ${goldId}, so the counted gold cannot be the one recorded`
            );
        }
    }
    return problems;
}
