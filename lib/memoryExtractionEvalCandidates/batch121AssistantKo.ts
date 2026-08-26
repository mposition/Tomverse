/**
 * Successor batch 121 — `assistant_only:ko`, cases 1–29. **CANDIDATE.**
 *
 * Not dataset. Nothing imports this outside the candidate index and its own
 * tests until a person adopts it, per
 * `docs/ops/memory-extraction-eval-dataset.md` §6.2.
 *
 * The conversations are unchanged and every case declares its `sourceCaseId`.
 * What schema 2 adds to a category ② case is `goldCompleteness`, and on an
 * empty gold that is the whole assertion: "nothing at all, and we finished
 * looking" is what `criticalBulkSafeAdoptions` counts against.
 *
 * ## No case here is mixed-critical
 *
 * Every one of the 250 `assistant_only` cases was read against the amended
 * contract before this rework was written, because the same screen was
 * skipped for `injection_directives` and cost two reversals. Seven carry a
 * health signal in a user turn, and all seven keep an empty gold:
 *
 *   * three are **negations** — "땅콩 알레르기 없습니다", "I don't have a nut
 *     allergy" — which is what batch 019 was written for. The sentence
 *     contains the whole of a durable fact except the part that reverses it,
 *     so the failure mode is extracting the *positive*, not missing it;
 *   * one is **retracted** in the next breath ("wrong chat");
 *   * three are **someone else's**, asked once. The amendment settles these
 *     outright: a third party's condition that changes nothing for the user
 *     yields nothing. `cand-assistant-ko-21` ("어머니가 당뇨 진단을 받으셨는데
 *     식단을 어떻게 바꿔야 하나요") is the near miss, and its pair is
 *     `succ-durable-ko-104` ("아버지가 당뇨가 있으셔서 같이 먹는 음식은 다
 *     그걸 고려해야 합니다"), which *does* carry a gold. The difference is an
 *     ongoing constraint on the user, not the diagnosis.
 *
 * A rework of the four seed cases and all 25 of batch 003 — guessing games,
 * fiction written in the first person, retracted statements and explicit
 * hypotheticals.
 */

import type { MemoryEvalCaseV2 } from "@/lib/memoryEvalDatasetSchema";

let sequence = 0;

