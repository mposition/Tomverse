import assert from "node:assert/strict";
import test from "node:test";
import {
    AUTO_LLM_ROUTER_CODING_GUIDANCE,
    AUTO_LLM_ROUTER_CODING_VERSION,
    AUTO_LLM_ROUTER_DEFAULT_GUIDANCE,
    AUTO_LLM_ROUTER_MAX_TOOL_RESULT_CHARS,
    AUTO_LLM_ROUTER_SYSTEM,
    boundedToolResult,
    buildAutoLlmRouterSystem,
} from "../lib/autoLlmRouterCore.ts";
import {
    externalApiModelCapabilities,
    hasRegistryCredits,
    isExternalApiServableModel,
    isSmartAdaptiveOnlyModel,
    nativeSmartAdaptiveCapabilities,
    nativeSmartAdaptiveDefaultId,
    smartAdaptiveCapabilities,
} from "../lib/externalApiCatalogCore.ts";
import { codingToolModels } from "../lib/externalApiCodingTools.ts";
import {
    conversationModelMayMove,
    escalateOnly,
    nativeLastUserText,
    nativePreviousAnswer,
    nativeCodingContext,
    nativeUserTurn,
    smartAdaptiveCodingContext,
    smartAdaptiveConversationKey,
} from "../lib/externalApiSmartAdaptiveCore.ts";

/**
 * Smart Adaptive as a coding router (owner decision 2026-11-20): the coding
 * guidance, the signals it reads, a model that only moves up within a
 * conversation, and frontier/apex models that only Smart Adaptive routes to.
 */

const model = (usageClass, extra = {}) => ({
    id: `fixture-${usageClass}`,
    name: "Fixture",
    apiModel: "fixture-upstream",
    provider: "anthropic",
    icon: "",
    bestFor: "",
    minimumPlan: "Pro",
    usageClass,
    enabled: true,
    status: "enabled",
    ...extra,
});

test("frontier and apex models are Smart Adaptive candidates only", () => {
    for (const usageClass of ["frontier", "apex"]) {
        assert.equal(isExternalApiServableModel(model(usageClass), "Pro"), false, `${usageClass} cannot be named directly`);
        assert.equal(isExternalApiServableModel(model(usageClass), "Pro", { smartAdaptive: true }), true, `${usageClass} routes`);
        assert.equal(isExternalApiServableModel(model(usageClass), "Free", { smartAdaptive: true }), false, "the plan still applies");
        assert.equal(
            isExternalApiServableModel(model(usageClass, { enabled: false }), "Pro", { smartAdaptive: true }),
            false,
            "a disabled model never routes"
        );
    }
    for (const usageClass of ["research", "deep-research"]) {
        assert.equal(isExternalApiServableModel(model(usageClass), "Max", { smartAdaptive: true }), false, `${usageClass} never`);
    }
    assert.equal(isExternalApiServableModel(model("premium"), "Pro", { smartAdaptive: true }), true);
    // Never a default (lib/externalApiSmartAdaptive.ts, lib/externalApiNativeSmartAdaptive.ts).
    assert.equal(isSmartAdaptiveOnlyModel(model("frontier")), true);
    assert.equal(isSmartAdaptiveOnlyModel(model("apex")), true);
    assert.equal(isSmartAdaptiveOnlyModel(model("premium")), false);
});

