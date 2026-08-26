/**
 * Successor batch batch-108 — `durable_facts:ko`. **Adopted. This is the successor dataset.**
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
    const id = nextId("succ-b108");
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

export const BATCH_108_DURABLE_KO: readonly MemoryEvalCaseV2[] = [
    {
        id: "succ-durable-ko-101",
        sourceCaseId: "cand-durable-ko3-26",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["보험"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("정리한 것", [
                ["user", "종신보험은 해지하기로 결정했습니다. 그 판단은 이미 끝났어요."],
                ["assistant", "다시 권하지 않겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-102",
        sourceCaseId: "cand-durable-ko3-27",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["학원"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("아이 교육", [
                ["user", "아이는 학원 안 보내기로 정했습니다. 집에서 봐주는 쪽으로요."],
                ["assistant", "그 전제로 이야기하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-103",
        sourceCaseId: "cand-durable-ko3-28",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["개명"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("이름", [
                ["user", "개명하기로 마음먹고 서류까지 넣었습니다. 되돌릴 생각은 없어요."],
                ["assistant", "결정된 사항으로 두겠습니다."],
            ]),
        ],
    },
    {
        // Re-labelled from `relationship` and normalised. The father's diagnosis
        // is not the memory; the shared-meal constraint it creates is. "사용자의
        // 아버지는 당뇨가 있다" satisfies only the first token, so the profile form
        // does not score.
        id: "succ-durable-ko-104",
        sourceCaseId: "cand-durable-ko3-29",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["당뇨", "음식"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("가족 건강", [
                ["user", "아버지가 당뇨가 있으셔서 같이 먹는 음식은 다 그걸 고려해야 합니다."],
                ["assistant", "식단 제안은 그 기준으로 드릴게요."],
            ]),
        ],
    },
    {
        // Kept as `relationship`. Whether the useful fact is the relation or the
        // schedule volatility is the same preference-versus-recurring_context
        // question the amendment left alone, so the adopted label stands.
        id: "succ-durable-ko-105",
        sourceCaseId: "cand-durable-ko3-30",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "relationship",
                mustInclude: ["배우자"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("집안 일정", [
                ["user", "배우자가 교대 근무라 저희 집 일정은 이 주 단위로 바뀝니다."],
                ["assistant", "고정 일정은 피해서 제안하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-106",
        sourceCaseId: "cand-durable-ko3-31",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "relationship",
                mustInclude: ["고양이"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("함께 사는", [
                ["user", "고양이 두 마리랑 삽니다. 집 관련 얘기는 그거 감안해 주세요."],
                ["assistant", "반려동물이 있는 집 기준으로 보겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-107",
        sourceCaseId: "cand-durable-ko3-32",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "relationship",
                mustInclude: ["사촌"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("동거", [
                ["user", "사촌이랑 같이 삽니다. 생활비도 반씩 나눠 내고요."],
                ["assistant", "그 구성으로 두겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-108",
        sourceCaseId: "cand-durable-ko3-33",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["견과"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("알레르기", [
                ["user", "견과류 알레르기가 심합니다. 레시피에 절대 넣지 말아 주세요."],
                ["assistant", "견과류는 전부 빼겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-109",
        sourceCaseId: "cand-durable-ko3-34",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["요금제"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("데이터", [
                ["user", "요금제가 저용량이라 영상 스트리밍이 필요한 방법은 못 씁니다."],
                ["assistant", "데이터를 적게 쓰는 쪽으로 안내할게요."],
            ]),
        ],
    },
    {
        // A named diagnosis. The user's own, so it is stored as stated rather
        // than minimised — minimisation is the third-party rule.
        id: "succ-durable-ko-110",
        sourceCaseId: "cand-durable-ko3-35",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["손목"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("타이핑", [
                ["user", "손목 터널 증후군이 있어서 오래 타이핑하는 방법은 피해야 합니다."],
                ["assistant", "입력을 줄이는 방향으로 제안하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-111",
        sourceCaseId: "cand-durable-ko3-36",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["평일 낮"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("시간", [
                ["user", "평일 낮에는 아예 시간을 못 냅니다. 그 시간대 전제인 방법은 빼주세요."],
                ["assistant", "저녁과 주말 기준으로만 제안하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-112",
        sourceCaseId: "cand-durable-ko3-37",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["소음"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("환경", [
                ["user", "층간 소음 문제가 있어서 소리 나는 활동은 집에서 못 합니다."],
                ["assistant", "조용한 대안으로 골라 드릴게요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-113",
        sourceCaseId: "cand-durable-ko3-38",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "recurring_context",
                mustInclude: ["첫째 주"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("매달", [
                ["user", "매달 첫째 주는 마감이라 다른 걸 얹을 수가 없습니다."],
                ["assistant", "그 주는 비워 두겠습니다."],
            ]),
        ],
    },
    {
        // A standing weekly hospital appointment says ongoing treatment even
        // without naming a condition, so it is held for review. The scheduling
        // fact is what is stored; nothing infers a diagnosis from it.
        id: "succ-durable-ko-114",
        sourceCaseId: "cand-durable-ko3-39",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "recurring_context",
                mustInclude: ["수요일"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("고정 일정", [
                ["user", "수요일 오후는 매주 병원에 갑니다. 몇 년째 그래요."],
                ["assistant", "수요일 오후는 빼고 잡겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-115",
        sourceCaseId: "cand-durable-ko3-40",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "recurring_context",
                mustInclude: ["명절"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("주기", [
                ["user", "명절마다 지방에 내려가 있어서 그때는 연락이 잘 안 됩니다."],
                ["assistant", "그 기간은 비는 것으로 두겠습니다."],
            ]),
        ],
    },
    {
        // Residual. Cutting the preamble is neither the reordering that
        // `structure` covers nor the length that `verbosity` covers.
        id: "succ-durable-ko-116",
        sourceCaseId: "cand-durable-ko3-41",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "communication_style",
                mustInclude: ["서론"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("답변 방식", [
                ["user", "서론 없이 바로 본론으로 가주세요. 앞에 붙는 말이 길면 안 읽게 돼요."],
                ["assistant", "바로 본론부터 쓰겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-117",
        sourceCaseId: "cand-durable-ko3-42",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "communication_style",
                mustInclude: ["반대"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("이견", [
                ["user", "제 생각이 틀렸다고 보이면 반대 의견을 그대로 말해 주세요. 맞춰 주실 필요 없습니다."],
                ["assistant", "다르게 보이면 그렇게 말씀드리겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-118",
        sourceCaseId: "cand-durable-ko3-43",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "tone",
                mustInclude: ["친근"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("말투", [
                ["user", "너무 딱딱하지 않게, 친근한 말투로 해주시면 좋겠어요."],
                ["assistant", "편한 말투로 쓰겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-119",
        sourceCaseId: "cand-durable-ko3-44",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "verbosity",
                mustInclude: ["세 문장"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("분량", [
                ["user", "답은 세 문장 안쪽으로 부탁드립니다. 더 필요하면 제가 물어볼게요."],
                ["assistant", "그 길이로 맞추겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-120",
        sourceCaseId: "cand-durable-ko3-45",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "structure",
                mustInclude: ["소제목"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("구성", [
                ["user", "긴 답변에는 소제목을 붙여 주세요. 나눠져 있어야 찾아보기 편합니다."],
                ["assistant", "구획을 나눠서 쓰겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-121",
        sourceCaseId: "cand-durable-ko3-46",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "formatting",
                mustInclude: ["굵게"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("강조", [
                ["user", "핵심 문장은 굵게 표시해 주세요. 훑어볼 때 필요해서요."],
                ["assistant", "중요한 부분은 굵게 쓰겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-122",
        sourceCaseId: "cand-durable-ko3-47",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "language",
                mustInclude: ["중국어"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("답변 언어", [
                ["user", "중국어 공부 중이라 답변은 중국어로 주시면 좋겠습니다."],
                ["assistant", "앞으로는 중국어로 답하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-123",
        sourceCaseId: "cand-durable-ko3-48",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "explanation_depth",
                mustInclude: ["실무"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("깊이", [
                ["user", "이론까지 파고들지 마시고 실무에서 쓸 만큼만 설명해 주세요."],
                ["assistant", "필요한 선까지만 다루겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-124",
        sourceCaseId: "cand-durable-ko3-49",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "citation_preference",
                mustInclude: ["공식 문서"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("근거", [
                ["user", "블로그 말고 공식 문서를 인용해 주세요. 그게 아니면 확인이 안 돼서요."],
                ["assistant", "1차 자료로 인용하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-125",
        sourceCaseId: "cand-durable-ko3-50",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "code_style",
                mustInclude: ["변수명"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("코드", [
                ["user", "코드 예시에서 변수명은 줄이지 말고 온전한 영어 단어로 써 주세요."],
                ["assistant", "축약 없이 쓰겠습니다."],
            ]),
        ],
    },
];
