/**
 * Successor batch batch-113 — `durable_facts:ko`. **CANDIDATE.**
 *
 * Not dataset. Nothing scores these until a person adopts them
 * (`docs/ops/memory-extraction-eval-dataset.md` §6.2).
 *
 * A schema-2 rework of `lib/memoryExtractionEvalAdopted/batch015DurableKo.ts` plus the
 * four seed cases declared directly in `lib/memoryExtractionEvalFixtures.ts`,
 * which predate the batch files.
 * Conversations are copied unchanged; the labelling follows
 * `docs/ops/memory-extraction-eval-dataset.md` §4.1.1–§4.1.3. Cases that
 * could not carry an exhaustive gold were rewritten instead, and those
 * declare no `sourceCaseId` because they copy nothing.
 *
 * What changed, case by case:
 * `docs/ops/memory-extraction-eval-batches/batch-102-114-rework-notes.md`.
 */

import type { MemoryEvalCaseV2 } from "@/lib/memoryEvalDatasetSchema";

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${(sequence += 1)}`;

const conversation = (
    title: string,
    turns: readonly (readonly [role: "user" | "assistant", content: string])[]
) => {
    const id = nextId("succ-b113");
    return {
        externalConversationId: id,
        title,
        messages: turns.map(([role, content], index) => ({
            externalMessageId: `${id}-m${index + 1}`,
            role,
            content,
        })),
    };
};

export const BATCH_113_DURABLE_KO: readonly MemoryEvalCaseV2[] = [
    {
        id: "succ-durable-ko-172",
        sourceCaseId: "cand-durable-ko5-1",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["어지럼"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("몸 상태", [
                ["user", "기립성 어지럼이 있어서 오래 서 있어야 하는 건 못 합니다."],
                ["assistant", "앉아서 할 수 있는 방법으로 드릴게요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-173",
        sourceCaseId: "cand-durable-ko5-2",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["허리"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("들 수 있는 것", [
                ["user", "허리 때문에 무거운 걸 못 듭니다. 오 킬로 넘으면 안 돼요."],
                ["assistant", "그 조건에 맞춰서만 제안하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-174",
        sourceCaseId: "cand-durable-ko5-3",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["노트북"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("장비", [
                ["user", "노트북이 십 년 된 거라 무거운 프로그램은 아예 안 돌아갑니다."],
                ["assistant", "가벼운 도구 위주로 골라 드릴게요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-175",
        sourceCaseId: "cand-durable-ko5-4",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["강원"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("사는 곳", [
                ["user", "강원도 산골에 삽니다. 가까운 마트도 차로 삼십 분이에요."],
                ["assistant", "접근성을 감안해서 보겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-176",
        sourceCaseId: "cand-durable-ko5-5",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["2001"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("나이", [
                ["user", "2001년생입니다. 사회 초년생이라고 보시면 돼요."],
                ["assistant", "그 기준으로 답변드릴게요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-177",
        sourceCaseId: "cand-durable-ko5-6",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["버스"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("이동", [
                ["user", "지하철보다 버스를 탑니다. 밖이 보여야 마음이 편해서요."],
                ["assistant", "경로는 버스 기준으로 안내하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-178",
        sourceCaseId: "cand-durable-ko5-7",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["손글씨"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("기록", [
                ["user", "메모는 손글씨로 합니다. 앱에 적으면 기억에 안 남아요."],
                ["assistant", "종이에 옮기기 좋은 형태로 정리해 드릴게요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-179",
        sourceCaseId: "cand-durable-ko5-8",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["승무원"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "recurring_context",
                mustInclude: ["열흘"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("직업", [
                ["user", "항공 승무원입니다. 한 달에 열흘은 해외에 있어요."],
                ["assistant", "그 일정으로 잡겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-180",
        sourceCaseId: "cand-durable-ko5-9",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["어업"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "recurring_context",
                mustInclude: ["날씨"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("하는 일", [
                ["user", "어업에 종사합니다. 날씨에 따라 일정이 통째로 바뀝니다."],
                ["assistant", "고정 일정은 피해서 제안하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-181",
        sourceCaseId: "cand-durable-ko5-10",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["뜨개질"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "explanation_depth",
                mustInclude: ["도안"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("익숙한 것", [
                ["user", "뜨개질은 삼십 년 했습니다. 도안 기호는 설명 없이 보셔도 됩니다."],
                ["assistant", "도안 표기는 그대로 쓰겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-182",
        sourceCaseId: "cand-durable-ko5-11",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["바둑"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "explanation_depth",
                mustInclude: ["정석"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("취미", [
                ["user", "바둑은 아마 오단입니다. 정석 이름은 그냥 말씀하셔도 알아들어요."],
                ["assistant", "용어를 그대로 쓰겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-183",
        sourceCaseId: "cand-durable-ko5-12",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["국악"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("언젠가", [
                ["user", "국악 무대에 한 번 서보는 게 오래된 목표입니다."],
                ["assistant", "그 목표를 기준으로 두겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-184",
        sourceCaseId: "cand-durable-ko5-13",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["게스트하우스"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("창업", [
                ["user", "게스트하우스를 여는 게 최종 목표예요. 자리를 알아보는 중입니다."],
                ["assistant", "그 방향으로 맞추겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-185",
        sourceCaseId: "cand-durable-ko5-14",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["웹툰"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("연재", [
                ["user", "웹툰을 격주로 연재하고 있습니다. 혼자 그리고 혼자 올려요."],
                ["assistant", "그 작업을 전제로 하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-186",
        sourceCaseId: "cand-durable-ko5-15",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["학회"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("준비 중", [
                ["user", "가을 학회 발표를 준비하고 있습니다. 초록은 넘겼고 슬라이드가 남았어요."],
                ["assistant", "그 일정에 맞춰 보겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-187",
        sourceCaseId: "cand-durable-ko5-16",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["헬스장"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("정리한 것", [
                ["user", "헬스장은 끊기로 했습니다. 집에서 하는 쪽으로 이미 정했어요."],
                ["assistant", "집에서 되는 방법만 드리겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-188",
        sourceCaseId: "cand-durable-ko5-17",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["서울"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("거주지", [
                ["user", "서울로는 안 올라가기로 결정했습니다. 그 얘기는 끝난 문제예요."],
                ["assistant", "지방에 머무는 전제로 보겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-189",
        sourceCaseId: "cand-durable-ko5-18",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "relationship",
                mustInclude: ["할머니"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("가족", [
                ["user", "할머니께 매일 전화를 드립니다. 그게 하루 일과 중 하나예요."],
                ["assistant", "그 습관을 감안하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-190",
        sourceCaseId: "cand-durable-ko5-19",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "relationship",
                mustInclude: ["처남"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("함께 일하는 사람", [
                ["user", "처남이랑 같이 가게를 합니다. 돈 얘기는 늘 같이 결정해요."],
                ["assistant", "공동 결정으로 두겠습니다."],
            ]),
        ],
    },
    {
        // A standing annual medical appointment, held for review on the same
        // reading as the weekly hospital visit in batch 108: the schedule is what
        // is stored, and nothing infers a condition from it.
        id: "succ-durable-ko-191",
        sourceCaseId: "cand-durable-ko5-20",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "recurring_context",
                mustInclude: ["정기검진"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("매년", [
                ["user", "매년 3월에 정기검진을 받습니다. 그 주는 병원 일정이 붙어 있어요."],
                ["assistant", "그 시기를 비워 두겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-192",
        sourceCaseId: "cand-durable-ko5-21",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "recurring_context",
                mustInclude: ["목요일"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("매주", [
                ["user", "목요일은 매주 야근입니다. 몇 년째 그렇습니다."],
                ["assistant", "목요일 저녁은 제외하겠습니다."],
            ]),
        ],
    },
    {
        // Re-labelled from `communication_style`. Examples before explanation is
        // an ordering instruction, and ordering has a dedicated kind — the same
        // call as its English counterpart in batch 102.
        id: "succ-durable-ko-193",
        sourceCaseId: "cand-durable-ko5-22",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "structure",
                mustInclude: ["예시"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("설명 순서", [
                ["user", "설명보다 예시를 먼저 보여 주세요. 예시를 봐야 이해가 됩니다."],
                ["assistant", "예시부터 놓고 설명하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-194",
        sourceCaseId: "cand-durable-ko5-23",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "verbosity",
                mustInclude: ["다섯 줄"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("분량", [
                ["user", "답변은 다섯 줄 정도가 딱 좋습니다. 그보다 길면 안 읽게 돼요."],
                ["assistant", "그 정도 길이로 맞추겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-195",
        sourceCaseId: "cand-durable-ko5-24",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "formatting",
                mustInclude: ["코드블록"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("표기", [
                ["user", "명령어는 코드블록으로 감싸 주세요. 복사할 때 섞이면 곤란해서요."],
                ["assistant", "그렇게 표시하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-196",
        sourceCaseId: "cand-durable-ko5-25",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "citation_preference",
                mustInclude: ["링크"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("자료 위치", [
                ["user", "링크는 본문에 섞지 말고 맨 끝에 모아 주세요. 읽는 흐름이 끊겨서요."],
                ["assistant", "마지막에 모아 두겠습니다."],
            ]),
        ],
    },
    {
        // REWRITTEN. The original ran occupation, shift pattern and a sleep
        // problem into one conversation, which no exhaustive gold survives —
        // and it is the case the mem-extract-v2 probe scored as three
        // candidates against a gold of one.
        id: "succ-durable-ko-197",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["간호사"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("직업", [
                ["user", "대학병원 간호사입니다."],
                ["assistant", "어떤 부분을 도와드릴까요?"],
                ["user", "환자 교육 자료를 정리하는 방법을 찾고 있어요."],
            ]),
        ],
    },
    {
        // Re-labelled from `preference`. A politeness register is register,
        // which has a dedicated kind. This is one of the two cases the probe
        // flagged as a taxonomy mismatch.
        id: "succ-durable-ko-198",
        sourceCaseId: "durable-ko-2",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "tone",
                mustInclude: ["존댓말"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("답변 방식", [
                ["user", "앞으로 답변은 존댓말로 해주세요."],
                ["assistant", "네, 존댓말로 답변드리겠습니다."],
            ]),
        ],
    },
    {
        // The goal and the current level are separate facts on separate turns,
        // and the gold now lists both.
        id: "succ-durable-ko-199",
        sourceCaseId: "durable-ko-3",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["일본어"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "expertise",
                mustInclude: ["회화"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("학습 계획", [
                ["user", "내년까지 일본어로 업무 회의를 할 수 있는 수준이 되는 게 목표예요."],
                ["assistant", "구체적인 목표네요. 지금 수준은 어느 정도인가요?"],
                ["user", "히라가나는 읽고 회화는 거의 못 합니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-200",
        sourceCaseId: "durable-ko-4",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["갑각류"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("식단 문의", [
                ["user", "갑각류 알레르기가 있어서 새우나 게가 들어간 건 못 먹습니다."],
                ["assistant", "알겠습니다. 갑각류를 뺀 식단으로 안내드릴게요."],
            ]),
        ],
    },
];