test("on the coding catalogue frontier and apex may be named, only with credits the registry holds", () => {
    // Owner decision 2026-11-22: the coding API with its catalogue on.
    const coding = { routerClassesNameable: true };
    for (const usageClass of ["frontier", "apex"]) {
        const priced = model(usageClass, { creditWeight: 32 });
        assert.equal(isExternalApiServableModel(priced, "Pro", coding), true, `${usageClass} can be named on the coding catalogue`);
        assert.equal(isExternalApiServableModel(priced, "Pro", { ...coding, smartAdaptive: true }), true, `${usageClass} still routes`);
        assert.equal(isExternalApiServableModel(priced, "Free", coding), false, "the plan still applies");
        // No registry credits, or zero: not offered at all there, named or routed.
        for (const creditWeight of [undefined, 0, -1, 1.5]) {
            const unpriced = model(usageClass, { creditWeight });
            assert.equal(hasRegistryCredits(unpriced), false, String(creditWeight));
            assert.equal(isExternalApiServableModel(unpriced, "Pro", coding), false, String(creditWeight));
            assert.equal(isExternalApiServableModel(unpriced, "Pro", { ...coding, smartAdaptive: true }), false, String(creditWeight));
        }
        // The general API keeps the 2026-11-20 rule.
        assert.equal(isExternalApiServableModel(priced, "Pro"), false, `${usageClass} is not named on the general API`);
        assert.equal(isExternalApiServableModel(priced, "Pro", { smartAdaptive: true }), true);
    }
    // Other classes are unchanged by the option; research never serves.
    assert.equal(isExternalApiServableModel(model("premium"), "Pro", coding), true);
    assert.equal(isExternalApiServableModel(model("research", { creditWeight: 5 }), "Max", coding), false);
});

const caps = (id, creditWeight, protocols) => ({
    id,
    name: id,
    provider: "x",
    tools: true,
    vision: true,
    reasoning: true,
    contextWindowTokens: 200_000,
    maxOutputTokens: 64_000,
    creditWeight,
    protocols,
});

test("Smart Adaptive states the most a request costs, per protocol", () => {
    const smart = smartAdaptiveCapabilities([
        caps("haiku", 1, ["chat_completions", "anthropic_messages"]),
        caps("fable", 80, ["chat_completions", "anthropic_messages"]),
        caps("luna", 1, ["chat_completions", "responses"]),
        caps("sol", 16, ["chat_completions", "responses"]),
    ]);
    assert.equal(smart.creditWeight, 80);
    assert.deepEqual(smart.creditWeightByProtocol, { chat_completions: 80, anthropic_messages: 80, responses: 16 });

    // The settings page lists the directly nameable models only, and Smart
    // Adaptive's ceiling on each protocol still counts the routed-only ones.
    const tools = codingToolModels([
        { ...smart, id: "smart-adaptive" },
        caps("haiku", 1, ["chat_completions", "anthropic_messages"]),
        caps("luna", 1, ["chat_completions", "responses"]),
        caps("sol", 16, ["chat_completions", "responses"]),
    ]);
    assert.equal(tools.claudeCode[0].id, "smart-adaptive");
    assert.equal(tools.claudeCode[0].creditWeight, 80, "Fable is routed to on Claude Code");
    assert.equal(tools.codex[0].creditWeight, 16, "an Anthropic model never sets Codex's ceiling");
    assert.ok(!tools.claudeCode.some((entry) => entry.id === "fable"), "never offered by name");
});

