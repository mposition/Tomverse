/**
 * Successor batch batch-107 — `durable_facts:ko`. **CANDIDATE.**
 *
 * Not dataset. Nothing scores these until a person adopts them
 * (`docs/ops/memory-extraction-eval-dataset.md` §6.2).
 *
 * A schema-2 rework of `lib/memoryExtractionEvalAdopted/batch011DurableKo.ts`.
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
    const id = nextId("succ-b107");
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

export const BATCH_107_DURABLE_KO: readonly MemoryEvalCaseV2[] = [
    {
        id: "succ-durable-ko-76",
        sourceCaseId: "cand-durable-ko3-1",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["광주"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("사는 곳", [
                ["user", "광주에 자리 잡은 지 십 년쯤 됐습니다. 옮길 생각은 없어요."],
                ["assistant", "그 지역 기준으로 안내드릴게요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-77",
        sourceCaseId: "cand-durable-ko3-2",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["78"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("나이대", [
                ["user", "78년생입니다. 연령대 얘기가 나오면 참고해 주세요."],
                ["assistant", "그 연령대를 기준으로 하겠습니다."],
            ]),
        ],
    },
    {
        // Colour vision deficiency is health information.
        id: "succ-durable-ko-78",
        sourceCaseId: "cand-durable-ko3-3",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["색약"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("시각", [
                ["user", "적록 색약이라 빨간 선 보라는 식의 설명은 저한테 안 통합니다."],
                ["assistant", "그래프는 색 대신 이름과 위치로 짚어 드릴게요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-79",
        sourceCaseId: "cand-durable-ko3-4",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["외동"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("형제", [
                ["user", "외동으로 자랐습니다. 형제 관련 얘기는 저한테 해당이 없어요."],
                ["assistant", "알겠습니다."],
            ]),
        ],
    },
    {
        // The user rules the health reading out themselves — "카페인 때문이 아니라
        // 그냥 취향" — so this stays bulk-safe.
        id: "succ-durable-ko-80",
        sourceCaseId: "cand-durable-ko3-5",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["녹차"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("마시는 것", [
                ["user", "커피는 안 마시고 녹차만 마십니다. 카페인 때문이 아니라 그냥 취향이에요."],
                ["assistant", "음료 얘기가 나오면 그쪽으로 맞추겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-81",
        sourceCaseId: "cand-durable-ko3-6",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["메신저"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("연락 수단", [
                ["user", "이메일보다 메신저가 훨씬 편합니다. 메일은 며칠씩 안 볼 때가 있어요."],
                ["assistant", "연락 방법은 메신저 기준으로 제안하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-82",
        sourceCaseId: "cand-durable-ko3-7",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["계단"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("이동", [
                ["user", "엘리베이터 두고 계단으로 다닙니다. 십 층까지는 그렇게 해요."],
                ["assistant", "그 습관을 전제로 하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-83",
        sourceCaseId: "cand-durable-ko3-8",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["도서관"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("작업 장소", [
                ["user", "집중해야 하는 일은 전부 도서관에서 합니다. 집에서는 안 돼요."],
                ["assistant", "작업 환경은 그쪽 기준으로 보겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-84",
        sourceCaseId: "cand-durable-ko3-9",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["소방관"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "recurring_context",
                mustInclude: ["3교대"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("직업", [
                ["user", "소방관입니다. 3교대라 생활 리듬이 일정하지 않아요."],
                ["assistant", "교대 근무를 전제로 답변드리겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-85",
        sourceCaseId: "cand-durable-ko3-10",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["수의사"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("일하는 곳", [
                ["user", "동네 동물병원에서 수의사로 일합니다."],
                ["assistant", "그 맥락을 반영하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-86",
        sourceCaseId: "cand-durable-ko3-11",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["미용사"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("하는 일", [
                ["user", "미용사로 일한 지 십이 년째입니다. 제 가게는 아니고 직원이에요."],
                ["assistant", "고용된 입장이라는 점 기억하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-87",
        sourceCaseId: "cand-durable-ko3-12",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["택배"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("직군", [
                ["user", "택배 일을 합니다. 하루에 이백 개 정도 돌려요."],
                ["assistant", "그 업무량을 전제로 하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-88",
        sourceCaseId: "cand-durable-ko3-13",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["사진"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "explanation_depth",
                mustInclude: ["용어"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("익숙한 분야", [
                ["user", "사진은 필름 현상까지 직접 합니다. 노출이나 현상 용어는 설명 안 하셔도 됩니다."],
                ["assistant", "용어는 그대로 쓰겠습니다."],
            ]),
        ],
    },
    {
        // "번역 없이 원문" could be a citation preference or an answer-language
        // instruction, and neither fits cleanly. Left as the expertise alone
        // rather than guessing a kind that exact matching would then punish.
        id: "succ-durable-ko-89",
        sourceCaseId: "cand-durable-ko3-14",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["독일어"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("언어 능력", [
                ["user", "독일어는 업무로 쓸 만큼 합니다. 번역 없이 원문 주셔도 돼요."],
                ["assistant", "원문 그대로 인용하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-90",
        sourceCaseId: "cand-durable-ko3-15",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["회계", "처음"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("새로 배우는 것", [
                ["user", "회계는 이번에 처음 봅니다. 차변 대변부터 모릅니다."],
                ["assistant", "기본 개념부터 짚어 드릴게요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-91",
        sourceCaseId: "cand-durable-ko3-16",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["암벽"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "explanation_depth",
                mustInclude: ["그레이드"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("운동", [
                ["user", "암벽 등반을 오래 했습니다. 그레이드 얘기는 그냥 하셔도 알아들어요."],
                ["assistant", "등급 표기는 그대로 쓰겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-92",
        sourceCaseId: "cand-durable-ko3-17",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["순례길"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("언젠가 할 일", [
                ["user", "산티아고 순례길을 완주하는 게 오래된 목표입니다. 시기는 아직이고요."],
                ["assistant", "그 목표를 기준으로 이야기하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-93",
        sourceCaseId: "cand-durable-ko3-18",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["카페"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("창업", [
                ["user", "결국은 작은 카페를 차리는 게 목표예요. 지금 준비 중인 것도 다 그거 때문입니다."],
                ["assistant", "그 방향으로 맞춰서 답변드릴게요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-94",
        sourceCaseId: "cand-durable-ko3-19",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["공인중개사"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("자격증", [
                ["user", "공인중개사 자격증을 따는 게 몇 년째 목표입니다."],
                ["assistant", "그 준비를 전제로 하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-95",
        sourceCaseId: "cand-durable-ko3-20",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["목조주택"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("집", [
                ["user", "언젠가 목조주택을 직접 지어서 살고 싶습니다. 그게 최종 목표예요."],
                ["assistant", "장기 목표로 기억하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-96",
        sourceCaseId: "cand-durable-ko3-21",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["족보"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("정리 중인 것", [
                ["user", "집안 족보를 디지털로 정리하고 있습니다. 삼 년째 하고 있어요."],
                ["assistant", "진행 중인 작업으로 두겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-97",
        sourceCaseId: "cand-durable-ko3-22",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["습관"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("만드는 것", [
                ["user", "습관 기록용 웹앱을 혼자 만들고 있어요. 아직 저만 씁니다."],
                ["assistant", "그 프로젝트를 기준으로 답변드릴게요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-98",
        sourceCaseId: "cand-durable-ko3-23",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["국토종주"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("자전거", [
                ["user", "자전거 국토종주를 준비하고 있습니다. 올가을 목표로요."],
                ["assistant", "그 일정에 맞춰 보겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-99",
        sourceCaseId: "cand-durable-ko3-24",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["대본"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("쓰는 것", [
                ["user", "지역 라디오에 나가는 대본을 매주 씁니다. 제 이름으로 나가는 건 아니고요."],
                ["assistant", "그 작업을 전제로 하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-100",
        sourceCaseId: "cand-durable-ko3-25",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["재택"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("근무 형태", [
                ["user", "재택으로 계속 가기로 회사랑 얘기 끝냈습니다. 다시 논의할 일은 없어요."],
                ["assistant", "재택을 고정으로 두겠습니다."],
            ]),
        ],
    },
];
