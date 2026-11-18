import assert from "node:assert/strict";
import test from "node:test";
import {
    createSseParser,
    estimateNativeInput,
    protocolsForProvider,
    publicUpstreamError,
    requestDigestInput,
    upstreamRefusedBeforeWork,
    nativeProtocolEnabled,
} from "../lib/externalApiNativeCore.ts";
import {
    anthropicErrorBody,
    createAnthropicStreamObserver,
    observeAnthropicMessage,
    prepareAnthropicMessages,
    toAnthropicModelList,
} from "../lib/anthropicMessagesProtocol.ts";
import {
    createResponsesStreamObserver,
    observeResponsesJson,
    prepareResponsesRequest,
} from "../lib/openAiResponsesProtocol.ts";

/**
 * The native protocol adapters (docs/policy/external-api.md, "Native
 * protocols"). Fixtures follow the request shapes Claude Code 2.1.278 and
 * Codex 0.146.0 were observed to send on 2026-11-18 -- synthetic content, real
 * structure: beta-paired body fields, mid-conversation system messages,
 * adaptive thinking, client cache markers, Codex's additional_tools item with
 * a freeform grammar tool, encrypted reasoning.
 */

const SONNET = { apiModel: "claude-sonnet-5", maxOutputTokens: 64_000 };
const LUNA = { apiModel: "gpt-5.6-luna", maxOutputTokens: 128_000 };

const sse = (events) => events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");

/** Feeds text through a streaming decoder in fixed-size byte slices. */
const feedBytes = (text, observer, slice = 7) => {
    const bytes = new TextEncoder().encode(text);
    const decoder = new TextDecoder();
    const parser = createSseParser((event) => observer.observe(event));
    for (let i = 0; i < bytes.length; i += slice) parser.push(decoder.decode(bytes.subarray(i, i + slice), { stream: true }));
    parser.push(decoder.decode());
    parser.end();
    return observer.final();
};

const claudeCodeBody = (overrides = {}) => ({
    model: "claude-sonnet-5",
    messages: [
        { role: "user", content: [{ type: "text", text: "Fix the failing test in src/sum.ts" }] },
        { role: "system", content: [{ type: "text", text: "effort note", cache_control: { type: "ephemeral" } }] },
    ],
    system: [
        { type: "text", text: "x-anthropic-billing-header: synthetic" },
        { type: "text", text: "You are a coding agent.", cache_control: { type: "ephemeral" } },
    ],
    tools: [
        {
            name: "Read",
            description: "Read a file",
            input_schema: { type: "object", properties: { source: { type: "string" }, file_id: { type: "string" } } },
        },
        { type: "bash_20250124", name: "bash" },
    ],
    metadata: { user_id: "{\"session_id\":\"synthetic\"}" },
    max_tokens: 64_000,
    thinking: { type: "adaptive", display: "omitted" },
    context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
    output_config: { effort: "high" },
    stream: true,
    ...overrides,
});

test("SSE parser survives byte splits, CRLF, comments and multi-line data", () => {
    const seen = [];
    const parser = createSseParser((event) => seen.push(event));
    const text = ": keepalive\r\nevent: a\r\ndata: {\"x\":\r\ndata: 1}\r\n\r\nevent: b\ndata: 한국어 ✓\n\n";
    for (const char of text) parser.push(char);
    parser.end();
    assert.deepEqual(seen, [
        { event: "a", data: "{\"x\":\n1}" },
        { event: "b", data: "한국어 ✓" },
    ]);
});

test("Anthropic: the client body passes through; only model and max_tokens change", () => {
    const body = claudeCodeBody({ max_tokens: 200_000 });
    const prepared = prepareAnthropicMessages(body, { apiModel: "claude-opus-5", maxOutputTokens: 64_000 });
    const sent = JSON.parse(prepared.upstreamBody);
    assert.equal(sent.model, "claude-opus-5");
    assert.equal(sent.max_tokens, 64_000);
    assert.equal(prepared.outputLimit, 64_000);
    assert.equal(prepared.outputLimitClamped, true);
    // Beta-paired fields, system blocks in order, mid-conversation system
    // message and metadata are untouched.
    for (const field of ["messages", "system", "tools", "thinking", "context_management", "output_config", "metadata"]) {
        assert.deepEqual(sent[field], body[field], field);
    }
    assert.equal(prepared.hasCacheMarker, true);
    assert.equal(prepared.stream, true);
    // A request within the limit keeps its own number.
    assert.equal(prepareAnthropicMessages(claudeCodeBody({ max_tokens: 1_000 }), SONNET).outputLimit, 1_000);
});

