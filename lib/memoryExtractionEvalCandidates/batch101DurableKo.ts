/**
 * Successor batch 101 — `durable_facts:ko`, cases 1–25. **CANDIDATE.**
 *
 * Not dataset. Nothing imports this outside the candidate index and its own
 * tests until a person adopts it, per
 * `docs/ops/memory-extraction-eval-dataset.md` §6.2.
 *
 * ## What this batch is
 *
 * A schema-2 rework of `lib/memoryExtractionEvalAdopted/batch001DurableKo.ts`
 * under the 2026-08-25 scoring amendment
 * (`.github/audits/memory-eval-scoring-contract-amendment-2026-08-25.md`).
 * The conversations are unchanged — they were drafted and adopted on
 * 2026-08-23 and nothing in A–D touches them. What changes is the labelling:
 *
 *   * `kind` re-labelled where the amendment's kind taxonomy puts a
 *     dedicated kind ahead of a
 *     generic one;
 *   * `expectedDisposition` written on every expected memory;
 *   * `goldCompleteness` written on every case, and the gold completed where
 *     the old single-memory gold was not the whole truth;
 *   * `decision` restricted to settled choices.
 *
 * The conversations are restated as literals rather than re-exported from the
 * frozen batch. Deriving them would tie this file's content to a file that is
 * frozen for a different contract, and the review record has to name what a
 * reviewer actually read.
 *
 * ## Traceability
 *
 * Each case carries the id of the frozen case it reworks in `sourceCaseId`,
 * so the adoption record can be checked against the 2026-08-23 one. Ids are
 * new (`succ-durable-ko-*`) because the labels are new: reusing the old id
 * would make two different gold labels answer to one name.
 *
 * ## Judgement calls
 *
 * Five cases needed a call that the rules constrain but do not settle, and
 * three of those calls decide how the remaining 375 cases get written. They
 * are set out one by one in
 * `docs/ops/memory-extraction-eval-batches/batch-101-rework-notes.md`, which
 * is a separate file because the review sheet next to it is generated and
 * would overwrite anything written into it.
 */

