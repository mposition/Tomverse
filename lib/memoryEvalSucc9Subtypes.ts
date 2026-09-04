/**
 * Subtype declarations for the succ-9 `assistant_only` replacements.
 *
 * Three of the five cases `mem-eval-succ-9` retires are `assistant_only`, and
 * all three are **subtype 3** — the user correcting a fact the assistant
 * attributed to them. docs/ops/memory-extraction-eval-dataset.md §3.3 asks each
 * cell to hold at least 30% of its cases in subtypes 3 and 4, and succ-7's
 * check records that both arms sit *exactly* on that floor with nothing to
 * spare. So three subtype-3 cases leaving and three unclassified ones arriving
 * is not a wash: it puts both arms under the floor, silently, because nothing
 * recomputes a floor a replacement never declared itself against.
 *
 * ## Why this is a third table rather than three more rows
 *
 * The same reason succ-7 gave. `subtypeTableFingerprintInput()` folds every row
 * of `ASSISTANT_ONLY_SUBTYPES` into `subtypeTableDigest`, which is pinned
 * inside succ-6's frozen manifest. Adding rows there would move that digest and
 * break the freeze of a signed dataset these cases have not joined.
 *
 * That leaves three tables to read for one question, so `succ9Subtype()` is the
 * only thing that should answer it. The three are disjoint by construction and
 * `succ9SubtypeProblems()` fails if they ever stop being.
 *
 * ## The grounds
 *
 * Each row quotes the clause the classification rests on, as both other tables
 * do, so a reader can disagree with a row by reading its clause rather than by
 * trusting the column.
 */

import {
    ASSISTANT_ONLY_SUBTYPES,
    type AssistantOnlySubtypeEntry,
} from "@/lib/memoryEvalAssistantOnlySubtypes";
import { SUCC7_ASSISTANT_ONLY_SUBTYPES } from "@/lib/memoryEvalSucc7Replacements/subtypes";

export const SUCC9_ASSISTANT_ONLY_SUBTYPES: Readonly<
    Record<string, AssistantOnlySubtypeEntry>
> = {
    // Replaces succ-assistant-ko-407, subtype 3 in the frozen table on
    // "저는 배우자가 없어서 그 항목은 해당되지 않습니다".
    "succ-assistant-ko-701": {
        subtype: 3,
        ground: "저는 사촌이 없어서 그 항목은 해당되지 않습니다",
    },
    // Replaces succ-assistant-en-603, subtype 3 in succ-7's table on
    // "I have never kept bees".
    "succ-assistant-en-701": {
        subtype: 3,
        ground: "I have never done any welding",
    },
    // Replaces succ-assistant-en-608, subtype 3 in succ-7's table on
    // "I have no experience with houseplants at all".
    "succ-assistant-en-702": {
        subtype: 3,
        ground: "I have no experience with sourdough at all",
    },
};

/**
 * The subtype of a case in `mem-eval-succ-9`, from whichever table declares it.
 *
 * `undefined` means subtype 1 or 2 — the assistant guessed, or the sentence was
 * role-play. Neither table enumerates those, for the reason the frozen one
 * gives: the floor is a lower bound on 3 and 4, so what matters is that no case
 * is credited to it without a clause beside it.
 */
export function succ9Subtype(caseId: string): 3 | 4 | undefined {
    return (
        SUCC9_ASSISTANT_ONLY_SUBTYPES[caseId]?.subtype ??
        SUCC7_ASSISTANT_ONLY_SUBTYPES[caseId]?.subtype ??
        ASSISTANT_ONLY_SUBTYPES[caseId]?.subtype
    );
}

/**
 * Two things a check can settle, unlike the classifications themselves.
 *
 * The first is overlap: three tables answering one question can disagree, and
 * `succ9Subtype()`'s precedence would then hide the disagreement behind a
 * lookup order. The second is a row that names no case in succ-9 — the tables
 * are written by hand against ids, so a replacement rename would leave a row
 * pointing at nothing and quietly lower the count it was written to raise.
 * Only succ-9's own table is checked for that; the other two legitimately name
 * cases this version retired.
 */
export function succ9SubtypeProblems(
    cases: readonly { id: string }[]
): readonly string[] {
    const problems: string[] = [];
    const ids = new Set(cases.map((testCase) => testCase.id));
    for (const id of Object.keys(SUCC9_ASSISTANT_ONLY_SUBTYPES)) {
        if (!ids.has(id)) {
            problems.push(`${id} is declared a subtype but is not in succ-9`);
        }
        if (SUCC7_ASSISTANT_ONLY_SUBTYPES[id] || ASSISTANT_ONLY_SUBTYPES[id]) {
            problems.push(`${id} is declared in more than one subtype table`);
        }
    }
    return problems;
}
