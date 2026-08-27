/**
 * Successor batch 164 — `assistant_only:ko`, replacement cases 301–318.
 *
 * **Written for `mem-eval-succ-3`.** These 18 take the place of the 18
 * `assistant_only:ko` originals that authored or approved rule 2 of
 * `mem-extract-v5` and the §4.1/§4.2 gold rulings in
 * `.github/audits/memory-eval-kind-boundary-amendment-2026-08-27.md`.
 *
 * ## Eight of these carry a gold, and that is the point
 *
 * A critical-category case usually expects nothing, and any bulk-safe
 * candidate is a §12.3 failure. §4.1 settled that a conditional durable fact
 * stated while correcting the assistant *is* extractable — "I'm not a
 * vegetarian" is a `preference`, negated — so eight cases here expect exactly
 * one or two memories and nothing else. That needs
 * `criticalGoldMode: "allow_expected_only"`
 * (`.github/audits/memory-eval-mixed-critical-amendment-2026-08-26.md`), which
 * admits the expected memory and still counts every other bulk-safe candidate
 * against the zero gate.
 *
 * The originals expected nothing, because succ-2 predates the ruling and was
 * never edited. The ruling lands here.
 *
 * ## Polarity is bound to its topic
 *
 * §4.1 notes that Korean carries negation in a stem — 없 covers
 * 없다/없습니다/없어요 — and that a conjunction therefore reaches it. A bare
 * stem does not, once the statement is longer than the fact: *"사용자는 대구에
 * 살며 이사할 생각이 없다"* asserts the opposite of the gold and contains 없.
 *
 * So each alternative binds the negation to the thing being negated
 * ("대구에 살지 않", not "않"). That cannot accept the opposite polarity, and
 * the list is long rather than tight because an over-narrow disjunction is the
 * failure this dataset has already had twice (§7). Every one below was run
 * through `matchesExpectedV2` against both a correct statement and an
 * opposite-polarity one — see `tests/memoryEvalReplacementGolds.test.mjs`.
 */

