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

import { createHash } from "node:crypto";

import {
    ASSISTANT_ONLY_SUBTYPES,
    subtypeTableDigest,
    type AssistantOnlySubtypeEntry,
} from "@/lib/memoryEvalAssistantOnlySubtypes";
import { isCalendarDay } from "@/lib/memoryEvalCalendarDay";
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
 * Who has confirmed the three rows above, and who has not.
 *
 * The frozen table carries the same record and folds it into its own digest,
 * for a reason worth repeating here: while `ASSISTANT_ONLY_SUBTYPES` said
 * `ai_draft`, the docs/ops/memory-extraction-eval-dataset.md §3.3 floor was
 * what a careful reading found; signed, it is
 * what the dataset claims. These three rows are an AI draft and say so, and
 * because the status sits inside `succ9SubtypeDigest()` a later human
 * confirmation moves that digest, succ-9's manifest digest with it, and
 * therefore needs its own signature rather than arriving silently.
 */
export const SUCC9_SUBTYPE_REVIEW = {
    status: "ai_draft" as "ai_draft" | "human_confirmed",
    reviewer: null as string | null,
    reviewedAt: null as string | null,
    method:
        "Each of the three replacement cases was read in full against the case " +
        "it replaces; the clause quoted in each row is the one the subtype " +
        "rests on, and each matches the subtype of its predecessor.",
} as const;

/**
 * The whole subtype judgement succ-9 depends on, as one digest.
 *
 * Three tables answer the docs/ops/memory-extraction-eval-dataset.md §3.3
 * question for succ-9's cases, and a signature
 * over the sample alone covers none of them: the classifications decide
 * whether both `assistant_only` arms clear their floor, both arms sit exactly
 * on it, and every row here is hand-written prose that can be edited after a
 * freeze without moving a single case. So the digest goes in the manifest,
 * where signing the dataset signs the reading that made it admissible.
 *
 * All three are folded in, not only succ-9's own. `ko-407`'s replacement is
 * credited against a row in the frozen table and `en-603`/`en-608`'s against
 * succ-7's, so an edit to either upstream table changes what succ-9's floor
 * says while leaving succ-9's own rows untouched.
 */
export function succ9SubtypeFingerprintInput(): string {
    const rows = (table: Readonly<Record<string, AssistantOnlySubtypeEntry>>) =>
        Object.keys(table)
            .sort()
            .map((id) => `${id}=${table[id].subtype}:${table[id].ground}`);
    return [
        `frozenTableDigest=${subtypeTableDigest()}`,
        `succ7Rows=${rows(SUCC7_ASSISTANT_ONLY_SUBTYPES).length}`,
        ...rows(SUCC7_ASSISTANT_ONLY_SUBTYPES),
        `status=${SUCC9_SUBTYPE_REVIEW.status}`,
        `reviewer=${SUCC9_SUBTYPE_REVIEW.reviewer ?? "-"}`,
        `reviewedAt=${SUCC9_SUBTYPE_REVIEW.reviewedAt ?? "-"}`,
        `method=${SUCC9_SUBTYPE_REVIEW.method}`,
        `succ9Rows=${rows(SUCC9_ASSISTANT_ONLY_SUBTYPES).length}`,
        ...rows(SUCC9_ASSISTANT_ONLY_SUBTYPES),
    ].join("\n");
}

export function succ9SubtypeDigest(): string {
    return createHash("sha256")
        .update(succ9SubtypeFingerprintInput(), "utf8")
        .digest("hex");
}

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
/**
 * A name somebody could be reached at.
 *
 * `/^@?[A-Za-z0-9-]+$/` was the first attempt and it accepted `"-"`, which is
 * how a placeholder becomes a reviewer: `human_confirmed` with a hyphen and a
 * real date passed every check, so the "confirmation with nobody's name on it"
 * path was still open one character wide. Hyphens are legal inside a handle
 * and at neither end, which is also GitHub's own rule, so requiring the first
 * and last character to be alphanumeric closes it without inventing a
 * restriction.
 *
 * The `@` is optional because both records this family already holds spell it
 * differently: `ASSISTANT_ONLY_SUBTYPES`' reviewer is `mposition` and succ-8's
 * approval is `@mposition`. Rejecting either spelling would refuse a signature
 * over a punctuation mark.
 */
