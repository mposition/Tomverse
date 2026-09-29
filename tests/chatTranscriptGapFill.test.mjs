import assert from "node:assert/strict";
import test from "node:test";
import {
    gapFilledModelTranscript,
    mergeGuestTranscripts,
} from "../lib/chatTranscriptGapFill.ts";

/**
 * A panel whose model was swapped used to show a column of bare questions:
 * every earlier answer belonged to the old model, and the panel only drew its
 * own. The next send then carried those bare questions -- and every image on
 * them -- to the new model with none of the answers they had received.
 */

const user = (id, extra = {}) => ({ id, role: "user", content: `q ${id}`, ...extra });
const answer = (id, modelId, extra = {}) => ({
    id,
    role: "assistant",
    content: `a ${id}`,
    modelId,
    status: "normal",
    ...extra,
});
const ids = (messages) => messages.map((message) => message.id);

// Luna and Terra answered two turns; the panel that showed Luna now shows mini.
const conversation = [
    user("q1"),
    answer("luna1", "luna"),
    answer("terra1", "terra"),
    user("q2"),
    answer("luna2", "luna"),
    answer("terra2", "terra"),
];

test("a swapped panel shows the replaced model's answers under its questions", () => {
    const view = gapFilledModelTranscript(conversation, "mini", ["terra"]);
    assert.deepEqual(ids(view), ["q1", "luna1", "q2", "luna2"]);
    const carried = view.filter((message) => message.role === "assistant");
    assert.ok(carried.every((message) => message.carriedAnswer === true));
    // Drawn under the model that wrote it, not under mini.
    assert.deepEqual(
        carried.map((message) => message.modelId),
        ["luna", "luna"]
    );
});

test("an answer another panel shows is never copied in", () => {
    // Terra's column still shows Terra. Copying its answers in would make the
    // columns stop being independent answers to the same question.
    const view = gapFilledModelTranscript(conversation, "mini", ["terra", "luna"]);
    assert.deepEqual(ids(view), ["q1", "q2"]);
});

test("a turn this model answered, failed or stopped is left as it was", () => {
    const messages = [
        user("q1"),
        answer("luna1", "luna"),
        answer("mini1", "mini"),
        user("q2"),
        answer("luna2", "luna"),
        answer("mini2", "mini", { status: "error", content: "failed" }),
        user("q3"),
        answer("luna3", "luna"),
        answer("mini3", "mini", { status: "cancelled" }),
    ];
    const view = gapFilledModelTranscript(messages, "mini", []);
    assert.deepEqual(ids(view), ["q1", "mini1", "q2", "mini2", "q3", "mini3"]);
    assert.ok(view.every((message) => !message.carriedAnswer));
});

test("only a completed answer is borrowed, and the latest one wins", () => {
    const messages = [
        user("q1"),
        answer("old-error", "luna", { status: "error" }),
        answer("empty", "sol", { content: "  " }),
        answer("first", "luna"),
        answer("second", "sol"),
    ];
    assert.deepEqual(
        ids(gapFilledModelTranscript(messages, "mini", [])),
        ["q1", "second"]
    );
});

test("a follow-up asked of one other model stays that model's", () => {
    const messages = [
        user("q1"),
        answer("luna1", "luna"),
        user("luna-only", { modelId: "luna" }),
        answer("luna-followup", "luna"),
        user("q2"),
        answer("mini2", "mini"),
    ];
    // The follow-up's answer is not an answer to q1.
    assert.deepEqual(
        ids(gapFilledModelTranscript(messages, "mini", [])),
        ["q1", "luna1", "q2", "mini2"]
    );
});

test("this model's own follow-ups and answers are always kept", () => {
    const messages = [
        user("q1"),
        answer("mini1", "mini"),
        user("mini-only", { modelId: "mini" }),
        answer("mini-followup", "mini"),
    ];
    assert.deepEqual(
        ids(gapFilledModelTranscript(messages, "mini", ["luna"])),
        ["q1", "mini1", "mini-only", "mini-followup"]
    );
});

test("the old filter's answer is unchanged when nothing was swapped", () => {
    // Every turn answered by this model: identical to the per-model view.
    const messages = [
        user("q1"),
        answer("mini1", "mini"),
        answer("luna1", "luna"),
        user("q2"),
        answer("luna2", "luna"),
        answer("mini2", "mini"),
    ];
    assert.deepEqual(
        ids(gapFilledModelTranscript(messages, "mini", [])),
        ["q1", "mini1", "q2", "mini2"]
    );
});

test("duplicate rows are drawn once", () => {
    const messages = [user("q1"), answer("luna1", "luna"), user("q1"), answer("luna1", "luna")];
    assert.deepEqual(
        ids(gapFilledModelTranscript(messages, "mini", [])),
        ["q1", "luna1"]
    );
});

test("guest transcripts merge into one ordered conversation", () => {
    // Per-model localStorage: mini's transcript starts after the swap, and
    // Luna's holds the turns before it.
    const luna = [user("q1"), answer("luna1", "luna"), user("q2"), answer("luna2", "luna")];
    const mini = [user("q2"), user("q3"), answer("mini3", "mini")];
    const merged = mergeGuestTranscripts([mini, luna]);
    assert.deepEqual(ids(merged), ["q1", "luna1", "q2", "luna2", "q3", "mini3"]);
    assert.deepEqual(
        ids(gapFilledModelTranscript(merged, "mini", [])),
        ["q1", "luna1", "q2", "luna2", "q3", "mini3"]
    );
});

test("an empty guest transcript takes the other model's whole history", () => {
    const luna = [user("q1"), answer("luna1", "luna")];
    assert.deepEqual(
        ids(gapFilledModelTranscript(mergeGuestTranscripts([[], luna]), "mini", [])),
        ["q1", "luna1"]
    );
});
