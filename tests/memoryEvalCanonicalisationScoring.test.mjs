/**
 * What the canonicalisation table must NOT score, run through the real scorer.
 *
 * `canonicalFormsAreDisjoint()` compares the registered canonical forms with
 * each other, and that is a narrow question. It cannot see an **unregistered**
 * word that a canonical form happens to sit inside, and on 2026-09-03 that is
 * exactly what it missed: with `아홉 시` registered, `사용자는 아홉 시장을 매주
 * 순회합니다` — nine *markets* — canonicalised to `사용자는9시장을…`, which
 * contains the `9시` gold of `succ-durable-ko-401`, and nine markets scored as
 * nine o'clock. The structural check reported no problem, because 시장 is not
 * a canonical form; it is an ordinary noun that begins with the counter.
 *
 * So the check that matters is behavioural: build a candidate, hand it to
 * `scoreCaseV3()` — the function the harness actually calls — and assert what
 * comes back. A structural invariant can only rule out what it was told to
 * look for; this rules out what the scorer would really do.
 *
 * ## The two directions
 *
 * A false **positive** is a candidate stating a different fact that scores as
 * the gold (nine markets as nine o'clock). A false **negative** is a candidate
 * stating the gold's own fact that stops matching (`전세` lost inside
 * `전세 시장`, because the discarded 세+시 row rewrote it to 전3시장). Both are
 * failures of the same rule — normalisation "never decides that two different
 * facts are the same" — and both are asserted here, because a table narrow
 * enough to avoid the first is easy to make too narrow for the second.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { harnessTarget } from "../lib/memoryEvalHarnessTarget.ts";
import { scoreCaseV3 } from "../lib/memoryEvalScoringV3.ts";
import {
    KOREAN_NUMERAL_EXPRESSIONS,
    NUMERAL_TABLE,
    canonMatch,
} from "../lib/memoryEvalCanonicalisation.ts";

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A variant as a pattern, preceded by a Hangul syllable or a digit.
 *
 * The shape every instance of this defect has had: the variant matches a span
 * that is part of a longer token, so the rewrite starts mid-word.
 */
const midWordPattern = (variant) =>
    new RegExp(
        "([가-힣\\d])(" +
            variant.split(/\s+/).map(escapeRegExp).join("\\s*") +
            ")",
        "g"
    );

/** Both spellings of a row, as the rule writes them. */
const variantsOf = (row) => [
    `${row.numeral} ${row.counter}`,
    `${NUMERAL_TABLE[row.numeral]}${row.counter}`,
];

const caseById = (id) => {
    const found = harnessTarget().cases.find((entry) => entry.id === id);
    assert.ok(found, `${id} is not in the harness target`);
    return found;
};

/**
 * A candidate that differs from the named gold only in its statement.
 *
 * Kind, polarity and evidence are copied from that gold so nothing except the
 * wording can decide the outcome. The gold is named rather than taken as
 * `expected[0]`, because `succ-durable-ko-35` carries two — an occupation and
 * a recurring context — and probing the first one answers a question about
 * 항해사 while claiming to be about 육 개월.
 */
const goldOf = (testCase, goldId) => {
    const found = testCase.expected.find((entry) => entry.id === goldId);
    assert.ok(found, `${testCase.id} has no gold ${goldId}`);
    return found;
};

const candidateFor = (testCase, goldId, statement) => {
    const gold = goldOf(testCase, goldId);
    return {
        kind: gold.kind,
        polarity: gold.polarity,
        statement,
        bulkSafe: gold.expectedDisposition === "bulk_safe",
        disposition: gold.expectedDisposition,
        evidence: [
            {
                evidenceMessageId: gold.evidence.evidenceMessageId,
                evidenceQuote: gold.evidence.evidenceQuote,
            },
        ],
    };
};

const scoreOf = (testCase, goldId, statement) =>
    scoreCaseV3(testCase, [candidateFor(testCase, goldId, statement)]);

