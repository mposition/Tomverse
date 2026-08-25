/**
 * Successor batch batch-103 — `durable_facts:ko`. **CANDIDATE.**
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
    const id = nextId("succ-b103");
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

export const BATCH_103_DURABLE_KO: readonly MemoryEvalCaseV2[] = [
    {
        id: "succ-durable-ko-26",
        sourceCaseId: "cand-durable-ko2-1",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["대전"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("고향", [
                ["user", "대전에서 나고 자랐고 지금도 거기 삽니다."],
                ["assistant", "그럼 근처 기준으로 말씀드릴게요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-27",
        sourceCaseId: "cand-durable-ko2-2",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["93"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("나이", [
                ["user", "93년생입니다. 나이 얘기가 필요하면 참고해 주세요."],
                ["assistant", "알겠습니다."],
            ]),
        ],
    },
    {
        // Handedness is a physical trait, not a diagnosis, so it stays bulk-safe.
        id: "succ-durable-ko-28",
        sourceCaseId: "cand-durable-ko2-3",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["왼손잡이"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("손", [
                ["user", "저 왼손잡이라서 도구 추천할 때 그거 감안해 주시면 좋겠어요. 가위 같은 거요."],
                ["assistant", "왼손용이 따로 나오는 품목은 그걸로 골라 드릴게요."],
            ]),
        ],
    },
    {
        // REWRITTEN. The original added "막내라 그런지 결정을 미루는 편" — a durable
        // self-description a reviewer would fairly call a second memory, and one
        // whose kind is genuinely unclear. Rewritten to the birth order alone.
        id: "succ-durable-ko-29",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["셋째"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("형제 관계", [
                ["user", "삼남매 중 셋째로 자랐어요."],
                ["assistant", "형제 순서가 필요한 이야기면 반영하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-30",
        sourceCaseId: "cand-durable-ko2-5",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["아침"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("회의 시간", [
                ["user", "회의는 아침에 잡는 걸 선호합니다. 오후엔 집중이 잘 안 돼요."],
                ["assistant", "일정 제안은 오전 위주로 드리겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-31",
        sourceCaseId: "cand-durable-ko2-6",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["걸어"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("이동", [
                ["user", "삼십 분 안쪽 거리는 무조건 걸어 다닙니다."],
                ["assistant", "그 정도 거리는 도보 기준으로 안내할게요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-32",
        sourceCaseId: "cand-durable-ko2-7",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["중고"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("구매", [
                ["user", "웬만한 물건은 중고로 삽니다. 새것 사는 게 아까워서요."],
                ["assistant", "중고 매물 기준으로 골라 드릴게요."],
            ]),
        ],
    },
    {
        // A taste, not an intolerance. Nothing here is health information.
        id: "succ-durable-ko-33",
        sourceCaseId: "cand-durable-ko2-8",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["매운"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("음식", [
                ["user", "매운 걸 워낙 좋아해서 맵찔이용 메뉴는 안 알려주셔도 됩니다 🌶️"],
                ["assistant", "그럼 매운 정도가 있는 쪽으로 추천드릴게요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-34",
        sourceCaseId: "cand-durable-ko2-9",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["물리치료사"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("직업", [
                ["user", "물리치료사로 일한 지 7년 됐습니다."],
                ["assistant", "그 경력 기준으로 말씀드릴게요."],
            ]),
        ],
    },
    {
        // Six months at sea decides when this person is reachable, which is
        // useful without knowing the job title.
        id: "succ-durable-ko-35",
        sourceCaseId: "cand-durable-ko2-10",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["항해사"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "recurring_context",
                mustInclude: ["육 개월"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("승선", [
                ["user", "저는 항해사입니다. 육 개월씩 배를 타고 나가 있어서 연락이 뜸해요."],
                ["assistant", "장기 승선을 전제로 답변드리겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-36",
        sourceCaseId: "cand-durable-ko2-11",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["제빵"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "recurring_context",
                mustInclude: ["새벽 세 시"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("가게", [
                ["user", "제빵 일을 합니다. 새벽 세 시에 시작해서 오후 두 시에 끝나요."],
                ["assistant", "그 시간대를 기준으로 잡겠습니다."],
            ]),
        ],
    },
    {
        // "민원 응대가 주 업무" describes the same job rather than adding one.
        id: "succ-durable-ko-37",
        sourceCaseId: "cand-durable-ko2-12",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["공무원"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("직군", [
                ["user", "구청에서 공무원으로 일하고 있어요. 민원 응대가 주 업무입니다."],
                ["assistant", "그 맥락을 반영해서 답변드릴게요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-38",
        sourceCaseId: "cand-durable-ko2-13",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["엑셀"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "explanation_depth",
                mustInclude: ["기초"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("이미 아는 것", [
                ["user", "엑셀은 피벗이랑 함수까지 능숙하게 씁니다. 기초 설명은 빼주세요."],
                ["assistant", "기초는 건너뛰겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-39",
        sourceCaseId: "cand-durable-ko2-14",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["기타"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "explanation_depth",
                mustInclude: ["코드 이름"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("악기", [
                ["user", "클래식 기타를 십오 년 쳤습니다. 코드 이름 정도는 그냥 말씀하셔도 됩니다."],
                ["assistant", "용어는 그대로 쓰겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-40",
        sourceCaseId: "cand-durable-ko2-15",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["주식", "처음"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("투자", [
                ["user", "주식은 이번에 처음 시작합니다. 용어부터 모릅니다."],
                ["assistant", "그럼 용어부터 하나씩 짚겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-41",
        sourceCaseId: "cand-durable-ko2-16",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["목공"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("취미", [
                ["user", "목공은 취미로 오래 했어요. 대패질이나 짜맞춤 정도는 익숙합니다."],
                ["assistant", "그 수준을 전제로 설명드리겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-42",
        sourceCaseId: "cand-durable-ko2-17",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["책방"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("언젠가", [
                ["user", "언젠가 작은 책방을 여는 게 목표입니다. 아직 시기는 못 정했지만 방향은 확실해요."],
                ["assistant", "그 목표를 전제로 이야기하겠습니다."],
            ]),
        ],
    },
    {
        // REWRITTEN. "석사 2년 차" is a durable status that a reviewer would name,
        // and no kind fits it cleanly — `occupation` is for a job, `identity` for
        // an attribute. Rewritten to the goal alone rather than guessing.
        id: "succ-durable-ko-43",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["박사"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("학업 목표", [
                ["user", "최종적으로는 박사까지 갈 생각입니다. 오래전부터 정해 둔 목표예요."],
                ["assistant", "장기 계획 기준으로 답변드릴게요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-44",
        sourceCaseId: "cand-durable-ko2-19",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["제주"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("이주", [
                ["user", "오 년 안에 제주로 완전히 이주하려고 준비 중입니다."],
                ["assistant", "이주를 전제로 말씀드리겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-45",
        sourceCaseId: "cand-durable-ko2-20",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["쇼팽"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("연주", [
                ["user", "쇼팽 발라드 1번을 끝까지 치는 게 목표예요. 십 년째 붙잡고 있습니다."],
                ["assistant", "그 곡을 기준으로 연습 얘기를 이어가죠."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-46",
        sourceCaseId: "cand-durable-ko2-21",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["유튜브"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("채널", [
                ["user", "유튜브 채널을 혼자 굴리고 있어요. 편집까지 다 제가 합니다."],
                ["assistant", "1인 제작 기준으로 답변드릴게요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-47",
        sourceCaseId: "cand-durable-ko2-22",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["텃밭"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("주말농장", [
                ["user", "주말마다 텃밭을 가꿉니다. 스무 평 정도 되고 올해가 삼 년째예요."],
                ["assistant", "규모와 연차를 반영하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-48",
        sourceCaseId: "cand-durable-ko2-23",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["번역", "소설"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("작업 중", [
                ["user", "스페인어 소설 하나를 번역하고 있습니다. 출판 계약은 아직 없고 혼자 하는 작업이에요."],
                ["assistant", "그 상황을 전제로 말씀드릴게요."],
            ]),
        ],
    },
    {
        // The balance pass is where the project is today, not a durable fact.
        id: "succ-durable-ko-49",
        sourceCaseId: "cand-durable-ko2-24",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["보드게임"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("제작", [
                ["user", "보드게임을 하나 만들고 있어요. 규칙은 다 잡았고 지금은 밸런스 조정 중입니다."],
                ["assistant", "밸런스 단계 기준으로 이어가겠습니다."],
            ]),
        ],
    },
    {
        // Derived from health: the constraint exists because of impaired night
        // vision. Minimised to the constraint itself, and still sensitive —
        // normalising a health fact does not lower its disposition.
        id: "succ-durable-ko-50",
        sourceCaseId: "cand-durable-ko2-25",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["야간", "운전"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("운전", [
                ["user", "야간 운전은 못 합니다. 밤에 시야가 너무 흐려서요. 일정 짤 때 꼭 빼주세요."],
                ["assistant", "이동은 낮 시간으로만 잡겠습니다."],
            ]),
        ],
    },
];
