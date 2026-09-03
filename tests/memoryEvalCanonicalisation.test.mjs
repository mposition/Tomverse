/**
 * The canonical form both sides of a comparison pass through.
 *
 * The Korean numeral rule is the subject of most of this file, because it is
 * the one step that rewrites text rather than normalising it, and on
 * 2026-09-03 it was found rewriting text it was never meant to reach.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
    CANON_STEP_ORDER,
    KOREAN_COUNTERS,
    KOREAN_NUMERAL_EXPRESSIONS,
    NUMERAL_TABLE,
    canon,
    canonMatch,
} from "../lib/memoryEvalCanonicalisation.ts";

/* ---------------------------------------- the defect mem-score-v3.5 fixed -- */

test("a numeral syllable ending an ordinary word is left alone", () => {
    // `mem-score-v3.4` read the 일 ending 토요일 as the numeral one and the 일
    // beginning 일정 as the day counter, so `토요일 일정` became `토요1일정` and
    // the token 격주토요일 existed in no candidate that phrased it that way.
    // `succ-durable-ko-611` could only score a false negative for three of
    // these five phrasings.
    const tokens = ["격주토요일", "일정"];
    const phrasings = [
        "격주토요일 일정을 잡을 수 없다",
        "격주 토요일 일정 불가",
        "사용자는 격주토요일 일정이 불가능하다",
        "사용자는 격주토요일에는 일정을 잡을 수 없다",
        "격주토요일에 일정을 잡지 못한다",
    ];
    for (const phrasing of phrasings) {
        const statement = canonMatch(phrasing, "ko");
        for (const token of tokens) {
            assert.ok(
                statement.includes(canonMatch(token, "ko")),
                `"${token}" is missing from canon("${phrasing}") = ${statement}`
            );
        }
    }
});

test("a numeral inside a number is not read as a counter", () => {
    // The same defect on a number: 십 preceded by 이 matched as ten plus the
    // day counter, so twenty-one canonicalised to `이10일`.
    assert.equal(canon("이십일"), "이십일");
    assert.equal(canon("이십일 일정"), "이십일 일정");
});

test("the step order names the reviewed-expression rule", () => {
    // The step order is part of the scoring contract digest, so the rename is
    // not cosmetic: it is how the change reaches every manifest that pins the
    // contract.
    assert.ok(
        CANON_STEP_ORDER.includes("reviewed_expressions_and_english_numerals"),
        CANON_STEP_ORDER.join(", ")
    );
    assert.ok(!CANON_STEP_ORDER.includes("numeral_words_to_digits"));
});

/* ------------------- the property that decided the design: context-freedom -- */

test("a token canonicalises the same alone as it does inside a sentence", () => {
    // The invariant a lookaround cannot have, and the reason the rule is a
    // table. A gold's `factValueAll` token is matched as a SUBSTRING of the
    // candidate's statement, so if `육 개월` on its own canonicalises to one
    // thing and `저는 육 개월씩 배를 탑니다` canonicalises it to another, the
    // gold cannot be found in the sentence it was drawn from.
    //
    // Both attempts at a boundary rule failed here. `(?<![가-힣])` and
    // `(?<![가-힣]\s*)` each made this assertion false for 육 개월, which also
    // stopped `succ-4` assembling: its `gold-evidence-covers-fact` anchor asks
    // exactly this question.
    for (const [token, sentence] of [
        ["육 개월", "저는 육 개월씩 배를 타고 일합니다"],
        ["새벽 세 시", "제빵 일을 합니다. 새벽 세 시에 시작해서"],
        ["일주일", "매달 초 일주일씩 머무십니다"],
        ["격주토요일", "격주토요일에는 일정을 잡을 수 없습니다"],
    ]) {
        assert.ok(
            canonMatch(sentence, "ko").includes(canonMatch(token, "ko")),
            `"${token}" -> ${canonMatch(token, "ko")} is not inside ` +
                `"${sentence}" -> ${canonMatch(sentence, "ko")}`
        );
    }
});

test("Korean canonicalisation does not depend on how the text was spaced", () => {
    // `canonMatch` drops every space for Korean because spacing is not stable,
    // so a step that consults spacing before those spaces are dropped makes
    // the canonical form a function of the typing rather than of the fact.
    //
    // A `(?<![가-힣])` lookbehind did exactly that for 82 of the 2,250 Korean
    // strings in the frozen corpus. These are four of them.
    for (const spaced of [
        "새벽 세 시",
        "매주 두 번",
        "총 세 개",
        "주식은 이번에 처음 시작합니다",
        "일주일 두 번",
    ]) {
        assert.equal(
            canonMatch(spaced, "ko"),
            canonMatch(spaced.replace(/ /g, ""), "ko"),
            spaced
        );
    }
});