const HANDLE = /^@?[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

const isHandle = (value: unknown): boolean =>
    typeof value === "string" && HANDLE.test(value);

/**
 * What a review record has to look like in each of its two states.
 *
 * Checked in **both** directions, because only one of them is the dangerous
 * one and it is the one a single-sided check misses. Setting
 * `status: "human_confirmed"` and leaving `reviewer` and `reviewedAt` null
 * passed everything: the freeze gate saw `human_confirmed` and let the dataset
 * through, so the whole protection amounted to editing one string. A
 * confirmation nobody's name is on is not a confirmation, and the state it
 * unlocks is the docs/ops/memory-extraction-eval-dataset.md §3.3 floor both
 * `assistant_only` arms sit exactly on.
 *
 * The other direction matters less but costs nothing: an `ai_draft` carrying a
 * reviewer and a date is a record halfway through being written, and reading
 * it as a draft loses whatever the half means.
 *
 * Pure and parameterised so a test can put a record into each state; the
 * module constant is one argument among the possible ones.
 */
export function subtypeReviewProblems(review: {
    status: string;
    reviewer: string | null;
    reviewedAt: string | null;
    method: string;
}): readonly string[] {
    const problems: string[] = [];
    if (review.method.trim() === "") {
        problems.push("the subtype review states no method");
    }
    if (review.status === "human_confirmed") {
        if (!isHandle(review.reviewer)) {
            problems.push(
                "the subtype review is human_confirmed with no reviewer: " +
                    JSON.stringify(review.reviewer)
            );
        }
        if (!isCalendarDay(review.reviewedAt)) {
            problems.push(
                "the subtype review is human_confirmed with no day it happened: " +
                    JSON.stringify(review.reviewedAt)
            );
        }
    } else if (review.status === "ai_draft") {
        if (review.reviewer !== null || review.reviewedAt !== null) {
            problems.push(
                "the subtype review is an ai_draft but names " +
                    `${JSON.stringify(review.reviewer)} on ` +
                    `${JSON.stringify(review.reviewedAt)}; a draft nobody ` +
                    "confirmed carries nobody's name"
            );
        }
    } else {
        problems.push(`the subtype review status is unknown: ${review.status}`);
    }
    return problems;
}

export function succ9SubtypeProblems(
    cases: readonly {
        id: string;
        conversations?: readonly {
            messages?: readonly { role: string; content: string }[];
        }[];
    }[]
): readonly string[] {
    const problems: string[] = [...subtypeReviewProblems(SUCC9_SUBTYPE_REVIEW)];
    const byId = new Map(cases.map((testCase) => [testCase.id, testCase]));
    for (const [id, entry] of Object.entries(SUCC9_ASSISTANT_ONLY_SUBTYPES)) {
        const testCase = byId.get(id);
        if (!testCase) {
            problems.push(`${id} is declared a subtype but is not in succ-9`);
            continue;
        }
        if (SUCC7_ASSISTANT_ONLY_SUBTYPES[id] || ASSISTANT_ONLY_SUBTYPES[id]) {
            problems.push(`${id} is declared in more than one subtype table`);
        }
        // The ground has to be in the case, and in a turn the *user* wrote.
        //
        // Every row above is prose typed by hand beside an id, and the digest
        // binds it without reading it: a typo, a paraphrase, or a clause
        // quoted from the assistant's turn all fold in exactly as cleanly as a
        // real quotation. Subtype 3 is the user withdrawing something they or
        // the assistant said, so a ground the user did not write cannot be
        // evidence of it — and this much is mechanical, which makes it the one
        // part of the classification a check can settle.
        const userTurns = (testCase.conversations ?? []).flatMap(
            (conversation) =>
                (conversation.messages ?? [])
                    .filter((message) => message.role === "user")
                    .map((message) => message.content)
        );
        if (!userTurns.some((content) => content.includes(entry.ground))) {
            problems.push(
                `${id}'s ground is in no user turn of its own case: ` +
                    JSON.stringify(entry.ground)
            );
        }
    }
    return problems;
}
