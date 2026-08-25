import assert from "node:assert/strict";
import test from "node:test";

import {
    COUNTED_INPUT_TOLERANCE,
    DEFAULT_COMPLETION_CAP,
    classifyCountedInput,
    classifyTrialAnswer,
    readSuccessTelemetry,
} from "../scripts/report-model-window-probe-trial-core.mjs";

// The trial sends one expensive request and prints a verdict on a technique.
// Everything here guards the same failure: reading a refusal about the request
// as a refusal about the input, and condemning the method on the strength of
// it. That is not hypothetical -- it is what the first run did.

// The message that produced this module. `perplexity/sonar`, 2026-08-24: the
// trial set max_tokens to 1, Perplexity's floor is 16, and the request died on
// cap validation before the 150,000-token input was counted. The old script
// printed "the technique does not answer the question ... delete it".
test("the refusal that caused this file is about the cap, not the input", () => {
    assert.equal(
        classifyTrialAnswer({ status: 400, message: "max_tokens must be at least 16" }),
        "refusedOnCap"
    );
});

test("the ceilings the max-output probe collected are cap refusals too", () => {
    for (const message of [
        "Range of max_tokens should be [1, 131072]",
        "The max_tokens parameter is illegal.: 限制数值范围[1,131072]",
        "max_tokens must be at most 128000",
    ]) {
        assert.equal(classifyTrialAnswer({ status: 400, message }), "refusedOnCap", message);
    }
});

test("a refusal about input length is the trial actually running", () => {
    for (const message of [
        "This model's maximum context length is 128000 tokens, however you requested 150001.",
        "Input is too long for requested model.",
        "prompt too large",
        "Your input exceeds the maximum context window.",
        "请求过长",
    ]) {
        assert.equal(classifyTrialAnswer({ status: 400, message }), "refusedOnLength", message);
    }
});

// A message carrying both must not be read as a malformed cap: it is the one
// answer the trial exists to collect, and discarding it would lose the finding
// while the run had already been paid for.
test("length wins over the cap field when a refusal names both", () => {
    assert.equal(
        classifyTrialAnswer({
            status: 400,
            message: "max_tokens plus your input exceeds the model's context length of 128000",
        }),
        "refusedOnLength"
    );
});

test("a refusal about neither is not evidence about anything", () => {
    for (const message of [
        "Invalid API key provided.",
        "Rate limit exceeded for requests per minute.",
        "The model `sonar-x` does not exist.",
        "",
        null,
    ]) {
        assert.equal(
            classifyTrialAnswer({ status: 401, message }),
            "refusedForOtherReason",
            String(message)
        );
    }
});

// The reason "exceed" cannot be a length word on its own. A rate limit is the
// commonest refusal there is, and reading it as a length refusal with no number
// in it would print the delete-this-script verdict over a message that means
// nothing more than wait and ask again.
test("a rate limit is not a length refusal, however much it exceeds", () => {
    assert.equal(
        classifyTrialAnswer({ status: 429, message: "Rate limit exceeded for requests per minute." }),
        "refusedForOtherReason"
    );
});

// The classifier's known soft spot, pinned as the behaviour it is meant to
// have. A provider phrasing a length refusal in words not listed lands here,
// and this branch prints the message and says the trial did not run. Costs one
// reading; the opposite mistake would cost the method.
test("an unrecognised length refusal degrades to go-and-look, not to a verdict", () => {
    assert.equal(
        classifyTrialAnswer({ status: 400, message: "Payload is bigger than we allow." }),
        "refusedForOtherReason"
    );
});

test("HTTP 200 is the provider answering, not a verdict on the window", () => {
    assert.equal(
        classifyTrialAnswer({ status: 200, message: "max_tokens context length exceeded" }),
        "answered"
    );
});

// Small because it is the blast radius of an accidental acceptance: the input
// fits, the provider answers, and this is how long the billed answer is.
test("the default cap is the only floor a provider has stated to us", () => {
    assert.equal(DEFAULT_COMPLETION_CAP, 16);
});

