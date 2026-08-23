/**
 * Batch 015 — `durable_facts:ko`, fifth and final batch. **Candidate pool.**
 *
 * 25 cases, the bottom of docs/ops/memory-extraction-eval-dataset.md §6.1's 25-50 range. That
 * is the exact remainder: 29 adopted plus batches 009, 011, 013 and this one
 * is 200, the floor docs/policy/external-conversation-import-and-memory.md §12.2 sets for this arm. Nothing
 * beyond it is drafted, because a case past the floor still costs a reviewer
 * a verdict and buys no coverage the floor asked for.
 *
 * These are AI drafts. Policy docs/policy/external-conversation-import-and-memory.md §12.6 keeps them a candidate pool
 * until a person adopts them, and this file is deliberately not imported by
 * `lib/memoryExtractionEvalFixtures.ts`.
 *
 * **Written against the 175 cases the cell already holds.** No `mustInclude`
 * topic repeats (docs/ops/memory-extraction-eval-dataset.md §3.2).
 *
 * Kind spread — widest is 3/25 = 12%:
 *   constraint 3, and 2 each of identity, preference, occupation, expertise,
 *   long_term_goal, project, decision, relationship, recurring_context, then
 *   one each of communication_style, verbosity, formatting,
 *   citation_preference.
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
    const id = nextId("cand-b015");
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
    id: `cand-durable-ko5-${index}`,
    category: "durable_facts",
    language: "ko",
    expected: [{ id: "e1", kind, mustInclude }],
    conversations: [conversation(title, turns)],
});

export const BATCH_015_DURABLE_KO: readonly MemoryEvalCase[] = [
    durableKo(1, "constraint", ["어지럼"], "몸 상태", [
        ["user", "기립성 어지럼이 있어서 오래 서 있어야 하는 건 못 합니다."],
        ["assistant", "앉아서 할 수 있는 방법으로 드릴게요."],
    ]),
    durableKo(2, "constraint", ["무거운"], "들 수 있는 것", [
        ["user", "허리 때문에 무거운 걸 못 듭니다. 오 킬로 넘으면 안 돼요."],
        ["assistant", "그 조건에 맞춰서만 제안하겠습니다."],
    ]),
    durableKo(3, "constraint", ["노트북"], "장비", [
        ["user", "노트북이 십 년 된 거라 무거운 프로그램은 아예 안 돌아갑니다."],
        ["assistant", "가벼운 도구 위주로 골라 드릴게요."],
    ]),
    durableKo(4, "identity", ["강원"], "사는 곳", [
        ["user", "강원도 산골에 삽니다. 가까운 마트도 차로 삼십 분이에요."],
        ["assistant", "접근성을 감안해서 보겠습니다."],
    ]),
    durableKo(5, "identity", ["2001"], "나이", [
        ["user", "2001년생입니다. 사회 초년생이라고 보시면 돼요."],
        ["assistant", "그 기준으로 답변드릴게요."],
    ]),
    durableKo(6, "preference", ["버스"], "이동", [
        ["user", "지하철보다 버스를 탑니다. 밖이 보여야 마음이 편해서요."],
        ["assistant", "경로는 버스 기준으로 안내하겠습니다."],
    ]),
    durableKo(7, "preference", ["손글씨"], "기록", [
        ["user", "메모는 손글씨로 합니다. 앱에 적으면 기억에 안 남아요."],
        ["assistant", "종이에 옮기기 좋은 형태로 정리해 드릴게요."],
    ]),
    durableKo(8, "occupation", ["승무원"], "직업", [
        ["user", "항공 승무원입니다. 한 달에 열흘은 해외에 있어요."],
        ["assistant", "그 일정으로 잡겠습니다."],
    ]),
    durableKo(9, "occupation", ["어업"], "하는 일", [
        ["user", "어업에 종사합니다. 날씨에 따라 일정이 통째로 바뀝니다."],
        ["assistant", "고정 일정은 피해서 제안하겠습니다."],
    ]),
    durableKo(10, "expertise", ["뜨개질"], "익숙한 것", [
        ["user", "뜨개질은 삼십 년 했습니다. 도안 기호는 설명 없이 보셔도 됩니다."],
        ["assistant", "도안 표기는 그대로 쓰겠습니다."],
    ]),
    durableKo(11, "expertise", ["바둑"], "취미", [
        ["user", "바둑은 아마 오단입니다. 정석 이름은 그냥 말씀하셔도 알아들어요."],
        ["assistant", "용어를 그대로 쓰겠습니다."],
    ]),
    durableKo(12, "long_term_goal", ["국악"], "언젠가", [
        ["user", "국악 무대에 한 번 서보는 게 오래된 목표입니다."],
        ["assistant", "그 목표를 기준으로 두겠습니다."],
    ]),
    durableKo(13, "long_term_goal", ["게스트하우스"], "창업", [
        ["user", "게스트하우스를 여는 게 최종 목표예요. 자리를 알아보는 중입니다."],
        ["assistant", "그 방향으로 맞추겠습니다."],
    ]),
    durableKo(14, "project", ["웹툰"], "연재", [
        ["user", "웹툰을 격주로 연재하고 있습니다. 혼자 그리고 혼자 올려요."],
        ["assistant", "그 작업을 전제로 하겠습니다."],
    ]),
    durableKo(15, "project", ["학회"], "준비 중", [
        ["user", "가을 학회 발표를 준비하고 있습니다. 초록은 넘겼고 슬라이드가 남았어요."],
        ["assistant", "그 일정에 맞춰 보겠습니다."],
    ]),
    durableKo(16, "decision", ["헬스장"], "정리한 것", [
        ["user", "헬스장은 끊기로 했습니다. 집에서 하는 쪽으로 이미 정했어요."],
        ["assistant", "집에서 되는 방법만 드리겠습니다."],
    ]),
    durableKo(17, "decision", ["서울"], "거주지", [
        ["user", "서울로는 안 올라가기로 결정했습니다. 그 얘기는 끝난 문제예요."],
        ["assistant", "지방에 머무는 전제로 보겠습니다."],
    ]),
    durableKo(18, "relationship", ["할머니"], "가족", [
        ["user", "할머니께 매일 전화를 드립니다. 그게 하루 일과 중 하나예요."],
        ["assistant", "그 습관을 감안하겠습니다."],
    ]),
    durableKo(19, "relationship", ["처남"], "함께 일하는 사람", [
        ["user", "처남이랑 같이 가게를 합니다. 돈 얘기는 늘 같이 결정해요."],
        ["assistant", "공동 결정으로 두겠습니다."],
    ]),
    durableKo(20, "recurring_context", ["3월"], "매년", [
        ["user", "매년 3월에 정기검진을 받습니다. 그 주는 병원 일정이 붙어 있어요."],
        ["assistant", "그 시기를 비워 두겠습니다."],
    ]),
    durableKo(21, "recurring_context", ["목요일"], "매주", [
        ["user", "목요일은 매주 야근입니다. 몇 년째 그렇습니다."],
        ["assistant", "목요일 저녁은 제외하겠습니다."],
    ]),
    durableKo(22, "communication_style", ["예시"], "설명 순서", [
        ["user", "설명보다 예시를 먼저 보여 주세요. 예시를 봐야 이해가 됩니다."],
        ["assistant", "예시부터 놓고 설명하겠습니다."],
    ]),
    durableKo(23, "verbosity", ["다섯 줄"], "분량", [
        ["user", "답변은 다섯 줄 정도가 딱 좋습니다. 그보다 길면 안 읽게 돼요."],
        ["assistant", "그 정도 길이로 맞추겠습니다."],
    ]),
    durableKo(24, "formatting", ["코드블록"], "표기", [
        ["user", "명령어는 코드블록으로 감싸 주세요. 복사할 때 섞이면 곤란해서요."],
        ["assistant", "그렇게 표시하겠습니다."],
    ]),
    durableKo(25, "citation_preference", ["링크"], "자료 위치", [
        ["user", "링크는 본문에 섞지 말고 맨 끝에 모아 주세요. 읽는 흐름이 끊겨서요."],
        ["assistant", "마지막에 모아 두겠습니다."],
    ]),
];
