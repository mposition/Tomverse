/**
 * Batch 001 — `durable_facts:ko`. **Adopted. This is dataset.**
 *
 * Reviewed and adopted on 2026-08-23, recorded in
 * `docs/ops/memory-extraction-eval-batches/batch-001-durable-facts-ko.md`:
 * five sampled cases (docs/ops/memory-extraction-eval-dataset.md §6.3's 20% for category ①) all 채택, draft
 * disagreement 0%, diversity judged sufficient, and the explicit batch
 * adoption line filled — which is what admits the twenty cases nobody sampled
 * (docs/ops/memory-extraction-eval-dataset.md §6.3: seeing the sample and saying nothing is not adoption).
 *
 * It moved out of `lib/memoryExtractionEvalCandidates/` rather than being
 * imported from there, because the candidate directory is what
 * `lib/memoryExtractionEvalFixtures.ts` is forbidden to import. Adoption has
 * to change where a file lives, or the barrier is a promise again.
 *
 * The `cand-` ids are kept. They are what the review record names, and a case
 * that cannot be traced back to the verdict that admitted it is a case whose
 * review cannot be checked (docs/ops/memory-extraction-eval-dataset.md §7.1 asks for the judgement basis on record).
 *
 * `tests/memoryEvalAdoptedBatches.test.mjs` re-reads that record on every run:
 * if the adoption line ever stops saying 채택, these cases stop being allowed
 * in the dataset.
 */

