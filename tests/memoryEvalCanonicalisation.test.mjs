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

test("the word-start rule is named in the step order", () => {
    // The step order is part of the scoring contract digest, so the rename is
    // not cosmetic: it is how the change reaches every manifest that pins the
    // contract.
    assert.ok(
        CANON_STEP_ORDER.includes("numeral_words_at_word_start_to_digits"),
        CANON_STEP_ORDER.join(", ")
    );
    assert.ok(!CANON_STEP_ORDER.includes("numeral_words_to_digits"));
});

/* ------------------------------------------- what the fix must not change -- */

test("every numeral form the datasets use still normalises", () => {
    // The other half. A guard that stopped the rule firing at all would pass
    // the tests above and silently undo what the rule is for.
    for (const [input, expected] of [
        ["육 개월", "6개월"],
        ["육개월", "6개월"],
        ["새벽 세 시", "새벽 3시"],
        ["여섯 개", "6개"],
        ["삼 일", "3일"],
        ["매주 두 번", "매주 2번"],
        ["총 세 개", "총 3개"],
        ["강아지 두 마리", "강아지 2마리"],
        ["책 세 권", "책 3권"],
        ["한 시간", "1시간"],
    ]) {
        assert.equal(canon(input), expected, input);
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
