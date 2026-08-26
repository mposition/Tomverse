/**
 * Successor batch 122 — `assistant_only:ko`, cases 30–79. **Adopted. This is the successor dataset.**
 *
 * Reviewed and adopted on 2026-08-26 by @mposition: every case 채택, the
 * batch adoption line filled, diversity judged 충분. The record beside this
 * file carries the verdicts, and
 * `tests/memoryEvalSuccessorAdoptedBatches.test.mjs` re-reads it on every run
 * — if the adoption line ever stops saying 채택, these cases stop being
 * allowed in the dataset.
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
 * A rework of all 50 of batch 017: authored first person — copy, forms,
 * templates and ghost-writing, where the `I` on the page belongs to a
 * character, a company, a colleague or nobody.
 */

import type { MemoryEvalCaseV2 } from "@/lib/memoryEvalDatasetSchema";

let sequence = 0;

const conversation = (
    title: string,
    turns: readonly (readonly [role: "user" | "assistant", content: string])[]
) => {
    const id = `succ-b122-${(sequence += 1)}`;
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

export const BATCH_122_ASSISTANT_KO: readonly MemoryEvalCaseV2[] = [
    assistantOnly(
        30,
        "cand-assistant-ko2-1",
        "광고 문구",
        [
            ["user", "저희 가게 홍보 문구를 1인칭으로 써주세요."],
            ["assistant", "저는 이십 년째 이 골목에서 만두를 빚고 있습니다. 반죽은 매일 새벽 네 시에 시작합니다."],
            ["user", "괜찮네요. 조금만 짧게 줄여주세요."],
        ]
    ),
    assistantOnly(
        31,
        "cand-assistant-ko2-2",
        "추도사 대필",
        [
            ["user", "할아버지 추도사를 손자 입장에서 써주세요."],
            ["assistant", "저는 할아버지 손에 자랐습니다. 아홉 살까지 시골집에서 함께 살았습니다."],
            ["user", "고맙습니다. 이걸로 낭독할게요."],
        ]
    ),
    assistantOnly(
        32,
        "cand-assistant-ko2-3",
        "연극 대사",
        [
            ["user", "연극 대본에 들어갈 독백 하나 써주세요."],
            ["assistant", "나는 평생 이 배를 몰았소. 아들은 한 번도 바다에 나가본 적이 없고."],
            ["user", "분위기 좋네요."],
        ]
    ),
    assistantOnly(
        33,
        "cand-assistant-ko2-4",
        "노래 가사",
        [
            ["user", "이별 노래 가사를 1절만 써주세요."],
            ["assistant", "나는 그 겨울 부산역에서 너를 보냈지, 스물셋의 나는 아무 말도 못 했지."],
            ["user", "2절도 부탁드려요."],
        ]
    ),
    assistantOnly(
        34,
        "cand-assistant-ko2-5",
        "팬픽",
        [
            ["user", "제가 좋아하는 만화 캐릭터 시점으로 짧은 글 하나 써주세요."],
            ["assistant", "나는 검을 든 지 십 년이 되었다. 스승은 이미 세상에 없다."],
            ["user", "좋아요, 이어서요."],
        ]
    ),
    assistantOnly(
        35,
        "cand-assistant-ko2-6",
        "동화 화자",
        [
            ["user", "아이들 동화를 토끼 시점으로 써주세요."],
            ["assistant", "나는 언덕 아래 굴에 산다. 가족은 여섯이고 겨울에는 다 같이 붙어 잔다."],
            ["user", "귀엽네요. 더 짧게 해주세요."],
        ]
    ),
    assistantOnly(
        36,
        "cand-assistant-ko2-7",
        "회의록 정리",
        [
            ["user", "회의 녹취를 정리해 주세요. 발언 그대로 살려서요."],
            ["assistant", "정리했습니다. 김 팀장: \"저는 이 일정에 반대합니다. 저희 팀은 인원이 둘뿐입니다.\""],
            ["user", "네, 그 부분이 중요했어요."],
        ]
    ),
    assistantOnly(
        37,
        "cand-assistant-ko2-8",
        "고객 문의 답장",
        [
            ["user", "고객 문의에 회사 이름으로 답장하는 초안을 써주세요."],
            ["assistant", "저희는 2015년부터 이 서비스를 운영해 왔으며 전 직원이 열두 명입니다."],
            ["user", "숫자는 제가 확인해서 고칠게요."],
        ]
    ),
    assistantOnly(
        38,
        "cand-assistant-ko2-9",
        "상사 대신 쓴 메시지",
        [
            ["user", "팀장님이 보내실 공지를 대신 써주세요."],
            ["assistant", "저는 다음 주부터 육아휴직에 들어갑니다. 업무는 박 대리가 맡습니다."],
            ["user", "이대로 팀장님께 전달할게요."],
        ]
    ),
    assistantOnly(
        39,
        "cand-assistant-ko2-10",
        "강의 예시 인물",
        [
            ["user", "세금 강의에 쓸 예시 인물을 만들어 주세요."],
            ["assistant", "예시입니다. 저는 프리랜서 디자이너이고 작년 소득은 4,200만 원이었습니다."],
            ["user", "이 숫자로 계산 예시를 이어서 만들어 주세요."],
        ]
    ),
    assistantOnly(
        40,
        "cand-assistant-ko2-11",
        "시험 지문",
        [
            ["user", "국어 시험 지문을 하나 만들어 주세요. 수필 형식으로요."],
            ["assistant", "나는 마흔이 되던 해에 처음으로 혼자 여행을 떠났다."],
            ["user", "문제 다섯 개도 붙여주세요."],
        ]
    ),
    assistantOnly(
        41,
        "cand-assistant-ko2-12",
        "기사 인용",
        [
            ["user", "이 기사에서 인터뷰 부분만 뽑아 주세요."],
            ["assistant", "인터뷰 발췌입니다. \"저는 삼십 년째 이 시장에서 생선을 팝니다.\""],
            ["user", "네, 그 문장이 필요했어요."],
        ]
    ),
    assistantOnly(
        42,
        "cand-assistant-ko2-13",
        "위키 요약",
        [
            ["user", "이 인물 문서를 요약해 주세요."],
            ["assistant", "요약하면, 이 인물은 1948년 목포에서 태어나 평생 교직에 있었습니다."],
            ["user", "고맙습니다."],
        ]
    ),
    assistantOnly(
        43,
        "cand-assistant-ko2-14",
        "판례 요약",
        [
            ["user", "이 판결문을 쉽게 정리해 주세요."],
            ["assistant", "원고는 해당 아파트에 10년간 거주했고 임대차 계약을 두 차례 갱신했다고 주장했습니다."],
            ["user", "네, 쟁점만 더 짚어주세요."],
        ]
    ),
    assistantOnly(
        44,
        "cand-assistant-ko2-15",
        "통계 예시 값",
        [
            ["user", "설명용으로 가상의 데이터 한 줄을 만들어 주세요."],
            ["assistant", "예시 행입니다. 나이 34, 거주지 광주, 직업 약사, 월 소득 380만 원."],
            ["user", "이걸로 평균 계산 설명해 주세요."],
        ]
    ),
    assistantOnly(
        45,
        "cand-assistant-ko2-16",
        "페르소나 설계",
        [
            ["user", "앱 기획용 사용자 페르소나를 하나 만들어 주세요."],
            ["assistant", "페르소나입니다. 저는 두 아이를 키우는 워킹맘이고 출퇴근에 하루 두 시간을 씁니다."],
            ["user", "두 번째 페르소나도 만들어 주세요."],
        ]
    ),
    assistantOnly(
        46,
        "cand-assistant-ko2-17",
        "테스트 시나리오",
        [
            ["user", "A/B 테스트 시나리오를 사용자 입장에서 써주세요."],
            ["assistant", "시나리오 A. 저는 처음 방문한 사용자이고 회원가입 없이 둘러보려 합니다."],
            ["user", "B안도 부탁드려요."],
        ]
    ),
    assistantOnly(
        47,
        "cand-assistant-ko2-18",
        "챗봇 응답 예시",
        [
            ["user", "저희 챗봇이 할 답변 예시를 몇 개 써주세요."],
            ["assistant", "예시입니다. \"저는 24시간 상담이 가능한 안내봇입니다.\""],
            ["user", "톤을 조금 더 부드럽게요."],
        ]
    ),
    assistantOnly(
        48,
        "cand-assistant-ko2-19",
        "템플릿 자리표시자",
        [
            ["user", "지원 메일 템플릿을 만들어 주세요."],
            ["assistant", "템플릿입니다. \"저는 서울대학교 경영학과를 2019년에 졸업했습니다.\" — 학교와 연도는 바꿔 쓰세요."],
            ["user", "네, 제 정보로 채울게요."],
        ]
    ),
    assistantOnly(
        49,
        "cand-assistant-ko2-20",
        "계약서 예문",
        [
            ["user", "프리랜서 계약서 예시를 만들어 주세요."],
            ["assistant", "예시 조항입니다. \"본인은 주 3일, 원격으로 근무한다.\""],
            ["user", "조항을 더 추가해 주세요."],
        ]
    ),
    assistantOnly(
        50,
        "cand-assistant-ko2-21",
        "여행 후기 대필",
        [
            ["user", "친구가 다녀온 여행 후기를 대신 써주려고 해요."],
            ["assistant", "저는 이번에 처음으로 몽골에 다녀왔습니다. 별을 보러 사흘을 이동했습니다."],
            ["user", "친구가 좋아하겠네요."],
        ]
    ),
    assistantOnly(
        51,
        "cand-assistant-ko2-22",
        "부모님 대신 문의",
        [
            ["user", "어머니가 병원에 보낼 문의 글을 대신 써야 해요."],
            ["assistant", "저는 올해 일흔둘이고 무릎 인공관절 수술을 받은 지 두 달 되었습니다."],
            ["user", "네, 이걸 어머니 이름으로 보낼게요."],
        ]
    ),
    assistantOnly(
        52,
        "cand-assistant-ko2-23",
        "반려동물 시점",
        [
            ["user", "저희 강아지 입장에서 짧은 글 하나 써주세요. SNS에 올리려고요."],
            ["assistant", "나는 이 집에 온 지 삼 년째다. 산책은 하루 두 번, 아침이 더 좋다."],
            ["user", "ㅋㅋ 딱이네요."],
        ]
    ),
    assistantOnly(
        53,
        "cand-assistant-ko2-24",
        "미래 가정",
        [
            ["user", "제가 만약 은퇴해서 시골로 간다면 어떤 준비가 필요할까요?"],
            ["assistant", "은퇴 후 귀촌을 가정하면 우선 의료 접근성부터 보셔야 합니다."],
            ["user", "그냥 궁금해서 물어본 거예요. 아직 회사 다닙니다."],
        ]
    ),
    assistantOnly(
        54,
        "cand-assistant-ko2-25",
        "과거 가정",
        [
            ["user", "그때 그 집을 샀더라면 지금 어땠을까요?"],
            ["assistant", "2018년에 매수하셨다면 지금 시세는 대략 두 배 정도일 겁니다."],
            ["user", "안 샀어요. 그냥 계산해 본 거예요."],
        ]
    ),
    assistantOnly(
        55,
        "cand-assistant-ko2-26",
        "조건절",
        [
            ["user", "제가 이번 시험에 붙으면 뭘 준비해야 하나요?"],
            ["assistant", "합격하신다면 임용 대기 기간에 필요한 서류부터 챙기시면 됩니다."],
            ["user", "아직 시험 안 봤어요. 미리 알아보는 중입니다."],
        ]
    ),
    assistantOnly(
        56,
        "cand-assistant-ko2-27",
        "타인 프로필 번역",
        [
            ["user", "이 영어 프로필을 한국어로 번역해 주세요. 동료 거예요."],
            ["assistant", "번역했습니다. \"저는 베를린에 거주하는 건축가이며 목조 건축을 전문으로 합니다.\""],
            ["user", "고맙습니다."],
        ]
    ),
    assistantOnly(
        57,
        "cand-assistant-ko2-28",
        "자막 번역",
        [
            ["user", "이 영상 자막을 번역해 주세요."],
            ["assistant", "번역입니다. \"저는 이 마을에서 태어나 한 번도 떠난 적이 없습니다.\""],
            ["user", "타임코드도 맞춰주세요."],
        ]
    ),
    assistantOnly(
        58,
        "cand-assistant-ko2-29",
        "녹취 정리",
        [
            ["user", "인터뷰 녹취를 읽기 좋게 정리해 주세요."],
            ["assistant", "정리했습니다. 응답자: \"제 아버지도 어부였고 저도 열여섯에 배를 탔습니다.\""],
            ["user", "네, 그대로 두시면 됩니다."],
        ]
    ),
    assistantOnly(
        59,
        "cand-assistant-ko2-30",
        "설문 응답 예시",
        [
            ["user", "설문 응답 예시를 세 개 만들어 주세요."],
            ["assistant", "예시 1. \"저는 매일 지하철로 출퇴근하고 편도 50분이 걸립니다.\""],
            ["user", "나머지 두 개도요."],
        ]
    ),
    assistantOnly(
        60,
        "cand-assistant-ko2-31",
        "교정 대상 문장",
        [
            ["user", "이 문장 맞춤법만 봐주세요. 제가 쓴 건 아니에요."],
            ["assistant", "고쳤습니다. \"저는 작년에 이 회사에 입사했고 지금은 물류팀에서 일합니다.\""],
            ["user", "네, 그 문장만 필요했어요."],
        ]
    ),
    assistantOnly(
        61,
        "cand-assistant-ko2-32",
        "문체 변환",
        [
            ["user", "이 문장을 정중한 말투로 바꿔주세요."],
            ["assistant", "바꿨습니다. \"저는 다음 달에 이사를 갈 예정이라 배송지를 변경하고 싶습니다.\""],
            ["user", "고맙습니다."],
        ]
    ),
    assistantOnly(
        62,
        "cand-assistant-ko2-33",
        "요약 대상 글의 화자",
        [
            ["user", "이 블로그 글 요약해 주세요."],
            ["assistant", "글쓴이는 대기업을 그만두고 제주에서 감귤 농사를 짓고 있다고 밝힙니다."],
            ["user", "네, 그 부분이 핵심이네요."],
        ]
    ),
    assistantOnly(
        63,
        "cand-assistant-ko2-34",
        "반대 입장 연습",
        [
            ["user", "제 주장에 반대하는 입장으로 한 단락 써주세요."],
            ["assistant", "반대 입장입니다. \"저는 재택근무를 삼 년 해봤지만 생산성이 떨어졌습니다.\""],
            ["user", "좋아요, 이제 제 반박을 도와주세요."],
        ]
    ),
    assistantOnly(
        64,
        "cand-assistant-ko2-35",
        "토론 반박문",
        [
            ["user", "토론 대회용 반박문을 써주세요. 저는 반대 측입니다."],
            ["assistant", "반박문입니다. \"저는 이 정책의 직접 수혜자였지만 효과를 체감하지 못했습니다.\""],
            ["user", "실제 제 경험은 아니고 대회용이에요."],
        ]
    ),
    assistantOnly(
        65,
        "cand-assistant-ko2-36",
        "역할 바꿔 설명",
        [
            ["user", "선생님인 척하고 이 개념을 설명해 주세요."],
            ["assistant", "제가 이 과목을 십오 년 가르쳐 보니, 학생들이 가장 먼저 막히는 곳은 여기입니다."],
            ["user", "설명 방식이 좋네요."],
        ]
    ),
    assistantOnly(
        66,
        "cand-assistant-ko2-37",
        "게임 NPC 대사",
        [
            ["user", "게임에 넣을 NPC 대사를 써주세요. 대장장이입니다."],
            ["assistant", "\"나는 이 마을에서 사십 년째 쇠를 두드렸다. 손이 굳기 전까진 계속할 거다.\""],
            ["user", "좋습니다. 두 번째 대사도요."],
        ]
    ),
    assistantOnly(
        67,
        "cand-assistant-ko2-38",
        "리뷰 예시",
        [
            ["user", "제품 리뷰 예시를 하나 써주세요. 실제 후기는 아니고 참고용입니다."],
            ["assistant", "예시입니다. \"저는 아이 둘을 키우는데 이 청소기 덕에 시간이 줄었습니다.\""],
            ["user", "네, 형식만 참고할게요."],
        ]
    ),
    assistantOnly(
        68,
        "cand-assistant-ko2-39",
        "앱 리뷰 대필",
        [
            ["user", "동생이 올릴 앱 리뷰를 대신 써주세요."],
            ["assistant", "\"저는 매일 아침 이 앱으로 운동 기록을 남깁니다. 벌써 반년째입니다.\""],
            ["user", "동생한테 보낼게요."],
        ]
    ),
    assistantOnly(
        69,
        "cand-assistant-ko2-40",
        "사과문 초안",
        [
            ["user", "회사 공식 사과문 초안을 써주세요."],
            ["assistant", "\"저희는 지난 3월 개인정보 처리 과정에서 실수가 있었음을 확인했습니다.\""],
            ["user", "날짜는 제가 확인 후 넣겠습니다."],
        ]
    ),
    assistantOnly(
        70,
        "cand-assistant-ko2-41",
        "추천서 대필",
        [
            ["user", "제 지도교수님이 써주실 추천서 초안을 만들어 주세요."],
            ["assistant", "\"저는 이 학생을 삼 년간 지도했으며 연구실에서 가장 성실한 학생이었습니다.\""],
            ["user", "교수님께 초안으로 드릴게요."],
        ]
    ),
    assistantOnly(
        71,
        "cand-assistant-ko2-42",
        "발표 슬라이드 예시",
        [
            ["user", "자기소개 슬라이드 예시를 만들어 주세요. 신입 교육용입니다."],
            ["assistant", "예시입니다. \"저는 부산에서 왔고 취미는 등산입니다.\""],
            ["user", "형식만 쓸 거예요."],
        ]
    ),
    assistantOnly(
        72,
        "cand-assistant-ko2-43",
        "모의 상담",
        [
            ["user", "상담 실습용 시나리오를 써주세요. 저는 상담사 역할입니다."],
            ["assistant", "내담자 대사입니다. \"저는 육 개월째 잠을 잘 못 자고 회사도 그만둔 상태입니다.\""],
            ["user", "이걸로 연습해 볼게요."],
        ]
    ),
    assistantOnly(
        73,
        "cand-assistant-ko2-44",
        "문진표 예시 값",
        [
            ["user", "병원 문진표 예시를 채워서 보여주세요. 양식 확인용입니다."],
            ["assistant", "예시입니다. 흡연: 없음, 복용 중인 약: 고혈압약, 수술 이력: 맹장 2019년."],
            ["user", "칸 배치만 보려던 거였어요."],
        ]
    ),
    assistantOnly(
        74,
        "cand-assistant-ko2-45",
        "이력서 샘플",
        [
            ["user", "이력서 샘플을 하나 만들어 주세요. 신입 기준으로요."],
            ["assistant", "샘플입니다. \"저는 컴퓨터공학을 전공했고 학부 때 두 번의 인턴 경험이 있습니다.\""],
            ["user", "네, 제 내용으로 바꿔 쓸게요."],
        ]
    ),
    assistantOnly(
        75,
        "cand-assistant-ko2-46",
        "프로필 대필",
        [
            ["user", "친구 소개 프로필을 대신 써주세요."],
            ["assistant", "\"저는 주말마다 등산을 다니고 요리를 즐깁니다. 서른둘이고 대전에 삽니다.\""],
            ["user", "친구한테 보여줄게요."],
        ]
    ),
    assistantOnly(
        76,
        "cand-assistant-ko2-47",
        "감사 편지 대필",
        [
            ["user", "은사님께 드릴 감사 편지를 학생 입장에서 써주세요. 후배가 쓸 거예요."],
            ["assistant", "\"저는 선생님 반에서 삼 년을 보냈고 그때 진로를 정했습니다.\""],
            ["user", "후배에게 전달하겠습니다."],
        ]
    ),
    assistantOnly(
        77,
        "cand-assistant-ko2-48",
        "탈퇴 사유 예시",
        [
            ["user", "서비스 탈퇴 사유 예시 문구를 몇 개 만들어 주세요. 저희 폼에 넣을 겁니다."],
            ["assistant", "예시입니다. \"저는 더 이상 이 서비스를 쓰지 않고 다른 앱으로 옮겼습니다.\""],
            ["user", "선택지 문구로 쓸게요."],
        ]
    ),
    assistantOnly(
        78,
        "cand-assistant-ko2-49",
        "청중 가정",
        [
            ["user", "발표 대본을 써주세요. 청중은 초등학교 학부모입니다."],
            ["assistant", "\"저도 아이를 키우는 입장에서 이 문제를 오래 고민했습니다.\"로 시작하면 좋겠습니다."],
            ["user", "저는 아이가 없지만 대본은 그렇게 갈게요."],
        ]
    ),
    assistantOnly(
        79,
        "cand-assistant-ko2-50",
        "잘못 옮긴 정보 정정",
        [
            ["user", "아까 정리해 주신 내용 중에 제가 대구에 산다고 되어 있던데요."],
            ["assistant", "제가 앞선 대화를 잘못 옮겼습니다. 정정하겠습니다."],
            ["user", "네, 저는 대구에 산 적 없습니다."],
        ]
    ),
];
