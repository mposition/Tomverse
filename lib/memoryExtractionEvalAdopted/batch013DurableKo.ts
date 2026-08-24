/**
 * Batch 013 — `durable_facts:ko`. **Adopted. This is dataset.**
 *
 * Reviewed and adopted on 2026-08-23, recorded in
 * `docs/ops/memory-extraction-eval-batches/batch-013-durable-facts-ko.md`:
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
 * 46 cases, inside the 25-50 range of docs/ops/memory-extraction-eval-dataset.md §6.1. The
 * number is 46 rather than 50 because the cell is 71 short of its floor: 46
 * now and 25 in the last batch lands on 200 exactly, and neither batch falls
 * under the range's floor. Drafting past 200 would buy nothing and would cost
 * a reviewer verdicts on cases the floor does not ask for.
 *
 * **Written against the 129 cases the cell already holds.** No `mustInclude`
 * topic repeats — a second case on the same topic grows the count without
 * widening what the cell measures (docs/ops/memory-extraction-eval-dataset.md §3.2).
 *
 * Kind spread — widest is 5/46 = 11%, well under the 40% ceiling:
 *   constraint 5, identity 4, preference 4, occupation 4, expertise 4,
 *   long_term_goal 3, project 3, decision 3, relationship 3,
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
    const id = nextId("cand-b013");
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
    id: `cand-durable-ko4-${index}`,
    category: "durable_facts",
    language: "ko",
    expected: [{ id: "e1", kind, mustInclude }],
    conversations: [conversation(title, turns)],
});

export const BATCH_013_DURABLE_KO: readonly MemoryEvalCase[] = [
    durableKo(1, "constraint", ["밀가루"], "먹는 것", [
        ["user", "밀가루를 못 먹습니다. 셀리악이라 조금도 안 됩니다."],
        ["assistant", "밀가루가 들어간 건 전부 빼고 제안드릴게요."],
    ]),
    durableKo(2, "constraint", ["냄새"], "민감한 것", [
        ["user", "인공적인 냄새에 심하게 민감해서 향 있는 제품은 못 씁니다."],
        ["assistant", "무향 제품 위주로 골라 드리겠습니다."],
    ]),
    durableKo(3, "constraint", ["운전"], "이동 수단", [
        ["user", "운전을 못 합니다. 면허가 없어서 자차 전제인 방법은 안 됩니다."],
        ["assistant", "대중교통 기준으로만 안내하겠습니다."],
    ]),
    durableKo(4, "constraint", ["주말"], "가능한 시간", [
        ["user", "주말에는 아예 시간을 못 냅니다. 가족 일정이 고정이라서요."],
        ["assistant", "평일 기준으로만 잡겠습니다."],
    ]),
    durableKo(5, "constraint", ["프린터"], "장비", [
        ["user", "집에 프린터가 없습니다. 출력해서 해야 하는 방법은 빼주세요."],
        ["assistant", "화면에서 끝나는 방법으로 안내할게요."],
    ]),
    durableKo(6, "identity", ["인천"], "사는 곳", [
        ["user", "인천에 삽니다. 서울로 매일 나가지는 않아요."],
        ["assistant", "그 지역 기준으로 보겠습니다."],
    ]),
    durableKo(7, "identity", ["65"], "나이대", [
        ["user", "65년생입니다. 은퇴 관련 얘기가 나오면 그 기준으로 봐주세요."],
        ["assistant", "그 연령대로 잡겠습니다."],
    ]),
    durableKo(8, "identity", ["난청"], "청력", [
        ["user", "한쪽 귀에 난청이 있습니다. 전화 통화는 잘 못 듣는 편이에요."],
        ["assistant", "소리에 의존하지 않는 방법을 우선 드리겠습니다."],
    ]),
    durableKo(9, "identity", ["이중국적"], "국적", [
        ["user", "이중국적이라 서류 관련해서는 양쪽을 다 봐야 합니다."],
        ["assistant", "두 나라 기준을 함께 짚겠습니다."],
    ]),
    durableKo(10, "preference", ["신문"], "정보 습득", [
        ["user", "뉴스는 종이 신문으로 봅니다. 앱은 안 씁니다."],
        ["assistant", "그 방식을 전제로 하겠습니다."],
    ]),
    durableKo(11, "preference", ["자막"], "영상", [
        ["user", "한국어 영상도 자막을 켜고 봅니다. 그게 편해요."],
        ["assistant", "자막 있는 자료로 골라 드릴게요."],
    ]),
    durableKo(12, "preference", ["혼밥"], "식사", [
        ["user", "혼밥이 편합니다. 여럿이 먹는 자리는 되도록 피해요."],
        ["assistant", "혼자 가기 좋은 곳 위주로 보겠습니다."],
    ]),
    durableKo(13, "preference", ["현금"], "결제", [
        ["user", "가능하면 현금으로 냅니다. 카드 안 받는 곳도 상관없어요."],
        ["assistant", "결제 수단은 그 전제로 두겠습니다."],
    ]),
    durableKo(14, "occupation", ["치과위생사"], "직업", [
        ["user", "치과위생사로 일합니다. 토요일도 진료가 있어요."],
        ["assistant", "그 근무 형태를 반영하겠습니다."],
    ]),
    durableKo(15, "occupation", ["과수원"], "일하는 곳", [
        ["user", "사과 과수원을 합니다. 수확기에는 아무것도 못 해요."],
        ["assistant", "농사 일정에 맞춰 보겠습니다."],
    ]),
    durableKo(16, "occupation", ["급식"], "하는 일", [
        ["user", "학교 급식실에서 조리사로 일합니다."],
        ["assistant", "그 맥락으로 두겠습니다."],
    ]),
    durableKo(17, "occupation", ["도배"], "직군", [
        ["user", "도배 일을 합니다. 현장마다 옮겨 다녀서 고정된 사무실은 없어요."],
        ["assistant", "현장 중심으로 보겠습니다."],
    ]),
    durableKo(18, "expertise", ["서예"], "익숙한 분야", [
        ["user", "서예를 이십 년 했습니다. 서체 이름은 그냥 쓰셔도 됩니다."],
        ["assistant", "용어는 그대로 쓰겠습니다."],
    ]),
    durableKo(19, "expertise", ["정비"], "손에 익은 일", [
        ["user", "자동차 정비는 제 전공이라 부품 이름은 설명 안 하셔도 됩니다."],
        ["assistant", "기초는 건너뛰겠습니다."],
    ]),
    durableKo(20, "expertise", ["프랑스어", "처음"], "새로 시작", [
        ["user", "프랑스어는 이번에 처음 배웁니다. 발음 규칙부터 모릅니다."],
        ["assistant", "기초부터 잡아 드릴게요."],
    ]),
    durableKo(21, "expertise", ["응급처치"], "자격", [
        ["user", "응급처치 강사 자격이 있습니다. 의학 용어는 그대로 쓰셔도 됩니다."],
        ["assistant", "용어를 그대로 쓰겠습니다."],
    ]),
    durableKo(22, "long_term_goal", ["시집"], "언젠가", [
        ["user", "시집을 한 권 내는 게 오래된 목표입니다. 아직 원고를 모으는 중이에요."],
        ["assistant", "그 목표를 기준으로 두겠습니다."],
    ]),
    durableKo(23, "long_term_goal", ["세계일주"], "장기 계획", [
        ["user", "언젠가 세계일주를 하려고 지금 저축하고 있습니다."],
        ["assistant", "그 방향으로 맞추겠습니다."],
    ]),
    durableKo(24, "long_term_goal", ["사회복지사"], "전직", [
        ["user", "사회복지사로 직업을 바꾸는 게 목표입니다. 야간 과정을 알아보는 중이에요."],
        ["assistant", "그 전제로 답변드릴게요."],
    ]),
    durableKo(25, "project", ["지도"], "만들고 있는 것", [
        ["user", "동네 골목길 지도를 직접 만들고 있습니다. 이 년째예요."],
        ["assistant", "진행 중인 작업으로 두겠습니다."],
    ]),
    durableKo(26, "project", ["앨범"], "음악", [
        ["user", "밴드에서 앨범을 녹음하고 있습니다. 다섯 곡까지 마쳤어요."],
        ["assistant", "그 프로젝트를 기준으로 하겠습니다."],
    ]),
    durableKo(27, "project", ["한옥"], "고치는 중", [
        ["user", "시골에 있는 한옥을 고치고 있습니다. 주말마다 내려가요."],
        ["assistant", "주말 작업을 전제로 보겠습니다."],
    ]),
    durableKo(28, "decision", ["티비"], "정리한 것", [
        ["user", "티비를 없애기로 하고 이미 처분했습니다. 다시 들일 생각 없어요."],
        ["assistant", "그 전제로 두겠습니다."],
    ]),
    durableKo(29, "decision", ["대출"], "돈 쓰는 순서", [
        ["user", "투자보다 대출 상환을 먼저 하기로 정했습니다. 그 판단은 끝났습니다."],
        ["assistant", "상환 우선으로 보겠습니다."],
    ]),
    durableKo(30, "decision", ["부업"], "일 정리", [
        ["user", "부업은 다 정리하기로 했습니다. 본업에만 집중하려고요."],
        ["assistant", "부업 관련 제안은 빼겠습니다."],
    ]),
    durableKo(31, "relationship", ["어머니", "요양"], "가족", [
        ["user", "어머니가 요양원에 계셔서 주에 두 번은 다녀옵니다."],
        ["assistant", "그 일정을 감안하겠습니다."],
    ]),
    durableKo(32, "relationship", ["딸", "유학"], "자녀", [
        ["user", "딸이 유학 중이라 시차 때문에 통화 시간이 늘 애매합니다."],
        ["assistant", "시차를 감안해서 보겠습니다."],
    ]),
    durableKo(33, "relationship", ["장인"], "함께 사는 분", [
        ["user", "장인어른과 함께 삽니다. 집 관련 결정은 늘 상의해서 합니다."],
        ["assistant", "그 구성으로 두겠습니다."],
    ]),
    durableKo(34, "recurring_context", ["분기"], "주기", [
        ["user", "분기마다 감사를 받아서 그 주는 다른 일을 못 잡습니다."],
        ["assistant", "그 시기는 비워 두겠습니다."],
    ]),
    durableKo(35, "recurring_context", ["토요일"], "고정 일정", [
        ["user", "토요일 오전은 매주 조기축구입니다. 몇 년째 빠진 적이 없어요."],
        ["assistant", "토요일 오전은 제외하겠습니다."],
    ]),
    durableKo(36, "recurring_context", ["성수기"], "계절", [
        ["user", "여름이 성수기라 그 석 달은 거의 쉬는 날이 없습니다."],
        ["assistant", "그 기간은 여유가 없다고 보겠습니다."],
    ]),
    durableKo(37, "communication_style", ["모른다"], "확신 없을 때", [
        ["user", "확실하지 않으면 모른다고 말해 주세요. 지어낸 답이 제일 곤란합니다."],
        ["assistant", "모르는 건 모른다고 말씀드리겠습니다."],
    ]),
    durableKo(38, "communication_style", ["용어"], "전문 표현", [
        ["user", "전문 용어는 그대로 쓰시고 괄호로 짧게 풀어 주세요. 용어 자체를 알아야 해서요."],
        ["assistant", "용어는 남기고 옆에 풀이를 붙이겠습니다."],
    ]),
    durableKo(39, "tone", ["유머"], "말투", [
        ["user", "유머는 넣지 말고 진지하게만 답해 주세요."],
        ["assistant", "담백하게 쓰겠습니다."],
    ]),
    durableKo(40, "verbosity", ["한 문단"], "분량", [
        ["user", "답은 한 문단으로 부탁드립니다. 그 이상은 제가 요청할게요."],
        ["assistant", "한 문단 안에서 정리하겠습니다."],
    ]),
    durableKo(41, "structure", ["요약"], "구성", [
        ["user", "긴 답변은 맨 앞에 요약을 붙여 주세요."],
        ["assistant", "요약을 먼저 쓰겠습니다."],
    ]),
    durableKo(42, "formatting", ["이모지"], "표기", [
        ["user", "이모지는 쓰지 말아 주세요. 업무 문서에 그대로 옮길 일이 많아서요."],
        ["assistant", "쓰지 않겠습니다."],
    ]),
    durableKo(43, "language", ["스페인어"], "답변 언어", [
        ["user", "스페인어로 답해 주세요. 공부 중이라 노출을 늘리려고요."],
        ["assistant", "Responderé en español."],
    ]),
    durableKo(44, "explanation_depth", ["초등학생"], "설명 수준", [
        ["user", "초등학생한테 설명하듯 풀어 주세요. 전문 지식이 하나도 없습니다."],
        ["assistant", "쉬운 말로만 쓰겠습니다."],
    ]),
    durableKo(45, "citation_preference", ["연도"], "인용", [
        ["user", "자료를 인용할 때 연도까지 적어 주세요. 오래된 건 걸러야 해서요."],
        ["assistant", "발행 연도를 함께 쓰겠습니다."],
    ]),
    durableKo(46, "code_style", ["한 파일"], "코드", [
        ["user", "코드 예시는 파일을 나누지 말고 한 파일로 주세요. 옮겨 붙이기 편하게요."],
        ["assistant", "하나로 합쳐서 드리겠습니다."],
    ]),
];
