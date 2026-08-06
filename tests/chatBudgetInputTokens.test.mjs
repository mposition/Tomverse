import assert from "node:assert/strict";
import test from "node:test";
import { createChatBudget } from "../lib/chatSecurity.ts";
import {
    TOOL_DEFINITION_INPUT_TOKEN_OVERHEAD,
    WEB_SEARCH_INPUT_TOKEN_OVERHEAD,
} from "../lib/chatTokenEstimate.ts";
import { getModel } from "../lib/models.ts";

/**
 * What `budget.inputTokens` means (docs/ops/tomverse-chat-context-window-rollout.md).
 *
 * It is the figure three separate things are sized on: the credit reservation,
 * the provider cost reservation, and the context-window guard. So it has to be
 * what the request really sends, not the conversation alone — a
 * provider-native search feeds retrieved result text back into the prompt
 * before the model answers, and those tokens are as real as the user's.
 */

// Native provider search, available to guests, so both plan ceilings are
// reachable from one model.
const MODEL = getModel("claude-haiku-4-5");

const budget = (estimated, options) =>
    createChatBudget("guest", MODEL, estimated, options);

test("a turn with no tools reserves the conversation and nothing more", () => {
    assert.equal(budget(1_000).inputTokens, 1_000);
    assert.equal(budget(1_000, { nativeSearchEnabled: false }).inputTokens, 1_000);
});

test("a searching turn reserves the tokens the search will really add", () => {
    // The number the context guard was missing: without it a searching turn
    // sat up to this far over the very limit the guard exists to protect.
    assert.equal(
        budget(1_000, { nativeSearchEnabled: true }).inputTokens,
        1_000 + WEB_SEARCH_INPUT_TOKEN_OVERHEAD + TOOL_DEFINITION_INPUT_TOKEN_OVERHEAD
    );
});

test("tool overhead widens the reservation without widening the charge", () => {
    // Credits are weighted by the conversation the user actually sent. The
    // overhead is an internal cost reservation, refunded down at settlement,
    // and must never reach what the user is billed.
    const plain = budget(1_000);
    const searching = budget(1_000, { nativeSearchEnabled: true });
    assert.ok(searching.inputTokens > plain.inputTokens);
    assert.equal(searching.usageCredits, plain.usageCredits);
});

test("the reserved figure never exceeds the plan's own input ceiling", () => {
    // A guest sending right up to their limit must not have the overhead push
    // the reservation past it -- the ceiling is the reservation's bound too.
    const ceiling = Number(process.env.CHAT_GUEST_MAX_INPUT_TOKENS) || 16_000;
    assert.equal(
        budget(ceiling, { nativeSearchEnabled: true }).inputTokens,
        ceiling
    );
});

test("a conversation over the plan ceiling is refused before any budget exists", () => {
    const ceiling = Number(process.env.CHAT_GUEST_MAX_INPUT_TOKENS) || 16_000;
    assert.throws(() => budget(ceiling + 1), /token budget/i);
});