import type { MemoryEvalCaseV2 } from "@/lib/memoryEvalDatasetSchema";

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${(sequence += 1)}`;

const conversation = (
    title: string,
    turns: readonly (readonly [role: "user" | "assistant", content: string])[]
) => {
    const id = nextId("succ-b101");
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

export const BATCH_101_DURABLE_KO: readonly MemoryEvalCaseV2[] = [
    {
        // Allergy: extractable, held for review, never auto-approved.
        id: "succ-durable-ko-1",
        sourceCaseId: "cand-durable-ko-1",
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
            conversation("식사 제약", [
                ["user", "저 갑각류 알레르기 있어서 새우나 게 들어간 건 빼주세요."],
                ["assistant", "알겠습니다. 갑각류 없는 메뉴로 골라 드릴게요."],
                ["user", "네 부탁드려요."],
            ]),
        ],
    },
    {
        // Two independently useful facts: the job, and the shift
        // pattern that decides when this person is reachable. The sleep
        // complaint is not gold — see the batch record.
        id: "succ-durable-ko-2",
        sourceCaseId: "cand-durable-ko-2",
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
            {
                id: "e2",
                kind: "recurring_context",
                mustInclude: ["3교대"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("교대 근무", [
                [
                    "user",
                    "제가 종합병원 간호사인데 3교대라 수면 패턴이 계속 깨져요. 야간 근무 끝나고 낮에 자려고 하면 두세 시간 만에 깨고, 다시 잠들기가 어렵습니다. 커피는 근무 시작할 때 한 잔만 마셔요.",
                ],
                ["assistant", "교대 근무 수면은 빛 노출 관리가 핵심입니다. 몇 가지 정리해 드릴게요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-3",
        sourceCaseId: "cand-durable-ko-3",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "verbosity",
                mustInclude: ["짧게"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("답변 길이", [
                ["user", "앞으로 짧게 대답해 주세요. 길면 안 읽게 돼요."],
                ["assistant", "네, 간결하게 답하겠습니다."],
            ]),
        ],
    },
    {
        // "주말에만" rests on the same evidence as the project itself,
        // so it stays inside the one memory rather than becoming a second.
        id: "succ-durable-ko-4",
        sourceCaseId: "cand-durable-ko-4",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["가계부", "앱"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("개인 프로젝트", [
                [
                    "user",
                    "요즘 가계부 앱을 혼자 만들고 있어요. 주말에만 붙잡고 있는데 벌써 넉 달째네요 😅",
                ],
                ["assistant", "넉 달이면 꽤 진행되셨겠는데요. 지금 어디가 막히시나요?"],
                ["user", "동기화 부분이요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-5",
        sourceCaseId: "cand-durable-ko-5",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["부산"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("사는 곳", [
                ["user", "부산 살아요. 근처에 갈 만한 데 있을까요?"],
                ["assistant", "부산이시면 선택지가 많습니다. 어떤 분위기를 찾으세요?"],
            ]),
        ],
    },
    {
        // The expertise and the answer-style instruction are separate facts
        // resting on separate clauses: one says what this
        // person knows, the other says what to skip.
        id: "succ-durable-ko-6",
        sourceCaseId: "cand-durable-ko-6",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["통계"],
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
            conversation("전문성", [
                [
                    "user",
                    "통계는 대학원에서 전공해서 어느 정도 압니다. 기초 설명은 건너뛰고 바로 모델 선택 얘기로 가주세요.",
                ],
                ["assistant", "그럼 바로 들어가겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-7",
        sourceCaseId: "cand-durable-ko-7",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["변호사"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("목표", [
                ["user", "최종 목표는 변호사가 되는 거예요. 지금은 직장 다니면서 준비 중이고요."],
                ["assistant", "직장과 병행하시는군요. 준비 기간은 어느 정도로 보고 계세요?"],
                ["user", "3년 정도요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-8",
        sourceCaseId: "cand-durable-ko-8",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "relationship",
                mustInclude: ["쌍둥이"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("가족", [
                ["user", "쌍둥이 아들 둘 키우고 있어요. 이제 여섯 살이요."],
                ["assistant", "여섯 살 쌍둥이면 한창 바쁘시겠어요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-9",
        sourceCaseId: "cand-durable-ko-9",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "code_style",
                mustInclude: ["탭"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("코드 스타일", [
                ["user", "코드 예시 줄 때 들여쓰기는 탭으로 해주세요. 스페이스는 안 씁니다."],
                ["assistant", "네, 탭으로 맞추겠습니다."],
            ]),
        ],
    },
    {
        // The taxonomy keeps `preference` for what is NOT about how the
        // assistant answers. A seat choice is a fact about this person's
        // life, so the generic kind is the right one.
        id: "succ-durable-ko-10",
        sourceCaseId: "cand-durable-ko-10",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["창가"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("여행 선호", [
                ["user", "비행기 예약할 때는 늘 창가 자리로 잡아요."],
                ["assistant", "창가 선호시군요. 이번에도 같은 기준으로 볼까요?"],
            ]),
        ],
    },
    {
        // "정했습니다. 이제 안 바꿀 거예요" — settled, so `decision` admits it.
        id: "succ-durable-ko-11",
        sourceCaseId: "cand-durable-ko-11",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["postgres"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("기술 선택", [
                ["user", "고민 끝에 postgres 쓰기로 정했습니다. 이제 안 바꿀 거예요."],
                ["assistant", "정하셨군요. 그럼 그 전제로 스키마 얘기를 이어가죠."],
            ]),
        ],
    },
    {
        // A family member's mobility. The sensitive scope names 진단·질환 without
        // restricting it to the account holder, and the whole point of the
        // sensitive lane is that nobody's health is auto-approved.
        id: "succ-durable-ko-12",
        sourceCaseId: "cand-durable-ko-12",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["휠체어"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("이동 제약", [
                ["user", "어머니가 휠체어를 쓰셔서 계단 있는 곳은 아예 못 갑니다. 이거 꼭 감안해 주세요."],
                ["assistant", "무장애 경로만 추려서 안내하겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-13",
        sourceCaseId: "cand-durable-ko-13",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "language",
                mustInclude: ["한국어"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("답변 언어", [
                ["user", "영어로 물어봐도 답은 한국어로 주세요."],
                ["assistant", "네, 질문 언어와 관계없이 한국어로 답하겠습니다."],
            ]),
        ],
    },
    {
        // "12년" is how long the job has been held, not separate
        // demonstrated expertise, so it does not become a second memory.
        id: "succ-durable-ko-14",
        sourceCaseId: "cand-durable-ko-14",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["세무사"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("직업", [
                ["user", "세무사로 일한 지 12년 됐습니다."],
                ["assistant", "오래 하셨네요. 어떤 부분을 도와드릴까요?"],
                ["user", "요즘 상담 기록 정리 방법을 바꿔보려고요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-15",
        sourceCaseId: "cand-durable-ko-15",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "recurring_context",
                mustInclude: ["월요일", "회의"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("주간 일정", [
                ["user", "매주 월요일 아침에 팀 회의가 있어서 그때는 답장이 늦어요."],
                ["assistant", "월요일 오전은 피해서 잡으면 되겠네요."],
            ]),
        ],
    },
    {
        // Same shape as ko-6, labelled the same way on purpose.
        id: "succ-durable-ko-16",
        sourceCaseId: "cand-durable-ko-16",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["용접"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "explanation_depth",
                mustInclude: ["기본기"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("현장 경력", [
                ["user", "용접은 현장에서 20년 했습니다. 기본기 설명은 필요 없어요."],
                ["assistant", "알겠습니다. 바로 본론으로 가겠습니다."],
            ]),
        ],
    },
    {
        // Re-labelled from `preference`. This IS about how the assistant
        // presents an answer, and the dedicated kind comes first.
        id: "succ-durable-ko-17",
        sourceCaseId: "cand-durable-ko-17",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "formatting",
                mustInclude: ["표"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("비교 방식", [
                ["user", "비교할 게 여러 개면 표로 정리해 주는 게 제일 편해요."],
                ["assistant", "그럼 비교는 표로 드리겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-18",
        sourceCaseId: "cand-durable-ko-18",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["1986"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("나이", [
                ["user", "1986년생이에요."],
                ["assistant", "네, 참고하겠습니다."],
                ["user", "그거 감안해서 추천해 주세요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-19",
        sourceCaseId: "cand-durable-ko-19",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["논문", "기후"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("연구", [
                [
                    "user",
                    "지금 기후 변화 관련 논문을 쓰고 있는데 자료 정리가 안 되네요. 인터뷰 스무 건이랑 통계 자료가 뒤섞여 있어서 어디서부터 손대야 할지 모르겠어요.",
                ],
                ["assistant", "자료 종류가 다르면 정리 축을 나누는 편이 낫습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-20",
        sourceCaseId: "cand-durable-ko-20",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["예산", "300"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("예산", [
                ["user", "예산이 300만원을 못 넘습니다. 이 선은 절대 못 넘어요."],
                ["assistant", "300만원 안에서만 후보를 추리겠습니다."],
            ]),
        ],
    },
    {
        // Re-labelled from `communication_style`. Answer ordering has a
        // dedicated kind, and `communication_style` is the generic style
        // bucket that the taxonomy puts last.
        id: "succ-durable-ko-21",
        sourceCaseId: "cand-durable-ko-21",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "structure",
                mustInclude: ["결론"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("답변 순서", [
                ["user", "결론 먼저 말해주고 이유는 뒤에 붙여주세요"],
                ["assistant", "네, 결론부터 말씀드리겠습니다."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-22",
        sourceCaseId: "cand-durable-ko-22",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["전세"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("주거 결정", [
                ["user", "고민하다가 매매 말고 전세로 가기로 결정했어요."],
                ["assistant", "결정하셨군요. 그 방향으로 조건을 정리해 볼까요?"],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-23",
        sourceCaseId: "cand-durable-ko-23",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "relationship",
                mustInclude: ["동업자"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("동업", [
                ["user", "동업자랑 둘이서 운영하는 가게예요. 지분은 반반이고요."],
                ["assistant", "두 분이 반반이시군요. 어떤 부분을 정리하고 싶으세요?"],
            ]),
        ],
    },
    {
        // The settled-choice rule's third branch: no date, but the direction is stated as
        // settled, so it is a long-term goal rather than something excluded
        // as weighing.
        id: "succ-durable-ko-24",
        sourceCaseId: "cand-durable-ko-24",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["귀농"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("계획", [
                ["user", "언젠가는 귀농할 생각이에요. 아직 시기는 안 정했지만 방향은 확실합니다."],
                ["assistant", "방향이 정해져 있으면 준비할 것들을 미리 볼 수 있겠네요."],
            ]),
        ],
    },
    {
        id: "succ-durable-ko-25",
        sourceCaseId: "cand-durable-ko-25",
        category: "durable_facts",
        language: "ko",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["전화"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("연락 방식", [
                [
                    "user",
                    "전화 통화는 싫어해서 되도록 문자나 메일로 처리해요. 급한거 아니면 전화는 안받습니다",
                ],
                ["assistant", "문자와 메일 위주로 안내드릴게요."],
            ]),
        ],
    },
];
