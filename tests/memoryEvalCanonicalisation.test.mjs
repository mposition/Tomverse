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
        CANON_STEP_ORDER.includes("reviewed_numeral_expressions_to_digits"),
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

test("every registered expression normalises, in both spacings and as digits", () => {
    // The other half. A table narrowed until it fires on nothing would pass
    // every test above and silently undo what the step is for. Each row of
    // `KOREAN_NUMERAL_EXPRESSIONS` is required by a frozen gold, so each is
    // asserted here in the three forms a writer may choose.
    for (const [input, expected] of [
        // succ-durable-ko-35
        ["육 개월", "6개월"],
        ["육개월", "6개월"],
        ["6개월", "6개월"],
        // succ-durable-ko-36
        ["새벽 세 시", "새벽 3시"],
        ["새벽세시", "새벽3시"],
        ["새벽 3시", "새벽 3시"],
    ]) {
        assert.equal(canon(input), expected, input);
    }
    // And the two golds meet their digit forms through the matching form,
    // which is the question the eval actually asks.
    assert.equal(canonMatch("육 개월", "ko"), canonMatch("6개월", "ko"));
    assert.equal(canonMatch("새벽 세 시", "ko"), canonMatch("새벽 3시", "ko"));
});

test("unregistered numeral expressions are left as written", () => {
    // Deliberate, and the cost of the design. No frozen gold asks a model's
    // 10년 to meet 십 년, so no row is registered for it and none of these is
    // rewritten. Asserted rather than left implicit: registering a row is a
    // reviewed act, and a row appearing without review should fail here.
    for (const untouched of [
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

test("every registered row states the over-matches it admits", () => {
    // A row rewrites its expression everywhere, including inside words. That
    // is safe only because it is context-free — both sides of a comparison get
    // the same rewrite, so an over-match can collide two facts but can never
    // lose one. `rejects` is where that reasoning is written down, and a row
    // added without it has not been reviewed.
    assert.ok(KOREAN_NUMERAL_EXPRESSIONS.length > 0);
    for (const row of KOREAN_NUMERAL_EXPRESSIONS) {
        assert.ok(KOREAN_COUNTERS.includes(row.counter), row.counter);
        assert.ok(Object.hasOwn(NUMERAL_TABLE, row.numeral), row.numeral);
        assert.ok(Array.isArray(row.rejects), row.numeral + row.counter);
        for (const form of row.matches) {
            assert.equal(
                canonMatch(form, "ko"),
                canonMatch(row.canonical, "ko"),
                `${form} should canonicalise to ${row.canonical}`
            );
        }
    }
});

test("the English and separator steps are untouched", () => {
    assert.equal(canon("twelve-hour"), "12 hour");
    assert.equal(canon("2,000"), "2000");
    assert.equal(canon("doesn't"), "does not");
    assert.equal(canon("  Mixed   Case  "), "mixed case");
});

test("Korean drops spaces for matching and English does not", () => {
    // The reason the two languages have different matching forms, asserted so
    // a change to one cannot quietly become a change to both.
    assert.equal(canonMatch("6 개월", "ko"), "6개월");
    assert.equal(canonMatch("lives in ottawa", "en"), "lives in ottawa");
});
