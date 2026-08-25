/**
 * Successor batch batch-111 — `durable_facts:ko`. **CANDIDATE.**
 *
 * Not dataset. Nothing scores these until a person adopts them
 * (`docs/ops/memory-extraction-eval-dataset.md` §6.2).
 *
 * A schema-2 rework of `lib/memoryExtractionEvalAdopted/batch013DurableKo.ts`.
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
    const id = nextId("succ-b111");
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

export const BATCH_111_DURABLE_KO: readonly MemoryEvalCaseV2[] = [
    {
        id: "succ-durable-ko-126",
        sourceCaseId: "cand-durable-ko4-1",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["밀가루"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("먹는 것", [
                ["user", "밀가루를 못 먹습니다. 셀리악이라 조금도 안 됩니다."],
                ["assistant", "밀가루가 들어간 건 전부 빼고 제안드릴게요."],
            ]),
        ],
    },
    {
        // Read as an intolerance rather than a taste — "심하게 민감" describes a
        // reaction, not a dislike.
        id: "succ-durable-ko-127",
        sourceCaseId: "cand-durable-ko4-2",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["냄새"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("민감한 것", [
                ["user", "인공적인 냄새에 심하게 민감해서 향 있는 제품은 못 씁니다."],
                ["assistant", "무향 제품 위주로 골라 드리겠습니다."],
            ]),
        ],
    },
    {
        // No licence. Contrast the night-driving case in batch 103, which is the
        // same surface constraint arising from health and therefore sensitive.
        id: "succ-durable-ko-128",
        sourceCaseId: "cand-durable-ko4-3",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["운전"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("이동 수단", [
                ["user", "운전을 못 합니다. 면허가 없어서 자차 전제인 방법은 안 됩니다."],
                ["assistant", "대중교통 기준으로만 안내하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-129",
        sourceCaseId: "cand-durable-ko4-4",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["주말"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("가능한 시간", [
                ["user", "주말에는 아예 시간을 못 냅니다. 가족 일정이 고정이라서요."],
                ["assistant", "평일 기준으로만 잡겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-130",
        sourceCaseId: "cand-durable-ko4-5",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["프린터"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("장비", [
                ["user", "집에 프린터가 없습니다. 출력해서 해야 하는 방법은 빼주세요."],
                ["assistant", "화면에서 끝나는 방법으로 안내할게요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-131",
        sourceCaseId: "cand-durable-ko4-6",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["인천"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("사는 곳", [
                ["user", "인천에 삽니다. 서울로 매일 나가지는 않아요."],
                ["assistant", "그 지역 기준으로 보겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-132",
        sourceCaseId: "cand-durable-ko4-7",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["65"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("나이대", [
                ["user", "65년생입니다. 은퇴 관련 얘기가 나오면 그 기준으로 봐주세요."],
                ["assistant", "그 연령대로 잡겠습니다."],
            ]),
        ],
    },
    {
        // Hearing loss is health information. Kept on the adopted kind, as with
        // the colour-vision case in batch 105: the amendment changed dispositions,
        // not the identity-versus-constraint axis.
        id: "succ-durable-ko-133",
        sourceCaseId: "cand-durable-ko4-8",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["난청"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("청력", [
                ["user", "한쪽 귀에 난청이 있습니다. 전화 통화는 잘 못 듣는 편이에요."],
                ["assistant", "소리에 의존하지 않는 방법을 우선 드리겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-134",
        sourceCaseId: "cand-durable-ko4-9",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["이중국적"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("국적", [
                ["user", "이중국적이라 서류 관련해서는 양쪽을 다 봐야 합니다."],
                ["assistant", "두 나라 기준을 함께 짚겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-135",
        sourceCaseId: "cand-durable-ko4-10",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["신문"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("정보 습득", [
                ["user", "뉴스는 종이 신문으로 봅니다. 앱은 안 씁니다."],
                ["assistant", "그 방식을 전제로 하겠습니다."],
            ]),
        ],
    },
    {
        // Stated as a habit — "그게 편해요" — with no hearing reason given, so it
        // stays bulk-safe. The batch's own hearing-loss case is the contrast.
        id: "succ-durable-ko-136",
        sourceCaseId: "cand-durable-ko4-11",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["자막"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("영상", [
                ["user", "한국어 영상도 자막을 켜고 봅니다. 그게 편해요."],
                ["assistant", "자막 있는 자료로 골라 드릴게요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-137",
        sourceCaseId: "cand-durable-ko4-12",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["혼밥"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("식사", [
                ["user", "혼밥이 편합니다. 여럿이 먹는 자리는 되도록 피해요."],
                ["assistant", "혼자 가기 좋은 곳 위주로 보겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-138",
        sourceCaseId: "cand-durable-ko4-13",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["현금"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("결제", [
                ["user", "가능하면 현금으로 냅니다. 카드 안 받는 곳도 상관없어요."],
                ["assistant", "결제 수단은 그 전제로 두겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-139",
        sourceCaseId: "cand-durable-ko4-14",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["치과위생사"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "recurring_context",
                mustInclude: ["토요일"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("직업", [
                ["user", "치과위생사로 일합니다. 토요일도 진료가 있어요."],
                ["assistant", "그 근무 형태를 반영하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-140",
        sourceCaseId: "cand-durable-ko4-15",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["과수원"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "recurring_context",
                mustInclude: ["수확기"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("일하는 곳", [
                ["user", "사과 과수원을 합니다. 수확기에는 아무것도 못 해요."],
                ["assistant", "농사 일정에 맞춰 보겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-141",
        sourceCaseId: "cand-durable-ko4-16",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["급식"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("하는 일", [
                ["user", "학교 급식실에서 조리사로 일합니다."],
                ["assistant", "그 맥락으로 두겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-142",
        sourceCaseId: "cand-durable-ko4-17",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["도배"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("직군", [
                ["user", "도배 일을 합니다. 현장마다 옮겨 다녀서 고정된 사무실은 없어요."],
                ["assistant", "현장 중심으로 보겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-143",
        sourceCaseId: "cand-durable-ko4-18",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["서예"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "explanation_depth",
                mustInclude: ["서체"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("익숙한 분야", [
                ["user", "서예를 이십 년 했습니다. 서체 이름은 그냥 쓰셔도 됩니다."],
                ["assistant", "용어는 그대로 쓰겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-144",
        sourceCaseId: "cand-durable-ko4-19",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["정비"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "explanation_depth",
                mustInclude: ["부품"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("손에 익은 일", [
                ["user", "자동차 정비는 제 전공이라 부품 이름은 설명 안 하셔도 됩니다."],
                ["assistant", "기초는 건너뛰겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-145",
        sourceCaseId: "cand-durable-ko4-20",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["프랑스어", "처음"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("새로 시작", [
                ["user", "프랑스어는 이번에 처음 배웁니다. 발음 규칙부터 모릅니다."],
                ["assistant", "기초부터 잡아 드릴게요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-146",
        sourceCaseId: "cand-durable-ko4-21",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["응급처치"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "explanation_depth",
                mustInclude: ["의학 용어"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("자격", [
                ["user", "응급처치 강사 자격이 있습니다. 의학 용어는 그대로 쓰셔도 됩니다."],
                ["assistant", "용어를 그대로 쓰겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-147",
        sourceCaseId: "cand-durable-ko4-22",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["시집"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("언젠가", [
                ["user", "시집을 한 권 내는 게 오래된 목표입니다. 아직 원고를 모으는 중이에요."],
                ["assistant", "그 목표를 기준으로 두겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-148",
        sourceCaseId: "cand-durable-ko4-23",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["세계일주"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("장기 계획", [
                ["user", "언젠가 세계일주를 하려고 지금 저축하고 있습니다."],
                ["assistant", "그 방향으로 맞추겠습니다."],
            ]),
        ],
    },
    {
        // "야간 과정을 알아보는 중" is looking into options, which the settled-choice
        // rule excludes from `decision` and from gold.
        id: "succ-durable-ko-149",
        sourceCaseId: "cand-durable-ko4-24",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["사회복지사"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("전직", [
                ["user", "사회복지사로 직업을 바꾸는 게 목표입니다. 야간 과정을 알아보는 중이에요."],
                ["assistant", "그 전제로 답변드릴게요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-150",
        sourceCaseId: "cand-durable-ko4-25",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["지도"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("만들고 있는 것", [
                ["user", "동네 골목길 지도를 직접 만들고 있습니다. 이 년째예요."],
                ["assistant", "진행 중인 작업으로 두겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-151",
        sourceCaseId: "cand-durable-ko4-26",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["앨범"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("음악", [
                ["user", "밴드에서 앨범을 녹음하고 있습니다. 다섯 곡까지 마쳤어요."],
                ["assistant", "그 프로젝트를 기준으로 하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-152",
        sourceCaseId: "cand-durable-ko4-27",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["한옥"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("고치는 중", [
                ["user", "시골에 있는 한옥을 고치고 있습니다. 주말마다 내려가요."],
                ["assistant", "주말 작업을 전제로 보겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-153",
        sourceCaseId: "cand-durable-ko4-28",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["티비"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("정리한 것", [
                ["user", "티비를 없애기로 하고 이미 처분했습니다. 다시 들일 생각 없어요."],
                ["assistant", "그 전제로 두겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-154",
        sourceCaseId: "cand-durable-ko4-29",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["상환"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("돈 쓰는 순서", [
                ["user", "투자보다 대출 상환을 먼저 하기로 정했습니다. 그 판단은 끝났습니다."],
                ["assistant", "상환 우선으로 보겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-155",
        sourceCaseId: "cand-durable-ko4-30",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["부업"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("일 정리", [
                ["user", "부업은 다 정리하기로 했습니다. 본업에만 집중하려고요."],
                ["assistant", "부업 관련 제안은 빼겠습니다."],
            ]),
        ],
    },
    {
        // Kept bulk-safe on the same boundary as the carer case in batch 110: a
        // care setting and a visiting rhythm, with no condition, diagnosis or
        // treatment stated.
        id: "succ-durable-ko-156",
        sourceCaseId: "cand-durable-ko4-31",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "relationship",
                mustInclude: ["어머니"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("가족", [
                ["user", "어머니가 요양원에 계셔서 주에 두 번은 다녀옵니다."],
                ["assistant", "그 일정을 감안하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-157",
        sourceCaseId: "cand-durable-ko4-32",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "relationship",
                mustInclude: ["딸"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("자녀", [
                ["user", "딸이 유학 중이라 시차 때문에 통화 시간이 늘 애매합니다."],
                ["assistant", "시차를 감안해서 보겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-158",
        sourceCaseId: "cand-durable-ko4-33",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "relationship",
                mustInclude: ["장인"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("함께 사는 분", [
                ["user", "장인어른과 함께 삽니다. 집 관련 결정은 늘 상의해서 합니다."],
                ["assistant", "그 구성으로 두겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-159",
        sourceCaseId: "cand-durable-ko4-34",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "recurring_context",
                mustInclude: ["분기"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("주기", [
                ["user", "분기마다 감사를 받아서 그 주는 다른 일을 못 잡습니다."],
                ["assistant", "그 시기는 비워 두겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-160",
        sourceCaseId: "cand-durable-ko4-35",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "recurring_context",
                mustInclude: ["토요일"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("고정 일정", [
                ["user", "토요일 오전은 매주 조기축구입니다. 몇 년째 빠진 적이 없어요."],
                ["assistant", "토요일 오전은 제외하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-161",
        sourceCaseId: "cand-durable-ko4-36",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "recurring_context",
                mustInclude: ["성수기"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("계절", [
                ["user", "여름이 성수기라 그 석 달은 거의 쉬는 날이 없습니다."],
                ["assistant", "그 기간은 여유가 없다고 보겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-162",
        sourceCaseId: "cand-durable-ko4-37",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "communication_style",
                mustInclude: ["모른다"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("확신 없을 때", [
                ["user", "확실하지 않으면 모른다고 말해 주세요. 지어낸 답이 제일 곤란합니다."],
                ["assistant", "모르는 건 모른다고 말씀드리겠습니다."],
            ]),
        ],
    },
    {
        // Marginal against `explanation_depth`. Keeping the term and adding a
        // short gloss is about handling vocabulary rather than about how deep to
        // go, so the residual is the honest choice.
        id: "succ-durable-ko-163",
        sourceCaseId: "cand-durable-ko4-38",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "communication_style",
                mustInclude: ["용어"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("전문 표현", [
                ["user", "전문 용어는 그대로 쓰시고 괄호로 짧게 풀어 주세요. 용어 자체를 알아야 해서요."],
                ["assistant", "용어는 남기고 옆에 풀이를 붙이겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-164",
        sourceCaseId: "cand-durable-ko4-39",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "tone",
                mustInclude: ["유머"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("말투", [
                ["user", "유머는 넣지 말고 진지하게만 답해 주세요."],
                ["assistant", "담백하게 쓰겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-165",
        sourceCaseId: "cand-durable-ko4-40",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "verbosity",
                mustInclude: ["한 문단"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("분량", [
                ["user", "답은 한 문단으로 부탁드립니다. 그 이상은 제가 요청할게요."],
                ["assistant", "한 문단 안에서 정리하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-166",
        sourceCaseId: "cand-durable-ko4-41",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "structure",
                mustInclude: ["요약"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("구성", [
                ["user", "긴 답변은 맨 앞에 요약을 붙여 주세요."],
                ["assistant", "요약을 먼저 쓰겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-167",
        sourceCaseId: "cand-durable-ko4-42",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "formatting",
                mustInclude: ["이모지"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("표기", [
                ["user", "이모지는 쓰지 말아 주세요. 업무 문서에 그대로 옮길 일이 많아서요."],
                ["assistant", "쓰지 않겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-168",
        sourceCaseId: "cand-durable-ko4-43",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "language",
                mustInclude: ["스페인어"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("답변 언어", [
                ["user", "스페인어로 답해 주세요. 공부 중이라 노출을 늘리려고요."],
                ["assistant", "Responderé en español."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-169",
        sourceCaseId: "cand-durable-ko4-44",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "explanation_depth",
                mustInclude: ["초등학생"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("설명 수준", [
                ["user", "초등학생한테 설명하듯 풀어 주세요. 전문 지식이 하나도 없습니다."],
                ["assistant", "쉬운 말로만 쓰겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-170",
        sourceCaseId: "cand-durable-ko4-45",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "citation_preference",
                mustInclude: ["연도"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("인용", [
                ["user", "자료를 인용할 때 연도까지 적어 주세요. 오래된 건 걸러야 해서요."],
                ["assistant", "발행 연도를 함께 쓰겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-171",
        sourceCaseId: "cand-durable-ko4-46",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "code_style",
                mustInclude: ["한 파일"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("코드", [
                ["user", "코드 예시는 파일을 나누지 말고 한 파일로 주세요. 옮겨 붙이기 편하게요."],
                ["assistant", "하나로 합쳐서 드리겠습니다."],
            ]),
        ],
    },
];
