import assert from "node:assert/strict";
import test from "node:test";
import { generateText, jsonSchema, tool } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";

import { AVAILABLE_MODELS } from "../lib/models.ts";
import { createChatBudget } from "../lib/chatSecurity.ts";
import { getModelGenerationSettings } from "../lib/modelGenerationCompatibility.ts";
import {
    convertChatCompletionRequest,
    parseChatCompletionRequest,
} from "../lib/openAiChatProtocol.ts";

/**
 * OpenAI Chat Completions has no cache marker, so an Anthropic-routed request
 * from Cursor, VS Code or JetBrains was billed fully uncached on every round.
 * These tests drive the same conversion and settings lib/externalApiInference.ts
 * uses through the real Anthropic SDK, and read the request bytes it sends.
 */

const PATH = "external_api_chat_completions";

const modelOf = (id) => {
    const found = AVAILABLE_MODELS.find((candidate) => candidate.id === id);
    assert.ok(found, `${id} is in the registry`);
    return found;
};

const viewOf = (model) => ({
    id: model.id,
    provider: model.provider,
    vision: true,
    reasoning: Boolean(model.reasoning),
    maxOutputTokens: 4096,
});

// A VS Code Custom Endpoint shape: the client resends system, tools and the
// whole history on every round, because the API is stateless.
const SYSTEM = "You are an AI programming assistant. ".repeat(40);
const TOOLS = [
    {
        type: "function",
        function: {
            name: "run_in_terminal",
            description: "Run a command",
            parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
        },
    },
];
const round1 = {
    model: "fixture",
    stream: false,
    messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: "Run the tests" },
    ],
    tools: TOOLS,
};
const round2 = {
    ...round1,
    messages: [
        ...round1.messages,
        { role: "assistant", content: "The tests pass." },
        { role: "user", content: "Now run the linter" },
    ],
};

const dispatch = async (model, body) => {
    const sent = [];
    const provider = createAnthropic({
        apiKey: "isolated-wire-fixture",
        fetch: async (_url, init) => {
            sent.push(JSON.parse(init.body));
            return Response.json({
                id: "msg_fixture",
                type: "message",
                role: "assistant",
                model: model.apiModel,
                content: [{ type: "text", text: "ok" }],
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: { input_tokens: 20, output_tokens: 1 },
            });
        },
    });
    const converted = convertChatCompletionRequest(parseChatCompletionRequest(body), viewOf(model));
    const settings = getModelGenerationSettings(model, { promptCachePath: PATH });
    const tools = Object.fromEntries(
        converted.tools.map((definition) => [
            definition.name,
            tool({ description: definition.description, inputSchema: jsonSchema(definition.parameters) }),
        ])
    );
    await generateText({
        model: provider(model.apiModel),
        messages: converted.messages,
        ...(converted.tools.length ? { tools } : {}),
        ...(settings.providerOptions ? { providerOptions: settings.providerOptions } : {}),
        maxOutputTokens: 16,
        maxRetries: 0,
        allowSystemInMessages: true,
    });
    assert.equal(sent.length, 1);
    return sent[0];
};

const withoutMarkers = (value) =>
    JSON.parse(JSON.stringify(value, (key, item) => (key === "cache_control" ? undefined : item)));

test("an Anthropic-routed Chat Completions request carries the 5-minute marker", async () => {
    const model = modelOf("claude-sonnet-5");
    const body = await dispatch(model, round1);
    assert.match(JSON.stringify(body), /"cache_control":\{"type":"ephemeral","ttl":"5m"\}/);
});

test("consecutive rounds send the same prefix, so round 2 can read round 1's entry", async () => {
    const model = modelOf("claude-sonnet-5");
    const first = withoutMarkers(await dispatch(model, round1));
    const second = withoutMarkers(await dispatch(model, round2));
    assert.deepEqual(second.tools, first.tools);
    assert.deepEqual(second.system, first.system);
    assert.deepEqual(
        second.messages.slice(0, first.messages.length),
        first.messages,
        "round 2 starts with round 1's messages byte for byte"
    );
});

test("the marker is merged beside a reasoning model's own Anthropic options", () => {
    // A shallow spread would replace thinking/effort with cacheControl and the
    // model would silently stop reasoning.
    const model = modelOf("claude-fable-5");
    const plain = getModelGenerationSettings(model, {}).providerOptions?.anthropic ?? {};
    const cached = getModelGenerationSettings(model, { promptCachePath: PATH }).providerOptions?.anthropic ?? {};
    assert.deepEqual(cached.cacheControl, { type: "ephemeral", ttl: "5m" });
    for (const [key, value] of Object.entries(plain)) {
        assert.deepEqual(cached[key], value, `${key} survives the cache marker`);
    }
});

test("the budget reserves the write premium exactly where the marker is sent", () => {
    for (const model of AVAILABLE_MODELS.filter((candidate) => candidate.enabled)) {
        let budget;
        try {
            budget = createChatBudget("user", model, 20_000, { promptCachePath: PATH });
        } catch {
            continue;
        }
        const marker = Boolean(
            getModelGenerationSettings(model, { promptCachePath: PATH }).providerOptions?.anthropic?.cacheControl
        );
        assert.equal(marker, model.provider === "anthropic", `${model.id}: marker only on Anthropic`);
        assert.equal(
            budget.promptCacheWriteReservedPremiumMicroUsd > 0,
            marker,
            `${model.id}: premium reserved exactly when the marker is sent`
        );
    }
});

test("a client cache_control field is still refused on this format", () => {
    // Tomverse decides the marker here; the client cannot add a second one.
    assert.throws(
        () =>
            parseChatCompletionRequest({
                ...round1,
                messages: [{ role: "user", content: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] }],
            }),
        (error) => error.code === "unsupported_parameter"
    );
});