test("Smart Adaptive is offered only where a model it may default to is; frontier and apex are never its default", () => {
    // externalApiModelCapabilities marks the classes only the router may pick.
    const limits = { maxInputTokens: 100_000, maxOutputTokens: 8_000, creditWeight: 40 };
    assert.equal(externalApiModelCapabilities(model("frontier"), limits).routerPickOnly, true);
    assert.equal(externalApiModelCapabilities(model("apex"), limits).routerPickOnly, true);
    assert.equal("routerPickOnly" in externalApiModelCapabilities(model("premium"), limits), false);

    const pick = (entry) => ({ ...entry, routerPickOnly: true });
    // Only frontier or apex models: no Smart Adaptive at all.
    assert.equal(smartAdaptiveCapabilities([pick(caps("opus", 40, ["chat_completions", "anthropic_messages"]))]), null);
    assert.equal(
        smartAdaptiveCapabilities([pick(caps("opus", 40, ["chat_completions", "anthropic_messages"])), pick(caps("astra", 32, ["chat_completions", "responses"]))]),
        null
    );
    // Anthropic only frontier, OpenAI a standard model: offered on Chat Completions and Responses only.
    const smart = smartAdaptiveCapabilities(
        [
            pick({ ...caps("opus", 40, ["chat_completions", "anthropic_messages"]), maxOutputTokens: 32_000 }),
            caps("luna", 1, ["chat_completions", "responses"]),
            pick(caps("astra", 32, ["chat_completions", "responses"])),
        ],
        "luna"
    );
    assert.deepEqual(smart.protocols, ["chat_completions", "responses"]);
    assert.deepEqual(smart.creditWeightByProtocol, { chat_completions: 40, responses: 32 }, "routed picks still count toward the most a request costs");
    assert.equal(smart.creditWeight, 40);
    assert.equal(smart.maxOutputTokens, 64_000, "the default model's limit");
    // A default id that names a frontier model is not taken as the default's limit.
    assert.equal(
        smartAdaptiveCapabilities([pick({ ...caps("opus", 40, ["chat_completions"]), maxOutputTokens: 128_000 }), caps("luna", 1, ["chat_completions"])], "opus").maxOutputTokens,
        64_000
    );

    // The native default skips them too, and is null when only they are left.
    assert.equal(nativeSmartAdaptiveDefaultId([pick({ id: "opus", creditWeight: 40 }), pick({ id: "fable", creditWeight: 80 })]), null);
    assert.equal(nativeSmartAdaptiveDefaultId([pick({ id: "opus", creditWeight: 40 }), { id: "sonnet", creditWeight: 16 }, pick({ id: "fable", creditWeight: 80 })]), "sonnet");
    assert.equal(nativeSmartAdaptiveDefaultId([pick({ id: "luna", creditWeight: 1 }), { id: "sol", creditWeight: 16 }], "luna"), "sol", "never the catalogue default if only the router may pick it");
    assert.equal(nativeSmartAdaptiveCapabilities([pick(caps("opus", 40, ["chat_completions", "anthropic_messages"]))]), null);

    // The settings page on the coding catalogue, where a frontier model is nameable: Claude
    // Code lists it by name and no Smart Adaptive; Codex has Smart Adaptive over Luna.
    const offered = [
        { ...smart, id: "smart-adaptive" },
        pick({ ...caps("opus", 40, ["chat_completions", "anthropic_messages"]), maxOutputTokens: 32_000 }),
        caps("luna", 1, ["chat_completions", "responses"]),
        pick(caps("astra", 32, ["chat_completions", "responses"])),
    ];
    const tools = codingToolModels(offered);
    assert.deepEqual(tools.claudeCode.map((entry) => entry.id), ["opus"]);
    assert.equal(tools.codex[0].id, "smart-adaptive");
    assert.equal(tools.codex[0].maxOutputTokens, 64_000, "Luna's output limit, not a frontier model's");
    assert.equal(tools.codex[0].creditWeight, 32);
    assert.equal(tools.cursor[0].id, "smart-adaptive");
});

test("the coding router has its own head and fixed guidance", () => {
    const system = buildAutoLlmRouterSystem(AUTO_LLM_ROUTER_CODING_GUIDANCE, { coding: true });
    assert.match(system, /coding agent/);
    assert.match(system, /Always set requiresFileGeneration to false/);
    assert.doesNotMatch(system, /one chat message/);
    assert.ok(system.includes(AUTO_LLM_ROUTER_CODING_GUIDANCE));
    assert.ok(!system.includes(AUTO_LLM_ROUTER_DEFAULT_GUIDANCE), "the Chat guidance is not in a coding call");
    // Quality first: credits only break ties, and the strongest tiers are named.
    assert.match(AUTO_LLM_ROUTER_CODING_GUIDANCE, /compare credits only between candidates you expect to do the work equally well/);
    assert.match(AUTO_LLM_ROUTER_CODING_GUIDANCE, /frontier/);
    assert.match(AUTO_LLM_ROUTER_CODING_GUIDANCE, /Apex candidates are for the hardest work only/);
    assert.match(AUTO_LLM_ROUTER_CODING_GUIDANCE, /currentModelId/);
    assert.equal(AUTO_LLM_ROUTER_CODING_VERSION, "coding-v1");
    // The Chat prompt is unchanged by the coding head.
    assert.match(AUTO_LLM_ROUTER_SYSTEM, /one chat message/);
});

