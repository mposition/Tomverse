import assert from "node:assert/strict";
import test from "node:test";

import {
    IMPOSSIBLE_COMPLETION_TOKENS,
    errorMessageFrom,
    parseLimitCandidates,
    probeRequestFor,
} from "../scripts/report-model-max-output-probe-core.mjs";

// The probe sends real requests with real credentials, so what it builds and
// what it reads back are the two things that must not drift. Neither can be
// exercised in CI -- there are no provider keys there -- which makes these
// tests the only thing that holds them.
//
// The messages below are the ones staging actually received on 2026-08-24,
// kept verbatim. The first version of the parser turned four of them into
// figures no provider had said, by reading a range's floor and ceiling as one
// separated number, and no invented example had caught it.

test("OpenAI gets the field it renamed, and the compatible providers keep the old one", () => {
    const openai = probeRequestFor({
        provider: "openai",
        apiModel: "gpt-5.5",
        baseUrl: "https://api.openai.com/v1",
        protocol: "native",
    });
    assert.equal(openai.capField, "max_completion_tokens");
    assert.equal(openai.body.max_completion_tokens, IMPOSSIBLE_COMPLETION_TOKENS);
    assert.equal(openai.url, "https://api.openai.com/v1/chat/completions");

    const compatible = probeRequestFor({
        provider: "perplexity",
        apiModel: "sonar",
        baseUrl: "https://api.perplexity.ai",
        protocol: "openai-compatible",
    });
    assert.equal(compatible.capField, "max_tokens");
    assert.equal(compatible.body.max_tokens, IMPOSSIBLE_COMPLETION_TOKENS);
});

test("a trailing slash on the base URL does not produce a doubled path", () => {
    const request = probeRequestFor({
        provider: "zhipu",
        apiModel: "glm-5.2",
        baseUrl: "https://api.z.ai/api/paas/v4/",
        protocol: "openai-compatible",
    });
    assert.equal(request.url, "https://api.z.ai/api/paas/v4/chat/completions");
});

// A request in the wrong dialect comes back rejected for the wrong reason, and
// that rejection reads exactly like a provider declining to state its limit.
// Refusing by name keeps those two apart.
test("a provider speaking its own dialect is refused rather than sent a guess", () => {
    for (const provider of ["anthropic", "google", "minimax"]) {
        assert.throws(
            () =>
                probeRequestFor({
                    provider,
                    apiModel: "x",
                    baseUrl: "https://example.invalid",
                    protocol: "native",
                }),
            /dialect/,
            `${provider} was not refused`
        );
    }
    assert.throws(
        () =>
            probeRequestFor({
                provider: "openai",
                apiModel: "x",
                baseUrl: "https://example.invalid",
                protocol: "graphql",
            }),
        /Unsupported protocol/
    );
});

// Every one of these is a real answer from a real provider. `[1, 131072]` read
// as 1,131,072 before the grouping rule required three-digit groups.
test("a range is two numbers, not one with a separator in it", () => {
    const cases = [
        [
            "Error.Algo.InvalidParameter: Range of max_tokens should be [1, 131072]",
            131_072,
        ],
        [
            "Error.Algo.InvalidParameter: Range of max_tokens should be [1, 65536]",
            65_536,
        ],
        ["The max_tokens parameter is illegal.: 限制数值范围[1,131072]", 131_072],
    ];
    for (const [message, expected] of cases) {
        assert.deepEqual(
            parseLimitCandidates(message).map((candidate) => candidate.tokens),
            [expected],
            message
        );
    }
});

test("real refusals that state one ceiling yield exactly it", () => {
    for (const message of [
        "max_tokens must be at most 128000",
        "body -> max_tokens: Input should be less than or equal to 128000",
    ]) {
        assert.deepEqual(
            parseLimitCandidates(message).map((candidate) => candidate.tokens),
            [128_000],
            message
        );
    }
});

test("thousands separators still read as one number", () => {
    assert.deepEqual(
        parseLimitCandidates("the window is 1,048,576 tokens and the cap is 131,072").map(
            (candidate) => candidate.tokens
        ),
        [1_048_576, 131_072]
    );
});

test("both numbers in a refusal are reported, largest first", () => {
    const candidates = parseLimitCandidates(
        "max_completion_tokens is too large: 1000000000. This model supports at most 128000 " +
            "completion tokens, whereas you provided 1000000000."
    );
    assert.deepEqual(
        candidates.map((candidate) => candidate.tokens),
        [128_000]
    );
    // The probe's own input is not evidence about the provider.
    assert.ok(!candidates.some((c) => c.tokens === IMPOSSIBLE_COMPLETION_TOKENS));
});

test("each candidate carries the words around it, because the number alone does not say what it is", () => {
    const [candidate] = parseLimitCandidates(
        "This model's maximum context length is 128000 tokens."
    );
    assert.equal(candidate.tokens, 128_000);
    assert.match(candidate.phrase, /maximum context length is 128000 tokens/);
});

// Rejections are full of small numbers -- status codes, field indices, retry
// counts -- and every one of them reported as a candidate window would bury
// the real answer.
test("numbers too small to be a window are not candidates", () => {
    assert.deepEqual(parseLimitCandidates("error 400 on attempt 2 of 3, code 1023"), []);
});

test("one number said twice is one candidate", () => {
    const candidates = parseLimitCandidates(
        "limit is 65536; you asked for more than 65536"
    );
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].tokens, 65_536);
});

test("nothing to read yields nothing, rather than a fabricated candidate", () => {
    for (const value of ["", "   ", null, undefined, 42, {}]) {
        assert.deepEqual(parseLimitCandidates(value), [], `${JSON.stringify(value)} produced candidates`);
    }
});

test("the message is found wherever a provider keeps it", () => {
    assert.equal(errorMessageFrom({ error: { message: "too large" } }), "too large");
    assert.equal(errorMessageFrom({ message: "too large" }), "too large");
    assert.equal(errorMessageFrom({ detail: "too large" }), "too large");
    assert.equal(errorMessageFrom({ msg: "too large" }), "too large");
    assert.equal(errorMessageFrom("too large"), "too large");
});

// "The provider said nothing about a limit" and "this script could not find
// where it said it" are different findings, and the output must not merge
// them into one.
test("an unreadable body is null, not a stringified object", () => {
    assert.equal(errorMessageFrom({ unexpected: { shape: true } }), null);
    assert.equal(errorMessageFrom(null), null);
    assert.equal(errorMessageFrom(""), null);
    assert.equal(errorMessageFrom({ error: { message: "   " } }), null);
});
