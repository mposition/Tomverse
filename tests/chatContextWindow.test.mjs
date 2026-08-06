import assert from "node:assert/strict";
import test from "node:test";
import { fitChatOutputToContextWindow } from "../lib/chatContextWindow.ts";
import { AVAILABLE_MODELS, resolveModelRequestPricing } from "../lib/models.ts";

/**
 * Fitting the output cap to the context window
 * (docs/ops/tomverse-chat-context-window-rollout.md).
 *
 * Three things are under test and they fail differently. The arithmetic is an
 * off-by-one risk whose cost is either a provider error the user pays for or a
 * refusal nobody deserved. The `unbounded` case is an honesty risk: a model
 * with no declared window is not clamped to a safe default, it is not checked
 * at all, and that has to be a named outcome. And the capability/request
 * separation is the one that actually broke a shipped model — see the Kimi K3
 * case at the bottom.
 */

const fit = (overrides = {}) =>
    fitChatOutputToContextWindow({
        contextWindowTokens: 1_000,
        reservedInputTokens: 400,
        requestOutputCapTokens: 200,
        ...overrides,
    });

test("a request that fits keeps the whole cap it asked for", () => {
    const budget = fit();
    assert.equal(budget.kind, "fitted");
    assert.equal(budget.outputTokens, 200);
    assert.equal(budget.limitTokens, 1_000);
});

test("the cap is lowered to the room the window has left, not refused", () => {
    // 900 in, 1,000 window: 100 tokens of answer is a short answer, not an
    // impossible request. Refusing here is what made Kimi K3 unusable.
    const budget = fit({ reservedInputTokens: 900, requestOutputCapTokens: 200 });
    assert.equal(budget.kind, "fitted");
    assert.equal(budget.outputTokens, 100);
});

test("input that exactly fills the window leaves nothing to answer in", () => {
    const budget = fit({ reservedInputTokens: 1_000 });
    assert.equal(budget.kind, "exceeded");
    assert.equal(budget.limitTokens, 1_000);
    assert.equal(budget.reservedInputTokens, 1_000);
});

test("one token of room is enough to proceed", () => {
    const budget = fit({ reservedInputTokens: 999 });
    assert.equal(budget.kind, "fitted");
    assert.equal(budget.outputTokens, 1);
});

test("one token past the window is refused", () => {
    assert.equal(fit({ reservedInputTokens: 1_001 }).kind, "exceeded");
});

test("the provider's ceiling lowers the request cap and never raises it", () => {
    assert.equal(
        fit({ requestOutputCapTokens: 500, providerMaxOutputTokens: 300 })
            .outputTokens,
        300
    );
    assert.equal(
        fit({ requestOutputCapTokens: 200, providerMaxOutputTokens: 900 })
            .outputTokens,
        200
    );
});

test("an unverified provider ceiling is absent, not unlimited", () => {
    // Null must not stand in as Infinity and quietly widen the request.
    for (const providerMaxOutputTokens of [null, undefined, 0]) {
        assert.equal(
            fit({ requestOutputCapTokens: 200, providerMaxOutputTokens })
                .outputTokens,
            200
        );
    }
});

test("a model with no declared window reports that nothing was checked", () => {
    // Not "fitted": nothing was compared. Reporting a pass would tell a reader
    // the request was bounded when it was not, and the fail-closed stage of
    // the rollout changes exactly this case.
    for (const contextWindowTokens of [null, undefined, 0, -1]) {
        const budget = fit({ contextWindowTokens, reservedInputTokens: 10_000_000 });
        assert.equal(budget.kind, "unbounded");
        assert.equal(budget.outputTokens, 200);
    }
});

/* --------------------------------------------------- the catalogue itself -- */

const GUEST_CEILING = Number(process.env.CHAT_GUEST_MAX_INPUT_TOKENS) || 16_000;

/**
 * The regression Kimi K3 is: its pricing profile carried the provider's
 * settable ceiling (1,048,576) as the request's fixed output cap, and that
 * ceiling is its entire context window. Adding any input at all put the pair
 * over the window, so every request was refused at every size — a Pro model
 * nobody could use, on develop, silently.
 *
 * Asserted over the whole catalogue rather than for that one model: the shape
 * of the mistake is "capability used as request budget", and it is available to
 * every future entry.
 */
test("no enabled model refuses a one-token request", () => {
    for (const model of AVAILABLE_MODELS) {
        if (!model.enabled) continue;
        const pricing = resolveModelRequestPricing(model, {
            estimatedPromptTokens: 1,
        });
        const budget = fitChatOutputToContextWindow({
            contextWindowTokens: model.contextWindowTokens,
            reservedInputTokens: 1,
            requestOutputCapTokens: pricing.maxOutputTokens,
            providerMaxOutputTokens: pricing.providerMaxOutputTokens,
        });
        assert.notEqual(
            budget.kind,
            "exceeded",
            `${model.id} refuses a one-token request: window ${model.contextWindowTokens}, output cap ${pricing.maxOutputTokens}`
        );
    }
});

test("every enabled model leaves a guest room for a real answer", () => {
    // A guest filling their entire input allowance must still get more than a
    // token or two back, or the model is nominally available and useless.
    const MINIMUM_USEFUL_ANSWER_TOKENS = 1_024;
    for (const model of AVAILABLE_MODELS) {
        if (!model.enabled || !model.contextWindowTokens) continue;
        const pricing = resolveModelRequestPricing(model, {
            estimatedPromptTokens: GUEST_CEILING,
        });
        const budget = fitChatOutputToContextWindow({
            contextWindowTokens: model.contextWindowTokens,
            reservedInputTokens: GUEST_CEILING,
            requestOutputCapTokens: pricing.maxOutputTokens,
            providerMaxOutputTokens: pricing.providerMaxOutputTokens,
        });
        assert.equal(budget.kind, "fitted", `${model.id} refuses a full guest turn`);
        assert.ok(
            budget.outputTokens >= MINIMUM_USEFUL_ANSWER_TOKENS,
            `${model.id} leaves a guest only ${budget.outputTokens} output tokens`
        );
    }
});

test("Kimi K3 answers a full-length turn instead of refusing it", () => {
    const model = AVAILABLE_MODELS.find((entry) => entry.id === "kimi-k3");
    const pricing = resolveModelRequestPricing(model, {
        estimatedPromptTokens: 50_000,
    });
    // The capability and the request cap are now two different numbers.
    assert.equal(pricing.providerMaxOutputTokens, model.contextWindowTokens);
    assert.ok(pricing.maxOutputTokens < pricing.providerMaxOutputTokens);

    const budget = fitChatOutputToContextWindow({
        contextWindowTokens: model.contextWindowTokens,
        reservedInputTokens: 50_000,
        requestOutputCapTokens: pricing.maxOutputTokens,
        providerMaxOutputTokens: pricing.providerMaxOutputTokens,
    });
    assert.equal(budget.kind, "fitted");
    assert.equal(budget.outputTokens, pricing.maxOutputTokens);
});