test("a tool result travels as its bounded end", () => {
    assert.equal(boundedToolResult(null), null);
    assert.equal(boundedToolResult("   "), null);
    assert.equal(boundedToolResult(" ok "), "ok");
    const long = `${"x".repeat(5_000)}FAILED 3 tests`;
    const bounded = boundedToolResult(long);
    assert.ok(bounded.endsWith("FAILED 3 tests"), "the summary printed last is kept");
    assert.ok(bounded.length <= AUTO_LLM_ROUTER_MAX_TOOL_RESULT_CHARS + 10);
    // The cut never leaves half a surrogate pair.
    for (const pad of [0, 1]) {
        const emoji = boundedToolResult("x".repeat(pad) + "😀".repeat(AUTO_LLM_ROUTER_MAX_TOOL_RESULT_CHARS));
        assert.doesNotMatch(emoji.slice(6), /^[\uDC00-\uDFFF]/);
    }
});

const entry = (id, creditWeight) => ({ model: { id }, capabilities: { creditWeight } });

test("within a conversation the model only moves up", () => {
    const luna = entry("luna", 1);
    const sonnet = entry("sonnet", 16);
    const opus = entry("opus", 32);
    assert.deepEqual(escalateOnly(undefined, luna), { entry: luna, held: false }, "nothing to hold");
    assert.deepEqual(escalateOnly(sonnet, luna), { entry: sonnet, held: true }, "a cheaper pick keeps the current model");
    assert.deepEqual(escalateOnly(sonnet, opus), { entry: opus, held: false }, "a stronger pick moves");
    assert.deepEqual(escalateOnly(luna, entry("deepseek", 1)), { entry: entry("deepseek", 1), held: false }, "an equal one may move");
});

test("Chat Completions: one conversation key across rounds, and the coding signals", () => {
    const opening = [
        { role: "system", content: "You are a coding agent." },
        { role: "user", content: "Fix the failing test" },
    ];
    const first = { model: "smart-adaptive", messages: opening };
    const later = {
        model: "smart-adaptive",
        tools: [{ type: "function", function: { name: "run", parameters: {} } }],
        messages: [
            ...opening,
            { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "run", arguments: "{}" } }] },
            { role: "tool", tool_call_id: "c1", content: "Error: expected 2, got 3\n1 failed" },
            { role: "assistant", content: "Still failing." },
            { role: "user", content: "It still does not work" },
        ],
    };
    assert.equal(smartAdaptiveConversationKey("k1", first), smartAdaptiveConversationKey("k1", later));
    assert.notEqual(smartAdaptiveConversationKey("k1", first), smartAdaptiveConversationKey("k2", first), "per key");
    assert.notEqual(
        smartAdaptiveConversationKey("k1", first),
        smartAdaptiveConversationKey("k1", { ...first, messages: [{ role: "user", content: "Another task" }] })
    );
    const coding = smartAdaptiveCodingContext(later, "Cursor/2.1 (Windows)", "sonnet");
    assert.equal(coding.client, "Cursor/2.1 (Windows)");
    assert.equal(coding.toolCount, 1);
    assert.equal(coding.modelTurns, 2);
    assert.ok(coding.inputTokens > 0);
    assert.equal(coding.lastToolResult, "Error: expected 2, got 3\n1 failed");
    assert.equal(coding.currentModelId, "sonnet");
});