test("Anthropic: signatures and redacted thinking are passed through byte-identical", () => {
    const history = [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
            role: "assistant",
            content: [
                { type: "thinking", thinking: "plan", signature: "EqQBCkgIARABGAIiQK+/sig==" },
                { type: "redacted_thinking", data: "EmwKAhgBEgy3opaque" },
                { type: "tool_use", id: "toolu_01", name: "Read", input: { source: { type: "url" }, file_id: "abc" } },
            ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: [{ type: "text", text: "ok" }] }] },
    ];
    const prepared = prepareAnthropicMessages(claudeCodeBody({ messages: history }), SONNET);
    assert.deepEqual(JSON.parse(prepared.upstreamBody).messages, history);
});

test("Anthropic: provider-run tools, remote content, 1h cache and fast mode are refused before dispatch", () => {
    const refusal = (body) => {
        try {
            prepareAnthropicMessages(body, SONNET);
        } catch (error) {
            return error.code;
        }
        return null;
    };
    assert.equal(refusal(claudeCodeBody({ tools: [{ type: "web_search_20250305", name: "web_search" }] })), "server_tool_unsupported");
    assert.equal(refusal(claudeCodeBody({ tools: [{ type: "code_execution_20250825", name: "code_execution" }] })), "server_tool_unsupported");
    assert.equal(refusal(claudeCodeBody({ mcp_servers: [{ type: "url", url: "https://example.test" }] })), "unsupported_feature");
    assert.equal(refusal(claudeCodeBody({ speed: "fast" })), "unsupported_feature");
    const image = (source) => claudeCodeBody({ messages: [{ role: "user", content: [{ type: "image", source }] }] });
    assert.equal(refusal(image({ type: "url", url: "http://169.254.169.254/" })), "remote_content_unsupported");
    assert.equal(refusal(image({ type: "file", file_id: "file_1" })), "remote_content_unsupported");
    assert.equal(refusal(image({ type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" })), null);
    const nested = claudeCodeBody({
        messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "image", source: { type: "url", url: "https://x.test/a.png" } }] }] }],
    });
    assert.equal(refusal(nested), "remote_content_unsupported");
    const hour = claudeCodeBody({ system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } }] });
    assert.equal(refusal(hour), "unsupported_cache_ttl");
    assert.equal(refusal(claudeCodeBody({ system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "5m" } }] })), null);
    assert.equal(refusal(claudeCodeBody({ thinking: { type: "enabled", budget_tokens: 70_000 }, max_tokens: 80_000 })), "invalid_request");
    assert.equal(refusal(claudeCodeBody({ max_tokens: undefined })), "invalid_request");
    // A tool schema property or a past tool call's arguments named like a
    // source or file id are the client's data, not content to refuse.
    assert.equal(refusal(claudeCodeBody()), null);
});

test("Anthropic: a request without markers reserves no cache premium", () => {
    const body = claudeCodeBody({
        system: [{ type: "text", text: "plain" }],
        messages: [{ role: "user", content: "hello" }],
    });
    assert.equal(prepareAnthropicMessages(body, SONNET).hasCacheMarker, false);
    assert.equal(prepareAnthropicMessages(claudeCodeBody({ cache_control: { type: "ephemeral" }, system: undefined, messages: [{ role: "user", content: "x" }] }), SONNET).hasCacheMarker, true);
});

const anthropicStream = (usageStart, usageDelta, { stop = true } = {}) =>
    sse([
        ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], usage: usageStart } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }],
        ["ping", { type: "ping" }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "생각 중" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "EqQBsig" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "Edit", input: {} } }],
        ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":\"src/" } }],
        ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "sum.ts\"}" } }],
        ["content_block_stop", { type: "content_block_stop", index: 1 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: usageDelta }],
        ...(stop ? [["message_stop", { type: "message_stop" }]] : []),
    ]);

