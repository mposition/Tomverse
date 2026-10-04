/**
 * Three cases swapped to bring the `assistant_only` cells up to their docs/ops/memory-extraction-eval-dataset.md §3.3
 * floor — a different kind of change from the B+ ten, and kept separate.
 *
 * ## Why this is not more B+
 *
 * The ten in `lib/memoryEvalSucc6Transition.ts` left because they formed the
 * boundary rule of 2026-08-30, and each has a history preserved in the
 * regression corpus. These three leave for an unrelated reason: reading all
 * 250 `assistant_only` cases showed the cells at ko 36 and en 37 subtype 3/4
 * against a floor of 38 (`docs/ops/memory-extraction-eval-dataset.md` §3.3, at
 * least 30% of each cell). `mem-eval-succ-5` was at ko 31 and en 34, so the
 * shortfall is inherited rather than introduced, and it had never been
 * measured.
 *
 * Nothing is wrong with the three that leave. They are not defective and there
 * is no gold to correct, so they do not enter the B+ regression corpus — that
 * corpus is the history of a rule, and putting an ordinary swap in it would
 * make it mean two different things.
 *
 * ## Why the counts were not simply relabelled
 *
 * ko needed two more and en one, and the exclusions in the review sheet's
 * docs/ops/memory-eval-succ6-replacement-review.md §3.1 — a denial inside a guessing game, a third party framed as one from the
 * start, material declared fictional up front, a rumour confirmed — would each
 * have supplied more than enough if they were counted as subtype 3. They were
 * adopted as exclusions instead, and then the sample was changed to meet the
 * floor rather than the classification changed to clear it. Moving a boundary
 * until the number passes is fitting the measurement to the threshold, and the
 * measurement stops meaning anything the moment it is done once.
 *
 * ## Which three leave
 *
 * The most redundant subtype 1/2 case in each cell, by the near-duplicate
 * scores the repository already computes. `en-107` sits in three of that
 * cell's closest pairs; `ko-71` in two; `ko-311` in two. So each swap removes
 * overlap and adds a hard case, and the cell is more varied afterwards rather
 * than merely larger in one subtype.
 */

import type { MemoryEvalCaseV3 } from "@/lib/memoryEvalDatasetSchemaV3";

/** One redundant case out, one subtype 3 or 4 case in. */
export type Succ6CompositionRepair = {
    removedId: string;
    addedId: string;
    cell: string;
    /** The subtype the new case is written to be. */
    addedSubtype: 3 | 4;
    /** Why this particular case was the one to lose. */
    removalReason: string;
    auditRef: string;
};

export const SUCC6_COMPOSITION_REPAIRS: readonly Succ6CompositionRepair[] = [
    {
        removedId: "succ-assistant-ko-71",
        addedId: "succ-assistant-ko-507",
        cell: "assistant_only:ko",
        addedSubtype: 3,
        removalReason:
            "the cell's most redundant sample-template case: nearest to ko-97 at 0.26 " +
            "token overlap and to ko-39 at 0.19, both of which are also 'write me an " +
            "example first-person blurb'",
        auditRef: "docs/ops/memory-eval-succ6-replacement-review.md",
    },
    {
        removedId: "succ-assistant-ko-311",
        addedId: "succ-assistant-ko-508",
        cell: "assistant_only:ko",
        addedSubtype: 4,
        removalReason:
            "a third interview-transcript case, nearest to ko-58 at 0.24 and ko-41 at " +
            "0.21, all three 'tidy this transcript and keep the speaker's words'",
        auditRef: "docs/ops/memory-eval-succ6-replacement-review.md",
    },
    {
        removedId: "succ-assistant-en-107",
        addedId: "succ-assistant-en-505",
        cell: "assistant_only:en",
        addedSubtype: 4,
        removalReason:
            "the cell's most redundant case by some distance: it is one half of the " +
            "closest pair in the cell (en-70, 0.38) and also sits nearest to en-51 " +
            "(0.32) and en-68 (0.29) — four ghost-written first-person letters",
        auditRef: "docs/ops/memory-eval-succ6-replacement-review.md",
    },
];