test("native: a message the user wrote is told from a tool round by its structure", () => {
    const anthropicUser = { messages: [{ role: "user", content: [{ type: "text", text: "Refactor the parser" }] }] };
    const anthropicTool = {
        tools: [{ name: "bash" }, { name: "edit" }],
        messages: [
            { role: "user", content: "Refactor the parser" },
            { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] },
            {
                role: "user",
                content: [
                    { type: "tool_result", tool_use_id: "t1", content: "TypeError: x is undefined" },
                    { type: "text", text: "<system-reminder>context</system-reminder>" },
                ],
            },
        ],
    };
    assert.equal(nativeUserTurn("anthropic_messages", anthropicUser), true);
    assert.equal(nativeUserTurn("anthropic_messages", anthropicTool), false, "a tool_result with reminder text is a tool round");
    const context = nativeCodingContext(
        "anthropic_messages",
        "claude-cli/2.1.278",
        anthropicTool,
        "claude-sonnet-5-5"
    );
    assert.equal(context.client, "claude-cli/2.1.278");
    assert.equal(context.toolCount, 2);
    assert.equal(context.modelTurns, 1);
    assert.equal(context.lastToolResult, "TypeError: x is undefined");
    assert.equal(context.currentModelId, "claude-sonnet-5-5");

    const responsesUser = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Add tests" }] }] };
    const responsesTool = {
        input: [
            { type: "message", role: "user", content: "Add tests" },
            { type: "function_call", call_id: "f1", name: "shell", arguments: "{}" },
            { type: "function_call_output", call_id: "f1", output: "2 passed, 1 failed" },
        ],
    };
    assert.equal(nativeUserTurn("responses", responsesUser), true);
    assert.equal(nativeUserTurn("responses", { input: "Add tests" }), true, "a string input is the user's");
    assert.equal(nativeUserTurn("responses", responsesTool), false);
    // A blank last message is not answered by an earlier turn's text.
    const blank = { messages: [...anthropicUser.messages, { role: "assistant", content: "ok" }, { role: "user", content: [{ type: "image", source: {} }] }] };
    assert.equal(nativeUserTurn("anthropic_messages", blank), true);
    assert.equal(nativeLastUserText("anthropic_messages", blank), "");
    assert.equal(nativeLastUserText("anthropic_messages", anthropicUser), "Refactor the parser");
    assert.equal(
        nativeCodingContext("responses", null, responsesTool, null).lastToolResult,
        "2 passed, 1 failed"
    );
});

test("the remembered model is checked again when it is written", () => {
    const hour = 60 * 60_000;
    const now = 10 * hour;
    const pinned = { creditWeight: 32, at: now - 1_000 };
    assert.equal(conversationModelMayMove(undefined, 1, now, hour, true), true, "nothing remembered");
    assert.equal(conversationModelMayMove(pinned, 16, now, hour, true), false, "a cheaper model admitted later never lowers it");
    assert.equal(conversationModelMayMove(pinned, 32, now, hour, true), true);
    assert.equal(conversationModelMayMove(pinned, 80, now, hour, true), true);
    assert.equal(conversationModelMayMove({ ...pinned, at: now - 2 * hour }, 1, now, hour, true), true, "an expired one");
    assert.equal(conversationModelMayMove(pinned, 1, now, hour, false), true, "the remembered model no longer fits");
});

test("native: the previous answer is the assistant text before the latest user text", () => {
    assert.equal(
        nativePreviousAnswer("anthropic_messages", {
            messages: [
                { role: "user", content: "Fix it" },
                { role: "assistant", content: [{ type: "text", text: "Fixed the parser." }] },
                { role: "user", content: [{ type: "text", text: "Now the tests" }] },
            ],
        }),
        "Fixed the parser."
    );
    assert.equal(nativePreviousAnswer("anthropic_messages", { messages: [{ role: "user", content: "First" }] }), null);
    assert.equal(
        nativePreviousAnswer("responses", {
            input: [
                { type: "message", role: "user", content: "Add tests" },
                { type: "message", role: "assistant", content: [{ type: "output_text", text: "Added two." }] },
                { type: "message", role: "user", content: [{ type: "input_text", text: "One more" }] },
            ],
        }),
        "Added two."
    );
});