/* ------------------------------------------- what the fix must not change -- */

test("the one registered row normalises, in both spacings and as a digit", () => {
    // The other half. A table narrowed until it fires on nothing would pass
    // every test above and silently undo what the step is for.
    //
    // One row, because exactly one frozen gold cannot be satisfied without it:
    // `succ-durable-ko-401` says `9시` and its evidence says `아홉 시`. The
    // rows the first draft carried for `육 개월` and `새벽 세 시` are gone —
    // both golds are stated in the same words as their evidence, so they match
    // verbatim, and the `세`+`시` row bought nothing while making `세 시간`
    // (three hours) equal to three o'clock.
    for (const [input, expected] of [
        ["아홉 시", "아홉시"],
        ["아홉시", "아홉시"],
        ["9시", "아홉시"],
        ["가게 문을 아홉 시에 열어서", "가게 문을 아홉시에 열어서"],
    ]) {
        assert.equal(canon(input), expected, input);
    }
    // The equivalence the gold actually needs, through the matching form.
    assert.equal(canonMatch("9시", "ko"), canonMatch("아홉 시", "ko"));
});

test("the row collapses toward the word form, so it adds no new equality", () => {
    // The property that makes this row safe and made `세`+`시` unsafe.
    //
    // Rewriting to `9시` would turn `아홉 시간` — nine *hours* — into `9시간`,
    // and a `9시` gold is a substring of that: two different facts, one value,
    // which the canonicalisation rule forbids. Collapsing to `아홉시` leaves
    // `아홉 시간` as `아홉시간`, which is exactly what it is with no rule at
    // all, so the row licenses nothing plain Korean matching did not already.
    assert.equal(canonMatch("아홉 시간", "ko"), "아홉시간");
    assert.equal(canonMatch("아홉시간", "ko"), "아홉시간");
    // And the discarded rule's collision is gone: three hours is no longer
    // three o'clock.
    assert.equal(canonMatch("세 시간 넘게", "ko"), "세시간넘게");
    assert.equal(canonMatch("새벽 세 시", "ko"), "새벽세시");
    assert.ok(!canonMatch("세 시간 넘게", "ko").includes(canonMatch("3시", "ko")));
});

test("unregistered numeral expressions are left as written", () => {
    // Deliberate, and the cost of the design. No frozen gold asks a model's
    // 10년 to meet 십 년, so no row is registered for it and none of these is
    // rewritten. Asserted rather than left implicit: registering a row is a
    // reviewed act, and a row appearing without review should fail here.
    for (const untouched of [
        "육 개월",
        "새벽 세 시",
        "십 년",
        "삼십 분",
        "매주 두 번",
        "총 세 개",
        "여섯 개",
        "삼 일",
        "책 세 권",
        "강아지 두 마리",
    ]) {
        assert.equal(canon(untouched), untouched, untouched);
    }
});

test("every registered row names its gold and its over-matches", () => {
    // A row rewrites its forms everywhere, including inside other words. That
    // is safe only when it cannot make two different facts equal, and
    // `requiredBy` plus `rejects` are where that reasoning is written down. A
    // row added without them has not been reviewed.
    assert.equal(KOREAN_NUMERAL_EXPRESSIONS.length, 1);
    for (const row of KOREAN_NUMERAL_EXPRESSIONS) {
        assert.match(row.requiredBy, /^succ-/, row.canonical);
        assert.ok(Array.isArray(row.rejects), row.canonical);
        assert.ok(row.variants.length >= 2, "a row with one variant collapses nothing");
        for (const variant of row.variants) {
            assert.equal(
                canonMatch(variant, "ko"),
                canonMatch(row.canonical, "ko"),
                `${variant} should canonicalise to ${row.canonical}`
            );
        }
    }
});

test("the vocabulary lists stay, and stop generating the rewrite", () => {
    // `NUMERAL_TABLE` and `KOREAN_COUNTERS` are still contract terms and still
    // hashed, but from v3.5 they no longer produce the Korean rewrite: they are
    // the vocabulary a reviewed row may draw from. Asserted because a future
    // row using a counter outside the list would describe a shape the contract
    // does not.
    assert.ok(Object.hasOwn(NUMERAL_TABLE, "아홉"));
    assert.ok(KOREAN_COUNTERS.includes("시"));
    // And the cross-product is genuinely gone: 토요일 일정 and 이십일 are the
    // two it corrupted, and neither is touched now.
    assert.equal(canon("토요일 일정"), "토요일 일정");
    assert.equal(canon("이십일"), "이십일");
});
