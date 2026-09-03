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
    canonicalFormsAreDisjoint,
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

test("the registered rows normalise, in both spacings and as digits", () => {
    // The other half. A table narrowed until it fires on nothing would pass
    // every test above and silently undo what the step is for.
    for (const [input, expected] of [
        // succ-durable-ko-35, both scripts
        ["육 개월", "6개월"],
        ["육개월", "6개월"],
        ["6개월", "6개월"],
        // succ-durable-ko-36
        ["새벽 세 시", "새벽 3시"],
        ["새벽세시", "새벽3시"],
        ["새벽 3시", "새벽 3시"],
        // succ-durable-ko-401
        ["아홉 시", "9시"],
        ["아홉시", "9시"],
        ["9시", "9시"],
        ["가게 문을 아홉 시에 열어서", "가게 문을 9시에 열어서"],
    ]) {
        assert.equal(canon(input), expected, input);
    }
    // The three equivalences the golds actually need, through the matching form.
    assert.equal(canonMatch("육 개월", "ko"), canonMatch("6개월", "ko"));
    assert.equal(canonMatch("새벽 세 시", "ko"), canonMatch("새벽 3시", "ko"));
    assert.equal(canonMatch("9시", "ko"), canonMatch("아홉 시", "ko"));
});

test("an hour never meets a duration, in either script", () => {
    // The defect that took three attempts to remove, and the reason guard rows
    // exist. Matching is by substring, so if the hour's canonical form sits
    // inside the duration's then three hours scores as three o'clock.
    //
    // Every earlier shape failed here: `3시` inside `3시간`, then `아홉시`
    // inside `아홉시간`, and collapsing to `9시` would have put `9시` inside
    // `9시간`. The guard rows collapse the duration to a form that shares no
    // prefix with the hour, and they are matched first.
    for (const [gold, durationText] of [
        ["3시", "세 시간 넘게 집을 비웁니다"],
        ["3시", "3시간 넘게 집을 비웁니다"],
        ["새벽 세 시", "세 시간 넘게 집을 비웁니다"],
        ["9시", "아홉 시간 넘게 잤습니다"],
        ["9시", "9시간 넘게 잤습니다"],
    ]) {
        assert.ok(
            !canonMatch(durationText, "ko").includes(canonMatch(gold, "ko")),
            `${gold} -> ${canonMatch(gold, "ko")} must not be inside ` +
                `${durationText} -> ${canonMatch(durationText, "ko")}`
        );
    }
    // And the durations still meet each other, so the guard is a normalisation
    // and not a hole.
    assert.equal(canonMatch("세 시간", "ko"), canonMatch("3시간", "ko"));
    assert.equal(canonMatch("아홉 시간", "ko"), canonMatch("9시간", "ko"));
});

test("no canonical form is a substring of another", () => {
    // The invariant behind the test above, stated once rather than argued per
    // row, and enforced in the library so a new row cannot reopen it. This is
    // what `check:memory-eval-succ8` runs in CI.
    assert.deepEqual([...canonicalFormsAreDisjoint()], []);
});

test("rows are matched longest-first, in one pass", () => {
    // Ordering is a contract term, not an implementation detail. Rewriting row
    // by row re-scans what an earlier row produced: the guard turns `아홉 시간`
    // into a form the hour row then finds `아홉시` inside, and the collision is
    // back. One ordered alternation consumes the whole longer expression.
    //
    // Asserted on the outcome rather than the mechanism, so a reimplementation
    // that keeps the property passes.
    assert.equal(canon("아홉 시간"), "아홉시간");
    assert.equal(canon("아홉 시"), "9시");
    assert.equal(canon("세 시간"), "세시간");
    assert.equal(canon("세 시"), "3시");
    // Both in one sentence, each resolved as itself.
    assert.equal(canon("아홉 시부터 아홉 시간"), "9시부터 아홉시간");
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

test("every registered row names why it exists and what else it rewrites", () => {
    // A row rewrites its forms everywhere, including inside other words. That
    // is safe only when it cannot make two different facts equal, and
    // `requiredBy` plus `rejects` are where that reasoning is written down. A
    // row added without them has not been reviewed.
    assert.equal(KOREAN_NUMERAL_EXPRESSIONS.length, 5);
    for (const row of KOREAN_NUMERAL_EXPRESSIONS) {
        assert.match(row.requiredBy, /^(succ-|guards succ-)/, row.canonical);
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
    // Three rows serve a gold and two guard one. A guard that stopped naming
    // what it guards would read as an equivalence somebody wanted.
    assert.equal(
        KOREAN_NUMERAL_EXPRESSIONS.filter((row) => row.requiredBy.startsWith("guards ")).length,
        2
    );
});

test("the vocabulary lists stay, and stop generating the rewrite", () => {
    // `NUMERAL_TABLE` and `KOREAN_COUNTERS` are still contract terms and still
    // hashed, but from v3.5 they no longer produce the Korean rewrite: they are
    // the vocabulary a reviewed row may draw from.
    assert.ok(Object.hasOwn(NUMERAL_TABLE, "아홉"));
    assert.ok(KOREAN_COUNTERS.includes("시"));
    // And the cross-product is genuinely gone: 토요일 일정 and 이십일 are the
    // two it corrupted, and neither is touched now.
    assert.equal(canon("토요일 일정"), "토요일 일정");
    assert.equal(canon("이십일"), "이십일");
});