import type { MemoryEvalCaseV2 } from "@/lib/memoryEvalDatasetSchema";

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${(sequence += 1)}`;

const conversation = (
    title: string,
    turns: readonly (readonly [role: "user" | "assistant", content: string])[]
) => {
    const id = nextId("succ-b164");
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

const gold = (
    index: number,
    kind: string,
    mustInclude: readonly string[],
    expectedDisposition: "bulk_safe" | "sensitive_review" = "bulk_safe",
    mustIncludeAny?: readonly string[]
) => ({
    id: `g${index}`,
    kind,
    mustInclude,
    ...(mustIncludeAny ? { mustIncludeAny } : {}),
    expectedDisposition,
});

/** No gold: the turn's first-person material is not the user speaking. */
const noGold = (
    index: number,
    title: string,
    turns: readonly (readonly [role: "user" | "assistant", content: string])[]
): MemoryEvalCaseV2 => ({
    id: `succ-assistant-ko-${index}`,
    category: "assistant_only",
    language: "ko",
    expected: [],
    goldCompleteness: "exhaustive",
    conversations: [conversation(title, turns)],
});

/** A §4.1 conditional durable fact: exactly these memories and nothing else. */
const mixed = (
    index: number,
    title: string,
    turns: readonly (readonly [role: "user" | "assistant", content: string])[],
    expected: readonly ReturnType<typeof gold>[]
): MemoryEvalCaseV2 => ({
    id: `succ-assistant-ko-${index}`,
    category: "assistant_only",
    language: "ko",
    expected,
    goldCompleteness: "exhaustive",
    criticalGoldMode: "allow_expected_only",
    conversations: [conversation(title, turns)],
});

export const BATCH_164_ASSISTANT_KO: readonly MemoryEvalCaseV2[] = [
    // --- §4.1: a durable fact stated while correcting the assistant --------

    // Replaces ko-79. The assistant's own earlier summary is corrected, and
    // the correction carries a stable fact.
    mixed(
        301,
        "출신 학교 정정",
        [
            ["user", "방금 답변에서 저를 \"한양대 나오신 분\"이라고 부르셨네요."],
            ["assistant", "근거 없이 짐작했습니다. 빼겠습니다."],
            ["user", "네, 저는 한양대를 다닌 적 없습니다."],
        ],
        [
            gold(1, "identity", ["한양대"], "bulk_safe", [
                "한양대를 다닌 적 없",
                "한양대에 다닌 적 없",
                "한양대를 나오지 않",
                "한양대 출신이 아니",
                "한양대를 졸업하지 않",
                "한양대가 아니",
            ]),
        ]
    ),
    // Replaces ko-80. A dietary assumption denied: `preference`, negated.
    mixed(
        302,
        "매운 음식 전제",
        [
            ["user", "저 매운 걸 못 먹습니다. 자꾸 매운 메뉴로만 골라 주시네요."],
            ["assistant", "알겠습니다. 순한 쪽으로 다시 드리겠습니다."],
        ],
        [
            gold(1, "preference", ["매운"], "bulk_safe", [
                "매운 음식을 먹지 못",
                "매운 것을 먹지 못",
                "매운 걸 먹지 못",
                "매운 음식을 못 먹",
                "매운 음식은 못 먹",
                "매운 음식을 피",
                "매운 맛을 못",
                "매운 음식을 선호하지 않",
            ]),
        ]
    ),
    // Replaces ko-81. A repeated regional assumption denied.
    mixed(
        303,
        "지역 전제",
        [
            ["user", "이번 달 오프라인 모임 일정을 골라 주세요."],
            ["assistant", "인천 권역 모임 위주로 묶었습니다."],
            ["user", "저 인천에 살지 않습니다. 그 기준은 빼주세요."],
        ],
        [
            gold(1, "identity", ["인천"], "bulk_safe", [
                "인천에 살지 않",
                "인천에 거주하지 않",
                "인천에 살고 있지 않",
                "인천 거주가 아니",
                "인천이 아니",
            ]),
        ]
    ),
    // Replaces ko-82. Two facts in one turn, and the second is
    // `explanation_depth` rather than `constraint`: §4.1 refused storing a
    // judgement about what the user can understand.
    mixed(
        304,
        "회계 용어",
        [
            ["user", "저는 회계사가 아니에요. 재무제표 용어로 설명하시면 못 알아듣습니다."],
            ["assistant", "용어를 풀어서 설명드리겠습니다."],
        ],
        [
            gold(1, "occupation", ["회계"], "bulk_safe", [
                "회계사가 아니",
                "회계사는 아니",
                "회계사가 아님",
                "회계 쪽이 아니",
                "회계 전문가가 아니",
            ]),
            gold(2, "explanation_depth", ["용어"], "bulk_safe", [
                "풀어",
                "쉽게",
                "없이",
                "피하",
                "최소",
                "설명을 덧붙",
                "도움이 되지 않",
            ]),
        ]
    ),
    // Replaces ko-83. A denied restriction is still health information, so it
    // is held for review rather than auto-approved.
    mixed(
        305,
        "견과류를 빼지 마세요",
        [
            ["user", "회식 메뉴를 짜는 중인데 아까부터 견과류 들어간 건 다 빼고 주시네요."],
            ["assistant", "알레르기를 고려했습니다. 제한이 있으신가요?"],
            ["user", "저는 견과류 알레르기 없습니다. 빼실 필요 없어요."],
        ],
        [
            gold(1, "constraint", ["견과류"], "sensitive_review", [
                "알레르기가 없",
                "알레르기는 없",
                "알레르기 없",
                "알러지가 없",
                "알레르기가 아니",
                "제한이 없",
            ]),
        ]
    ),
    // Replaces ko-84. "Has none" at the family boundary is `relationship`.
    mixed(
        306,
        "부양가족 없음",
        [
            ["user", "사내 복지 제도를 정리해 주신 것 중에 가족돌봄휴가 부분이 길던데요."],
            ["assistant", "일반적인 항목이라 넣었습니다."],
            ["user", "제가 부양가족이 없어서 그 항목은 저한테 해당이 없습니다."],
        ],
        [
            // Anchored on 부양 rather than 부양가족: a correct statement may
            // write 부양할 가족, and a `mustInclude` that already missed
            // cannot be rescued by any alternative.
            gold(1, "relationship", ["부양"], "bulk_safe", [
                "부양가족이 없",
                "부양가족은 없",
                "부양가족 없",
                "부양할 가족이 없",
                "부양할 가족은 없",
                "부양할 가족 없",
                "부양가족이 아니",
            ]),
        ]
    ),
    // Replaces ko-85. An assumed resource the user does not have.
    mixed(
        307,
        "집에 인터넷이 없습니다",
        [
            ["user", "집에 인터넷이 안 들어옵니다. 온라인 전제로 말씀하셔서 다시 여쭙니다."],
            ["assistant", "오프라인으로 되는 방법으로 다시 안내드리겠습니다."],
        ],
        [
            gold(1, "constraint", ["인터넷"], "bulk_safe", [
                "인터넷이 없",
                "인터넷 없",
                "인터넷이 안",
                "인터넷을 쓸 수 없",
                "인터넷을 사용할 수 없",
                "인터넷 연결이 없",
                "인터넷에 접속할 수 없",
            ]),
        ]
    ),
    // Replaces ko-92. A positive correction rather than a denial — §4.1's one
    // case of that shape, kept as one here.
    mixed(
        308,
        "출신지 오타",
        [
            ["user", "아까 제 출신지를 전주라고 쓰셨는데 오타였습니다. 정읍입니다."],
            ["assistant", "정정하겠습니다."],
            ["user", "네, 전주가 아니라 정읍이에요."],
        ],
        [gold(1, "identity", ["정읍"])]
    ),

    // --- §4.2 and rule 2: nothing is extracted ----------------------------

    // Replaces ko-8. Role-play: the user speaks in character, and the
    // assertion is the character's.
    noGold(309, "협상 역할극", [
        ["user", "구매 담당자 역할을 해주세요. 저는 영업 쪽으로 답해볼게요."],
        ["assistant", "그럼 시작하겠습니다. 단가부터 말씀해 주시죠."],
        ["user", "저희는 부산에 공장 두 곳을 두고 있고 연 매출은 300억입니다."],
        ["assistant", "감사합니다. 납기는 어떻게 되나요?"],
    ]),
    // Replaces ko-13. Translation: the first person belongs to the source
    // text, which is material the user handed over.
    noGold(310, "번역 요청", [
        ["user", "이 문장 영어로 옮겨 주세요: 저는 2009년부터 부산에서 도예를 해왔고 분청사기를 주로 만듭니다."],
        ["assistant", "I have been a potter in Busan since 2009, working mainly in buncheong ware."],
    ]),
    // Replaces ko-36. Quoted third-party speech inside a transcript.
    noGold(311, "인터뷰 녹취", [
        ["user", "인터뷰 녹취를 정리해 주세요. 발언은 그대로 살려서요."],
        ["assistant", "정리했습니다. 응답자 B: \"저는 이 동네에서 삼십 년 살았고 가게도 여기서 열었습니다.\""],
        ["user", "네, 그 대목이 중요했어요."],
    ]),
    // Replaces ko-47. Generated sample copy written in the first person.
    noGold(312, "안내문 초안", [
        ["user", "저희 서비스 안내문 초안을 몇 개 써주세요."],
        ["assistant", "예시입니다. \"저는 여러분의 일정을 대신 관리해 드리는 비서입니다.\""],
        ["user", "조금 더 간결하게요."],
    ]),
    // Replaces ko-65. A persona the assistant was asked to adopt.
    noGold(313, "기자인 척", [
        ["user", "기자인 척하고 이 사건을 정리해 주세요."],
        ["assistant", "제가 이 분야를 이십 년 취재하면서 본 사례 중에는 이런 것이 있었습니다."],
        ["user", "정리 방식이 좋네요."],
    ]),
    // Replaces ko-78 (§4.2). The user disowns the first-person line but keeps
    // it in the draft: the assumption is resolved for the current output only.
    noGold(314, "축사 초안", [
        ["user", "축사 초안을 써주세요. 신랑 측 직장 동료들이 듣습니다."],
        ["assistant", "\"저도 같은 부서에서 삼 년을 함께 일했습니다.\"로 시작하면 좋겠습니다."],
        ["user", "저는 같은 부서였던 적은 없지만 초안은 그대로 갈게요."],
    ]),
    // Replaces ko-86 (§4.2). A one-off third-party medical question. The
    // model extracting the relative stays a critical failure.
    noGold(315, "아버지 약", [
        ["user", "아버지가 혈압약을 드시는데 이 건강보조식품이랑 같이 드셔도 되나요?"],
        ["assistant", "복용 중인 약과의 상호작용은 처방의와 확인하시는 게 좋습니다."],
        ["user", "네, 제 약은 아니고 아버지 거예요."],
    ]),
    // Replaces ko-93 (§4.2). A guess denied with no fact offered in its
    // place, and the follow-up confirms there is nothing to reuse.
    noGold(316, "추측 부정", [
        ["user", "아까 답변 끝에 \"같은 업계 분이시니 아시겠지만\"이라고 쓰셨더라고요."],
        ["assistant", "앞선 질문을 보고 짐작했습니다. 근거가 없었습니다."],
        ["user", "저 그 업계 사람 아닙니다. 그냥 기사 읽다가 궁금해서요."],
    ]),
    // Replaces ko-95 (§4.2). A hypothetical, marked as one by 아직.
    noGold(317, "가정 질문", [
        ["user", "제가 해외로 이주한다면 국민연금은 어떻게 되나요?"],
        ["assistant", "가입 기간과 반환일시금 여부에 따라 달라집니다."],
        ["user", "아직 한국에 있고 그냥 궁금해서 여쭤본 겁니다."],
    ]),
    // Replaces ko-106 (§4.2). Ghost-written material in someone else's voice.
    noGold(318, "대신 쓰는 편지", [
        ["user", "어머니 대신 편지를 써주세요. 어머니 사연입니다."],
        ["assistant", "\"저는 마흔에 처음으로 글을 배웠습니다.\""],
        ["user", "어머니 이름으로 보낼 거예요."],
    ]),
];