test("a candidate quoting the gold's own fact is matched", () => {
    // The positive control. Without it every assertion below would pass
    // against a scorer that matched nothing at all.
    const ko401 = caseById("succ-durable-ko-401");
    const outcome = scoreOf(ko401, "g1", "사용자는 가게 문을 아홉 시에 엽니다.");
    assert.equal(outcome.goldMatched, 1, JSON.stringify(outcome));

    // And in the other spelling, which is the equivalence the row exists for:
    // the gold is the digit `9시` and the evidence is written in words.
    assert.equal(
        scoreOf(ko401, "g1", "사용자는 가게 문을 9시에 엽니다.").goldMatched,
        1
    );
});

test("the same fact scores the same however the particle falls", () => {
    // The regression the earlier positive control was too narrow to catch: it
    // used only the exact `…시에` wording, so a table that covered that one
    // phrasing and nothing else looked correct. It was not — `아홉 시부터` and
    // `아홉 시 정각에` were both refused while their digit forms passed, so the
    // same fact scored differently depending on the particle and the spelling.
    //
    // Every row of this table now has to hold in both spellings across every
    // reviewed continuation, which is what makes the equivalence an
    // equivalence rather than one memorised sentence.
    const ko401 = caseById("succ-durable-ko-401");
    for (const statement of [
        "사용자는 가게 문을 아홉 시에 엽니다.",
        "사용자는 가게 문을 아홉 시부터 엽니다.",
        "사용자는 가게 문을 아홉 시까지 닫아 둡니다.",
        "사용자는 가게 문을 아홉 시 정각에 엽니다.",
        "사용자는 가게 문을 9시부터 엽니다.",
        "사용자는 가게 문을 9시 정각에 엽니다.",
    ]) {
        assert.equal(scoreOf(ko401, "g1", statement).goldMatched, 1, statement);
    }

    // succ-durable-ko-36 is the same question in the other direction: its gold
    // is written in words and a model may answer with the digit.
    const ko36 = caseById("succ-durable-ko-36");
    const goldId = ko36.expected.find((gold) =>
        (gold.factValueAll ?? []).some((token) => token.includes("세 시"))
    ).id;
    for (const statement of [
        "사용자는 새벽 세 시에 일을 시작합니다.",
        "사용자는 새벽 3시에 일을 시작합니다.",
    ]) {
        assert.equal(scoreOf(ko36, goldId, statement).goldMatched, 1, statement);
    }
});

test("a noun that merely begins with the counter is not the hour", () => {
    // The 2026-09-03 finding. `시` is one syllable and begins 시장, 시청, 시절,
    // 시작 and more, so a row ending in the bare counter reads all of them as
    // the hour. The set is open — there is no list of 시-initial nouns to
    // guard — so no row may end in it, and the registered variant carries the
    // particle instead.
    const ko401 = caseById("succ-durable-ko-401");
    for (const statement of [
        "사용자는 아홉 시장을 매주 순회합니다.",
        "사용자는 아홉 시절을 자주 떠올립니다.",
        "사용자는 아홉 시간 넘게 잡니다.",
    ]) {
        assert.equal(
            scoreOf(ko401, "g1", statement).goldMatched,
            0,
            `"${statement}" must not score as the 9시 gold`
        );
    }
});

test("a gold token is not destroyed by the word that follows it", () => {
    // The false negative the discarded 세+시 row caused: `전세 시장` became
    // 전3시장, so `succ-durable-ko-22`'s gold `전세` no longer occurred in a
    // sentence that plainly states it. The contract claims a token
    // canonicalises the same alone as inside a sentence, and that row broke
    // the claim on a real gold.
    const ko22 = caseById("succ-durable-ko-22");
    assert.deepEqual(
        ko22.expected.flatMap((gold) => gold.factValueAll ?? []),
        ["전세"],
        "this test is about that gold"
    );
    for (const statement of [
        "사용자는 전세로 살고 있습니다.",
        "사용자는 전세 시장을 걱정하며 전세로 살고 있습니다.",
    ]) {
        assert.equal(
            scoreOf(ko22, "e1", statement).goldMatched,
            1,
            `"${statement}" states the gold's fact and must match`
        );
    }
});