import type { MemoryEvalCase } from "@/lib/memoryExtractionEvalCore";

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${(sequence += 1)}`;

const conversation = (
    title: string,
    turns: readonly (readonly [role: "user" | "assistant", content: string])[]
) => {
    const id = nextId("cand-b001");
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

/**
 * 25 drafts for `durable_facts:ko`.
 *
 * Kind spread (docs/ops/memory-extraction-eval-dataset.md §3.2: no kind above 40% of the cell) — the widest of the two
 * here is 3/25 = 12%:
 *   constraint 3, preference 3, identity 2, occupation 2, expertise 2,
 *   long_term_goal 2, project 2, decision 2, relationship 2,
 *   recurring_context 1, communication_style 1, verbosity 1, language 1,
 *   code_style 1.
 *
 * docs/ops/memory-extraction-eval-dataset.md §3.1 asks for deliberate spread in length, register and topic: there are
 * one-line requests, long background dumps, a message with typos, one with an
 * emoji, and formal and casual registers. Names, emails and numbers are all
 * invented.
 */
export const BATCH_001_DURABLE_KO: readonly MemoryEvalCase[] = [
    {
        id: "cand-durable-ko-1",
        category: "durable_facts",
        language: "ko",
        expected: [{ id: "e1", kind: "constraint", mustInclude: ["갑각류"] }],
        conversations: [
            conversation("저녁 메뉴", [
                ["user", "저 갑각류 알레르기 있어서 새우나 게 들어간 건 빼주세요."],
                ["assistant", "알겠습니다. 갑각류 없는 메뉴로 골라 드릴게요."],
                ["user", "네 부탁드려요."],
            ]),
        ],
    },
    {
        id: "cand-durable-ko-2",
        category: "durable_facts",
        language: "ko",
        expected: [{ id: "e1", kind: "occupation", mustInclude: ["간호사"] }],
        conversations: [
            conversation("교대 근무 질문", [
                ["user", "제가 종합병원 간호사인데 3교대라 수면 패턴이 계속 깨져요. 야간 근무 끝나고 낮에 자려고 하면 두세 시간 만에 깨고, 다시 잠들기가 어렵습니다. 커피는 근무 시작할 때 한 잔만 마셔요."],
                ["assistant", "교대 근무 수면은 빛 노출 관리가 핵심입니다. 몇 가지 정리해 드릴게요."],
            ]),
        ],
    },
    {
        id: "cand-durable-ko-3",
        category: "durable_facts",
        language: "ko",
        expected: [{ id: "e1", kind: "verbosity", mustInclude: ["짧게"] }],
        conversations: [
            conversation("답변 길이", [
                ["user", "앞으로 짧게 대답해 주세요. 길면 안 읽게 돼요."],
                ["assistant", "네, 간결하게 답하겠습니다."],
            ]),
        ],
    },
    {
        id: "cand-durable-ko-4",
        category: "durable_facts",
        language: "ko",
        expected: [{ id: "e1", kind: "project", mustInclude: ["가계부", "앱"] }],
        conversations: [
            conversation("사이드 프로젝트", [
                ["user", "요즘 가계부 앱을 혼자 만들고 있어요. 주말에만 붙잡고 있는데 벌써 넉 달째네요 😅"],
                ["assistant", "넉 달이면 꽤 진행되셨겠는데요. 지금 어디가 막히시나요?"],
                ["user", "동기화 부분이요."],
            ]),
        ],
    },
    {
        id: "cand-durable-ko-5",
        category: "durable_facts",
        language: "ko",
        expected: [{ id: "e1", kind: "identity", mustInclude: ["부산"] }],
        conversations: [
            conversation("지역 정보", [
                ["user", "부산 살아요. 근처에 갈 만한 데 있을까요?"],
                ["assistant", "부산이시면 선택지가 많습니다. 어떤 분위기를 찾으세요?"],
            ]),
        ],
    },
    {
        id: "cand-durable-ko-6",
        category: "durable_facts",
        language: "ko",
        expected: [{ id: "e1", kind: "expertise", mustInclude: ["통계"] }],
        conversations: [
            conversation("분석 방법", [
                ["user", "통계는 대학원에서 전공해서 어느 정도 압니다. 기초 설명은 건너뛰고 바로 모델 선택 얘기로 가주세요."],
                ["assistant", "그럼 바로 들어가겠습니다."],
            ]),
        ],
    },
    {
        id: "cand-durable-ko-7",
        category: "durable_facts",
        language: "ko",
        expected: [{ id: "e1", kind: "long_term_goal", mustInclude: ["변호사"] }],
        conversations: [
            conversation("진로", [
                ["user", "최종 목표는 변호사가 되는 거예요. 지금은 직장 다니면서 준비 중이고요."],
                ["assistant", "직장과 병행하시는군요. 준비 기간은 어느 정도로 보고 계세요?"],
                ["user", "3년 정도요."],
            ]),
        ],
    },
    {
        id: "cand-durable-ko-8",
        category: "durable_facts",
        language: "ko",
        expected: [{ id: "e1", kind: "relationship", mustInclude: ["쌍둥이"] }],
        conversations: [
            conversation("가족", [
                ["user", "쌍둥이 아들 둘 키우고 있어요. 이제 여섯 살이요."],
                ["assistant", "여섯 살 쌍둥이면 한창 바쁘시겠어요."],
            ]),
        ],
    },
    {
        id: "cand-durable-ko-9",
        category: "durable_facts",
        language: "ko",
        expected: [{ id: "e1", kind: "code_style", mustInclude: ["탭"] }],
        conversations: [
            conversation("코드 스타일", [
                ["user", "코드 예시 줄 때 들여쓰기는 탭으로 해주세요. 스페이스는 안 씁니다."],
                ["assistant", "네, 탭으로 맞추겠습니다."],
            ]),
        ],
    },
    {
        id: "cand-durable-ko-10",
        category: "durable_facts",
        language: "ko",
        expected: [{ id: "e1", kind: "preference", mustInclude: ["창가"] }],
        conversations: [
            conversation("좌석", [
                ["user", "비행기 예약할 때는 늘 창가 자리로 잡아요."],
                ["assistant", "창가 선호시군요. 이번에도 같은 기준으로 볼까요?"],
            ]),
        ],
    },
    {
        id: "cand-durable-ko-11",
        category: "durable_facts",
        language: "ko",
        expected: [{ id: "e1", kind: "decision", mustInclude: ["postgres"] }],
        conversations: [
            conversation("DB 선택", [
                ["user", "고민 끝에 postgres 쓰기로 정했습니다. 이제 안 바꿀 거예요."],
                ["assistant", "정하셨군요. 그럼 그 전제로 스키마 얘기를 이어가죠."],
            ]),
        ],
    },
    {
        id: "cand-durable-ko-12",
        category: "durable_facts",
        language: "ko",
        expected: [{ id: "e1", kind: "constraint", mustInclude: ["휠체어"] }],
        conversations: [
            conversation("여행 계획", [
                ["user", "어머니가 휠체어를 쓰셔서 계단 있는 곳은 아예 못 갑니다. 이거 꼭 감안해 주세요."],
                ["assistant", "무장애 경로만 추려서 안내하겠습니다."],
            ]),
        ],
    },
    {
        id: "cand-durable-ko-13",
        category: "durable_facts",
        language: "ko",
        expected: [{ id: "e1", kind: "language", mustInclude: ["한국어"] }],
        conversations: [
            conversation("언어 설정", [
                ["user", "영어로 물어봐도 답은 한국어로 주세요."],
                ["assistant", "네, 질문 언어와 관계없이 한국어로 답하겠습니다."],
            ]),
        ],
    },
    {
        id: "cand-durable-ko-14",
        category: "durable_facts",
        language: "ko",
        expected: [{ id: "e1", kind: "occupation", mustInclude: ["세무사"] }],
        conversations: [
            conversation("업무 문의", [
                ["user", "세무사로 일한 지 12년 됐습니다."],
                ["assistant", "오래 하셨네요. 어떤 부분을 도와드릴까요?"],
                ["user", "요즘 상담 기록 정리 방법을 바꿔보려고요."],
            ]),
        ],
    },
    {
        id: "cand-durable-ko-15",
        category: "durable_facts",
        language: "ko",
        expected: [{ id: "e1", kind: "recurring_context", mustInclude: ["월요일", "회의"] }],
        conversations: [
            conversation("주간 일정", [
                ["user", "매주 월요일 아침에 팀 회의가 있어서 그때는 답장이 늦어요."],
                ["assistant", "월요일 오전은 피해서 잡으면 되겠네요."],
            ]),
        ],
    },
    {
        id: "cand-durable-ko-16",
        category: "durable_facts",
        language: "ko",
        expected: [{ id: "e1", kind: "expertise", mustInclude: ["용접"] }],
        conversations: [
            conversation("작업 문의", [
                ["user", "용접은 현장에서 20년 했습니다. 기본기 설명은 필요 없어요."],
                ["assistant", "알겠습니다. 바로 본론으로 가겠습니다."],
            ]),
        ],
    },
    {
        id: "cand-durable-ko-17",
        category: "durable_facts",
        language: "ko",
        expected: [{ id: "e1", kind: "preference", mustInclude: ["표", "정리"] }],
        conversations: [
            conversation("정리 방식", [
                ["user", "비교할 게 여러 개면 표로 정리해 주는 게 제일 편해요."],
                ["assistant", "그럼 비교는 표로 드리겠습니다."],
            ]),
        ],
    },
    {
        id: "cand-durable-ko-18",
        category: "durable_facts",
        language: "ko",
        expected: [{ id: "e1", kind: "identity", mustInclude: ["1986"] }],
        conversations: [
            conversation("나이 관련", [
                ["user", "1986년생이에요."],
                ["assistant", "네, 참고하겠습니다."],
                ["user", "그거 감안해서 추천해 주세요."],
            ]),
        ],
    },
    {
        id: "cand-durable-ko-19",
        category: "durable_facts",
        language: "ko",
        expected: [{ id: "e1", kind: "project", mustInclude: ["논문", "기후"] }],
        conversations: [
            conversation("연구", [
                ["user", "지금 기후 변화 관련 논문을 쓰고 있는데 자료 정리가 안 되네요. 인터뷰 스무 건이랑 통계 자료가 뒤섞여 있어서 어디서부터 손대야 할지 모르겠어요."],
                ["assistant", "자료 종류가 다르면 정리 축을 나누는 편이 낫습니다."],
            ]),
        ],
    },
    {
        id: "cand-durable-ko-20",
        category: "durable_facts",
        language: "ko",
        expected: [{ id: "e1", kind: "constraint", mustInclude: ["예산", "300"] }],
        conversations: [
            conversation("장비 구매", [
                ["user", "예산이 300만원을 못 넘습니다. 이 선은 절대 못 넘어요."],
                ["assistant", "300만원 안에서만 후보를 추리겠습니다."],
            ]),
        ],
    },
    {
        id: "cand-durable-ko-21",
        category: "durable_facts",
        language: "ko",
        expected: [{ id: "e1", kind: "communication_style", mustInclude: ["결론"] }],
        conversations: [
            conversation("답변 방식", [
                ["user", "결론 먼저 말해주고 이유는 뒤에 붙여주세요"],
                ["assistant", "네, 결론부터 말씀드리겠습니다."],
            ]),
        ],
    },
    {
        id: "cand-durable-ko-22",
        category: "durable_facts",
        language: "ko",
        expected: [{ id: "e1", kind: "decision", mustInclude: ["전세"] }],
        conversations: [
            conversation("주거", [
                ["user", "고민하다가 매매 말고 전세로 가기로 결정했어요."],
                ["assistant", "결정하셨군요. 그 방향으로 조건을 정리해 볼까요?"],
            ]),
        ],
    },
    {
        id: "cand-durable-ko-23",
        category: "durable_facts",
        language: "ko",
        expected: [{ id: "e1", kind: "relationship", mustInclude: ["동업자"] }],
        conversations: [
            conversation("사업", [
                ["user", "동업자랑 둘이서 운영하는 가게예요. 지분은 반반이고요."],
                ["assistant", "두 분이 반반이시군요. 어떤 부분을 정리하고 싶으세요?"],
            ]),
        ],
    },
    {
        id: "cand-durable-ko-24",
        category: "durable_facts",
        language: "ko",
        expected: [{ id: "e1", kind: "long_term_goal", mustInclude: ["귀농"] }],
        conversations: [
            conversation("계획", [
                ["user", "언젠가는 귀농할 생각이에요. 아직 시기는 안 정했지만 방향은 확실합니다."],
                ["assistant", "방향이 정해져 있으면 준비할 것들을 미리 볼 수 있겠네요."],
            ]),
        ],
    },
    {
        id: "cand-durable-ko-25",
        category: "durable_facts",
        language: "ko",
        expected: [{ id: "e1", kind: "preference", mustInclude: ["전화", "싫"] }],
        conversations: [
            conversation("연락 방식", [
                ["user", "전화 통화는 싫어해서 되도록 문자나 메일로 처리해요. 급한거 아니면 전화는 안받습니다"],
                ["assistant", "문자와 메일 위주로 안내드릴게요."],
            ]),
        ],
    },
];