test("Anthropic stream: cumulative usage with cache read and write, tool-only and thinking output", () => {
    const text = anthropicStream(
        { input_tokens: 100, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 2_000, output_tokens: 1 },
        { output_tokens: 340 }
    );
    for (const slice of [1, 3, 64]) {
        const final = feedBytes(text, createAnthropicStreamObserver(), slice);
        assert.equal(final.terminal, true);
        assert.equal(final.finishReason, "tool_use");
        assert.equal(final.outputItems, 2);
        // Cumulative: the delta's output replaces the start's 1, never adds.
        assert.deepEqual(final.usage, {
            inputTokens: 7_100,
            cachedInputTokens: 5_000,
            cacheWriteInputTokens: 2_000,
            outputTokens: 340,
        });
        assert.equal(final.providerResponseId, "msg_1");
        assert.ok(final.producedBytes > 0);
    }
    // A later delta that repeats input figures replaces them as well.
    const repeated = feedBytes(
        anthropicStream({ input_tokens: 10, output_tokens: 1 }, { input_tokens: 12, cache_read_input_tokens: 3, output_tokens: 9 }),
        createAnthropicStreamObserver()
    );
    assert.deepEqual(repeated.usage, { inputTokens: 15, cachedInputTokens: 3, cacheWriteInputTokens: 0, outputTokens: 9 });
});

test("Anthropic stream: a cut-off stream is not terminal; an error event is a provider error", () => {
    const cut = feedBytes(anthropicStream({ input_tokens: 10, output_tokens: 1 }, { output_tokens: 5 }, { stop: false }), createAnthropicStreamObserver());
    assert.equal(cut.terminal, false);
    const early = sse([
        ["message_start", { type: "message_start", message: { id: "m", usage: { input_tokens: 10, output_tokens: 1 } } }],
        ["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }],
    ]);
    const failed = feedBytes(early, createAnthropicStreamObserver());
    assert.equal(failed.providerError, true);
    assert.equal(failed.usage, null, "no message_delta: usage is not final");
});

test("Anthropic non-streaming message and model list", () => {
    const observed = observeAnthropicMessage({
        id: "msg_2",
        type: "message",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 20, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, output_tokens: 4 },
    });
    assert.equal(observed.terminal, true);
    assert.deepEqual(observed.usage, { inputTokens: 30, cachedInputTokens: 10, cacheWriteInputTokens: 0, outputTokens: 4 });
    const list = toAnthropicModelList([{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }]);
    assert.equal(list.data[0].type, "model");
    assert.equal(list.first_id, "claude-sonnet-5");
    assert.equal(list.has_more, false);
    assert.deepEqual(anthropicErrorBody(429, "slow down", "key_credit_cap_reached").error, { type: "rate_limit_error", message: "slow down" });
});