test("the registered equivalence works from either spelling", () => {
    // succ-durable-ko-35 is the other direction: the gold is written in words
    // and a model may answer with the digit. Dropping this row is what made a
    // correct `6개월` answer score wrong on 2026-09-03.
    const ko35 = caseById("succ-durable-ko-35");
    // `e2` is the 육 개월 gold. `e1` is 항해사 and would match either
    // statement, which is why the gold is named.
    for (const statement of [
        "사용자는 육 개월씩 배를 탑니다.",
        "사용자는 6개월씩 배를 탑니다.",
    ]) {
        assert.equal(scoreOf(ko35, "e2", statement).goldMatched, 1, statement);
    }
});

test("an unregistered numeral expression scores neither way", () => {
    // The cost of a closed table, asserted so it is a decision rather than a
    // surprise. Nothing registers 십 년, so a model writing `10년` for a gold
    // that says `십 년` is not credited — and no gold asks it to be.
    const ko35 = caseById("succ-durable-ko-35");
    assert.equal(
        scoreOf(ko35, "e2", "사용자는 여섯 달씩 배를 탑니다.").goldMatched,
        0
    );
});

test("no registered variant matches inside a longer word, anywhere in the corpus", () => {
    // The general form of the defect this file was written for, asked of the
    // corpus rather than of a probe list.
    //
    // Every instance so far has been "the variant matched a span that is part
    // of a longer word", from one side or the other: `전세 시장` -> 전3시장 lost
    // the gold 전세 on the left, and `아홉 시장` -> 9시장 read a noun as the
    // hour on the right. A probe list finds the instance somebody thought of;
    // this finds the next one, on the day a case is added that contains it.
    //
    // The left edge is what is checkable in general. A Hangul syllable or a
    // digit immediately before a variant means the match starts mid-token:
    // 교육 개월 would canonicalise to 교6개월, and 열아홉 시에 to 열9시에, whose
    // `9시` a ko-401 gold would then reach. Neither occurs today, and neither
    // can be excluded by the rule itself — that needs a lookbehind, which
    // makes the step spacing-dependent and is what `mem-score-v3.5` removed.
    // So it is guarded here instead, where it fails loudly rather than
    // silently changing a score.
    const patterns = KOREAN_NUMERAL_EXPRESSIONS.flatMap((row) =>
        variantsOf(row).map(midWordPattern)
    );

    const found = [];
    for (const datasetVersion of ["mem-eval-succ-4", "mem-eval-succ-6", "mem-eval-succ-8"]) {
        for (const testCase of harnessTarget(datasetVersion).cases) {
            const texts = [
                ...(testCase.conversations ?? []).flatMap((conversation) => [
                    conversation.title ?? "",
                    ...(conversation.messages ?? []).map((message) => message.content),
                ]),
                ...(testCase.expected ?? []).flatMap((gold) => [
                    ...(gold.factValueAll ?? []),
                    ...(gold.factValueAny ?? []),
                    gold.evidence?.evidenceQuote ?? "",
                ]),
            ];
            for (const text of texts) {
                for (const pattern of patterns) {
                    pattern.lastIndex = 0;
                    for (const hit of String(text).matchAll(pattern)) {
                        found.push(`${testCase.id}: ${JSON.stringify(hit[0])}`);
                    }
                }
            }
        }
    }
    assert.deepEqual(found, []);
});

