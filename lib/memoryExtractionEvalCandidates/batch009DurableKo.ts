/**
 * Batch 009 — `durable_facts:ko`, second batch. **Candidate pool, not dataset.**
 *
 * docs/ops/memory-extraction-eval-dataset.md §6.1 (25-50 per batch). 50 here,
 * the top of that range: the cell's first batch has been reviewed
 * (docs/ops/memory-extraction-eval-dataset.md §6.5), so
 * what is left is volume, and 50 halves the number of review sheets without
 * changing how many verdicts docs/ops/memory-extraction-eval-dataset.md §6.3's 20% sample asks for.
 *
 * These are AI drafts. Policy docs/policy/external-conversation-import-and-memory.md §12.6 keeps them a candidate pool
 * until a person adopts them, and this file is deliberately not imported by
 * `lib/memoryExtractionEvalFixtures.ts`.
 *
 * **Written against what the cell already holds.** The 29 adopted cases cover
 * 간호사, 세무사, 통계, 용접, 부산, 1986, 갑각류, 휠체어, 예산 300, postgres,
 * 전세, 쌍둥이, 동업자, 가계부 앱, 기후 논문, 일본어, 변호사, 귀농, 창가,
 * 존댓말, 표 정리, 전화, 월요일 회의, 결론, 짧게, 한국어, 탭. None of them
 * appears again — a second case on the same topic grows the count without
 * widening what the cell measures (docs/ops/memory-extraction-eval-dataset.md §3.2).
 *
 * It also reaches the five style kinds the first batch never used — `tone`,
 * `structure`, `formatting`, `explanation_depth`, `citation_preference`. A
 * cell that exercises ten of the nineteen kinds reports the quality of ten.
 *
 * Kind spread (docs/ops/memory-extraction-eval-dataset.md §3.2: no kind above 40% of the cell) — widest is 5/50 = 10%:
 *   constraint 5, identity 4, preference 4, occupation 4, expertise 4,
 *   long_term_goal 4, project 4, decision 4, relationship 4,
 *   recurring_context 3, communication_style 2, and one each of tone,
 *   verbosity, structure, formatting, language, explanation_depth,
 *   citation_preference, code_style.
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
    const id = nextId("cand-b009");
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

const durableKo = (
    index: number,
    kind: string,
    mustInclude: readonly string[],
    title: string,
    turns: readonly (readonly [role: "user" | "assistant", content: string])[]
): MemoryEvalCase => ({
    id: `cand-durable-ko2-${index}`,
    category: "durable_facts",
    language: "ko",
    expected: [{ id: "e1", kind, mustInclude }],
    conversations: [conversation(title, turns)],
});

export const BATCH_009_DURABLE_KO: readonly MemoryEvalCase[] = [
    durableKo(1, "identity", ["대전"], "고향", [
        ["user", "대전에서 나고 자랐고 지금도 거기 삽니다."],
        ["assistant", "그럼 근처 기준으로 말씀드릴게요."],
    ]),
    durableKo(2, "identity", ["93"], "나이", [
        ["user", "93년생입니다. 나이 얘기가 필요하면 참고해 주세요."],
        ["assistant", "알겠습니다."],
    ]),
    durableKo(3, "identity", ["왼손잡이"], "손", [
        ["user", "저 왼손잡이라서 도구 추천할 때 그거 감안해 주시면 좋겠어요. 가위 같은 거요."],
        ["assistant", "왼손용이 따로 나오는 품목은 그걸로 골라 드릴게요."],
    ]),
    durableKo(4, "identity", ["셋째"], "형제", [
        ["user", "삼남매 중 셋째예요. 막내라 그런지 결정을 미루는 편이고요."],
        ["assistant", "그 부분은 따로 다뤄도 좋겠네요."],
    ]),
    durableKo(5, "preference", ["아침"], "회의 시간", [
        ["user", "회의는 아침에 잡는 걸 선호합니다. 오후엔 집중이 잘 안 돼요."],
        ["assistant", "일정 제안은 오전 위주로 드리겠습니다."],
    ]),
    durableKo(6, "preference", ["걸어"], "이동", [
        ["user", "삼십 분 안쪽 거리는 무조건 걸어 다닙니다."],
        ["assistant", "그 정도 거리는 도보 기준으로 안내할게요."],
    ]),
    durableKo(7, "preference", ["중고"], "구매", [
        ["user", "웬만한 물건은 중고로 삽니다. 새것 사는 게 아까워서요."],
        ["assistant", "중고 매물 기준으로 골라 드릴게요."],
    ]),
    durableKo(8, "preference", ["매운"], "음식", [
        ["user", "매운 걸 워낙 좋아해서 맵찔이용 메뉴는 안 알려주셔도 됩니다 🌶️"],
        ["assistant", "그럼 매운 정도가 있는 쪽으로 추천드릴게요."],
    ]),
    durableKo(9, "occupation", ["물리치료사"], "직업", [
        ["user", "물리치료사로 일한 지 7년 됐습니다."],
        ["assistant", "그 경력 기준으로 말씀드릴게요."],
    ]),
    durableKo(10, "occupation", ["항해사"], "승선", [
        ["user", "저는 항해사입니다. 육 개월씩 배를 타고 나가 있어서 연락이 뜸해요."],
        ["assistant", "장기 승선을 전제로 답변드리겠습니다."],
    ]),
    durableKo(11, "occupation", ["제빵"], "가게", [
        ["user", "제빵 일을 합니다. 새벽 세 시에 시작해서 오후 두 시에 끝나요."],
        ["assistant", "그 시간대를 기준으로 잡겠습니다."],
    ]),
    durableKo(12, "occupation", ["공무원"], "직군", [
        ["user", "구청에서 공무원으로 일하고 있어요. 민원 응대가 주 업무입니다."],
        ["assistant", "그 맥락을 반영해서 답변드릴게요."],
    ]),
    durableKo(13, "expertise", ["엑셀"], "이미 아는 것", [
        ["user", "엑셀은 피벗이랑 함수까지 능숙하게 씁니다. 기초 설명은 빼주세요."],
        ["assistant", "기초는 건너뛰겠습니다."],
    ]),
    durableKo(14, "expertise", ["기타"], "악기", [
        ["user", "클래식 기타를 십오 년 쳤습니다. 코드 이름 정도는 그냥 말씀하셔도 됩니다."],
        ["assistant", "용어는 그대로 쓰겠습니다."],
    ]),
    durableKo(15, "expertise", ["주식", "처음"], "투자", [
        ["user", "주식은 이번에 처음 시작합니다. 용어부터 모릅니다."],
        ["assistant", "그럼 용어부터 하나씩 짚겠습니다."],
    ]),
    durableKo(16, "expertise", ["목공"], "취미", [
        ["user", "목공은 취미로 오래 했어요. 대패질이나 짜맞춤 정도는 익숙합니다."],
        ["assistant", "그 수준을 전제로 설명드리겠습니다."],
    ]),
    durableKo(17, "long_term_goal", ["책방"], "언젠가", [
        ["user", "언젠가 작은 책방을 여는 게 목표입니다. 아직 시기는 못 정했지만 방향은 확실해요."],
        ["assistant", "그 목표를 전제로 이야기하겠습니다."],
    ]),
    durableKo(18, "long_term_goal", ["박사"], "학위", [
        ["user", "최종적으로는 박사까지 갈 생각입니다. 지금은 석사 2년 차예요."],
        ["assistant", "장기 계획 기준으로 답변드릴게요."],
    ]),
    durableKo(19, "long_term_goal", ["제주"], "이주", [
        ["user", "오 년 안에 제주로 완전히 이주하려고 준비 중입니다."],
        ["assistant", "이주를 전제로 말씀드리겠습니다."],
    ]),
    durableKo(20, "long_term_goal", ["쇼팽"], "연주", [
        ["user", "쇼팽 발라드 1번을 끝까지 치는 게 목표예요. 십 년째 붙잡고 있습니다."],
        ["assistant", "그 곡을 기준으로 연습 얘기를 이어가죠."],
    ]),
    durableKo(21, "project", ["유튜브"], "채널", [
        ["user", "유튜브 채널을 혼자 굴리고 있어요. 편집까지 다 제가 합니다."],
        ["assistant", "1인 제작 기준으로 답변드릴게요."],
    ]),
    durableKo(22, "project", ["텃밭"], "주말농장", [
        ["user", "주말마다 텃밭을 가꿉니다. 스무 평 정도 되고 올해가 삼 년째예요."],
        ["assistant", "규모와 연차를 반영하겠습니다."],
    ]),
    durableKo(23, "project", ["번역", "소설"], "작업 중", [
        ["user", "스페인어 소설 하나를 번역하고 있습니다. 출판 계약은 아직 없고 혼자 하는 작업이에요."],
        ["assistant", "그 상황을 전제로 말씀드릴게요."],
    ]),
    durableKo(24, "project", ["보드게임"], "제작", [
        ["user", "보드게임을 하나 만들고 있어요. 규칙은 다 잡았고 지금은 밸런스 조정 중입니다."],
        ["assistant", "밸런스 단계 기준으로 이어가겠습니다."],
    ]),
    durableKo(25, "constraint", ["야간"], "운전", [
        ["user", "야간 운전은 못 합니다. 밤에 시야가 너무 흐려서요. 일정 짤 때 꼭 빼주세요."],
        ["assistant", "이동은 낮 시간으로만 잡겠습니다."],
    ]),
    durableKo(26, "constraint", ["고소공포"], "높이", [
        ["user", "고소공포증이 심해서 높은 데는 아예 못 갑니다."],
        ["assistant", "높은 곳이 포함된 선택지는 제외하겠습니다."],
    ]),
    durableKo(27, "constraint", ["강아지"], "외출", [
        ["user", "강아지를 혼자 오래 못 두는 편이라 네 시간 넘는 외출은 어렵습니다."],
        ["assistant", "그 시간 안에서 제안드릴게요."],
    ]),
    durableKo(28, "constraint", ["무릎"], "몸", [
        ["user", "무릎이 안 좋아서 계단이나 등산은 무리예요. 이건 나아지지 않는 조건입니다."],
        ["assistant", "무릎에 부담 가는 선택지는 빼겠습니다."],
    ]),
    durableKo(29, "constraint", ["저염"], "식단", [
        ["user", "저염식을 해야 합니다. 의사 지시라 조절이 아니라 아예 지켜야 하는 거예요."],
        ["assistant", "나트륨 기준으로 걸러서 말씀드리겠습니다."],
    ]),
    durableKo(30, "decision", ["이직"], "정한 것", [
        ["user", "고민 끝에 이직하기로 결정했습니다. 다음 달에 얘기 꺼낼 거예요."],
        ["assistant", "그 결정을 전제로 준비 얘기를 하죠."],
    ]),
    durableKo(31, "decision", ["자취"], "독립", [
        ["user", "올해 안에 자취하기로 정했어요. 이건 번복 안 합니다."],
        ["assistant", "정하신 걸로 두고 이어가겠습니다."],
    ]),
    durableKo(32, "decision", ["대학원"], "진학", [
        ["user", "대학원은 안 가기로 했습니다. 대신 실무로 쌓기로요."],
        ["assistant", "실무 경로 기준으로 말씀드릴게요."],
    ]),
    durableKo(33, "decision", ["경차"], "차", [
        ["user", "차는 경차로 가기로 했어요. 유지비 때문에 그렇게 정했습니다."],
        ["assistant", "그 조건에서 골라 드리겠습니다."],
    ]),
    durableKo(34, "relationship", ["조카"], "가족", [
        ["user", "조카 셋을 자주 봐요. 큰애가 초등학생이고 아래로 둘이 더 있습니다."],
        ["assistant", "그 연령대를 감안해서 말씀드릴게요."],
    ]),
    durableKo(35, "relationship", ["남동생"], "형제", [
        ["user", "남동생이 한 명 있고 같은 회사에 다닙니다. 부서는 다르고요."],
        ["assistant", "그 관계를 반영하겠습니다."],
    ]),
    durableKo(36, "relationship", ["시부모"], "동거", [
        ["user", "시부모님과 함께 살고 있어요. 집 구조 얘기할 때 그 부분이 걸립니다."],
        ["assistant", "동거 가족을 전제로 말씀드릴게요."],
    ]),
    durableKo(37, "relationship", ["룸메이트"], "주거", [
        ["user", "룸메이트랑 둘이 살아요. 공간을 반반 나눠 쓰는 구조입니다."],
        ["assistant", "공유 공간 기준으로 이어가겠습니다."],
    ]),
    durableKo(38, "recurring_context", ["새벽"], "근무", [
        ["user", "새벽에 일하고 낮에 잡니다. 그래서 오후 연락이 어려워요."],
        ["assistant", "연락 가능한 시간대를 그렇게 잡겠습니다."],
    ]),
    durableKo(39, "recurring_context", ["봉사"], "주말", [
        ["user", "토요일 오전은 늘 봉사 활동이 있습니다. 몇 년째 고정이에요."],
        ["assistant", "그 시간은 비워 두겠습니다."],
    ]),
    durableKo(40, "recurring_context", ["격주"], "출장", [
        ["user", "격주로 지방 출장을 갑니다. 이틀씩 자리를 비워요."],
        ["assistant", "그 주기를 반영해서 계획 세우죠."],
    ]),
    durableKo(41, "communication_style", ["비유"], "설명 방식", [
        ["user", "비유를 들어서 설명해 주시면 훨씬 잘 들어와요."],
        ["assistant", "그럼 비유를 섞어서 말씀드리겠습니다."],
    ]),
    durableKo(42, "communication_style", ["질문"], "되묻기", [
        ["user", "애매하면 그냥 넘기지 말고 질문을 먼저 해주세요. 잘못 짚고 가는 게 더 손해라서요."],
        ["assistant", "불확실한 지점은 먼저 여쭙겠습니다."],
    ]),
    durableKo(43, "tone", ["담백"], "말투", [
        ["user", "칭찬이나 추임새 없이 담백하게 말해 주세요."],
        ["assistant", "그렇게 하겠습니다."],
    ]),
    durableKo(44, "verbosity", ["자세히"], "분량", [
        ["user", "저는 자세히 받는 걸 좋아합니다. 길어도 괜찮아요."],
        ["assistant", "분량을 넉넉히 잡겠습니다."],
    ]),
    durableKo(45, "structure", ["단계"], "구성", [
        ["user", "설명은 단계별로 나눠서 주세요. 한 덩어리로 오면 못 따라갑니다."],
        ["assistant", "단계를 나눠 드리겠습니다."],
    ]),
    durableKo(46, "formatting", ["목록"], "형식", [
        ["user", "줄글보다 목록 형태가 읽기 편해요."],
        ["assistant", "목록으로 정리해 드리겠습니다."],
    ]),
    durableKo(47, "language", ["영어"], "답변 언어", [
        ["user", "한국어로 물어봐도 답은 영어로 주세요. 영어 감을 유지하려고요."],
        ["assistant", "I'll answer in English from here."],
    ]),
    durableKo(48, "explanation_depth", ["원리"], "깊이", [
        ["user", "방법만 알려주지 마시고 원리까지 같이 설명해 주세요."],
        ["assistant", "배경까지 함께 짚겠습니다."],
    ]),
    durableKo(49, "citation_preference", ["출처"], "근거", [
        ["user", "사실 관계를 말할 때는 출처를 같이 달아 주세요. 확인하고 싶어서요."],
        ["assistant", "근거를 함께 표시하겠습니다."],
    ]),
    durableKo(50, "code_style", ["주석"], "코드", [
        ["user", "코드 예시에는 주석을 촘촘히 달아 주세요. 나중에 다시 볼 때 필요해서요."],
        ["assistant", "설명 주석을 붙여서 드리겠습니다."],
    ]),
];
