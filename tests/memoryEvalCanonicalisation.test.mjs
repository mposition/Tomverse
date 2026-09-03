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
    // The unstable space is the one *inside* the expression — a writer may
    // put 육 개월 or 육개월 — and `\\s*` covers it. The space *before* the
    // numeral is a different one: it separates two words, and the left
    // boundary reads it.
    for (const [a, b] of [
        ["육 개월", "육개월"],
        ["저는 육 개월씩", "저는 육개월씩"],
        ["아홉 시에", "아홉시에"],
        ["새벽 세 시에", "새벽 세시에"],
        ["매주 두 번", "매주두번"],
        ["주식은 이번에 처음", "주식은이번에처음"],
    ]) {
        assert.equal(canonMatch(a, "ko"), canonMatch(b, "ko"), `${a} / ${b}`);
    }

    // And the assumption, asserted so it is a decision rather than a surprise:
    // deleting the space before the numeral does change the canonical form.
    // Five of the corpus's 2,250 Korean strings behave this way, all of them
    // under a transform that deletes every space at once, which is not how
    // Korean is written. Removing the assumption means removing the left
    // boundary, and that is what scored 교육 개월 as six months.
    assert.notEqual(canonMatch("저는 육 개월씩", "ko"), canonMatch("저는육 개월씩", "ko"));
});

/* ------------------------------------------- what the fix must not change -- */

test("the registered rows normalise, in both spellings", () => {
    // The other half. A table narrowed until it fires on nothing would pass
    // every test above and silently undo what the step is for.
    for (const [input, expected] of [
        // succ-durable-ko-35, both spellings
        ["육 개월", "6개월"],
        ["육개월", "6개월"],
        ["6개월", "6개월"],
        // succ-durable-ko-401. The variant carries the particle, so the bare
        // counter is never the right edge of a row — see the test below.
        ["아홉 시에", "9시에"],
        ["아홉시에", "9시에"],
        ["9시에", "9시에"],
        ["가게 문을 아홉 시에 열어서", "가게 문을 9시에 열어서"],
    ]) {
        assert.equal(canon(input), expected, input);
    }
    // The two equivalences the golds actually need, through the matching form.
    assert.equal(canonMatch("육 개월", "ko"), canonMatch("6개월", "ko"));
    assert.ok(
        canonMatch("가게 문을 아홉 시에 열어서", "ko").includes(canonMatch("9시", "ko"))
    );
});

test("a row matches only where both boundaries allow it", () => {
    // The 2026-09-03 finding, and the reason the ko-401 variant carries `에`.
    //
    // `시` is one syllable and begins 시장, 시청, 시절, 시작, 시간 and more, so
    // a row ending in the bare counter reads all of them as the hour: with
    // `아홉 시` registered, nine *markets* canonicalised to `9시장…` and scored
    // as the `9시` gold. That set is open — there is no list of 시-initial
    // nouns to guard against — which is the same shape as `mem-score-v3.4`
    // reading the 일 of 토요일, one counter over.
    //
    // Asserted on the canonical text here; scored through `scoreCaseV3()` in
    // tests/memoryEvalCanonicalisationScoring.test.mjs, which is the check
    // that would actually have caught it.
    // Right boundary: the counter must end the expression unless a reviewed
    // continuation follows. 시 begins 시장, 시청, 시절 and 시간, and that set
    // is open, so the rule is stated as the closed set of particles instead.
    for (const untouched of [
        "아홉 시장",
        "아홉 시절",
        "아홉 시간",
        "세 시장",
        "세 시청",
        "세 시간",
    ]) {
        assert.equal(
            canonMatch(untouched, "ko"),
            untouched.replace(/\s+/g, ""),
            untouched
        );
    }
    // Left boundary: the numeral must not be read off the end of a word.
    for (const untouched of [
        "교육 개월",
        "체육 개월",
        "열아홉 시에",
        "이십일",
        "토요일 일정",
    ]) {
        assert.equal(
            canonMatch(untouched, "ko"),
            untouched.replace(/\s+/g, ""),
            untouched
        );
    }
    // And the reviewed continuations do continue the expression.
    for (const [text, expected] of [
        ["아홉 시에", "9시에"],
        ["아홉 시부터", "9시부터"],
        ["아홉 시까지", "9시까지"],
        ["아홉 시 정각에", "9시정각에"],
        ["육 개월씩", "6개월씩"],
        ["육 개월째", "6개월째"],
    ]) {
        assert.equal(canonMatch(text, "ko"), expected, text);
    }
    // And the token-alone property holds for a real gold that the discarded
    // 세+시 row destroyed: `전세` inside `전세 시장` became 전3시장.
    assert.ok(canonMatch("전세 시장이 불안합니다", "ko").includes(canonMatch("전세", "ko")));
});

test("no canonical form is a substring of another", () => {
    // A structural invariant, and a narrow one: it compares the registered
    // canonical forms with each other and cannot see an unregistered noun that
    // one of them sits inside. That blind spot is what let 시장 through, so it
    // is kept as a cheap floor rather than as the argument.
    assert.deepEqual([...canonicalFormsAreDisjoint()], []);
});

test("rows are matched longest-first, in one pass", () => {
    // Ordering is a contract term. Rewriting row by row re-scans what an
    // earlier row produced, so a longer expression could be broken up by a
    // shorter one that is its prefix.
    //
    // Asserted on the outcome rather than the mechanism, so a reimplementation
    // that keeps the property passes.
    assert.equal(canon("아홉 시에"), "9시에");
    assert.equal(canon("아홉 시간"), "아홉 시간");
    assert.equal(canon("아홉 시에 아홉 시간"), "9시에 아홉 시간");
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
    assert.equal(KOREAN_NUMERAL_EXPRESSIONS.length, 3);
    for (const row of KOREAN_NUMERAL_EXPRESSIONS) {
        assert.match(row.requiredBy, /^succ-/, row.canonical);
        assert.ok(Array.isArray(row.rejects), row.canonical);
        assert.ok(KOREAN_COUNTERS.includes(row.counter), row.counter);
        assert.ok(Object.hasOwn(NUMERAL_TABLE, row.numeral), row.numeral);
        // Both spellings reach the canonical form.
        const digit = NUMERAL_TABLE[row.numeral];
        assert.equal(canonMatch(`${row.numeral} ${row.counter}`, "ko"), row.canonical);
        assert.equal(canonMatch(`${digit}${row.counter}`, "ko"), row.canonical);
        // Every reviewed continuation is a real one: it keeps the expression
        // matching rather than silently doing nothing.
        for (const after of row.followedBy) {
            assert.equal(
                canonMatch(`${row.numeral} ${row.counter}${after}`, "ko"),
                `${row.canonical}${after}`,
                `${row.counter}${after}`
            );
        }
    }
    // 간 continues 개월 and must not continue 시, where 시간 is a different
    // counter. The lists are per row for that reason.
    assert.ok(
        KOREAN_NUMERAL_EXPRESSIONS.find((row) => row.counter === "개월").followedBy.includes("간")
    );
    for (const row of KOREAN_NUMERAL_EXPRESSIONS.filter((entry) => entry.counter === "시")) {
        assert.ok(!row.followedBy.includes("간"), "간 after 시 is 시간, a duration");
    }
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
