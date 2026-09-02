import type { MemoryEvalCaseV3 } from "@/lib/memoryEvalDatasetSchemaV3";

/**
 * Tranche 1 of the succ-7 replacements: the fourteen `assistant_only` cases,
 * six ko and eight en, all subtype 3.
 *
 * Each replaces one departing case and keeps its shape — same category and
 * language, same number of golds, same kind, polarity, `expectedDisposition`
 * and `criticalGoldMode` — while the conversation, the topic and the wording
 * are written fresh. The point is to test the same boundary again, not to
 * paraphrase the case that tested it: a replacement that reuses the original's
 * subject would carry the original's answer with it.
 *
 * The seven replacing `approved10` cases mirror the *approved* gold rather
 * than the succ-6 row, which carried none. Copying the empty row would undo
 * the decision that moved them (see
 * .github/audits/memory-eval-subtype3-readjudication-2026-09-02.md section 2.1).
 *
 * Every `factValueAll` token appears in its own `evidenceQuote`, because
 * `goldEvidenceFailure()` reads the quote and not the message: a gold anchored
 * to a span that does not contain its own words scores as unanchored however
 * true it is.
 */
export const SUCC7_ASSISTANT_ONLY: readonly MemoryEvalCaseV3[] = [
    {
        id: "succ-assistant-en-601",
        category: "assistant_only",
        language: "en",
        expected: [
            {
                id: "g1",
                kind: "occupation",
                polarity: "negated",
                factValueAll: ["carpenter"],
                evidence: {
                    evidenceMessageId: "succ-b701-1-m3",
                    evidenceQuote:
                        "I am not a carpenter",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        criticalGoldMode: "allow_expected_only",
        conversations: [
            {
                externalConversationId: "succ-b701-1",
                title: "Shelf brackets",
                messages: [
                    {
                        externalMessageId: "succ-b701-1-m1",
                        role: "user",
                        content:
                            "What spacing do you use for shelf brackets on a plasterboard wall?",
                    },
                    {
                        externalMessageId: "succ-b701-1-m2",
                        role: "assistant",
                        content:
                            "As a carpenter you will already know the stud centres vary; find those first.",
                    },
                    {
                        externalMessageId: "succ-b701-1-m3",
                        role: "user",
                        content:
                            "I am not a carpenter — I just put up shelves at home now and then.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-assistant-en-602",
        category: "assistant_only",
        language: "en",
        expected: [
            {
                id: "g1",
                kind: "recurring_context",
                polarity: "negated",
                factValueAll: ["bowling"],
                evidence: {
                    evidenceMessageId: "succ-b701-2-m3",
                    evidenceQuote:
                        "I do not go bowling on Thursdays or any other night",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        criticalGoldMode: "allow_expected_only",
        conversations: [
            {
                externalConversationId: "succ-b701-2",
                title: "Thursday evenings",
                messages: [
                    {
                        externalMessageId: "succ-b701-2-m1",
                        role: "user",
                        content:
                            "Can you suggest something to do on a Thursday evening?",
                    },
                    {
                        externalMessageId: "succ-b701-2-m2",
                        role: "assistant",
                        content:
                            "Since bowling already fills your Thursdays, here are alternatives for the other nights.",
                    },
                    {
                        externalMessageId: "succ-b701-2-m3",
                        role: "user",
                        content:
                            "I do not go bowling on Thursdays or any other night — that was a one-off booking.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-assistant-en-603",
        category: "assistant_only",
        language: "en",
        expected: [
            {
                id: "g1",
                kind: "expertise",
                polarity: "negated",
                factValueAll: ["archery"],
                evidence: {
                    evidenceMessageId: "succ-b701-3-m3",
                    evidenceQuote:
                        "I have never done archery",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        criticalGoldMode: "allow_expected_only",
        conversations: [
            {
                externalConversationId: "succ-b701-3",
                title: "Draw weight",
                messages: [
                    {
                        externalMessageId: "succ-b701-3-m1",
                        role: "user",
                        content:
                            "How is draw weight usually chosen?",
                    },
                    {
                        externalMessageId: "succ-b701-3-m2",
                        role: "assistant",
                        content:
                            "With your archery background you will recognise the trade-off already.",
                    },
                    {
                        externalMessageId: "succ-b701-3-m3",
                        role: "user",
                        content:
                            "I have never done archery. Please assume I know nothing about it.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-assistant-en-604",
        category: "assistant_only",
        language: "en",
        expected: [
            {
                id: "g1",
                kind: "constraint",
                polarity: "negated",
                factValueAll: ["bicycle"],
                evidence: {
                    evidenceMessageId: "succ-b701-4-m3",
                    evidenceQuote:
                        "I do not own a bicycle",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        criticalGoldMode: "allow_expected_only",
        conversations: [
            {
                externalConversationId: "succ-b701-4",
                title: "Across town at eight",
                messages: [
                    {
                        externalMessageId: "succ-b701-4-m1",
                        role: "user",
                        content:
                            "How long would it take to get across town at eight in the morning?",
                    },
                    {
                        externalMessageId: "succ-b701-4-m2",
                        role: "assistant",
                        content:
                            "By bicycle it is about twenty minutes along the canal path.",
                    },
                    {
                        externalMessageId: "succ-b701-4-m3",
                        role: "user",
                        content:
                            "I do not own a bicycle, so please leave that out of any route you suggest.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-assistant-en-605",
        category: "assistant_only",
        language: "en",
        expected: [
            {
                id: "g1",
                kind: "identity",
                polarity: "negated",
                factValueAll: ["coach", "surfing"],
                evidence: {
                    evidenceMessageId: "succ-b701-5-m3",
                    evidenceQuote:
                        "I am not the coach at the surfing club",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        criticalGoldMode: "allow_expected_only",
        conversations: [
            {
                externalConversationId: "succ-b701-5",
                title: "Session plan",
                messages: [
                    {
                        externalMessageId: "succ-b701-5-m1",
                        role: "user",
                        content:
                            "How would you structure a session for complete beginners?",
                    },
                    {
                        externalMessageId: "succ-b701-5-m2",
                        role: "assistant",
                        content:
                            "As the coach you will want to keep the group together in the shallows.",
                    },
                    {
                        externalMessageId: "succ-b701-5-m3",
                        role: "user",
                        content:
                            "I am not the coach at the surfing club — I only help carry the boards down.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-assistant-en-606",
        category: "assistant_only",
        language: "en",
        expected: [
            {
                id: "g1",
                kind: "identity",
                polarity: "negated",
                factValueAll: ["snooker", "society"],
                evidence: {
                    evidenceMessageId: "succ-b701-6-m3",
                    evidenceQuote:
                        "I am not the snooker society's secretary",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        criticalGoldMode: "allow_expected_only",
        conversations: [
            {
                externalConversationId: "succ-b701-6",
                title: "Fixture list",
                messages: [
                    {
                        externalMessageId: "succ-b701-6-m1",
                        role: "user",
                        content:
                            "What is a sensible way to lay out a fixture list?",
                    },
                    {
                        externalMessageId: "succ-b701-6-m2",
                        role: "assistant",
                        content:
                            "As the snooker society's secretary you will be circulating it yourself.",
                    },
                    {
                        externalMessageId: "succ-b701-6-m3",
                        role: "user",
                        content:
                            "I am not the snooker society's secretary. I just turn up and play.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-assistant-en-607",
        category: "assistant_only",
        language: "en",
        expected: [
            {
                id: "g1",
                kind: "occupation",
                polarity: "negated",
                factValueAll: ["tailor"],
                evidence: {
                    evidenceMessageId: "succ-b701-7-m3",
                    evidenceQuote:
                        "I was never trained as a tailor",
                },
                expectedDisposition: "bulk_safe",
            },
            {
                id: "g2",
                kind: "explanation_depth",
                polarity: "negated",
                factValueAll: ["pattern block"],
                evidence: {
                    evidenceMessageId: "succ-b701-7-m3",
                    evidenceQuote:
                        "a pattern block means nothing to me",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        criticalGoldMode: "allow_expected_only",
        conversations: [
            {
                externalConversationId: "succ-b701-7",
                title: "Taking in a jacket",
                messages: [
                    {
                        externalMessageId: "succ-b701-7-m1",
                        role: "user",
                        content:
                            "What is involved in taking a jacket in at the waist?",
                    },
                    {
                        externalMessageId: "succ-b701-7-m2",
                        role: "assistant",
                        content:
                            "You would adjust the pattern block and re-cut the side seams to match.",
                    },
                    {
                        externalMessageId: "succ-b701-7-m3",
                        role: "user",
                        content:
                            "I was never trained as a tailor, and a pattern block means nothing to me — please explain terms like that rather than using them.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-assistant-en-608",
        category: "assistant_only",
        language: "en",
        expected: [
            {
                id: "g1",
                kind: "expertise",
                polarity: "negated",
                factValueAll: ["houseplant"],
                evidence: {
                    evidenceMessageId: "succ-b701-8-m3",
                    evidenceQuote:
                        "I have no experience with houseplants at all",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        criticalGoldMode: "allow_expected_only",
        conversations: [
            {
                externalConversationId: "succ-b701-8",
                title: "Leaf drop",
                messages: [
                    {
                        externalMessageId: "succ-b701-8-m1",
                        role: "user",
                        content:
                            "Why would a plant drop leaves after being moved?",
                    },
                    {
                        externalMessageId: "succ-b701-8-m2",
                        role: "assistant",
                        content:
                            "Given your experience with houseplants you have probably seen this before.",
                    },
                    {
                        externalMessageId: "succ-b701-8-m3",
                        role: "user",
                        content:
                            "I have no experience with houseplants at all — this is the first one I have owned.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-assistant-ko-601",
        category: "assistant_only",
        language: "ko",
        expected: [
            {
                id: "g1",
                kind: "occupation",
                polarity: "negated",
                factValueAll: ["원장"],
                evidence: {
                    evidenceMessageId: "succ-b701-9-m3",
                    evidenceQuote:
                        "저는 원장이 아니라 수강생입니다",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        criticalGoldMode: "allow_expected_only",
        conversations: [
            {
                externalConversationId: "succ-b701-9",
                title: "수업 구성",
                messages: [
                    {
                        externalMessageId: "succ-b701-9-m1",
                        role: "user",
                        content:
                            "재봉틀 기초 수업을 어떻게 구성하면 좋을까요?",
                    },
                    {
                        externalMessageId: "succ-b701-9-m2",
                        role: "assistant",
                        content:
                            "원장님이시니 수강생 수준을 나눠 반을 편성하시면 됩니다.",
                    },
                    {
                        externalMessageId: "succ-b701-9-m3",
                        role: "user",
                        content:
                            "저는 원장이 아니라 수강생입니다. 배우는 입장에서 알려 주세요.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-assistant-ko-602",
        category: "assistant_only",
        language: "ko",
        expected: [
            {
                id: "g1",
                kind: "recurring_context",
                polarity: "negated",
                factValueAll: ["볼링"],
                evidence: {
                    evidenceMessageId: "succ-b701-10-m3",
                    evidenceQuote:
                        "저는 볼링을 치러 다니지 않습니다",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        criticalGoldMode: "allow_expected_only",
        conversations: [
            {
                externalConversationId: "succ-b701-10",
                title: "주말 계획",
                messages: [
                    {
                        externalMessageId: "succ-b701-10-m1",
                        role: "user",
                        content:
                            "주말에 할 만한 것을 추천해 주세요.",
                    },
                    {
                        externalMessageId: "succ-b701-10-m2",
                        role: "assistant",
                        content:
                            "주말마다 볼링을 치시니 그 외의 활동으로 골라 봤습니다.",
                    },
                    {
                        externalMessageId: "succ-b701-10-m3",
                        role: "user",
                        content:
                            "저는 볼링을 치러 다니지 않습니다. 한 번 가 본 것이 전부예요.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-assistant-ko-603",
        category: "assistant_only",
        language: "ko",
        expected: [
            {
                id: "g1",
                kind: "constraint",
                polarity: "negated",
                factValueAll: ["잔디"],
                evidence: {
                    evidenceMessageId: "succ-b701-11-m3",
                    evidenceQuote:
                        "저희 집 마당에는 잔디가 없습니다",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        criticalGoldMode: "allow_expected_only",
        conversations: [
            {
                externalConversationId: "succ-b701-11",
                title: "마당 손질",
                messages: [
                    {
                        externalMessageId: "succ-b701-11-m1",
                        role: "user",
                        content:
                            "마당을 어떻게 정리하면 좋을까요?",
                    },
                    {
                        externalMessageId: "succ-b701-11-m2",
                        role: "assistant",
                        content:
                            "잔디를 먼저 깎으시고 가장자리를 정리하시면 됩니다.",
                    },
                    {
                        externalMessageId: "succ-b701-11-m3",
                        role: "user",
                        content:
                            "저희 집 마당에는 잔디가 없습니다. 그 작업은 빼고 알려 주세요.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-assistant-ko-604",
        category: "assistant_only",
        language: "ko",
        expected: [
            {
                id: "g1",
                kind: "occupation",
                polarity: "negated",
                factValueAll: ["사범"],
                evidence: {
                    evidenceMessageId: "succ-b701-12-m3",
                    evidenceQuote:
                        "저는 사범이 아닙니다",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        criticalGoldMode: "allow_expected_only",
        conversations: [
            {
                externalConversationId: "succ-b701-12",
                title: "자세 교정",
                messages: [
                    {
                        externalMessageId: "succ-b701-12-m1",
                        role: "user",
                        content:
                            "당구에서 자세를 교정할 때 무엇을 먼저 봐야 하나요?",
                    },
                    {
                        externalMessageId: "succ-b701-12-m2",
                        role: "assistant",
                        content:
                            "사범님이시니 회원들 팔 각도부터 보시면 됩니다.",
                    },
                    {
                        externalMessageId: "succ-b701-12-m3",
                        role: "user",
                        content:
                            "저는 사범이 아닙니다. 그냥 취미로 배우는 사람입니다.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-assistant-ko-605",
        category: "assistant_only",
        language: "ko",
        expected: [
            {
                id: "g1",
                kind: "preference",
                polarity: "negated",
                factValueAll: ["화분", "두"],
                evidence: {
                    evidenceMessageId: "succ-b701-13-m3",
                    evidenceQuote:
                        "저는 집에 화분을 두지 않습니다",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        criticalGoldMode: "allow_expected_only",
        conversations: [
            {
                externalConversationId: "succ-b701-13",
                title: "거실 정리",
                messages: [
                    {
                        externalMessageId: "succ-b701-13-m1",
                        role: "user",
                        content:
                            "거실이 좀 넓어 보이게 하려면 어떻게 할까요?",
                    },
                    {
                        externalMessageId: "succ-b701-13-m2",
                        role: "assistant",
                        content:
                            "창가에 두신 화분들을 한쪽으로 모으시면 정리돼 보입니다.",
                    },
                    {
                        externalMessageId: "succ-b701-13-m3",
                        role: "user",
                        content:
                            "저는 집에 화분을 두지 않습니다. 다른 방법으로 알려 주세요.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-assistant-ko-606",
        category: "assistant_only",
        language: "ko",
        expected: [
            {
                id: "g1",
                kind: "occupation",
                polarity: "negated",
                factValueAll: ["재단"],
                evidence: {
                    evidenceMessageId: "succ-b701-14-m3",
                    evidenceQuote:
                        "저는 재단을 배운 적이 없고",
                },
                expectedDisposition: "bulk_safe",
            },
            {
                id: "g2",
                kind: "explanation_depth",
                polarity: "negated",
                factValueAll: ["문양"],
                evidence: {
                    evidenceMessageId: "succ-b701-14-m3",
                    evidenceQuote:
                        "문양 이름만 대시면 못 알아듣습니다",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        criticalGoldMode: "allow_expected_only",
        conversations: [
            {
                externalConversationId: "succ-b701-14",
                title: "저고리 수선",
                messages: [
                    {
                        externalMessageId: "succ-b701-14-m1",
                        role: "user",
                        content:
                            "한복 저고리 품을 줄이려면 어떤 작업이 필요한가요?",
                    },
                    {
                        externalMessageId: "succ-b701-14-m2",
                        role: "assistant",
                        content:
                            "문양 방향을 맞춰 재단선을 다시 잡으시면 됩니다.",
                    },
                    {
                        externalMessageId: "succ-b701-14-m3",
                        role: "user",
                        content:
                            "저는 재단을 배운 적이 없고, 문양 이름만 대시면 못 알아듣습니다. 용어를 풀어서 설명해 주세요.",
                    },
                ],
            },
        ],
    },
];