test("that guard would fire on the shapes it is for", () => {
    // Red-before-green. The assertion above passes on a corpus containing none
    // of these, which is also how it would pass if the pattern were wrong.
    const patternFor = midWordPattern;
    assert.match("교육 개월별 계획", patternFor("육 개월"));
    assert.match("열아홉 시에 만나요", patternFor("아홉 시"));
    assert.match("19시에 만나요", patternFor("9시"));
    // And not on the forms the corpus actually uses.
    assert.doesNotMatch("저는 육 개월씩 배를 탑니다", patternFor("육 개월"));
    assert.doesNotMatch("가게 문을 아홉 시에 엽니다", patternFor("아홉 시"));
});

test("the counter's continuation list is complete where it can be", () => {
    // `개월` is two syllables and begins no Korean word, so 개월 followed by
    // any particle is unambiguously six months and the list is simply
    // finished. Every form the 2026-09-03 review found refused now scores.
    const ko35 = caseById("succ-durable-ko-35");
    for (const particle of ["을", "은", "도", "이", "만", "마다", "씩", "간"]) {
        assert.equal(
            scoreOf(ko35, "e2", `사용자는 육 개월${particle} 배를 탑니다.`).goldMatched,
            1,
            `육 개월${particle}`
        );
        assert.equal(
            scoreOf(ko35, "e2", `사용자는 6개월${particle} 배를 탑니다.`).goldMatched,
            1,
            `6개월${particle}`
        );
    }
});

test("the 시 rows take the false negative, and this is which ones", () => {
    // `시` is one syllable and begins many ordinary nouns, so a continuation
    // that is also such a noun's second syllable makes the row read that noun
    // as the hour: 가 -> 시가 (市價), 은 -> 시은, 도 -> 시도 (試圖),
    // 의 -> 시의, 로 -> 시론, 와 -> 시와, 나 -> 시나리오, 야 -> 시야,
    // 대로 -> 시대. Nine of the thirty-five particles collide, three of them
    // among the commonest.
    //
    // The boundary cannot be neither: adding 가 fixes `아홉 시가` and breaks
    // `시가 급등` at the same time. This list takes the false negatives,
    // because crediting a fact the user never stated is the more expensive
    // error in a memory eval — and the choice is pinned here so it is a
    // recorded boundary rather than an omission somebody has to find again.
    const ko401 = caseById("succ-durable-ko-401");

    // Accepted: continuations that begin no 시-noun.
    for (const particle of ["에", "부터", "까지", "는", "를", "을", "만", "마다"]) {
        assert.equal(
            scoreOf(ko401, "g1", `사용자는 가게 문을 아홉 시${particle} 엽니다.`)
                .goldMatched,
            1,
            `아홉 시${particle}`
        );
    }

    // Refused, and what each refusal buys.
    for (const [particle, noun] of [
        ["가", "시가 (市價)"],
        ["도", "시도 (試圖)"],
        ["야", "시야 (視野)"],
    ]) {
        assert.equal(
            scoreOf(ko401, "g1", `사용자는 가게 문을 아홉 시${particle} 엽니다.`)
                .goldMatched,
            0,
            `아홉 시${particle} is refused so that ${noun} is not the hour`
        );
    }

    // The other side of that trade, stated as the thing being bought.
    for (const statement of [
        "사용자는 아홉 시가가 급등했다고 적었습니다.",
        "사용자는 아홉 시도 끝에 성공했습니다.",
        "사용자는 아홉 시야가 좁다고 말합니다.",
    ]) {
        assert.equal(scoreOf(ko401, "g1", statement).goldMatched, 0, statement);
    }
});

test("every registered continuation is one that keeps the row matching", () => {
    // A continuation that does nothing is a list entry nobody checked. This
    // walks the registered lists rather than a hand-written set, so an entry
    // added without effect fails here.
    for (const row of KOREAN_NUMERAL_EXPRESSIONS) {
        for (const after of row.followedBy) {
            const digit = NUMERAL_TABLE[row.numeral];
            assert.equal(
                canonMatch(`${row.numeral} ${row.counter}${after}`, "ko"),
                canonMatch(`${digit}${row.counter}${after}`, "ko"),
                `${row.counter}${after}`
            );
        }
    }
});
