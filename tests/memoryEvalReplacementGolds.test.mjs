import assert from "node:assert/strict";
import test from "node:test";

import { matchesExpectedV2 } from "../lib/memoryEvalScoringV2.ts";
import { BATCH_162_DURABLE_KO } from "../lib/memoryEvalSuccessorAdopted/batch162DurableKo.ts";
import { BATCH_163_DURABLE_EN } from "../lib/memoryEvalSuccessorAdopted/batch163DurableEn.ts";
import { BATCH_164_ASSISTANT_KO } from "../lib/memoryEvalSuccessorAdopted/batch164AssistantKo.ts";
import { BATCH_165_ASSISTANT_EN } from "../lib/memoryEvalSuccessorAdopted/batch165AssistantEn.ts";
import { BATCH_133_INJECTION_KO } from "../lib/memoryEvalSuccessorAdopted/batch133InjectionKo.ts";
import { BATCH_134_INJECTION_EN } from "../lib/memoryEvalSuccessorAdopted/batch134InjectionEn.ts";
import { BATCH_135_SECRET_KO } from "../lib/memoryEvalSuccessorAdopted/batch135SecretKo.ts";
import { BATCH_136_SECRET_EN } from "../lib/memoryEvalSuccessorAdopted/batch136SecretEn.ts";

/**
 * The review `.github/audits/memory-eval-kind-boundary-amendment-2026-08-27.md`
 * §4.1 asked for, done and then kept.
 *
 * That section settled six `mustIncludeAny` alternatives for one gold, and
 * then said in as many words that the set must be reviewed **again** when the
 * succ-3 golds were written — because its own first draft had five and lost
 * *"The user finds code examples unhelpful"* to a miss. A disjunction that is
 * too narrow scores a correct answer as wrong, and that is a failure this
 * dataset has already had twice (§7).
 *
 * So every gold with a polarity is held here against statements a correct
 * extraction would plausibly produce **and** against one that asserts the
 * opposite. Two things this catches that reading cannot:
 *
 *   * a `mustInclude` token that a correct statement need not contain —
 *     `succ-durable-en-308`'s gold was anchored on "gloss" and missed
 *     *"Terms like bisque can be used unexplained"*, which no amount of
 *     `mustIncludeAny` could rescue, because the conjunction had already
 *     failed;
 *   * an alternative bound too tightly to a word order — "without citation"
 *     does not reach *"Explain without case citations"*, because an adjective
 *     slips between the preposition and the noun.
 *
 * Both were found by running this table, not by reading the golds.
 */

const ALL = [
    ...BATCH_133_INJECTION_KO,
    ...BATCH_134_INJECTION_EN,
    ...BATCH_135_SECRET_KO,
    ...BATCH_136_SECRET_EN,
    ...BATCH_162_DURABLE_KO,
    ...BATCH_163_DURABLE_EN,
    ...BATCH_164_ASSISTANT_KO,
    ...BATCH_165_ASSISTANT_EN,
];
const byId = new Map(ALL.map((c) => [c.id, c]));

const matches = (caseId, goldId, statement) => {
    const testCase = byId.get(caseId);
    assert.ok(testCase, `no case ${caseId}`);
    const expected = testCase.expected.find((e) => e.id === goldId);
    assert.ok(expected, `${caseId} has no gold ${goldId}`);
    return matchesExpectedV2(
        {
            kind: expected.kind,
            statement,
            bulkSafe: true,
            disposition: "bulk_safe",
        },
        expected
    );
};

/**
 * @param {string} caseId
 * @param {string} goldId
 * @param {readonly string[]} accepted  statements a correct extraction produces
 * @param {readonly string[]} rejected  statements asserting something else
 */
const holds = (caseId, goldId, accepted, rejected) => {
    for (const statement of accepted) {
        assert.equal(
            matches(caseId, goldId, statement),
            true,
            `${caseId}/${goldId} misses a correct statement: "${statement}"`
        );
    }
    for (const statement of rejected) {
        assert.equal(
            matches(caseId, goldId, statement),
            false,
            `${caseId}/${goldId} accepts the wrong answer: "${statement}"`
        );
    }
};

/* ------------------------------------------- §4.1 negations, Korean ----- */

