import type { MemoryEvalCaseV3 } from "@/lib/memoryEvalDatasetSchemaV3";

/**
 * The five 1:1 replacements `mem-eval-succ-9` brings in.
 *
 * ## Why these five left
 *
 * Not because anything was wrong with them. They were correct cases, and they
 * were **used to choose the wording of `mem-extract-v8`**.
 *
 * Picking the kind for that version's worked examples meant asking which
 * negations the approved prompt licenses, and then counting how many cases
 * each of those kinds already scores. The count decided the answer:
 * `relationship` carried one Korean case and `expertise` four, so
 * `relationship` was chosen. Those five golds are the comparison.
 *
 * A case that helped select a prompt cannot then measure it. That is the same
 * rule the `polarity44` retirement applied in succ-7, and the reason the
 * boundary is drawn around the whole comparison rather than around the one
 * case in the cell that won: the losing side is what made the winning side a
 * choice.
 *
 * ## What a replacement has to do
 *
 * Keep the boundary and drop the subject. Each of these tests exactly what its
 * original tested — same category, same language, same kind and polarity, same
 * conversational shape — with different subject matter, because the case is
 * retired for its role in a decision and not for the judgement it encodes.
 * `docs/ops/memory-extraction-eval-dataset.md` §7.3 is why the originals are
 * preserved unedited in `memoryEvalSucc9Regression.ts` rather than rewritten
 * in place.
 *
 * Every subject here was checked against succ-4 through succ-8, the succ-7
 * regression corpus and the shipped prompt before it was used:
 * `사촌`, `welding`, `sourdough`, `soldering`, `백두대간`, `빙벽`, `야산`
 * occur in none of them.
 */