const codexBody = (overrides = {}) => ({
    model: "gpt-5.6-luna",
    input: [
        {
            type: "additional_tools",
            role: "developer",
            tools: [
                { type: "custom", name: "exec", description: "freeform", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } },
                { type: "function", name: "wait", parameters: { type: "object", properties: {} } },
            ],
        },
        { type: "message", role: "developer", content: [{ type: "input_text", text: "You are Codex." }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the test" }] },
        { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAAAABpZ0encrypted+/=" },
        { type: "custom_tool_call", call_id: "call_1", name: "exec", input: "*** Begin Patch\n*** End Patch" },
        { type: "custom_tool_call_output", call_id: "call_1", output: "Done!" },
    ],
    tools: [{ type: "function", name: "shell_command", parameters: { type: "object", properties: {} } }],
    tool_choice: "auto",
    parallel_tool_calls: false,
    reasoning: { effort: "medium", context: "all_turns" },
    store: true,
    stream: true,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "thread-1",
    text: { verbosity: "low" },
    client_metadata: { thread_id: "thread-1" },
    ...overrides,
});

test("Responses: store is forced off, the output limit is explicit, everything else passes", () => {
    const body = codexBody();
    const prepared = prepareResponsesRequest(body, { apiModel: "gpt-5.6-luna", maxOutputTokens: 128_000 });
    const sent = JSON.parse(prepared.upstreamBody);
    assert.equal(sent.store, false);
    assert.equal(sent.max_output_tokens, 128_000, "no client limit: the model's, reserved in full");
    assert.equal(prepared.outputLimitClamped, false);
    for (const field of ["input", "tools", "reasoning", "include", "prompt_cache_key", "text", "client_metadata", "parallel_tool_calls"]) {
        assert.deepEqual(sent[field], body[field], field);
    }
    const capped = prepareResponsesRequest(codexBody({ max_output_tokens: 500_000 }), LUNA);
    assert.equal(capped.outputLimit, 128_000);
    assert.equal(capped.outputLimitClamped, true);
});

test("Responses: stateful, hosted-tool and remote-content requests are refused before dispatch", () => {
    const refusal = (body) => {
        try {
            prepareResponsesRequest(body, LUNA);
        } catch (error) {
            return error.code;
        }
        return null;
    };
    assert.equal(refusal(codexBody({ previous_response_id: "resp_1" })), "stateful_request_unsupported");
    assert.equal(refusal(codexBody({ conversation: "conv_1" })), "stateful_request_unsupported");
    assert.equal(refusal(codexBody({ background: true })), "stateful_request_unsupported");
    assert.equal(refusal(codexBody({ service_tier: "priority" })), "unsupported_feature");
    assert.equal(refusal(codexBody({ tools: [{ type: "web_search" }] })), "hosted_tool_unsupported");
    assert.equal(refusal(codexBody({ tools: [{ type: "mcp", server_url: "https://x.test" }] })), "hosted_tool_unsupported");
    assert.equal(
        refusal(codexBody({ tools: [{ type: "namespace", name: "multi_agent_v1", tools: [{ type: "image_generation" }] }] })),
        "hosted_tool_unsupported"
    );
    assert.equal(refusal(codexBody({ tools: [{ type: "namespace", name: "ns", tools: [{ type: "function", name: "f" }] }] })), null);
    const withPart = (part) => codexBody({ input: [{ type: "message", role: "user", content: [part] }] });
    assert.equal(refusal(withPart({ type: "input_image", image_url: "https://x.test/a.png" })), "remote_content_unsupported");
    assert.equal(refusal(withPart({ type: "input_image", file_id: "file_1" })), "remote_content_unsupported");
    assert.equal(refusal(withPart({ type: "input_file", file_url: "https://x.test/a.pdf" })), "remote_content_unsupported");
    assert.equal(refusal(withPart({ type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" })), null);
    assert.equal(refusal(codexBody({ input: [{ type: "item_reference", id: "msg_1" }] })), "stateful_request_unsupported");
    const hostedInAdditional = codexBody({ input: [{ type: "additional_tools", tools: [{ type: "web_search" }] }] });
    assert.equal(refusal(hostedInAdditional), "hosted_tool_unsupported");
    assert.equal(refusal(codexBody({ max_output_tokens: 0 })), "invalid_request");
});

test("Responses stream: freeform tool input, reasoning, terminal usage", () => {
    const text = sse([
        ["response.created", { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } }],
        ["response.output_item.added", { type: "response.output_item.added", item: { type: "reasoning", id: "rs_2" } }],
        ["response.output_item.done", { type: "response.output_item.done", item: { type: "reasoning", id: "rs_2", encrypted_content: "gAAA" } }],
        ["response.output_item.added", { type: "response.output_item.added", item: { type: "custom_tool_call", call_id: "c2", name: "exec" } }],
        ["response.custom_tool_call_input.delta", { type: "response.custom_tool_call_input.delta", delta: "*** Begin Patch\n*** Update File: src/sum.ts\n" }],
        ["response.custom_tool_call_input.delta", { type: "response.custom_tool_call_input.delta", delta: "-a - b\n+a + b\n*** End Patch" }],
        [
            "response.completed",
            {
                type: "response.completed",
                response: {
                    id: "resp_1",
                    status: "completed",
                    output: [{}, {}],
                    usage: { input_tokens: 9_000, input_tokens_details: { cached_tokens: 8_192 }, output_tokens: 700, output_tokens_details: { reasoning_tokens: 512 } },
                },
            },
        ],
    ]);
    for (const slice of [1, 5, 4096]) {
        const final = feedBytes(text, createResponsesStreamObserver(), slice);
        assert.equal(final.terminal, true);
        assert.equal(final.providerError, false);
        assert.equal(final.finishReason, "completed");
        assert.deepEqual(final.usage, { inputTokens: 9_000, cachedInputTokens: 8_192, cacheWriteInputTokens: 0, outputTokens: 700, reasoningTokens: 512 });
        assert.ok(final.producedBytes > 40);
        assert.equal(final.outputItems, 2);
    }
});

test("Responses stream: incomplete is terminal, failed is a provider error, a cut stream is neither", () => {
    const incomplete = feedBytes(
        sse([["response.incomplete", { type: "response.incomplete", response: { id: "r", status: "incomplete", usage: { input_tokens: 5, output_tokens: 9 } } }]]),
        createResponsesStreamObserver()
    );
    assert.equal(incomplete.terminal, true);
    assert.equal(incomplete.finishReason, "incomplete");
    const failed = feedBytes(
        sse([["response.failed", { type: "response.failed", response: { id: "r", status: "failed", usage: { input_tokens: 5, output_tokens: 0 } } }]]),
        createResponsesStreamObserver()
    );
    assert.equal(failed.providerError, true);
    assert.equal(failed.terminal, false);
    const cut = feedBytes(
        sse([["response.output_text.delta", { type: "response.output_text.delta", delta: "partial" }]]),
        createResponsesStreamObserver()
    );
    assert.equal(cut.terminal, false);
    assert.equal(cut.usage, null);
    assert.equal(cut.producedBytes, 7);
    const json = observeResponsesJson({ id: "r", status: "completed", output: [{ type: "function_call", arguments: "{}" }], usage: { input_tokens: 3, output_tokens: 2 } });
    assert.equal(json.terminal, true);
    assert.equal(json.usage.inputTokens, 3);
});

test("input estimate: images by size, opaque state by length, schemas by their keys", () => {
    // A 1x1 PNG.
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const withImage = estimateNativeInput({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png } }] }] }, "anthropic");
    assert.equal(withImage.images, 1);
    assert.ok(withImage.reservationOnlyInputTokens > 0, "the rest of the flat image allowance is reserved");
    assert.ok(withImage.breakdown.rawTotal < 2_000, "the base64 text is not counted as prose");
    const signature = "s".repeat(40_000);
    const opaque = estimateNativeInput({ content: [{ type: "thinking", thinking: "", signature }] }, "anthropic");
    assert.ok(opaque.breakdown.rawTotal >= 10_000, "opaque state counts at bytes/4");
    const encrypted = estimateNativeInput({ input: [{ type: "reasoning", encrypted_content: "e".repeat(8_000) }] }, "openai");
    assert.ok(encrypted.breakdown.rawTotal >= 2_000);
    const schema = estimateNativeInput({ tools: [{ name: "t", input_schema: { type: "object", properties: { aVeryLongPropertyName: {}, anotherLongProperty: {} } } }] }, "anthropic");
    assert.ok(schema.breakdown.rawTotal > 10, "property names are keys and still count");
    const dataUrl = estimateNativeInput({ input: [{ type: "message", content: [{ type: "input_image", image_url: `data:image/png;base64,${png}` }] }] }, "openai");
    assert.equal(dataUrl.images, 1);
});