const conversation = (
    title: string,
    turns: readonly (readonly [role: "user" | "assistant", content: string])[]
) => {
    const id = `succ-b121-${(sequence += 1)}`;
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

const assistantOnly = (
    index: number,
    sourceCaseId: string,
    title: string,
    turns: readonly (readonly [role: "user" | "assistant", content: string])[]
): MemoryEvalCaseV2 => ({
    id: `succ-assistant-ko-${index}`,
    sourceCaseId,
    category: "assistant_only",
    language: "ko",
    expected: [],
    goldCompleteness: "exhaustive",
    conversations: [conversation(title, turns)],
});

export const BATCH_121_ASSISTANT_KO: readonly MemoryEvalCaseV2[] = [
    assistantOnly(
        1,
        "assistant-ko-1",
        "추측 놀이",
        [
            ["user", "제 직업이 뭘 것 같아요? 맞혀보세요."],
            ["assistant", "말투로 보면 아마 광고 업계에서 기획 일을 하시는 것 같네요."],
            ["user", "아니에요, 틀렸어요."],
        ]
    ),
    assistantOnly(
        2,
        "assistant-ko-2",
        "역할극",
        [
            ["user", "제가 쓴 일기인 것처럼 한 편 써주세요."],
            ["assistant", "오늘 나는 부산으로 이사했고 새 회사에 첫 출근을 했다."],
            ["user", "잘 썼네요. 물론 지어낸 이야기고요."],
        ]
    ),
    assistantOnly(
        3,
        "assistant-ko-3",
        "정정된 정보",
        [
            ["user", "저는 부산에 삽니다."],
            ["assistant", "부산이시군요."],
            ["user", "아, 잘못 썼어요. 예전에 살았고 지금은 아닙니다. 기억하지 말아주세요."],
        ]
    ),
    assistantOnly(
        4,
        "assistant-ko-4",
        "가정 질문",
        [
            ["user", "제가 만약 채식주의자라면 뭘 추천하시겠어요?"],
            ["assistant", "채식을 하신다면 콩류와 두부를 늘리시는 게 좋습니다."],
            ["user", "네, 가정해서 물어본 거예요."],
        ]
    ),
    assistantOnly(
        5,
        "cand-assistant-ko-1",
        "말투로 추측하기",
        [
            ["user", "제가 어디 살 것 같아요?"],
            ["assistant", "말씀하시는 억양으로 보면 대구 쪽에 사시는 것 같네요."],
            ["user", "재밌네요. 맞히기 놀이였어요."],
        ]
    ),
    assistantOnly(
        6,
        "cand-assistant-ko-2",
        "나이 추측",
        [
            ["user", "제 나이를 한번 맞혀보세요."],
            ["assistant", "쓰시는 표현으로 보면 30대 초반이신 것 같습니다."],
            ["user", "ㅋㅋ 그냥 궁금해서 물어본 거예요."],
        ]
    ),
    assistantOnly(
        7,
        "cand-assistant-ko-3",
        "소설 속 화자",
        [
            ["user", "1인칭으로 짧은 소설 도입부 하나 써주세요."],
            ["assistant", "나는 열두 해 동안 등대지기로 살았다. 아내는 육지에 남았고 나는 그 겨울을 혼자 보냈다."],
            ["user", "좋네요. 이어서 써주세요."],
        ]
    ),
    assistantOnly(
        8,
        "cand-assistant-ko-4",
        "면접 역할극",
        [
            ["user", "면접관 역할을 해주세요. 저는 지원자 역할로 답해볼게요."],
            ["assistant", "그럼 시작하겠습니다. 자기소개 부탁드립니다."],
            ["user", "저는 삼성전자에서 8년간 반도체 공정을 담당했습니다. 연봉은 1억 2천이었고요."],
            ["assistant", "감사합니다. 다음 질문으로 넘어가겠습니다."],
        ]
    ),
    assistantOnly(
        9,
        "cand-assistant-ko-5",
        "즉시 정정",
        [
            ["user", "저는 채식주의자예요."],
            ["assistant", "알겠습니다."],
            ["user", "아 죄송해요, 잘못 보냈습니다. 다른 사람한테 쓰던 메시지였어요."],
        ]
    ),
    assistantOnly(
        10,
        "cand-assistant-ko-6",
        "예전 이야기",
        [
            ["user", "제가 대구에서 카페를 했었어요. 3년 전에 접었고 지금은 전혀 다른 일 합니다."],
            ["assistant", "지금 하시는 일 기준으로 답변드릴게요."],
        ]
    ),
    assistantOnly(
        11,
        "cand-assistant-ko-7",
        "친구 이야기",
        [
            ["user", "친구가 그러는데 걔는 글루텐 알레르기가 있어서 밀가루를 아예 못 먹는대요. 이런 경우 뭘 먹어야 하나요?"],
            ["assistant", "글루텐을 피해야 한다면 쌀이나 메밀 기반이 선택지입니다."],
        ]
    ),
    assistantOnly(
        12,
        "cand-assistant-ko-8",
        "동생 대신 질문",
        [
            ["user", "동생 대신 물어봐요. 동생이 지금 임신 7개월인데 먹으면 안 되는 게 뭐가 있나요?"],
            ["assistant", "일반적인 주의 목록은 있지만 담당 의사 확인이 우선입니다."],
        ]
    ),
    assistantOnly(
        13,
        "cand-assistant-ko-9",
        "이력서 번역",
        [
            ["user", "이 문장 영어로 번역해 주세요: 저는 2015년부터 서울에서 건축사로 일하고 있으며 주거 설계를 전문으로 합니다."],
            ["assistant", "I have worked as an architect in Seoul since 2015, specialising in residential design."],
        ]
    ),
    assistantOnly(
        14,
        "cand-assistant-ko-10",
        "자소서 첨삭",
        [
            ["user", "제가 쓴 게 아니라 후배 자기소개서인데 좀 봐주세요. 「저는 세 남매의 막내로 자라 어릴 때부터 책임감을…」"],
            ["assistant", "도입부가 상투적입니다. 구체적인 장면으로 여는 편이 낫습니다."],
        ]
    ),
    assistantOnly(
        15,
        "cand-assistant-ko-11",
        "가정법",
        [
            ["user", "제가 만약 지금 퇴사하고 유학을 간다면 어떤 준비가 필요할까요?"],
            ["assistant", "유학을 가신다면 어학 성적과 자금 계획이 먼저입니다."],
            ["user", "그냥 상상해 본 거예요. 아직 회사 잘 다니고 있습니다."],
        ]
    ),
    assistantOnly(
        16,
        "cand-assistant-ko-12",
        "반어법",
        [
            ["user", "네 저는 하루에 열여섯 시간씩 운동하는 사람이라서요. 당연히 아니고요, 요즘 거의 안 움직입니다."],
            ["assistant", "그럼 짧은 활동부터 시작하는 쪽으로 말씀드릴게요."],
        ]
    ),
    assistantOnly(
        17,
        "cand-assistant-ko-13",
        "샘플 데이터",
        [
            ["user", "테스트용 회원 데이터 3건만 만들어 주세요."],
            ["assistant", "이름: 박지훈 / 직업: 수의사 / 지역: 청주, 이름: 최유진 / 직업: 번역가 / 지역: 인천, 이름: 강민 / 직업: 도예가 / 지역: 여주."],
            ["user", "네 이걸로 화면 테스트할게요."],
        ]
    ),
    assistantOnly(
        18,
        "cand-assistant-ko-14",
        "리뷰 인용",
        [
            ["user", "이 리뷰 좀 요약해 주세요. 「저는 등산을 매주 가는 사람인데 이 신발은 두 달 만에 밑창이 떨어졌습니다.」"],
            ["assistant", "요약하면 내구성 불만이고, 사용 빈도가 높은 사용자 기준입니다."],
        ]
    ),
    assistantOnly(
        19,
        "cand-assistant-ko-15",
        "추론 부인",
        [
            ["user", "요즘 아침마다 손이 저려요."],
            ["assistant", "사무직으로 키보드를 오래 쓰시면 흔한 증상입니다."],
            ["user", "저 사무직 아닌데요. 그냥 증상만 물어본 거예요."],
        ]
    ),
    assistantOnly(
        20,
        "cand-assistant-ko-16",
        "브레인스토밍 캐릭터",
        [
            ["user", "웹툰 주인공 설정 좀 잡아주세요."],
            ["assistant", "스물여덟 살 소방관, 부산 출신, 고양이 두 마리와 삽니다."],
            ["user", "좋아요. 이 설정으로 1화 시놉시스 부탁해요."],
        ]
    ),
    assistantOnly(
        21,
        "cand-assistant-ko-17",
        "예시 인물",
        [
            ["user", "상속세 계산이 어떻게 되는지 예를 들어 설명해 주세요."],
            ["assistant", "예를 들어 배우자와 자녀 둘을 둔 사람이 10억을 남겼다고 하면, 공제 후 과세표준은…"],
            ["user", "이해했습니다."],
        ]
    ),
    assistantOnly(
        22,
        "cand-assistant-ko-18",
        "설문 문항 작성",
        [
            ["user", "설문 문항 초안 써주세요. 응답자 입장에서 1인칭으로요."],
            ["assistant", "「나는 주 3회 이상 대중교통을 이용한다」, 「나는 재택근무를 선호한다」 같은 형태가 됩니다."],
        ]
    ),
    assistantOnly(
        23,
        "cand-assistant-ko-19",
        "번복",
        [
            ["user", "저 서울 강서구 살아요."],
            ["assistant", "강서구시군요."],
            ["user", "아니다, 그건 회사 주소고 집은 다른 데예요. 집 주소는 말하고 싶지 않습니다."],
        ]
    ),
    assistantOnly(
        24,
        "cand-assistant-ko-20",
        "게임 캐릭터",
        [
            ["user", "제 캐릭터 설정이에요. 이름은 세라, 엘프 궁수, 나이는 이백 살."],
            ["assistant", "설정 반영해서 대사 만들어 드릴게요."],
        ]
    ),
    assistantOnly(
        25,
        "cand-assistant-ko-21",
        "타인의 진단",
        [
            ["user", "어머니가 당뇨 진단을 받으셨는데 식단을 어떻게 바꿔야 하나요?"],
            ["assistant", "혈당 부하가 낮은 식품 위주로 바꾸는 것이 일반적입니다."],
        ]
    ),
    assistantOnly(
        26,
        "cand-assistant-ko-22",
        "가상 인터뷰",
        [
            ["user", "제가 기자고 당신이 등산가라고 치고 인터뷰 형식으로 써주세요."],
            ["assistant", "「저는 열아홉에 처음 히말라야에 갔고 그 뒤로 스무 번을 올랐습니다.」"],
            ["user", "좋네요, 이대로 갑시다."],
        ]
    ),
    assistantOnly(
        27,
        "cand-assistant-ko-23",
        "번역된 편지",
        [
            ["user", "영어 편지 번역해 주세요: I retired last spring and moved to the coast with my wife."],
            ["assistant", "「저는 지난봄에 은퇴했고 아내와 함께 해안가로 이사했습니다.」"],
        ]
    ),
    assistantOnly(
        28,
        "cand-assistant-ko-24",
        "농담",
        [
            ["user", "제 취미는 잠자기랑 숨쉬기입니다 ㅋㅋㅋ 진지하게는 딱히 없어요."],
            ["assistant", "그럼 부담 없이 시작할 만한 것부터 몇 개 골라 드릴게요."],
        ]
    ),
    assistantOnly(
        29,
        "cand-assistant-ko-25",
        "오래된 대화 인용",
        [
            ["user", "예전에 제가 이렇게 썼더라고요. 「나는 올해 안에 이직할 것이다.」 지금 보니 결국 안 했네요."],
            ["assistant", "지금 상황 기준으로 다시 보시는 게 좋겠습니다."],
        ]
    ),
];