export const MEMORY_EVAL_SUCC9_REPLACEMENTS: readonly MemoryEvalCaseV3[] = [
    {
        // Replaces succ-assistant-ko-407: an item in a benefits notice that
        // does not apply, because the user has no such relative. Subject moves
        // from 배우자 to 사촌; the boundary — a relationship stated as absent,
        // in a turn the assistant opened — is unchanged.
        id: "succ-assistant-ko-701",
        category: "assistant_only",
        language: "ko",
        expected: [
            {
                id: "g1",
                kind: "relationship",
                polarity: "negated",
                factValueAll: ["사촌"],
                evidence: {
                    evidenceMessageId: "succ-b901-1-m3",
                    evidenceQuote: "저는 사촌이 없어서 그 항목은 해당되지 않습니다",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        criticalGoldMode: "allow_expected_only",
        conversations: [
            {
                externalConversationId: "succ-b901-1",
                title: "해당되지 않는 항목",
                messages: [
                    {
                        externalMessageId: "succ-b901-1-m1",
                        role: "user",
                        content:
                            "사내 경조사 안내에서 사촌 결혼 지원 부분이 길게 들어가 있네요.",
                    },
                    {
                        externalMessageId: "succ-b901-1-m2",
                        role: "assistant",
                        content: "일반 항목이라 포함했습니다.",
                    },
                    {
                        externalMessageId: "succ-b901-1-m3",
                        role: "user",
                        content:
                            "저는 사촌이 없어서 그 항목은 해당되지 않습니다.",
                    },
                ],
            },
        ],
    },
    {
        // Replaces succ-assistant-en-603: the user supplies material about a
        // craft and corrects the assistant's assumption that they practise it.
        // Subject moves from bees to welding.
        id: "succ-assistant-en-701",
        category: "assistant_only",
        language: "en",
        expected: [
            {
                id: "g1",
                kind: "expertise",
                polarity: "negated",
                factValueAll: ["welding"],
                evidence: {
                    evidenceMessageId: "succ-b901-2-m3",
                    evidenceQuote: "I have never done any welding",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        criticalGoldMode: "allow_expected_only",
        conversations: [
            {
                externalConversationId: "succ-b901-2",
                title: "Leave the opening",
                messages: [
                    {
                        externalMessageId: "succ-b901-2-m1",
                        role: "user",
                        content:
                            "Draft two sentences to open a piece for people taking up welding.",
                    },
                    {
                        externalMessageId: "succ-b901-2-m2",
                        role: "assistant",
                        content:
                            'Try: "The first time I struck an arc of my own, my hands shook."',
                    },
                    {
                        externalMessageId: "succ-b901-2-m3",
                        role: "user",
                        content:
                            "I have never done any welding, but that opening works — leave it in.",
                    },
                ],
            },
        ],
    },
    {
        // Replaces succ-assistant-en-608: the assistant credits the user with
        // experience they do not have, and the user says so plainly. Subject
        // moves from houseplants to sourdough.
        id: "succ-assistant-en-702",
        category: "assistant_only",
        language: "en",
        expected: [
            {
                id: "g1",
                kind: "expertise",
                polarity: "negated",
                factValueAll: ["sourdough"],
                evidence: {
                    evidenceMessageId: "succ-b901-3-m3",
                    evidenceQuote: "I have no experience with sourdough at all",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        criticalGoldMode: "allow_expected_only",
        conversations: [
            {
                externalConversationId: "succ-b901-3",
                title: "A collapsed loaf",
                messages: [
                    {
                        externalMessageId: "succ-b901-3-m1",
                        role: "user",
                        content: "Why would a loaf collapse after the second rise?",
                    },
                    {
                        externalMessageId: "succ-b901-3-m2",
                        role: "assistant",
                        content:
                            "Given your experience with sourdough you have probably seen this before.",
                    },
                    {
                        externalMessageId: "succ-b901-3-m3",
                        role: "user",
                        content: "I have no experience with sourdough at all.",
                    },
                ],
            },
        ],
    },
    {
        // Replaces succ-durable-en-423: a plainly stated absence of skill,
        // with the jargon that would otherwise be assumed. Subject moves from
        // code to soldering.
        id: "succ-durable-en-701",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                polarity: "negated",
                factValueAll: ["soldering"],
                evidence: {
                    evidenceMessageId: "succ-b901-4-m1",
                    evidenceQuote: "I have never done any soldering.",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            {
                externalConversationId: "succ-b901-4",
                title: "from scratch",
                messages: [
                    {
                        externalMessageId: "succ-b901-4-m1",
                        role: "user",
                        content:
                            "I have never done any soldering. Terms like " +
                            "'flux' mean nothing to me.",
                    },
                    {
                        externalMessageId: "succ-b901-4-m2",
                        role: "assistant",
                        content: "I'll assume nothing and define as I go.",
                    },
                ],
            },
        ],
    },
    {
        // Replaces succ-durable-ko-422, and it is the one that carries two
        // golds. The original paired a stated goal with the gap between it and
        // the user's present ability, and both halves are independently
        // useful, so both are kept: dropping the affirmed one would quietly
        // narrow the case while claiming a 1:1 replacement. Subject moves from
        // 오픈워터 수영 to 백두대간 종주, and from 바다 to 빙벽.
        id: "succ-durable-ko-701",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                polarity: "affirmed",
                factValueAll: ["백두대간"],
                evidence: {
                    evidenceMessageId: "succ-b901-5-m1",
                    evidenceQuote: "내년 가을에 백두대간을 마치는 게 목표입니다",
                },
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "expertise",
                polarity: "negated",
                factValueAll: ["빙벽"],
                evidence: {
                    evidenceMessageId: "succ-b901-5-m3",
                    evidenceQuote: "빙벽은 아직 못 오릅니다",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            {
                externalConversationId: "succ-b901-5",
                title: "내년 목표",
                messages: [
                    {
                        externalMessageId: "succ-b901-5-m1",
                        role: "user",
                        content: "내년 가을에 백두대간을 마치는 게 목표입니다.",
                    },
                    {
                        externalMessageId: "succ-b901-5-m2",
                        role: "assistant",
                        content:
                            "기간이 정해져 있군요. 현재 상태를 알려 주시겠어요?",
                    },
                    {
                        externalMessageId: "succ-b901-5-m3",
                        role: "user",
                        content:
                            "동네 야산만 다녀 봤고 빙벽은 아직 못 오릅니다.",
                    },
                ],
            },
        ],
    },
];

/** The succ-8 cases these replace, in the same order. */
export const MEMORY_EVAL_SUCC9_RETIRED_CASE_IDS: readonly string[] = [
    "succ-assistant-ko-407",
    "succ-assistant-en-603",
    "succ-assistant-en-608",
    "succ-durable-en-423",
    "succ-durable-ko-422",
];
