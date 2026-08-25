/**
 * Successor batch batch-104 — `durable_facts:ko`. **CANDIDATE.**
 *
 * Not dataset. Nothing scores these until a person adopts them
 * (`docs/ops/memory-extraction-eval-dataset.md` §6.2).
 *
 * A schema-2 rework of `lib/memoryExtractionEvalAdopted/batch009DurableKo.ts`.
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
    const id = nextId("succ-b104");
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

export const BATCH_104_DURABLE_KO: readonly MemoryEvalCaseV2[] = [
    {
        // A phobia is mental-health information, so it is held for review.
        id: "succ-durable-ko-51",
        sourceCaseId: "cand-durable-ko2-26",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["고소공포"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("높이", [
                ["user", "고소공포증이 심해서 높은 데는 아예 못 갑니다."],
                ["assistant", "높은 곳이 포함된 선택지는 제외하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-52",
        sourceCaseId: "cand-durable-ko2-27",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["강아지"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("외출", [
                ["user", "강아지를 혼자 오래 못 두는 편이라 네 시간 넘는 외출은 어렵습니다."],
                ["assistant", "그 시간 안에서 제안드릴게요."],
            ]),
        ],
    },
    {
        // A stated ongoing physical condition.
        id: "succ-durable-ko-53",
        sourceCaseId: "cand-durable-ko2-28",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["무릎"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("몸", [
                ["user", "무릎이 안 좋아서 계단이나 등산은 무리예요. 이건 나아지지 않는 조건입니다."],
                ["assistant", "무릎에 부담 가는 선택지는 빼겠습니다."],
            ]),
        ],
    },
    {
        // A prescribed diet is treatment, not a taste.
        id: "succ-durable-ko-54",
        sourceCaseId: "cand-durable-ko2-29",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["저염"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("식단", [
                ["user", "저염식을 해야 합니다. 의사 지시라 조절이 아니라 아예 지켜야 하는 거예요."],
                ["assistant", "나트륨 기준으로 걸러서 말씀드리겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-55",
        sourceCaseId: "cand-durable-ko2-30",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["이직"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("정한 것", [
                ["user", "고민 끝에 이직하기로 결정했습니다. 다음 달에 얘기 꺼낼 거예요."],
                ["assistant", "그 결정을 전제로 준비 얘기를 하죠."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-56",
        sourceCaseId: "cand-durable-ko2-31",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["자취"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("독립", [
                ["user", "올해 안에 자취하기로 정했어요. 이건 번복 안 합니다."],
                ["assistant", "정하신 걸로 두고 이어가겠습니다."],
            ]),
        ],
    },
    {
        // Skipping graduate school and building experience instead are two
        // sides of one decision, not two memories.
        id: "succ-durable-ko-57",
        sourceCaseId: "cand-durable-ko2-32",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["대학원"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("진학", [
                ["user", "대학원은 안 가기로 했습니다. 대신 실무로 쌓기로요."],
                ["assistant", "실무 경로 기준으로 말씀드릴게요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-58",
        sourceCaseId: "cand-durable-ko2-33",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["경차"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("차", [
                ["user", "차는 경차로 가기로 했어요. 유지비 때문에 그렇게 정했습니다."],
                ["assistant", "그 조건에서 골라 드리겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-59",
        sourceCaseId: "cand-durable-ko2-34",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "relationship",
                mustInclude: ["조카"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("가족", [
                ["user", "조카 셋을 자주 봐요. 큰애가 초등학생이고 아래로 둘이 더 있습니다."],
                ["assistant", "그 연령대를 감안해서 말씀드릴게요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-60",
        sourceCaseId: "cand-durable-ko2-35",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "relationship",
                mustInclude: ["남동생"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("형제", [
                ["user", "남동생이 한 명 있고 같은 회사에 다닙니다. 부서는 다르고요."],
                ["assistant", "그 관계를 반영하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-61",
        sourceCaseId: "cand-durable-ko2-36",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "relationship",
                mustInclude: ["시부모"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("동거", [
                ["user", "시부모님과 함께 살고 있어요. 집 구조 얘기할 때 그 부분이 걸립니다."],
                ["assistant", "동거 가족을 전제로 말씀드릴게요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-62",
        sourceCaseId: "cand-durable-ko2-37",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "relationship",
                mustInclude: ["룸메이트"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("주거", [
                ["user", "룸메이트랑 둘이 살아요. 공간을 반반 나눠 쓰는 구조입니다."],
                ["assistant", "공유 공간 기준으로 이어가겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-63",
        sourceCaseId: "cand-durable-ko2-38",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "recurring_context",
                mustInclude: ["새벽"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("근무", [
                ["user", "새벽에 일하고 낮에 잡니다. 그래서 오후 연락이 어려워요."],
                ["assistant", "연락 가능한 시간대를 그렇게 잡겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-64",
        sourceCaseId: "cand-durable-ko2-39",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "recurring_context",
                mustInclude: ["봉사"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("주말", [
                ["user", "토요일 오전은 늘 봉사 활동이 있습니다. 몇 년째 고정이에요."],
                ["assistant", "그 시간은 비워 두겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-65",
        sourceCaseId: "cand-durable-ko2-40",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "recurring_context",
                mustInclude: ["격주"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("출장", [
                ["user", "격주로 지방 출장을 갑니다. 이틀씩 자리를 비워요."],
                ["assistant", "그 주기를 반영해서 계획 세우죠."],
            ]),
        ],
    },
    {
        // Residual: an explanatory manner rather than depth, register or format.
        id: "succ-durable-ko-66",
        sourceCaseId: "cand-durable-ko2-41",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "communication_style",
                mustInclude: ["비유"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("설명 방식", [
                ["user", "비유를 들어서 설명해 주시면 훨씬 잘 들어와요."],
                ["assistant", "그럼 비유를 섞어서 말씀드리겠습니다."],
            ]),
        ],
    },
    {
        // Residual, and the clearest case of it: asking before assuming is a way
        // of conducting the exchange, not a property of the answer.
        id: "succ-durable-ko-67",
        sourceCaseId: "cand-durable-ko2-42",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "communication_style",
                mustInclude: ["질문"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("되묻기", [
                ["user", "애매하면 그냥 넘기지 말고 질문을 먼저 해주세요. 잘못 짚고 가는 게 더 손해라서요."],
                ["assistant", "불확실한 지점은 먼저 여쭙겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-68",
        sourceCaseId: "cand-durable-ko2-43",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "tone",
                mustInclude: ["담백"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("말투", [
                ["user", "칭찬이나 추임새 없이 담백하게 말해 주세요."],
                ["assistant", "그렇게 하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-69",
        sourceCaseId: "cand-durable-ko2-44",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "verbosity",
                mustInclude: ["자세히"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("분량", [
                ["user", "저는 자세히 받는 걸 좋아합니다. 길어도 괜찮아요."],
                ["assistant", "분량을 넉넉히 잡겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-70",
        sourceCaseId: "cand-durable-ko2-45",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "structure",
                mustInclude: ["단계"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("구성", [
                ["user", "설명은 단계별로 나눠서 주세요. 한 덩어리로 오면 못 따라갑니다."],
                ["assistant", "단계를 나눠 드리겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-71",
        sourceCaseId: "cand-durable-ko2-46",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "formatting",
                mustInclude: ["목록"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("형식", [
                ["user", "줄글보다 목록 형태가 읽기 편해요."],
                ["assistant", "목록으로 정리해 드리겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-72",
        sourceCaseId: "cand-durable-ko2-47",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "language",
                mustInclude: ["영어"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("답변 언어", [
                ["user", "한국어로 물어봐도 답은 영어로 주세요. 영어 감을 유지하려고요."],
                ["assistant", "I'll answer in English from here."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-73",
        sourceCaseId: "cand-durable-ko2-48",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "explanation_depth",
                mustInclude: ["원리"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("깊이", [
                ["user", "방법만 알려주지 마시고 원리까지 같이 설명해 주세요."],
                ["assistant", "배경까지 함께 짚겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-74",
        sourceCaseId: "cand-durable-ko2-49",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "citation_preference",
                mustInclude: ["출처"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("근거", [
                ["user", "사실 관계를 말할 때는 출처를 같이 달아 주세요. 확인하고 싶어서요."],
                ["assistant", "근거를 함께 표시하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-75",
        sourceCaseId: "cand-durable-ko2-50",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "code_style",
                mustInclude: ["주석"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("코드", [
                ["user", "코드 예시에는 주석을 촘촘히 달아 주세요. 나중에 다시 볼 때 필요해서요."],
                ["assistant", "설명 주석을 붙여서 드리겠습니다."],
            ]),
        ],
    },
];
