/**
 * Batch 019 — `assistant_only:ko`. **Adopted. This is dataset.**
 *
 * Reviewed and adopted on 2026-08-23, recorded in
 * `docs/ops/memory-extraction-eval-batches/batch-019-assistant-only-ko.md`:
 * all 10 sampled cases 채택 under docs/ops/memory-extraction-eval-dataset.md §6.3's 20% sample review,
 * draft disagreement 0%, diversity judged sufficient, the drafting setup
 * recorded as unchanged, and the explicit batch adoption line filled.
 *
 * The other 36 cases enter the dataset on that adoption line rather than on a
 * verdict of their own. docs/ops/memory-extraction-eval-dataset.md §6.3 is explicit that this is what the line is for:
 * seeing the sample and saying nothing is not adoption.
 *
 * The `cand-` ids are kept: they are what the review record names, and a case
 * that cannot be traced back to the verdict that admitted it is a case whose
 * review cannot be checked (docs/ops/memory-extraction-eval-dataset.md §7.1 asks for the judgement basis on record).
 *
 * `tests/memoryEvalAdoptedBatches.test.mjs` re-reads that record on every run:
 * if the adoption line ever stops saying 채택, these cases stop being allowed
 * in the dataset.
 *
 * 46 cases. The cell stands at 79 (29 adopted plus batch-017), and 46 brings
 * it to 125, the floor docs/policy/external-conversation-import-and-memory.md §12.2 sets. Nothing beyond it is
 * drafted: a case past the floor still costs a reviewer a verdict.
 *
 * Category ② (docs/ops/memory-extraction-eval-dataset.md §4.2): every case has an empty `expected`, and any
 * bulk-safe adoption from one of them is a docs/policy/external-conversation-import-and-memory.md §12.3 critical failure.
 *
 * **Written against the 79 cases the cell already holds.** Batch-017 filled
 * out authored first person — copy, forms, templates, ghost-writing. This
 * batch leans on the mechanisms neither earlier batch reaches:
 *
 * - **negation.** "저는 채식주의자가 아닙니다" contains the whole of a durable
 *   fact except the part that reverses it, and a keyword reader that drops the
 *   negation has no way to notice.
 * - **someone else's account**, where the first person belongs to a spouse, a
 *   parent, a client or a stranger the user is relaying.
 * - **the user correcting the record**, including a typo they are fixing and a
 *   fact the assistant inferred and they refuse.
 * - **facts held only as questions** — "제가 ~라면 어떻게 되나요" — where the
 *   condition is the question, not a state of affairs.
 *
 * Names, places, ages and numbers are invented.
 */

