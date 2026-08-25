import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/**
 * Korean particles that change with what precedes them.
 *
 * 은/는, 이/가, 을/를, 과/와 and 으로/로 are chosen by the final sound of the
 * word in front. When that word is a placeholder, the sentence cannot commit
 * to one form: `개정 {revision}으로` is right for revision 3 (삼, ㅁ) and wrong
 * for revision 1 (일, ㄹ → 로). A staging round in 2026-08-25 found exactly
 * that string reading "개정 1으로" on screen.
 *
 * `locales/ko.ts` already answers this with the parenthetical form — it wrote
 * `{models}은(는)` and `{type}을(를)` long before this test existed. What was
 * missing was anything to stop the next string being written the other way,
 * which is what these assertions are.
 *
 * Only Korean needs this. The other six locales have no particle agreement of
 * this kind, so a placeholder there is followed by a space or by fixed text.
 */

const ROOT = resolve(import.meta.dirname, "..");
const source = readFileSync(resolve(ROOT, "locales/ko.ts"), "utf8");

/**
 * A placeholder followed immediately by one of the varying particles, with no
 * parenthetical alternative after it.
 *
 * The negative lookahead lets two things through: another Hangul syllable, so
 * `{count}개` and `{max}자` (counters, which do not vary) are not matched, and
 * an opening parenthesis, which is the fix itself -- `을(를)`, `과(와)`. The
 * `(으)로` form is matched by the same rule from the other side: the particle
 * there begins with `(`, so `{revision}(으)로` never reaches this pattern.
 */
const UNGUARDED =
    /\{[a-zA-Z]+\}(은|는|이|가|을|를|과|와|으로|로)(?![가-힣(])/g;

/**
 * Lines allowed to commit to one form, and why.
 *
 * An exception is only defensible when the text in front of the particle
 * cannot vary. A placeholder filled from a fixed constant qualifies; one
 * filled from user data, a model name or a number does not.
 */
const ALLOWED = [
    {
        fragment: 'deleteAllConfirmLabel: "확인을 위해 {phrase}를 입력하세요"',
        reason:
            "`{phrase}` is DELETE_ALL_CONFIRMATION in components/memory/MemoryReviewSettings.tsx, " +
            "a fixed English constant identical in every locale. It ends in a sound with no " +
            "final consonant, so 를 is correct and stays correct as long as the constant does.",
    },
];

test("no Korean string commits to a particle after a placeholder that can vary", () => {
    const offenders = [];
    for (const line of source.split("\n")) {
        UNGUARDED.lastIndex = 0;
        if (!UNGUARDED.test(line)) continue;
        if (ALLOWED.some((entry) => line.includes(entry.fragment))) continue;
        offenders.push(line.trim());
    }
    assert.deepEqual(
        offenders,
        [],
        "these must use the parenthetical form -- 을(를), 과(와), 은(는), (으)로:\n" +
            offenders.map((line) => `  ${line}`).join("\n")
    );
});

test("the scan still finds the parenthetical form, so it is not matching nothing", () => {
    // A regex that stopped matching would make the assertion above pass over
    // an unchecked file, which is how a static scan fails silently. These are
    // the strings that already answer the problem correctly.
    for (const fragment of ["{models}은(는)", "{type}을(를)", "{revision}(으)로", "{revision}과(와)"]) {
        assert.ok(
            source.includes(fragment),
            `expected ${fragment} in locales/ko.ts; if the copy changed, update this list`
        );
    }
});

test("every allowed exception still exists and still states its reason", () => {
    // An exception that outlives the string it excused is an exception nobody
    // is checking any more.
    for (const entry of ALLOWED) {
        assert.ok(
            source.includes(entry.fragment),
            `the exception for ${entry.fragment} no longer matches any line; remove it`
        );
        assert.ok(
            entry.reason.trim().length > 40,
            "an exception without a stated reason is not an exception"
        );
    }
});