// --- the success path ------------------------------------------------------
//
// `perplexity/sonar`, 2026-08-24: ~150,000 tokens of filler came back HTTP 200
// and the script printed "the input fitted, so the window is larger than this
// request". Perplexity's own model page puts sonar at 128K. A provider that
// truncates an over-long input answers 200 as readily as one that carries it,
// and the old line could not tell the two apart because it never looked.

const success = (usage, extra = {}) => ({
    id: "req_abc123",
    choices: [{ message: { role: "assistant", content: "ok" } }],
    usage,
    ...extra,
});

test("a success body yields the count and an id worth quoting", () => {
    assert.deepEqual(readSuccessTelemetry(success({ prompt_tokens: 149_512 })), {
        promptTokens: 149_512,
        requestId: "req_abc123",
    });
});

// "The provider did not say" and "the provider said a small number" lead to
// opposite conclusions, so nothing unusable may be coerced into a count.
test("a count that is not a positive number is no count", () => {
    for (const usage of [
        undefined,
        {},
        { prompt_tokens: null },
        { prompt_tokens: "149512" },
        { prompt_tokens: 0 },
        { prompt_tokens: -1 },
        { prompt_tokens: Number.NaN },
        { prompt_tokens: { value: 149_512 } },
    ]) {
        assert.equal(
            readSuccessTelemetry(success(usage)).promptTokens,
            null,
            JSON.stringify(usage ?? null)
        );
    }
});

test("a body that is not an object reports nothing rather than throwing", () => {
    for (const body of [null, undefined, "plain text", 42]) {
        assert.deepEqual(readSuccessTelemetry(body), { promptTokens: null, requestId: null });
    }
});

test("an id under another name is still an id, and a blank one is not", () => {
    assert.equal(
        readSuccessTelemetry({ request_id: "rq-1", usage: { prompt_tokens: 10 } }).requestId,
        "rq-1"
    );
    assert.equal(readSuccessTelemetry({ id: "   ", usage: {} }).requestId, null);
});

test("no count means the run measured nothing", () => {
    assert.equal(
        classifyCountedInput({ promptTokens: null, approxRequestedTokens: 150_000 }),
        "INCONCLUSIVE"
    );
    assert.equal(
        classifyCountedInput({ promptTokens: 149_512, approxRequestedTokens: 0 }),
        "INCONCLUSIVE"
    );
});

// The case the tolerance is chosen against. Perplexity publishes 128K for
// sonar; if that window truncated the ~150,000 sent, the count comes back at
// 85% -- and any looser threshold would report the truncation as a clean
// carry, which is the whole mistake being fixed.
test("a 128K truncation of a 150K request reads as possible truncation", () => {
    assert.equal(
        classifyCountedInput({ promptTokens: 128_000, approxRequestedTokens: 150_000 }),
        "POSSIBLE_TRUNCATION"
    );
    assert.ok(128_000 / 150_000 < COUNTED_INPUT_TOLERANCE);
});

// --approx-input-tokens is a repetition count, not a token count, so the
// comparison has to leave room for a tokeniser that disagrees by a few percent.
test("a few percent of tokeniser drift is not truncation", () => {
    assert.equal(
        classifyCountedInput({ promptTokens: 146_000, approxRequestedTokens: 150_000 }),
        "PROVIDER_COUNTED_APPROXIMATELY_REQUESTED_INPUT"
    );
});

test("the tolerance boundary itself counts as carried", () => {
    assert.equal(
        classifyCountedInput({
            promptTokens: 150_000 * COUNTED_INPUT_TOLERANCE,
            approxRequestedTokens: 150_000,
        }),
        "PROVIDER_COUNTED_APPROXIMATELY_REQUESTED_INPUT"
    );
});

// Counting more than was sent is not truncation. It happens: a provider may
// add a system preamble, or its tokeniser may be less generous than one token
// a word.
test("counting more than was sent is not truncation", () => {
    assert.equal(
        classifyCountedInput({ promptTokens: 162_000, approxRequestedTokens: 150_000 }),
        "PROVIDER_COUNTED_APPROXIMATELY_REQUESTED_INPUT"
    );
});