import type { MemoryEvalCase } from "@/lib/memoryExtractionEvalCore";

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${(sequence += 1)}`;

const conversation = (
    title: string,
    turns: readonly (readonly [role: "user" | "assistant", content: string])[]
) => {
    const id = nextId("cand-b019");
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

const assistantKo = (
    index: number,
    title: string,
    turns: readonly (readonly [role: "user" | "assistant", content: string])[]
): MemoryEvalCase => ({
    id: `cand-assistant-ko3-${index}`,
    category: "assistant_only",
    language: "ko",
    expected: [],
    conversations: [conversation(title, turns)],
});

export const BATCH_019_ASSISTANT_KO: readonly MemoryEvalCase[] = [
    assistantKo(1, "부정 — 채식", [
        ["user", "저는 채식주의자가 아닙니다. 그런 전제로 추천하지 말아 주세요."],
        ["assistant", "알겠습니다. 육류를 포함해서 제안드리겠습니다."],
    ]),
    assistantKo(2, "부정 — 거주지", [
        ["user", "저 서울 안 삽니다. 자꾸 서울 기준으로 알려주시네요."],
        ["assistant", "죄송합니다. 지역을 알려주시면 그 기준으로 다시 드리겠습니다."],
    ]),
    assistantKo(3, "부정 — 직업", [
        ["user", "저는 개발자가 아니에요. 코드 얘기는 못 알아듣습니다."],
        ["assistant", "그럼 코드 없이 설명드리겠습니다."],
    ]),
    assistantKo(4, "부정 — 알레르기", [
        ["user", "땅콩 알레르기 없습니다. 굳이 빼실 필요 없어요."],
        ["assistant", "그럼 제한 없이 제안드리겠습니다."],
    ]),
    assistantKo(5, "부정 — 자녀", [
        ["user", "아이 없습니다. 육아 관련 얘기는 저한테 해당 없어요."],
        ["assistant", "알겠습니다. 그 부분은 빼겠습니다."],
    ]),
    assistantKo(6, "부정 — 차량", [
        ["user", "차 없어요. 자차 전제로 말씀하셔서 다시 여쭙니다."],
        ["assistant", "대중교통 기준으로 다시 안내드리겠습니다."],
    ]),
    assistantKo(7, "배우자 대신 문의", [
        ["user", "아내가 갑상선 약을 먹는데 이 음식이랑 같이 먹어도 되는지 궁금합니다."],
        ["assistant", "복용 중인 약과 음식의 상호작용은 처방의와 확인하시는 게 좋습니다."],
        ["user", "네, 제 약은 아니고 아내 거예요."],
    ]),
    assistantKo(8, "부모님 상황 전달", [
        ["user", "아버지가 이번에 정년 퇴직하셨는데 연금을 언제부터 받으실 수 있나요?"],
        ["assistant", "퇴직 시점과 가입 기간에 따라 다릅니다."],
        ["user", "저는 아직 한참 남았고 아버지 얘기입니다."],
    ]),
    assistantKo(9, "고객 상황 전달", [
        ["user", "제 고객이 원룸에서 사무실로 용도 변경을 하려는데 가능한가요?"],
        ["assistant", "용도 변경은 건축물대장상 용도와 지구 단위 계획을 봐야 합니다."],
        ["user", "제 건물은 아니고 상담 건입니다."],
    ]),
    assistantKo(10, "지인 이야기 전달", [
        ["user", "아는 분이 이민 준비 중인데 어떤 서류가 필요한지 물어보시더라고요."],
        ["assistant", "국가마다 다르지만 보통 재정 증명과 범죄 경력 조회가 들어갑니다."],
        ["user", "네, 그분께 전달할게요."],
    ]),
    assistantKo(11, "소문 인용", [
        ["user", "회사에 소문이 돌던데, 팀장님이 다음 달에 그만두신다고 하더라고요."],
        ["assistant", "확인되지 않은 이야기라면 판단은 유보하시는 게 좋겠습니다."],
        ["user", "그러게요. 저도 들은 거라서요."],
    ]),
    assistantKo(12, "통계 속 인물", [
        ["user", "이 보고서 요약해 주세요."],
        ["assistant", "응답자의 절반이 \"나는 주 5일 이상 재택근무를 한다\"고 답했습니다."],
        ["user", "네, 그 수치가 필요했어요."],
    ]),
    assistantKo(13, "오타 정정", [
        ["user", "아까 제 나이를 마흔이라고 썼는데 오타였습니다. 서른입니다."],
        ["assistant", "정정하겠습니다."],
        ["user", "네, 마흔이 아니라 서른이에요."],
    ]),
    assistantKo(14, "추측 거부", [
        ["user", "제 전공이 경영학인 것 같다고 하셨는데, 왜 그렇게 보셨어요?"],
        ["assistant", "쓰시는 용어를 보고 추측했습니다. 근거가 약했습니다."],
        ["user", "경영학 아닙니다. 그냥 궁금해서 여쭤봤어요."],
    ]),
    assistantKo(15, "가정 질문 — 이직", [
        ["user", "제가 만약 지금 이직하면 퇴직금은 어떻게 되나요?"],
        ["assistant", "근속 1년 이상이면 지급 대상입니다."],
        ["user", "이직 계획은 없고 그냥 알아두려고요."],
    ]),
    assistantKo(16, "가정 질문 — 창업", [
        ["user", "제가 사업자를 낸다면 어떤 세금을 내게 되나요?"],
        ["assistant", "부가가치세와 종합소득세가 기본입니다."],
        ["user", "아직 직장인이고 궁금해서 여쭤본 겁니다."],
    ]),
    assistantKo(17, "가정 질문 — 유학", [
        ["user", "제가 유학을 간다고 하면 건강보험은 어떻게 되나요?"],
        ["assistant", "장기 해외 체류 시 정지 신청이 가능합니다."],
        ["user", "갈 계획은 없습니다."],
    ]),
    assistantKo(18, "이메일 서명 예시", [
        ["user", "이메일 서명 예시를 만들어 주세요."],
        ["assistant", "예시입니다. \"저는 마케팅팀 이수현이고 내선은 3204입니다.\""],
        ["user", "형식만 참고할게요."],
    ]),
    assistantKo(19, "매물 소개 대필", [
        ["user", "부동산 매물 소개 글을 집주인 입장에서 써주세요."],
        ["assistant", "\"저는 이 집에서 십 년을 살았고 작년에 전체 리모델링을 했습니다.\""],
        ["user", "집주인분께 초안으로 드릴게요."],
    ]),
    assistantKo(20, "모집 공고", [
        ["user", "봉사자 모집 공고를 단체 이름으로 써주세요."],
        ["assistant", "\"저희는 2011년부터 이 지역에서 무료 급식을 운영해 왔습니다.\""],
        ["user", "연혁은 확인 후 넣겠습니다."],
    ]),
    assistantKo(21, "펀딩 소개글", [
        ["user", "크라우드펀딩 소개글을 창작자 시점으로 써주세요."],
        ["assistant", "\"저는 삼 년 동안 이 악기를 혼자 만들어 왔습니다.\""],
        ["user", "친구 프로젝트라 대신 씁니다."],
    ]),
    assistantKo(22, "영상 스크립트", [
        ["user", "채널 오프닝 스크립트를 써주세요."],
        ["assistant", "\"안녕하세요, 십 년째 등산 다니는 사람입니다.\"로 시작하면 어떨까요."],
        ["user", "채널 주인은 제가 아니고 의뢰받은 거예요."],
    ]),
    assistantKo(23, "채용 공고 예시", [
        ["user", "채용 공고에 넣을 지원자 요건 예시를 1인칭으로 써주세요."],
        ["assistant", "\"저는 백엔드 경력이 3년 있고 Go를 주로 씁니다.\" 같은 형태입니다."],
        ["user", "예시 문장만 필요했습니다."],
    ]),
    assistantKo(24, "약관 예문", [
        ["user", "개인정보 처리방침 예문을 만들어 주세요."],
        ["assistant", "\"저는 만 14세 이상이며 아래 내용에 동의합니다.\"가 동의 문구 예시입니다."],
        ["user", "네, 그 문구 형식이요."],
    ]),
    assistantKo(25, "TRPG NPC", [
        ["user", "TRPG 세션에 넣을 NPC 설정을 써주세요."],
        ["assistant", "\"나는 이 여관을 이십 년 운영했고 손님 얼굴은 다 기억한다.\""],
        ["user", "좋네요, 능력치도 붙여주세요."],
    ]),
    assistantKo(26, "뮤지컬 가사", [
        ["user", "뮤지컬 넘버 가사를 써주세요. 주인공 솔로입니다."],
        ["assistant", "\"나는 이 도시를 떠난 적이 없어, 스무 해를 같은 창을 보며 살았어.\""],
        ["user", "후렴도 부탁드려요."],
    ]),
    assistantKo(27, "라디오 사연 대필", [
        ["user", "라디오에 보낼 사연을 대신 써주세요. 동생 사연입니다."],
        ["assistant", "\"저는 올해 처음 혼자 자취를 시작했습니다.\""],
        ["user", "동생 이름으로 보낼 거예요."],
    ]),
    assistantKo(28, "독자 투고 대필", [
        ["user", "신문 독자 투고를 대신 써주세요. 어머니가 보내실 겁니다."],
        ["assistant", "\"저는 사십 년째 이 동네에 살고 있습니다.\""],
        ["user", "어머니께 보여드릴게요."],
    ]),
    assistantKo(29, "민원 대필", [
        ["user", "이웃 어르신 대신 민원 글을 써드리려고 해요."],
        ["assistant", "\"저는 이 아파트 3동에 거주하며 소음 문제로 민원을 넣습니다.\""],
        ["user", "제 동은 아니고 어르신 동입니다."],
    ]),
    assistantKo(30, "청구서 예시", [
        ["user", "보험 청구서 작성 예시를 보여주세요."],
        ["assistant", "예시입니다. 사고일 2026-03-04, 부상 부위 손목, 치료 기간 6주."],
        ["user", "칸 채우는 법만 보려던 거예요."],
    ]),
    assistantKo(31, "신고서 예시 값", [
        ["user", "세관 신고서 예시를 채워서 보여주세요."],
        ["assistant", "예시입니다. 체류 목적: 관광, 체류 기간: 10일, 반입 물품: 없음."],
        ["user", "양식만 확인했습니다."],
    ]),
    assistantKo(32, "장학금 신청 예시", [
        ["user", "장학금 신청서 자기소개 예시를 써주세요."],
        ["assistant", "\"저는 편부모 가정에서 자랐고 학비를 스스로 마련해 왔습니다.\""],
        ["user", "예시 문체만 참고합니다."],
    ]),
    assistantKo(33, "입양 신청서 예시", [
        ["user", "유기견 입양 신청서 예시를 채워 주세요."],
        ["assistant", "예시입니다. 주거 형태: 단독주택, 반려 경험: 10년, 가족 수: 4명."],
        ["user", "제 상황은 아니고 양식 확인용입니다."],
    ]),
    assistantKo(34, "커뮤니티 자기소개 템플릿", [
        ["user", "동호회 가입 인사 템플릿을 만들어 주세요."],
        ["assistant", "\"안녕하세요, 3년 차 클라이머이고 주말마다 실내암장에 갑니다.\""],
        ["user", "회원들이 쓸 템플릿입니다."],
    ]),
    assistantKo(35, "예상 질문 만들기", [
        ["user", "발표 후 나올 만한 청중 질문을 만들어 주세요."],
        ["assistant", "\"저는 이 분야에서 십 년 일했는데 현장에서는 잘 안 맞던데요?\" 같은 질문이 나올 수 있습니다."],
        ["user", "답변 준비해 볼게요."],
    ]),
    assistantKo(36, "면접 예상 답변 연습", [
        ["user", "면접에서 이런 질문이 오면 어떻게 답할지 예시를 써주세요."],
        ["assistant", "예시 답변입니다. \"저는 팀을 다섯 명 이끌었고 이직률을 절반으로 줄였습니다.\""],
        ["user", "제 경력은 다릅니다. 문장 구조만 참고할게요."],
    ]),
    assistantKo(37, "협상 시뮬레이션", [
        ["user", "협상 연습을 하려는데 상대 역할을 맡아주세요."],
        ["assistant", "\"저희는 이미 다른 업체와 계약 직전이라 단가를 더 내릴 수 없습니다.\""],
        ["user", "좋아요, 계속 해주세요."],
    ]),
    assistantKo(38, "불만 사례 작성", [
        ["user", "고객 불만 사례를 몇 개 만들어 주세요. 교육용입니다."],
        ["assistant", "사례입니다. \"저는 세 번이나 전화했는데 매번 다른 답을 들었습니다.\""],
        ["user", "교육 자료에 넣겠습니다."],
    ]),
    assistantKo(39, "사용자 스토리", [
        ["user", "사용자 스토리를 몇 개 써주세요."],
        ["assistant", "\"나는 야간 근무자로서, 앱이 어두운 화면을 기본으로 켜주기를 원한다.\""],
        ["user", "백로그에 넣을게요."],
    ]),
    assistantKo(40, "버그 재현 절차", [
        ["user", "버그 리포트 양식 예시를 써주세요."],
        ["assistant", "재현 절차 예시입니다. \"나는 아이폰 15에서 앱을 열고 설정에 들어갔다.\""],
        ["user", "제 기기는 아니고 양식 예시입니다."],
    ]),
    assistantKo(41, "로그 샘플", [
        ["user", "로그 형식을 설명해 주세요. 샘플 한 줄로요."],
        ["assistant", "샘플입니다. user_id=8812 city=대구 plan=pro locale=ko"],
        ["user", "필드 순서만 보려던 거예요."],
    ]),
    assistantKo(42, "시드 데이터", [
        ["user", "개발용 시드 데이터를 만들어 주세요."],
        ["assistant", "생성했습니다. 이름 김하늘, 나이 29, 직업 사진작가, 도시 전주."],
        ["user", "테스트 DB에 넣겠습니다."],
    ]),
    assistantKo(43, "목업 문구", [
        ["user", "화면 목업에 들어갈 예시 문구를 써주세요."],
        ["assistant", "\"저는 매일 아침 이 앱으로 하루를 시작합니다\" 같은 후기 문구가 들어갑니다."],
        ["user", "디자인 시안용입니다."],
    ]),
    assistantKo(44, "문법 교재 예문", [
        ["user", "과거완료를 설명할 예문을 만들어 주세요."],
        ["assistant", "예문입니다. \"나는 그가 도착하기 전에 이미 저녁을 먹었다.\""],
        ["user", "교재에 실을 예문입니다."],
    ]),
    assistantKo(45, "받아쓰기 문장", [
        ["user", "받아쓰기 연습 문장 다섯 개만 주세요."],
        ["assistant", "1. 나는 어제 도서관에서 책을 세 권 빌렸다."],
        ["user", "나머지도 주세요."],
    ]),
    assistantKo(46, "오디오북 내레이션", [
        ["user", "오디오북 내레이션 대본을 다듬어 주세요."],
        ["assistant", "다듬었습니다. \"나는 그해 겨울 처음으로 아버지의 편지를 읽었다.\""],
        ["user", "낭독 호흡만 맞추면 되겠네요."],
    ]),
];
