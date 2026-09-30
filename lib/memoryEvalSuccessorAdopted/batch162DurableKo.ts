/**
 * Successor batch 162 — `durable_facts:ko`, replacement cases 301–329.
 *
 * **Written for `mem-eval-succ-3`.** These 29 take the place of the 29
 * `durable_facts:ko` originals that moved to `lib/memoryEvalRegressionCorpus/`.
 * Every one of those was used to author or approve a rule of `mem-extract-v5`
 * or a gold ruling in
 * `.github/audits/memory-eval-kind-boundary-amendment-2026-08-27.md`, and a
 * case that decided a rule cannot also measure it.
 *
 * ## The gold is the amendment's, not succ-2's
 *
 * The originals still carry their pre-amendment labels, because succ-2 is
 * frozen and was never edited. The rulings land here instead: `외동` and
 * `삼남매` were `identity` and the amendment made that boundary
 * `relationship` (§4.3 ①), so the replacements are labelled the way the
 * amendment settled, not the way the case they replace was.
 *
 * ## Same boundary, different situation
 *
 * A paraphrase would leave `mem-extract-v5` answering a sentence it was
 * written from. So each case keeps what its original was testing — which kind
 * wins at a boundary — and changes the situation entirely. `ko-106`'s cats
 * become a rabbit; `ko-156`'s care-home visits become weekend shifts in a
 * father's shop. What carries over is the question, never the wording.
 *
 * ## No `sourceCaseId`
 *
 * New conversations rather than reworks of a seed case, so there is no earlier
 * case to declare — and the near-duplicate detector stays free to report one
 * of these repeating a template.
 */

