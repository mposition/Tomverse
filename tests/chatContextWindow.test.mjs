import assert from "node:assert/strict";
import test from "node:test";
import { chatContextWindowDecision } from "../lib/chatContextWindow.ts";

/**
 * The context-window boundary (docs/ops/tomverse-chat-context-window-rollout.md).
 *
 * Two things are under test and they fail differently. The arithmetic is an
 * off-by-one risk whose cost is either a provider error the user pays for or a
 * refusal they did not deserve. The `unbounded` case is an honesty risk: a
 * model with no declared window is not clamped to a safe default, it is not
 * checked at all, and that has to be a named outcome rather than something a
 * reader infers from a passing check.
 */

const decide = (overrides = {}) =>
    chatContextWindowDecision({
        contextWindowTokens: 1_000,
        inputTokens: 500,
        maxOutputTokens: 200,
        ...overrides,
    });

test("input and output are counted against one shared window", () => {
    // The model holds the prompt while it writes the answer, so a request that
    // fits only because its answer was not counted does not fit.
    const decision = decide({ inputTokens: 900, maxOutputTokens: 200 });
    assert.equal(decision.kind, "exceeded");
    assert.equal(decision.requiredTokens, 1_100);
    assert.equal(decision.limitTokens, 1_000);
});

test("a request that exactly fills the window fits", () => {
    const decision = decide({ inputTokens: 800, maxOutputTokens: 200 });
    assert.equal(decision.kind, "within");
    assert.equal(decision.requiredTokens, 1_000);
});

test("one token over the window does not fit", () => {
    assert.equal(decide({ inputTokens: 801, maxOutputTokens: 200 }).kind, "exceeded");
});

test("one token under the window fits", () => {
    assert.equal(decide({ inputTokens: 799, maxOutputTokens: 200 }).kind, "within");
});

test("a model with no declared window reports that nothing was checked", () => {
    // Not "within": nothing was compared. Reporting a pass would tell a reader
    // the request was bounded when it was not, and the fail-closed stage of the
    // rollout changes exactly this case.
    for (const contextWindowTokens of [null, undefined, 0]) {
        assert.deepEqual(decide({ contextWindowTokens }), { kind: "unbounded" });
    }
});

test("an unbounded model is unbounded however large the request is", () => {
    assert.equal(
        decide({
            contextWindowTokens: null,
            inputTokens: 10_000_000,
            maxOutputTokens: 10_000_000,
        }).kind,
        "unbounded"
    );
});

test("a nonsensical window is treated as no window, not as a limit of zero", () => {
    // A negative window would otherwise refuse every request on that model,
    // which is a worse failure than the unbounded one it really is.
    assert.equal(decide({ contextWindowTokens: -1 }).kind, "unbounded");
});

test("the refusal carries both numbers, so the message can name the limit", () => {
    const decision = decide({
        contextWindowTokens: 400_000,
        inputTokens: 399_000,
        maxOutputTokens: 32_000,
    });
    assert.equal(decision.kind, "exceeded");
    assert.equal(decision.limitTokens, 400_000);
    assert.equal(decision.requiredTokens, 431_000);
});
