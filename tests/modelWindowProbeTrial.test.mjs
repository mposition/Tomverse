import assert from "node:assert/strict";
import test from "node:test";

import {
    DEFAULT_COMPLETION_CAP,
    classifyTrialAnswer,
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

test("HTTP 200 is an undersized input, whatever the body says", () => {
    assert.equal(
        classifyTrialAnswer({ status: 200, message: "max_tokens context length exceeded" }),
        "accepted"
    );
});

// Small because it is the blast radius of an accidental acceptance: the input
// fits, the provider answers, and this is how long the billed answer is.
test("the default cap is the only floor a provider has stated to us", () => {
    assert.equal(DEFAULT_COMPLETION_CAP, 16);
});
