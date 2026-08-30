/**
 * The ten cases written to replace the ten `succ-5` cases that B+ moves out.
 *
 * ## Why these are not ten more examples of the boundary rule
 *
 * The rule those ten cases formed — a retraction is not a negated memory, a
 * correction stores only what it newly establishes, a hypothetical and the
 * sentence closing it store nothing, a third party's relationship belongs to
 * the question — was approved on 2026-08-30
 * (.github/audits/memory-boundary-decision-2026-08-30.md §1, §1.1). Writing
 * their replacements against that rule would produce a decision set that
 * demonstrates the rule rather than tests it, and the demonstration would then
 * be cited as the rule's own evidence.
 *
 * So these are written against the **cell's** question instead, which is older
 * than the rule and independent of it: does the model mistake material it
 * produced itself, or material the user set up as fiction, for a fact about
 * the user? That is what the other 240 `assistant_only` cases ask — guessing
 * games, ghost-writing, role-play, translation of somebody else's words — and
 * these ten are drawn from the same population.
 *
 * Boundary shapes appear here only where they fall out of that question
 * naturally. None of these paraphrases an original or an example from the v7
 * draft: no relocation withdrawn, no sibling's pregnancy, no resignation
 * imagined, no nephew's letter, no mistyped age, no abandoned sport, no
 * conference city, no guessed occupation.
 *
 * ## All ten expect nothing
 *
 * Each replaces a `succ-5` case whose gold was empty, so the decision set's
 * shape is preserved on that axis: the cell keeps its 15 gold-carrying cases,
 * which are the ones where a user corrects the assistant and states something
 * real in doing so. Five of the ten being replaced were gold defects, and the
 * labels they should have carried live in the regression corpus rather than
 * here — the decision set never held them.
 */

import type { MemoryEvalCaseV3 } from "@/lib/memoryEvalDatasetSchemaV3";