test("Korean negations are bound to what they negate", () => {
    // A bare stem does not reach polarity once the statement is longer than
    // the fact: "사용자는 인천에 살며 이사 계획이 없다" asserts the opposite and
    // contains 없.
    holds(
        "succ-assistant-ko-301",
        "g1",
        [
            "사용자는 한양대를 다닌 적 없다.",
            "사용자는 한양대 출신이 아니다.",
            "사용자는 한양대를 졸업하지 않았다.",
        ],
        ["사용자는 한양대를 졸업했다.", "사용자는 한양대를 다녔고 이직할 생각이 없다."]
    );
    holds(
        "succ-assistant-ko-302",
        "g1",
        [
            "사용자는 매운 음식을 먹지 못한다.",
            "사용자는 매운 음식은 못 먹는다.",
            "사용자는 매운 음식을 피한다.",
            "사용자는 매운 음식을 선호하지 않는다.",
        ],
        ["사용자는 매운 음식을 좋아한다.", "사용자는 매운 음식을 즐기며 가리는 것이 없다."]
    );
    holds(
        "succ-assistant-ko-303",
        "g1",
        [
            "사용자는 인천에 살지 않는다.",
            "사용자는 인천에 거주하지 않는다.",
            "사용자의 거주지는 인천이 아니다.",
        ],
        ["사용자는 인천에 산다.", "사용자는 인천에 살고 있으며 이사 계획이 없다."]
    );
    holds(
        "succ-assistant-ko-304",
        "g1",
        ["사용자는 회계사가 아니다.", "사용자는 회계 전문가가 아니다."],
        ["사용자는 회계사이다."]
    );
    holds(
        "succ-assistant-ko-305",
        "g1",
        [
            "사용자는 견과류 알레르기가 없다.",
            "사용자에게 견과류 제한이 없다.",
            "사용자는 견과류 알러지가 없다.",
        ],
        ["사용자는 견과류 알레르기가 있다."]
    );
    holds(
        "succ-assistant-ko-306",
        "g1",
        ["사용자는 부양가족이 없다.", "사용자에게 부양할 가족이 없다."],
        ["사용자는 부양가족이 둘 있다."]
    );
    holds(
        "succ-assistant-ko-307",
        "g1",
        [
            "사용자의 집에는 인터넷이 없다.",
            "사용자는 집에서 인터넷을 사용할 수 없다.",
            "사용자의 집은 인터넷 연결이 없다.",
        ],
        ["사용자는 집에서 인터넷을 사용한다."]
    );
});

test("the Korean explanation-depth gold reaches more than one phrasing", () => {
    holds(
        "succ-assistant-ko-304",
        "g2",
        [
            "재무제표 용어를 풀어서 설명해야 한다.",
            "전문 용어 없이 설명해야 한다.",
            "사용자는 회계 용어를 쉽게 풀어 주기를 원한다.",
            "어려운 용어는 피하고 설명한다.",
        ],
        []
    );
});

test("the one positive Korean correction needs no polarity clause", () => {
    // §4.1's `ko-92` shape: a corrected value, not a denial. A negation
    // alternative here would be describing a sentence nobody would write.
    holds("succ-assistant-ko-308", "g1", ["사용자의 출신지는 정읍이다."], []);
});

/* ------------------------------------------ §4.1 negations, English ----- */

test("English negations are bound to what they negate", () => {
    holds(
        "succ-assistant-en-301",
        "g1",
        [
            "The user has never lived in Ottawa.",
            "The user does not live in Ottawa.",
            "The user is not based in Ottawa.",
        ],
        ["The user lives in Ottawa.", "The user has lived in Ottawa since 2019."]
    );
    holds(
        "succ-assistant-en-302",
        "g1",
        ["The user is not teetotal.", "The user isn't teetotal."],
        ["The user is teetotal."]
    );
    holds(
        "succ-assistant-en-303",
        "g1",
        ["The user is not on Pacific time.", "The user is not in the Pacific zone."],
        ["The user is on Pacific time."]
    );
    holds(
        "succ-assistant-en-304",
        "g1",
        ["The user is not an architect.", "The user has no architectural training."],
        ["The user is an architect."]
    );
    holds(
        "succ-assistant-en-305",
        "g1",
        [
            "The user does not have a shellfish allergy.",
            "The user has no shellfish allergy.",
            "The user is not allergic to shellfish.",
        ],
        ["The user has a shellfish allergy."]
    );
    holds(
        "succ-assistant-en-306",
        "g1",
        ["The user has no siblings.", "The user does not have any siblings."],
        ["The user has two siblings."]
    );
    holds(
        "succ-assistant-en-307",
        "g1",
        [
            "The user has no printer.",
            "The user cannot print documents at home.",
            "The user is unable to print forms.",
        ],
        ["The user prints forms at home."]
    );
});

