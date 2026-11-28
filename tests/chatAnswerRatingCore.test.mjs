import assert from "node:assert/strict";
import test from "node:test";

import {
    CHAT_ANSWER_RATINGS,
    CHAT_ANSWER_RATING_REASONS,
    CHAT_ANSWER_RATING_REFUSAL_STATUS,
    chatAnswerRatingRefusal,
    chatAnswerRatingWriteSchema,
    publicChatAnswerRating,
} from "../lib/chatAnswerRatingCore.ts";

const answer = (overrides = {}) => ({
    role: "assistant",
    status: "normal",
    conversation: { userId: "u-1", kind: "chat" },
    ...overrides,
});

test("the write schema: up, down, withdraw, and a reason only on down", () => {
    const parse = (body) => chatAnswerRatingWriteSchema.safeParse(body).success;
    assert.equal(parse({ messageId: "m-1", rating: "up" }), true);
    assert.equal(parse({ messageId: "m-1", rating: "down", reason: "inaccurate" }), true);
    assert.equal(parse({ messageId: "m-1", rating: null }), true);
    assert.equal(parse({ messageId: "m-1", rating: "up", reason: "inaccurate" }), false);
    assert.equal(parse({ messageId: "m-1", rating: "down", reason: "rude" }), false);
    assert.equal(parse({ messageId: "m-1", rating: "meh" }), false);
    // No model id from the client: the server copies it from the answer row.
    assert.equal(parse({ messageId: "m-1", rating: "up", modelId: "gpt-6-luna" }), false);
    assert.deepEqual([...CHAT_ANSWER_RATINGS], ["up", "down"]);
    assert.ok(CHAT_ANSWER_RATING_REASONS.includes("other"));
});

test("another account's answer is not found, even when its conversation is also locked", () => {
    assert.equal(
        chatAnswerRatingRefusal({ message: answer({ conversation: { userId: "u-2", kind: "chat" } }), userId: "u-1", unlocked: false }),
        "not_found"
    );
    assert.equal(chatAnswerRatingRefusal({ message: null, userId: "u-1", unlocked: true }), "not_found");
});

test("an owned answer in a locked conversation needs the unlock grant", () => {
    assert.equal(chatAnswerRatingRefusal({ message: answer(), userId: "u-1", unlocked: false }), "locked");
    assert.equal(chatAnswerRatingRefusal({ message: answer(), userId: "u-1", unlocked: true }), null);
    assert.equal(CHAT_ANSWER_RATING_REFUSAL_STATUS.locked, 423);
    assert.equal(CHAT_ANSWER_RATING_REFUSAL_STATUS.not_found, 404);
});

test("only a finished assistant answer in a text conversation can be rated", () => {
    assert.equal(chatAnswerRatingRefusal({ message: answer({ role: "user" }), userId: "u-1", unlocked: true }), "not_an_answer");
    assert.equal(chatAnswerRatingRefusal({ message: answer({ status: "error" }), userId: "u-1", unlocked: true }), "not_an_answer");
    assert.equal(
        chatAnswerRatingRefusal({ message: answer({ conversation: { userId: "u-1", kind: "image" } }), userId: "u-1", unlocked: true }),
        "unsupported_conversation"
    );
});

test("what the client is told drops a reason on an up rating and an unknown stored rating", () => {
    assert.deepEqual(publicChatAnswerRating({ messageId: "m-1", rating: "up", reason: "other" }), {
        messageId: "m-1",
        rating: "up",
        reason: null,
    });
    assert.deepEqual(publicChatAnswerRating({ messageId: "m-1", rating: "down", reason: "incomplete" }), {
        messageId: "m-1",
        rating: "down",
        reason: "incomplete",
    });
    assert.equal(publicChatAnswerRating({ messageId: "m-1", rating: "meh", reason: null }), null);
});