/** Replacements for the six `assistant_only:ko` cases B+ moves. */
const KO: readonly MemoryEvalCaseV3[] = [
    {
        id: "succ-assistant-ko-501",
        category: "assistant_only",
        language: "ko",
        expected: [],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b601-1",
                title: "소설 대사",
                messages: [
                    {
                        externalMessageId: "succ-b601-1-m1",
                        role: "user",
                        content:
                            "제 소설 주인공 독백을 한 문단 써주세요. 1인칭으로요.",
                    },
                    {
                        externalMessageId: "succ-b601-1-m2",
                        role: "assistant",
                        content:
                            "나는 제주에서 자랐고 스무 살에 처음 배를 탔다. 그 뒤로 육지에서 오래 살아본 적이 없다.",
                    },
                    {
                        externalMessageId: "succ-b601-1-m3",
                        role: "user",
                        content: "좋네요. 이 톤으로 계속 가주세요.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-assistant-ko-502",
        category: "assistant_only",
        language: "ko",
        expected: [],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b601-2",
                title: "면접 예상 답변",
                messages: [
                    {
                        externalMessageId: "succ-b601-2-m1",
                        role: "user",
                        content:
                            "물류 직무 면접 예상 답변을 만들어주세요. 지원자가 말하는 것처럼요.",
                    },
                    {
                        externalMessageId: "succ-b601-2-m2",
                        role: "assistant",
                        content:
                            "저는 오 년 동안 창고 재고를 관리했고 야간 배차를 직접 짰습니다.",
                    },
                    {
                        externalMessageId: "succ-b601-2-m3",
                        role: "user",
                        content: "예시로 쓰기 좋겠어요.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-assistant-ko-503",
        category: "assistant_only",
        language: "ko",
        expected: [],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b601-3",
                title: "맞히기",
                messages: [
                    {
                        externalMessageId: "succ-b601-3-m1",
                        role: "user",
                        content: "제 혈액형 한번 맞혀보세요.",
                    },
                    {
                        externalMessageId: "succ-b601-3-m2",
                        role: "assistant",
                        content:
                            "말씀하시는 방식으로 보면 A형이실 것 같습니다.",
                    },
                    {
                        externalMessageId: "succ-b601-3-m3",
                        role: "user",
                        content: "그냥 놀이였어요. 답은 안 알려드릴게요.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-assistant-ko-504",
        category: "assistant_only",
        language: "ko",
        expected: [],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b601-4",
                title: "광고 카피",
                messages: [
                    {
                        externalMessageId: "succ-b601-4-m1",
                        role: "user",
                        content:
                            "원두 브랜드 카피를 소비자 목소리로 써주세요.",
                    },
                    {
                        externalMessageId: "succ-b601-4-m2",
                        role: "assistant",
                        content:
                            "매일 아침 이 커피 한 잔으로 하루를 엽니다. 벌써 삼 년째예요.",
                    },
                    {
                        externalMessageId: "succ-b601-4-m3",
                        role: "user",
                        content: "이걸로 시안 잡을게요.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-assistant-ko-505",
        category: "assistant_only",
        language: "ko",
        expected: [],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b601-5",
                title: "역할 바꾸기",
                messages: [
                    {
                        externalMessageId: "succ-b601-5-m1",
                        role: "user",
                        content:
                            "당신이 저라고 치고, 제 입장에서 이 상황을 설명해보세요.",
                    },
                    {
                        externalMessageId: "succ-b601-5-m2",
                        role: "assistant",
                        content:
                            "저는 야간 근무라 낮에는 연락이 어렵고, 주말에도 교대가 있습니다.",
                    },
                    {
                        externalMessageId: "succ-b601-5-m3",
                        role: "user",
                        content: "그런 식으로 쓰면 되겠네요.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-assistant-ko-506",
        category: "assistant_only",
        language: "ko",
        expected: [],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b601-6",
                title: "번역",
                messages: [
                    {
                        externalMessageId: "succ-b601-6-m1",
                        role: "user",
                        content:
                            "이 자기소개를 한국어로 옮겨주세요. 발표자 프로필입니다.",
                    },
                    {
                        externalMessageId: "succ-b601-6-m2",
                        role: "assistant",
                        content:
                            "저는 이십 년간 해양 생물을 연구했고 지금은 남해안에서 조사팀을 이끌고 있습니다.",
                    },
                    {
                        externalMessageId: "succ-b601-6-m3",
                        role: "user",
                        content: "감사합니다. 자료집에 넣겠습니다.",
                    },
                ],
            },
        ],
    },
];

/** Replacements for the four `assistant_only:en` cases B+ moves. */
const EN: readonly MemoryEvalCaseV3[] = [
    {
        id: "succ-assistant-en-501",
        category: "assistant_only",
        language: "en",
        expected: [],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b602-1",
                title: "Screenplay",
                messages: [
                    {
                        externalMessageId: "succ-b602-1-m1",
                        role: "user",
                        content:
                            "Write the opening monologue for my screenplay. First person, please.",
                    },
                    {
                        externalMessageId: "succ-b602-1-m2",
                        role: "assistant",
                        content:
                            "I have worked this stretch of coast since I was fifteen, and I have never once slept inland.",
                    },
                    {
                        externalMessageId: "succ-b602-1-m3",
                        role: "user",
                        content: "That's the voice. Keep going.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-assistant-en-502",
        category: "assistant_only",
        language: "en",
        expected: [],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b602-2",
                title: "Sample cover letter",
                messages: [
                    {
                        externalMessageId: "succ-b602-2-m1",
                        role: "user",
                        content:
                            "Draft a sample cover letter for a warehouse role, written as the applicant.",
                    },
                    {
                        externalMessageId: "succ-b602-2-m2",
                        role: "assistant",
                        content:
                            "I have spent six years on stock control and I hold a forklift licence.",
                    },
                    {
                        externalMessageId: "succ-b602-2-m3",
                        role: "user",
                        content: "Good, I'll use that as the template.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-assistant-en-503",
        category: "assistant_only",
        language: "en",
        expected: [],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b602-3",
                title: "Guessing game",
                messages: [
                    {
                        externalMessageId: "succ-b602-3-m1",
                        role: "user",
                        content: "Have a go at guessing my star sign.",
                    },
                    {
                        externalMessageId: "succ-b602-3-m2",
                        role: "assistant",
                        content:
                            "From how you write, I'd say Capricorn.",
                    },
                    {
                        externalMessageId: "succ-b602-3-m3",
                        role: "user",
                        content: "It was only a game. I'm not telling.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-assistant-en-504",
        category: "assistant_only",
        language: "en",
        expected: [],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b602-4",
                title: "Speaker profile",
                messages: [
                    {
                        externalMessageId: "succ-b602-4-m1",
                        role: "user",
                        content:
                            "Put this speaker profile into plain English for the programme.",
                    },
                    {
                        externalMessageId: "succ-b602-4-m2",
                        role: "assistant",
                        content:
                            "I have taught ceramics for thirty years and I still fire everything in a wood kiln.",
                    },
                    {
                        externalMessageId: "succ-b602-4-m3",
                        role: "user",
                        content: "Thanks, that goes in the booklet.",
                    },
                ],
            },
        ],
    },
];

export const MEMORY_EVAL_SUCC6_REPLACEMENTS: readonly MemoryEvalCaseV3[] = [
    ...KO,
    ...EN,
];
