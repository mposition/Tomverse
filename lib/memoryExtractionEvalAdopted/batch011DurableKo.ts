/**
 * Batch 011 — `durable_facts:ko`. **Adopted. This is dataset.**
 *
 * Reviewed and adopted on 2026-08-23, recorded in
 * `docs/ops/memory-extraction-eval-batches/batch-011-durable-facts-ko.md`:
 * all 10 sampled cases 채택 under docs/ops/memory-extraction-eval-dataset.md §6.3's 20% sample review,
 * draft disagreement 0%, diversity judged sufficient, the drafting setup
 * recorded as unchanged, and the explicit batch adoption line filled.
 *
 * The other 40 cases enter the dataset on that adoption line rather than on a
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
 * docs/ops/memory-extraction-eval-dataset.md §6.1 (25-50 per batch). 50 here,
 * the top of that range, for the same reason batch-009 took it: the cell's
 * brief was settled by its first review, so what is left is volume.
 *
 * **Written against the 79 cases the cell already holds** — 29 adopted and the
 * 50 of batch-009. No `mustInclude` topic from either appears again; a second
 * case on the same topic grows the count without widening what the cell
 * measures (docs/ops/memory-extraction-eval-dataset.md §3.2).
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
    const id = nextId("cand-b011");
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
    id: `cand-durable-ko3-${index}`,
    category: "durable_facts",
    language: "ko",
    expected: [{ id: "e1", kind, mustInclude }],
    conversations: [conversation(title, turns)],
});

export const BATCH_011_DURABLE_KO: readonly MemoryEvalCase[] = [
    durableKo(1, "identity", ["광주"], "사는 곳", [
        ["user", "광주에 자리 잡은 지 십 년쯤 됐습니다. 옮길 생각은 없어요."],
        ["assistant", "그 지역 기준으로 안내드릴게요."],
    ]),
    durableKo(2, "identity", ["78"], "나이대", [
        ["user", "78년생입니다. 연령대 얘기가 나오면 참고해 주세요."],
        ["assistant", "그 연령대를 기준으로 하겠습니다."],
    ]),
    durableKo(3, "identity", ["색약"], "시각", [
        ["user", "적록 색약이라 빨간 선 보라는 식의 설명은 저한테 안 통합니다."],
        ["assistant", "그래프는 색 대신 이름과 위치로 짚어 드릴게요."],
    ]),
    durableKo(4, "identity", ["외동"], "형제", [
        ["user", "외동으로 자랐습니다. 형제 관련 얘기는 저한테 해당이 없어요."],
        ["assistant", "알겠습니다."],
    ]),
    durableKo(5, "preference", ["녹차"], "마시는 것", [
        ["user", "커피는 안 마시고 녹차만 마십니다. 카페인 때문이 아니라 그냥 취향이에요."],
        ["assistant", "음료 얘기가 나오면 그쪽으로 맞추겠습니다."],
    ]),
    durableKo(6, "preference", ["메신저"], "연락 수단", [
        ["user", "이메일보다 메신저가 훨씬 편합니다. 메일은 며칠씩 안 볼 때가 있어요."],
        ["assistant", "연락 방법은 메신저 기준으로 제안하겠습니다."],
    ]),
    durableKo(7, "preference", ["계단"], "이동", [
        ["user", "엘리베이터 두고 계단으로 다닙니다. 십 층까지는 그렇게 해요."],
        ["assistant", "그 습관을 전제로 하겠습니다."],
    ]),
    durableKo(8, "preference", ["도서관"], "작업 장소", [
        ["user", "집중해야 하는 일은 전부 도서관에서 합니다. 집에서는 안 돼요."],
        ["assistant", "작업 환경은 그쪽 기준으로 보겠습니다."],
    ]),
    durableKo(9, "occupation", ["소방관"], "직업", [
        ["user", "소방관입니다. 3교대라 생활 리듬이 일정하지 않아요."],
        ["assistant", "교대 근무를 전제로 답변드리겠습니다."],
    ]),
    durableKo(10, "occupation", ["수의사"], "일하는 곳", [
        ["user", "동네 동물병원에서 수의사로 일합니다."],
        ["assistant", "그 맥락을 반영하겠습니다."],
    ]),
    durableKo(11, "occupation", ["미용사"], "하는 일", [
        ["user", "미용사로 일한 지 십이 년째입니다. 제 가게는 아니고 직원이에요."],
        ["assistant", "고용된 입장이라는 점 기억하겠습니다."],
    ]),
    durableKo(12, "occupation", ["택배"], "직군", [
        ["user", "택배 일을 합니다. 하루에 이백 개 정도 돌려요."],
        ["assistant", "그 업무량을 전제로 하겠습니다."],
    ]),
    durableKo(13, "expertise", ["사진"], "익숙한 분야", [
        ["user", "사진은 필름 현상까지 직접 합니다. 노출이나 현상 용어는 설명 안 하셔도 됩니다."],
        ["assistant", "용어는 그대로 쓰겠습니다."],
    ]),
    durableKo(14, "expertise", ["독일어"], "언어 능력", [
        ["user", "독일어는 업무로 쓸 만큼 합니다. 번역 없이 원문 주셔도 돼요."],
        ["assistant", "원문 그대로 인용하겠습니다."],
    ]),
    durableKo(15, "expertise", ["회계", "처음"], "새로 배우는 것", [
        ["user", "회계는 이번에 처음 봅니다. 차변 대변부터 모릅니다."],
        ["assistant", "기본 개념부터 짚어 드릴게요."],
    ]),
    durableKo(16, "expertise", ["암벽"], "운동", [
        ["user", "암벽 등반을 오래 했습니다. 그레이드 얘기는 그냥 하셔도 알아들어요."],
        ["assistant", "등급 표기는 그대로 쓰겠습니다."],
    ]),
    durableKo(17, "long_term_goal", ["순례길"], "언젠가 할 일", [
        ["user", "산티아고 순례길을 완주하는 게 오래된 목표입니다. 시기는 아직이고요."],
        ["assistant", "그 목표를 기준으로 이야기하겠습니다."],
    ]),
    durableKo(18, "long_term_goal", ["카페"], "창업", [
        ["user", "결국은 작은 카페를 차리는 게 목표예요. 지금 준비 중인 것도 다 그거 때문입니다."],
        ["assistant", "그 방향으로 맞춰서 답변드릴게요."],
    ]),
    durableKo(19, "long_term_goal", ["공인중개사"], "자격증", [
        ["user", "공인중개사 자격증을 따는 게 몇 년째 목표입니다."],
        ["assistant", "그 준비를 전제로 하겠습니다."],
    ]),
    durableKo(20, "long_term_goal", ["목조주택"], "집", [
        ["user", "언젠가 목조주택을 직접 지어서 살고 싶습니다. 그게 최종 목표예요."],
        ["assistant", "장기 목표로 기억하겠습니다."],
    ]),
    durableKo(21, "project", ["족보"], "정리 중인 것", [
        ["user", "집안 족보를 디지털로 정리하고 있습니다. 삼 년째 하고 있어요."],
        ["assistant", "진행 중인 작업으로 두겠습니다."],
    ]),
    durableKo(22, "project", ["습관"], "만드는 것", [
        ["user", "습관 기록용 웹앱을 혼자 만들고 있어요. 아직 저만 씁니다."],
        ["assistant", "그 프로젝트를 기준으로 답변드릴게요."],
    ]),
    durableKo(23, "project", ["국토종주"], "자전거", [
        ["user", "자전거 국토종주를 준비하고 있습니다. 올가을 목표로요."],
        ["assistant", "그 일정에 맞춰 보겠습니다."],
    ]),
    durableKo(24, "project", ["대본"], "쓰는 것", [
        ["user", "지역 라디오에 나가는 대본을 매주 씁니다. 제 이름으로 나가는 건 아니고요."],
        ["assistant", "그 작업을 전제로 하겠습니다."],
    ]),
    durableKo(25, "decision", ["재택"], "근무 형태", [
        ["user", "재택으로 계속 가기로 회사랑 얘기 끝냈습니다. 다시 논의할 일은 없어요."],
        ["assistant", "재택을 고정으로 두겠습니다."],
    ]),
    durableKo(26, "decision", ["보험"], "정리한 것", [
        ["user", "종신보험은 해지하기로 결정했습니다. 그 판단은 이미 끝났어요."],
        ["assistant", "다시 권하지 않겠습니다."],
    ]),
    durableKo(27, "decision", ["학원"], "아이 교육", [
        ["user", "아이는 학원 안 보내기로 정했습니다. 집에서 봐주는 쪽으로요."],
        ["assistant", "그 전제로 이야기하겠습니다."],
    ]),
    durableKo(28, "decision", ["개명"], "이름", [
        ["user", "개명하기로 마음먹고 서류까지 넣었습니다. 되돌릴 생각은 없어요."],
        ["assistant", "결정된 사항으로 두겠습니다."],
    ]),
    durableKo(29, "relationship", ["아버지", "당뇨"], "가족 건강", [
        ["user", "아버지가 당뇨가 있으셔서 같이 먹는 음식은 다 그걸 고려해야 합니다."],
        ["assistant", "식단 제안은 그 기준으로 드릴게요."],
    ]),
    durableKo(30, "relationship", ["배우자", "교대"], "집안 일정", [
        ["user", "배우자가 교대 근무라 저희 집 일정은 이 주 단위로 바뀝니다."],
        ["assistant", "고정 일정은 피해서 제안하겠습니다."],
    ]),
    durableKo(31, "relationship", ["고양이"], "함께 사는", [
        ["user", "고양이 두 마리랑 삽니다. 집 관련 얘기는 그거 감안해 주세요."],
        ["assistant", "반려동물이 있는 집 기준으로 보겠습니다."],
    ]),
    durableKo(32, "relationship", ["사촌"], "동거", [
        ["user", "사촌이랑 같이 삽니다. 생활비도 반씩 나눠 내고요."],
        ["assistant", "그 구성으로 두겠습니다."],
    ]),
    durableKo(33, "constraint", ["견과"], "알레르기", [
        ["user", "견과류 알레르기가 심합니다. 레시피에 절대 넣지 말아 주세요."],
        ["assistant", "견과류는 전부 빼겠습니다."],
    ]),
    durableKo(34, "constraint", ["요금제"], "데이터", [
        ["user", "요금제가 저용량이라 영상 스트리밍이 필요한 방법은 못 씁니다."],
        ["assistant", "데이터를 적게 쓰는 쪽으로 안내할게요."],
    ]),
    durableKo(35, "constraint", ["손목"], "타이핑", [
        ["user", "손목 터널 증후군이 있어서 오래 타이핑하는 방법은 피해야 합니다."],
        ["assistant", "입력을 줄이는 방향으로 제안하겠습니다."],
    ]),
    durableKo(36, "constraint", ["평일 낮"], "시간", [
        ["user", "평일 낮에는 아예 시간을 못 냅니다. 그 시간대 전제인 방법은 빼주세요."],
        ["assistant", "저녁과 주말 기준으로만 제안하겠습니다."],
    ]),
    durableKo(37, "constraint", ["소음"], "환경", [
        ["user", "층간 소음 문제가 있어서 소리 나는 활동은 집에서 못 합니다."],
        ["assistant", "조용한 대안으로 골라 드릴게요."],
    ]),
    durableKo(38, "recurring_context", ["첫째 주"], "매달", [
        ["user", "매달 첫째 주는 마감이라 다른 걸 얹을 수가 없습니다."],
        ["assistant", "그 주는 비워 두겠습니다."],
    ]),
    durableKo(39, "recurring_context", ["수요일"], "고정 일정", [
        ["user", "수요일 오후는 매주 병원에 갑니다. 몇 년째 그래요."],
        ["assistant", "수요일 오후는 빼고 잡겠습니다."],
    ]),
    durableKo(40, "recurring_context", ["명절"], "주기", [
        ["user", "명절마다 지방에 내려가 있어서 그때는 연락이 잘 안 됩니다."],
        ["assistant", "그 기간은 비는 것으로 두겠습니다."],
    ]),
    durableKo(41, "communication_style", ["서론"], "답변 방식", [
        ["user", "서론 없이 바로 본론으로 가주세요. 앞에 붙는 말이 길면 안 읽게 돼요."],
        ["assistant", "바로 본론부터 쓰겠습니다."],
    ]),
    durableKo(42, "communication_style", ["반대"], "이견", [
        ["user", "제 생각이 틀렸다고 보이면 반대 의견을 그대로 말해 주세요. 맞춰 주실 필요 없습니다."],
        ["assistant", "다르게 보이면 그렇게 말씀드리겠습니다."],
    ]),
    durableKo(43, "tone", ["친근"], "말투", [
        ["user", "너무 딱딱하지 않게, 친근한 말투로 해주시면 좋겠어요."],
        ["assistant", "편한 말투로 쓰겠습니다."],
    ]),
    durableKo(44, "verbosity", ["세 문장"], "분량", [
        ["user", "답은 세 문장 안쪽으로 부탁드립니다. 더 필요하면 제가 물어볼게요."],
        ["assistant", "그 길이로 맞추겠습니다."],
    ]),
    durableKo(45, "structure", ["소제목"], "구성", [
        ["user", "긴 답변에는 소제목을 붙여 주세요. 나눠져 있어야 찾아보기 편합니다."],
        ["assistant", "구획을 나눠서 쓰겠습니다."],
    ]),
    durableKo(46, "formatting", ["굵게"], "강조", [
        ["user", "핵심 문장은 굵게 표시해 주세요. 훑어볼 때 필요해서요."],
        ["assistant", "중요한 부분은 굵게 쓰겠습니다."],
    ]),
    durableKo(47, "language", ["중국어"], "답변 언어", [
        ["user", "중국어 공부 중이라 답변은 중국어로 주시면 좋겠습니다."],
        ["assistant", "앞으로는 중국어로 답하겠습니다."],
    ]),
    durableKo(48, "explanation_depth", ["실무"], "깊이", [
        ["user", "이론까지 파고들지 마시고 실무에서 쓸 만큼만 설명해 주세요."],
        ["assistant", "필요한 선까지만 다루겠습니다."],
    ]),
    durableKo(49, "citation_preference", ["공식 문서"], "근거", [
        ["user", "블로그 말고 공식 문서를 인용해 주세요. 그게 아니면 확인이 안 돼서요."],
        ["assistant", "1차 자료로 인용하겠습니다."],
    ]),
    durableKo(50, "code_style", ["변수명"], "코드", [
        ["user", "코드 예시에서 변수명은 줄이지 말고 온전한 영어 단어로 써 주세요."],
        ["assistant", "축약 없이 쓰겠습니다."],
    ]),
];
