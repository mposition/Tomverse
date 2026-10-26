import assert from "node:assert/strict";
import test from "node:test";

import {
    REVIEW_PREFILL_MAX_CHARS,
    reviewPrefillHref,
    reviewSeedFromChat,
} from "../lib/chatReviewHandoff.ts";

const turns = [
    { id: "u1", role: "user", content: "Plan a 3-day trip to Tokyo" },
    { id: "a1", role: "assistant", content: "Day 1 ..." },
    { id: "u2", role: "user", content: "Make it cheaper" },
    { id: "a2", role: "assistant", content: "Budget plan ..." },
    { id: "u3", role: "user", content: "And for families?" },
    { id: "a3", role: "assistant", content: "Family plan ..." },
];

test("the first answer opens Review with its question alone", () => {
    assert.equal(reviewSeedFromChat(turns, "a1", "Earlier:"), "Plan a 3-day trip to Tokyo");
});

test("a follow-up carries up to two earlier questions, never earlier answers", () => {
    const seed = reviewSeedFromChat(turns, "a3", "Earlier:");
    assert.equal(seed, "Earlier:\n- Plan a 3-day trip to Tokyo\n- Make it cheaper\n\nAnd for families?");
    assert.doesNotMatch(seed, /Day 1|Budget plan|Family plan/);
});

test("the answer's own question is used, not a later one", () => {
    assert.equal(reviewSeedFromChat(turns, "a2", "Earlier:"), "Earlier:\n- Plan a 3-day trip to Tokyo\n\nMake it cheaper");
});

test("imported original messages are not questions this conversation asked", () => {
    const seed = reviewSeedFromChat(
        [{ id: "x", role: "user", content: "Imported question", imported: { provider: "chatgpt" } }, ...turns.slice(0, 2)],
        "a1",
        "Earlier:"
    );
    assert.equal(seed, "Plan a 3-day trip to Tokyo");
});

test("no question, an unknown id or a user message gives no seed", () => {
    assert.equal(reviewSeedFromChat([{ id: "a", role: "assistant", content: "hi" }], "a", "Earlier:"), null);
    assert.equal(reviewSeedFromChat(turns, "missing", "Earlier:"), null);
    assert.equal(reviewSeedFromChat(turns, "u1", "Earlier:"), null);
});

test("the question always fits; context gives way first", () => {
    const long = "q".repeat(REVIEW_PREFILL_MAX_CHARS - 10);
    const seed = reviewSeedFromChat(
        [{ id: "u0", role: "user", content: "earlier question" }, { id: "a0", role: "assistant", content: "x" },
            { id: "u1", role: "user", content: long }, { id: "a1", role: "assistant", content: "y" }],
        "a1",
        "Earlier:"
    );
    assert.equal(seed, long);
    assert.ok(reviewSeedFromChat([{ id: "u", role: "user", content: "z".repeat(5000) }, { id: "a", role: "assistant", content: "" }], "a", "E").length <= REVIEW_PREFILL_MAX_CHARS);
});

test("the href is the existing Review prefill, clipped to what it reads", () => {
    assert.equal(reviewPrefillHref("a b&c"), "/review?prompt=a%20b%26c");
    const href = reviewPrefillHref("가".repeat(5000));
    assert.equal(decodeURIComponent(href.split("prompt=")[1]).length, REVIEW_PREFILL_MAX_CHARS);
});