test("upstream errors: the client's own 400 is kept, account detail never is", () => {
    assert.deepEqual(publicUpstreamError(400, "messages.1.content.0.thinking.signature: Invalid signature"), {
        status: 400,
        message: "messages.1.content.0.thinking.signature: Invalid signature",
        kind: "invalid_request",
    });
    assert.doesNotMatch(publicUpstreamError(400, "Your credit balance is too low to access the Anthropic API.").message, /credit|balance/i);
    assert.equal(publicUpstreamError(429, "Number of request tokens has exceeded your per-minute rate limit (org_123)").status, 529);
    assert.doesNotMatch(publicUpstreamError(429, "org_123 rate limit").message, /org_/);
    assert.equal(publicUpstreamError(503, "x").status, 529);
    assert.equal(publicUpstreamError(408, "x").status, 504);
    assert.equal(upstreamRefusedBeforeWork(400), true);
    assert.equal(upstreamRefusedBeforeWork(429), true);
    assert.equal(upstreamRefusedBeforeWork(408), false);
    assert.equal(upstreamRefusedBeforeWork(529), false);
});

test("protocol metadata: digests, providers and switches", () => {
    assert.equal(requestDigestInput("chat_completions", "{}"), "{}", "Chat receipts keep their digest");
    assert.notEqual(requestDigestInput("responses", "{}"), requestDigestInput("anthropic_messages", "{}"));
    assert.notEqual(requestDigestInput("responses", "{}"), "{}");
    assert.deepEqual(protocolsForProvider("anthropic"), ["chat_completions", "anthropic_messages"]);
    assert.deepEqual(protocolsForProvider("openai"), ["chat_completions", "responses"]);
    assert.deepEqual(protocolsForProvider("deepseek"), ["chat_completions"]);
    assert.equal(nativeProtocolEnabled({}, "anthropic_messages"), false, "default off");
    assert.equal(nativeProtocolEnabled({ EXTERNAL_API_ANTHROPIC_ENABLED: "true" }, "anthropic_messages"), true);
    assert.equal(nativeProtocolEnabled({ EXTERNAL_API_ANTHROPIC_ENABLED: "true" }, "responses"), false);
    assert.equal(nativeProtocolEnabled({ EXTERNAL_API_RESPONSES_ENABLED: "true" }, "responses"), true);
});