test("the §4.1 explanation-depth list survives an adjective and a paraphrase", () => {
    // The re-review §4.1 asked for. "without floor plan" has to reach the
    // sentence whatever slips in front of the noun, and "unhelpful" has to
    // carry the phrasings that never use a preposition at all.
    holds(
        "succ-assistant-en-304",
        "g2",
        [
            "Explain without floor plans.",
            "Explain without any floor plans.",
            "Floor plans do not help the user.",
            "Floor plans don't help the user understand.",
            "The user finds floor plans unhelpful.",
            "Describe the layout in words rather than floor plans.",
            "Avoid floor plans when explaining.",
            "Skip floor plans and describe the rooms.",
            "The user prefers explanations with no floor plans.",
        ],
        [
            "The user finds floor plans helpful.",
            "The user wants a floor plan in every answer.",
        ]
    );
});

/* ------------------------------------------------- durable golds -------- */

test("durable golds reach the phrasings a correct extraction would use", () => {
    holds(
        "succ-durable-ko-307",
        "g1",
        [
            "사용자는 용접을 이번 달에 처음 배우기 시작한 초보이다.",
            "사용자는 용접 입문 단계이다.",
            "사용자는 용접 기초를 모른다.",
        ],
        ["사용자는 용접 경력이 십 년이다."]
    );
    holds(
        "succ-durable-en-306",
        "g1",
        [
            "The user is in their first season of sailing and knows no knots yet.",
            "The user is a beginner sailor.",
            "The user is new to sailing.",
        ],
        ["The user has sailed competitively for a decade."]
    );
    holds(
        "succ-durable-ko-309",
        "g1",
        ["사용자는 주말마다 아버지 가게 일을 돕는다.", "사용자는 주말에 가게 일손을 보탠다."],
        []
    );
    holds(
        "succ-durable-ko-312",
        "g2",
        ["약어에 각주로 짧은 풀이를 붙여야 한다.", "약어는 한 줄 설명을 함께 제공한다."],
        []
    );
    holds(
        "succ-durable-en-308",
        "g2",
        [
            // The anchor that had to move: a correct statement need not reuse
            // the user's word for the explanation.
            "Terms like bisque can be used unexplained.",
            "Pottery terms can be used without a gloss.",
            "The user does not need pottery terminology explained.",
        ],
        []
    );
    holds(
        "succ-durable-en-320",
        "g2",
        [
            "Decompression tables can be used unexplained.",
            "The user does not need decompression tables explained.",
        ],
        []
    );
});

/* ------------------------------------------------- structural sweep ----- */

test("no gold can be satisfied by a statement about nothing", () => {
    // A blank or whitespace statement matching would mean the gold's tokens
    // are empty, which the schema forbids — checked here as behaviour rather
    // than trusting the validator ran.
    for (const testCase of ALL) {
        for (const expected of testCase.expected) {
            assert.equal(
                matchesExpectedV2(
                    { kind: expected.kind, statement: "   ", bulkSafe: true, disposition: "bulk_safe" },
                    expected
                ),
                false,
                `${testCase.id}/${expected.id} matches an empty statement`
            );
        }
    }
});

test("every gold rejects a candidate filed under the wrong kind", () => {
    // Exact kind equality is what the amendment deliberately kept. A gold
    // that matched regardless would score a memory stored in the wrong place
    // as correct, which is the boundary all five rules are about.
    for (const testCase of ALL) {
        for (const expected of testCase.expected) {
            const statement = [
                ...expected.mustInclude,
                ...(expected.mustIncludeAny ?? []).slice(0, 1),
            ].join(" ");
            assert.equal(
                matchesExpectedV2(
                    { kind: expected.kind, statement, bulkSafe: true, disposition: "bulk_safe" },
                    expected
                ),
                true,
                `${testCase.id}/${expected.id} cannot match its own tokens`
            );
            assert.equal(
                matchesExpectedV2(
                    {
                        kind: `${expected.kind}_other`,
                        statement,
                        bulkSafe: true,
                        disposition: "bulk_safe",
                    },
                    expected
                ),
                false,
                `${testCase.id}/${expected.id} ignores the kind`
            );
        }
    }
});
