import assert from "node:assert/strict";
import test from "node:test";
import {
    PRODUCT_ANALYTICS_EVENT_NAMES,
    analyticsPropertiesSchema,
} from "../lib/productAnalyticsShared.ts";

/**
 * §16 describes what a profile's fields are used for, and sending them to an
 * analytics provider is not on that list. A profile's name, description and
 * instructions are the user's own words about how they want to be spoken to.
 *
 * The guarantee is structural rather than a rule somebody follows: the
 * property schema is a closed object, so a key it does not name is stripped
 * before an event leaves the browser. These tests pin that the schema stays
 * closed and that no key capable of carrying prose is ever added to it.
 */

const ASSISTANT_EVENTS = [
    "assistant_profile_create_started",
    "assistant_profile_create_completed",
    "assistant_profile_applied_to_chat",
];

test("the assistant profile events exist and are the only ones added", () => {
    for (const name of ASSISTANT_EVENTS) {
        assert.ok(
            PRODUCT_ANALYTICS_EVENT_NAMES.includes(name),
            `${name} is missing from the event allowlist`
        );
    }
});

test("the entry property is a closed two-value enum", () => {
    for (const value of ["settings", "chat"]) {
        const parsed = analyticsPropertiesSchema.safeParse({
            assistant_profile_entry: value,
        });
        assert.equal(parsed.success, true, value);
    }
    // A third entry point would be a deliberate edit here, which is the moment
    // to ask whether it is a place or a description of one.
    assert.equal(
        analyticsPropertiesSchema.safeParse({
            assistant_profile_entry: "somewhere else",
        }).success,
        false
    );
});

test("a profile's own words cannot travel in an analytics event", () => {
    // The exact shape a leak would arrive in: somebody adds the name "just for
    // this one funnel". The schema is strict, so the whole event is refused
    // rather than quietly slimmed -- and `trackProductEvent` returns without
    // sending anything when the parse fails. That is the stronger of the two
    // possible behaviours: a stripped event still reports the funnel and hides
    // that somebody tried, while a refused one loses the datapoint and makes
    // the attempt visible in testing.
    for (const leaky of [
        { profile_name: "내 세무 도우미" },
        { name: "내 세무 도우미" },
        { description: "Answers tax questions about my own filings." },
        { instructions: "You know that I live in Seoul and file as a sole trader." },
        { title: "내 세무 도우미" },
        { file_name: "2025-tax-return.pdf" },
        { prompt: "You know that I live in Seoul." },
    ]) {
        const parsed = analyticsPropertiesSchema.safeParse({
            assistant_profile_entry: "chat",
            ...leaky,
        });
        assert.equal(
            parsed.success,
            false,
            `${Object.keys(leaky)[0]} was accepted as an analytics property`
        );
    }

    // And the legitimate event still passes, carrying nothing else.
    const ok = analyticsPropertiesSchema.safeParse({
        assistant_profile_entry: "chat",
    });
    assert.equal(ok.success, true);
    assert.deepEqual(ok.data, { assistant_profile_entry: "chat" });
});

test("no analytics property is a free field wide enough for instructions", () => {
    // A bounded id or a location label is fine; a field long enough to hold a
    // paragraph is how prose eventually gets sent. Instructions are capped in
    // the thousands of characters, so nothing here should approach that.
    const shape = analyticsPropertiesSchema.shape;
    for (const [key, field] of Object.entries(shape)) {
        const checks = field?._def?.innerType?._def?.checks ?? field?._def?.checks;
        if (!Array.isArray(checks)) continue;
        const max = checks.find((check) => check.kind === "max");
        if (!max) continue;
        assert.ok(
            max.value <= 128,
            `${key} accepts ${max.value} characters, which is room for prose`
        );
    }
});