export const SUCC6_REMOVED_FOR_COMPOSITION: ReadonlySet<string> = new Set(
    SUCC6_COMPOSITION_REPAIRS.map((repair) => repair.removedId)
);

export const SUCC6_COMPOSITION_ADDITION_IDS: ReadonlySet<string> = new Set(
    SUCC6_COMPOSITION_REPAIRS.map((repair) => repair.addedId)
);

/**
 * The three new cases.
 *
 * Written to the cell's own question, like the B+ ten: does the model mistake
 * material it produced, or material the user framed as supposition, for a fact
 * about the user? None reuses a domain already in the cell — the ko pair are a
 * courtesy car and a pet the user does not have, the en case a broadband exit
 * fee — and none paraphrases an example from the v7 draft.
 */
export const SUCC6_COMPOSITION_ADDITIONS: readonly MemoryEvalCaseV3[] = [
    // 3 — the assistant attributes ownership the user never claimed, and the
    // user takes it back without putting a durable fact in its place. A hire
    // car is exactly the shape that looks like a possession and is not one.
    {
        id: "succ-assistant-ko-507",
        category: "assistant_only",
        language: "ko",
        expected: [],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b603-1",
                title: "차량 점검",
                messages: [
                    {
                        externalMessageId: "succ-b603-1-m1",
                        role: "user",
                        content:
                            "계기판에 타이어 공기압 경고등이 떴는데 지금 바로 정비소에 가야 하나요?",
                    },
                    {
                        externalMessageId: "succ-b603-1-m2",
                        role: "assistant",
                        content:
                            "차주분 차량이라면 공기압을 먼저 확인해 보시고, 계속 뜨면 점검을 받으십시오.",
                    },
                    {
                        externalMessageId: "succ-b603-1-m3",
                        role: "user",
                        content:
                            "제 차가 아니라 수리 맡긴 동안 빌린 대차예요. 오늘 오후에 반납합니다.",
                    },
                ],
            },
        ],
    },
    // 4 — a supposition the user closes explicitly. The animal is imagined and
    // the closing line says so, so nothing here is a relationship.
    {
        id: "succ-assistant-ko-508",
        category: "assistant_only",
        language: "ko",
        expected: [],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b603-2",
                title: "관리규약 문의",
                messages: [
                    {
                        externalMessageId: "succ-b603-2-m1",
                        role: "user",
                        content:
                            "아파트에서 중형견을 키운다고 하면 관리규약상 걸리는 게 있나요?",
                    },
                    {
                        externalMessageId: "succ-b603-2-m2",
                        role: "assistant",
                        content:
                            "단지마다 다르지만 무게나 체고 기준, 엘리베이터 이용 규정을 두는 곳이 있습니다.",
                    },
                    {
                        externalMessageId: "succ-b603-2-m3",
                        role: "user",
                        content:
                            "지금 키우는 건 없고, 규약을 어디까지 정할 수 있는지가 궁금해서 여쭤봤습니다.",
                    },
                ],
            },
        ],
    },
    // 4 — a conditional about a contract the user is not leaving. The figures
    // in the answer belong to the mechanism, not to the user's account.
    {
        id: "succ-assistant-en-505",
        category: "assistant_only",
        language: "en",
        expected: [],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b603-3",
                title: "Exit fees",
                messages: [
                    {
                        externalMessageId: "succ-b603-3-m1",
                        role: "user",
                        content:
                            "If someone broke a broadband contract halfway through, how is the exit fee usually worked out?",
                    },
                    {
                        externalMessageId: "succ-b603-3-m2",
                        role: "assistant",
                        content:
                            "Typically the remaining months times the monthly charge, less the cost of service no longer supplied.",
                    },
                    {
                        externalMessageId: "succ-b603-3-m3",
                        role: "user",
                        content:
                            "That's the formula I was after. I'm not going anywhere — I wanted to understand how the number is built.",
                    },
                ],
            },
        ],
    },
];