import type { MemoryEvalCaseV2 } from "@/lib/memoryEvalDatasetSchema";

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${(sequence += 1)}`;

const conversation = (
    title: string,
    turns: readonly (readonly [role: "user" | "assistant", content: string])[]
) => {
    const id = nextId("succ-b162");
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

const makeCase = (
    index: number,
    title: string,
    turns: readonly (readonly [role: "user" | "assistant", content: string])[],
    expected: readonly ReturnType<typeof gold>[]
): MemoryEvalCaseV2 => ({
    id: `succ-durable-ko-${index}`,
    category: "durable_facts",
    language: "ko",
    expected,
    goldCompleteness: "exhaustive",
    conversations: [conversation(title, turns)],
});

export const BATCH_162_DURABLE_KO: readonly MemoryEvalCaseV2[] = [
    // Replaces ko-105 (§5.1). Another person causes a repeated situation; the
    // reusable proposition is the household rhythm, not the person.
    makeCase(
        301,
        "새벽에 나가는 가족",
        [
            ["user", "아버지가 새벽 시장에 나가셔서 저희 집은 아침 여섯 시면 다들 깨어 있습니다."],
            ["assistant", "이른 시간대를 전제로 보겠습니다."],
        ],
        [gold(1, "recurring_context", ["여섯"])]
    ),
    // Replaces ko-106 (§5.3). A companion animal is a relationship because
    // rule 4 says so explicitly — without that clause this gold had no basis.
    makeCase(
        302,
        "토끼를 키웁니다",
        [
            ["user", "토끼를 한 마리 키웁니다. 집 온도 얘기할 때 그거 감안해 주세요."],
            ["assistant", "반려동물이 있는 집 기준으로 보겠습니다."],
        ],
        [gold(1, "relationship", ["토끼"])]
    ),
    // Replaces ko-107 (§5.3). Remove the shared living and the tie is still
    // useful, so relationship rather than recurring_context.
    makeCase(
        303,
        "이모와 한집",
        [
            ["user", "이모와 한집에 삽니다. 살림은 같이 꾸리고요."],
            ["assistant", "그 구성으로 두겠습니다."],
        ],
        [gold(1, "relationship", ["이모"])]
    ),
    // Replaces ko-116 (§4.3). Ordering the parts of an answer is `structure`;
    // `communication_style` is the residual and loses to it.
    makeCase(
        304,
        "예시부터 보여주세요",
        [
            ["user", "예시를 먼저 보여주고 설명은 그 뒤에 붙여 주세요."],
            ["assistant", "예시를 앞에 두겠습니다."],
        ],
        [gold(1, "structure", ["예시"])]
    ),
    // Replaces ko-133 (§4.3 ②). A functional health limit is `constraint`,
    // and it is held for review rather than auto-approved.
    makeCase(
        305,
        "손목 관절염",
        [
            ["user", "손목 관절염이 있어서 오래 타이핑하는 건 어렵습니다."],
            ["assistant", "입력을 적게 요구하는 쪽으로 안내드리겠습니다."],
        ],
        [gold(1, "constraint", ["관절염"], "sensitive_review")]
    ),
    // Replaces ko-134. Stays `identity`: a stable legal status with a direct
    // consequence, and no separate recurring event to name.
    makeCase(
        306,
        "영주권 서류",
        [
            ["user", "영주권자라서 체류 관련 서류는 늘 별도로 챙겨야 합니다."],
            ["assistant", "그 부분을 함께 짚겠습니다."],
        ],
        [gold(1, "identity", ["영주권"])]
    ),
    // Replaces ko-145 (§6). Being a beginner is a durable proficiency level,
    // so `expertise` — turning it into an answer-style preference is the
    // inference rule 5 refuses.
    makeCase(
        307,
        "용접은 처음입니다",
        [
            ["user", "용접은 이번 달에 처음 배우기 시작했습니다. 아직 기초도 모릅니다."],
            ["assistant", "기초부터 잡아 드리겠습니다."],
        ],
        [
            gold(1, "expertise", ["용접"], "bulk_safe", [
                "처음",
                "초보",
                "기초",
                "입문",
                "배우기 시작",
                "시작한 지",
            ]),
        ]
    ),
    // Replaces ko-15 (§3). Rule 4's contrast: a repeated clause with no person
    // in it at all.
    makeCase(
        308,
        "격주 재고 조사",
        [
            ["user", "격주 금요일마다 재고 조사를 해서 그날은 오후가 통째로 나갑니다."],
            ["assistant", "그 날짜는 비워 두고 잡겠습니다."],
        ],
        [gold(1, "recurring_context", ["재고"])]
    ),
    // Replaces ko-156 (§5.1). The father appears and the kind is still
    // `recurring_context`: the reusable fact is the user's own weekend.
    makeCase(
        309,
        "주말마다 가게 일",
        [
            ["user", "주말마다 아버지 가게 일을 도우러 갑니다."],
            ["assistant", "주말은 비어 있지 않은 것으로 두겠습니다."],
        ],
        [gold(1, "recurring_context", ["주말"], "bulk_safe", ["가게", "돕", "도우", "일손"])]
    ),
    // Replaces ko-157 (§5.1). A relative's circumstance explains a rhythm;
    // the rhythm is what gets stored.
    makeCase(
        310,
        "매달 초 일주일",
        [
            ["user", "장모님이 매달 초에 저희 집에 일주일씩 머무십니다."],
            ["assistant", "그 기간을 감안하겠습니다."],
        ],
        [gold(1, "recurring_context", ["일주일"])]
    ),
    // Replaces ko-158 (§5.4). Two golds: the tie and the consequence are
    // independently useful, so they are separate candidates.
    makeCase(
        311,
        "삼촌과 같이 사는 집",
        [
            ["user", "삼촌과 함께 삽니다. 큰 지출은 늘 상의해서 정합니다."],
            ["assistant", "공동 결정으로 두겠습니다."],
        ],
        [
            gold(1, "relationship", ["삼촌"]),
            gold(2, "recurring_context", ["지출"], "bulk_safe", ["상의", "함께", "같이", "공동"]),
        ]
    ),
    // Replaces ko-163 (§6). Two independent demands: where the note goes is
    // `formatting`, how much is explained is `explanation_depth`.
    makeCase(
        312,
        "약어는 각주로",
        [
            ["user", "약어는 본문에 그대로 쓰시고 각주로 한 줄씩 풀어 주세요. 약어 자체를 익혀야 해서요."],
            ["assistant", "본문은 약어로 두고 각주를 달겠습니다."],
        ],
        [
            gold(1, "formatting", ["각주"]),
            gold(2, "explanation_depth", ["약어"], "bulk_safe", ["풀이", "설명", "풀어", "한 줄"]),
        ]
    ),
    // Replaces ko-175 (§4.3 ②). An accessibility limit that is not health,
    // diagnosis or disability: `constraint`, and bulk-safe.
    makeCase(
        313,
        "배송이 안 되는 곳",
        [
            ["user", "섬에 살아서 당일 배송이 되는 물건이 거의 없습니다."],
            ["assistant", "배송 가능 여부를 먼저 보고 고르겠습니다."],
        ],
        [gold(1, "constraint", ["배송"])]
    ),
    // Replaces ko-189 (§5.1). A named frequency, unlike ko-59's vague "자주".
    makeCase(
        314,
        "매일 저녁 산책",
        [
            ["user", "아버지랑 매일 저녁에 삼십 분씩 걷습니다. 그게 하루 마무리예요."],
            ["assistant", "저녁 시간대는 그 일정으로 두겠습니다."],
        ],
        [gold(1, "recurring_context", ["매일"], "bulk_safe", ["걷", "산책", "저녁"])]
    ),
    // Replaces ko-190 (§5.5). Three propositions, each independently useful.
    makeCase(
        315,
        "누나와 공방",
        [
            ["user", "누나랑 둘이 공방을 운영합니다. 재료 주문은 매달 같이 정합니다."],
            ["assistant", "두 분 공동 운영으로 두겠습니다."],
        ],
        [
            gold(1, "relationship", ["누나"]),
            gold(2, "occupation", ["공방"]),
            gold(3, "recurring_context", ["주문"], "bulk_safe", ["매달", "매월", "달마다"]),
        ]
    ),
    // Replaces ko-2 (§3). Rule 4's contrast in the other direction: a job and
    // a rhythm in one turn, and both are worth storing.
    makeCase(
        316,
        "관제탑 근무",
        [
            ["user", "항공 관제사입니다. 4조 2교대라 근무가 주마다 달라집니다."],
            ["assistant", "교대 주기를 알려주시면 반영하겠습니다."],
        ],
        [
            gold(1, "occupation", ["관제"]),
            gold(2, "recurring_context", ["교대"]),
        ]
    ),
    // Replaces ko-21 (§3). The case that moved rule 2's third clause from
    // "지속 표현" to "요청이냐 승인이냐": a plain request, kept.
    makeCase(
        317,
        "근거 링크를 같이",
        [
            ["user", "설명할 때마다 근거 링크를 같이 붙여 주세요"],
            ["assistant", "출처를 함께 달겠습니다."],
        ],
        [gold(1, "citation_preference", ["링크"])]
    ),
    // Replaces ko-23 (§5.4). Two golds: the partner and the business.
    makeCase(
        318,
        "친구와 하는 카페",
        [
            ["user", "친구랑 둘이서 카페를 합니다. 지분은 반반이고요."],
            ["assistant", "두 분이 반반이시군요."],
        ],
        [gold(1, "relationship", ["친구"]), gold(2, "occupation", ["카페"])]
    ),
    // Replaces ko-28 (§4.3 ②). A stated limit on what tools work: functional,
    // so `constraint` rather than `identity`.
    makeCase(
        319,
        "위쪽 선반",
        [
            ["user", "키가 작아서 위쪽 선반에 두는 물건은 저한테 안 맞습니다."],
            ["assistant", "손이 닿는 높이 기준으로 골라 드리겠습니다."],
        ],
        [gold(1, "constraint", ["선반"])]
    ),
    // Replaces ko-29 (§4.3 ①). A family structure is `relationship`, which
    // beats `identity` at the family boundary.
    makeCase(
        320,
        "재혼 가정",
        [
            ["user", "재혼 가정에서 자랐고 의붓형이 하나 있습니다."],
            ["assistant", "가족 구성을 그렇게 두겠습니다."],
        ],
        [gold(1, "relationship", ["의붓형"])]
    ),
    // Replaces ko-47 (§6). Three years of the same weekend activity is a
    // repeated situation, not a project.
    makeCase(
        321,
        "합창단 연습",
        [
            ["user", "화요일 저녁마다 합창단 연습에 나갑니다. 올해로 오 년째예요."],
            ["assistant", "화요일 저녁은 고정으로 두겠습니다."],
        ],
        [gold(1, "recurring_context", ["합창"])]
    ),
    // Replaces ko-59 (§5.3). One gold: "가끔"은 예측 가능한 반복이 아니므로
    // 관계만 남습니다 — ko-314와 대조되는 경계입니다.
    makeCase(
        322,
        "가끔 보는 손주",
        [
            ["user", "손주를 가끔 봅니다. 큰애가 이제 막 걷기 시작했어요."],
            ["assistant", "그 연령대를 감안해서 말씀드릴게요."],
        ],
        [gold(1, "relationship", ["손주"])]
    ),
    // Replaces ko-61 (§5.3). Living arrangement stated as a household tie.
    makeCase(
        323,
        "명절 계획",
        [
            ["user", "명절 계획을 짜는 중입니다. 할아버지를 모시고 살아서 이동 없이 집에서 하려고요."],
            ["assistant", "집에서 치르는 쪽으로 보겠습니다."],
        ],
        [gold(1, "relationship", ["할아버지"])]
    ),
    // Replaces ko-62 (§5.3). A shared-tenancy tie.
    makeCase(
        324,
        "하숙집",
        [
            ["user", "하숙을 하고 있어서 주인집 가족과 같이 지냅니다."],
            ["assistant", "공유 공간 기준으로 이어가겠습니다."],
        ],
        [gold(1, "relationship", ["하숙"])]
    ),
    // Replaces ko-76 (§3). `identity` as the residual: nothing more specific
    // is available, so ③ applies.
    makeCase(
        325,
        "대전 토박이",
        [
            ["user", "이사 얘기가 나올 때마다 말씀드리는데, 저는 대전 토박이입니다."],
            ["assistant", "그 지역 기준으로 안내드릴게요."],
        ],
        [gold(1, "identity", ["대전"])]
    ),
    // Replaces ko-78 (§4.3 ②). A functional sensory limit, held for review.
    makeCase(
        326,
        "저시력",
        [
            ["user", "저시력이라 작은 글씨로 된 표는 읽지 못합니다."],
            ["assistant", "표 대신 문장으로 풀어 드리겠습니다."],
        ],
        [gold(1, "constraint", ["저시력"], "sensitive_review")]
    ),
    // Replaces ko-79 (§4.3 ①). Sibling structure is `relationship`.
    makeCase(
        327,
        "막내입니다",
        [
            ["user", "삼형제 막내로 자랐습니다. 위로 형이 둘이에요."],
            ["assistant", "형제 순서가 필요한 이야기면 반영하겠습니다."],
        ],
        [gold(1, "relationship", ["막내"])]
    ),
    // Replaces ko-83 (§6). Where the work happens, repeatedly — a situation,
    // not a preference.
    makeCase(
        328,
        "카페에서만 됩니다",
        [
            ["user", "글 쓰는 일은 전부 동네 카페에서 합니다. 사무실에서는 한 줄도 못 써요."],
            ["assistant", "작업 환경은 그쪽 기준으로 보겠습니다."],
        ],
        [gold(1, "recurring_context", ["카페"])]
    ),
    // Replaces ko-99 (§6). Stays `project`: a piece of work in progress, and
    // v4 already says recurring_context is not another word for one.
    makeCase(
        329,
        "번역 중인 책",
        [
            ["user", "작년부터 소설 한 권을 번역하고 있습니다. 아직 절반쯤 왔어요."],
            ["assistant", "그 작업을 전제로 하겠습니다."],
        ],
        [gold(1, "project", ["번역"])]
    ),
];
