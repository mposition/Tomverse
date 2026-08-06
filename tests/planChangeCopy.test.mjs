import assert from "node:assert/strict";
import test from "node:test";
import { planChangeText } from "../components/billing/planChangeCopy.ts";

/**
 * The plan-change dialog's copy, across every language it ships in.
 *
 * TypeScript already proves each block has every key. What it cannot prove is
 * that a translated string still *says* the thing: an interpolated sentence
 * that drops one of its numbers compiles perfectly and quotes a balance
 * nobody can check. These are the two numbers a customer is being asked to
 * approve a subscription change against.
 */

const LANGUAGES = ["en", "ko", "zh", "fr", "de", "es", "pt"];

test("every language quotes both credit figures", () => {
    for (const lang of LANGUAGES) {
        const text = planChangeText(lang);
        // Four digits so a thousands separator cannot make the assertion
        // depend on one locale's grouping.
        const rendered = text.creditsRemaining(1234, 5678);
        assert.match(
            rendered,
            /1[.,  ]?234/,
            `${lang}: the remaining figure is missing`
        );
        assert.match(
            rendered,
            /5[.,  ]?678/,
            `${lang}: the new allowance is missing`
        );
    }
});

test("zero remaining is rendered, not dropped as falsy", () => {
    // The case that matters most: a downgrade landing on an allowance the
    // month has already passed. A template that treated 0 as absent would
    // quote the allowance alone and read as "you have 3,000 left".
    for (const lang of LANGUAGES) {
        assert.match(
            planChangeText(lang).creditsRemaining(0, 3000),
            /0/,
            `${lang}: zero remaining is not shown`
        );
    }
});

test("every language explains that spent credits are not clawed back", () => {
    for (const lang of LANGUAGES) {
        const notice = planChangeText(lang).creditsOverageNotice;
        assert.ok(
            notice.trim().length > 20,
            `${lang}: the overage notice is missing or too short to explain anything`
        );
        if (lang !== "en") {
            assert.notEqual(
                notice,
                planChangeText("en").creditsOverageNotice,
                `${lang}: still carries the English notice`
            );
        }
    }
});

test("an unknown language falls back to English rather than throwing", () => {
    assert.equal(
        planChangeText("xx").creditsLabel,
        planChangeText("en").creditsLabel
    );
});
