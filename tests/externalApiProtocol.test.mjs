import assert from "node:assert/strict";
import test from "node:test";
import {
    buildChatCompletion,
    convertChatCompletionRequest,
    createChunkTranslator,
    decodeImageDataUrl,
    parseChatCompletionRequest,
    ProtocolError,
    resolveRequestOptions,
    toOpenAiFinishReason,
    toOpenAiUsage,
} from "../lib/openAiChatProtocol.ts";

const model = { id: "fixture", provider: "openai", vision: true, reasoning: false, maxOutputTokens: 4096 };
const PNG_1x1 =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const rejects = (fn, code) =>
    assert.throws(fn, (error) => error instanceof ProtocolError && error.code === code);

// Shapes recorded from the two clients' request builders (Pi/Aside
// openai-completions and VS Code Custom Endpoint chat-completions), with no
// user code, secrets or real paths.
const asideToolRound = {
    model: "fixture",
    stream: true,
    stream_options: { include_usage: true },
    store: false,
    max_completion_tokens: 2048,
    messages: [
        { role: "developer", content: "You are a coding agent." },
        { role: "user", content: [{ type: "text", text: "Read package.json" }, { type: "image_url", image_url: { url: PNG_1x1 } }] },
        {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"package.json"}' } }],
        },
        { role: "tool", tool_call_id: "call_1", content: '{"name":"fixture"}' },
    ],
    tools: [
        {
            type: "function",
            function: {
                name: "read",
                description: "Read a file",
                parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
            },
        },
    ],
};
const vscodeRequest = {
    model: "fixture",
    messages: [
        { role: "system", content: "You are an AI programming assistant." },
        { role: "user", content: "Run the tests" },
    ],
    stream: true,
    n: 1,
    temperature: 0.1,
    max_tokens: 4096,
    tools: [{ type: "function", function: { name: "run_in_terminal", parameters: { type: "object", properties: {} } } }],
    tool_choice: "auto",
};

test("recorded Aside and VS Code requests parse and convert", () => {
    for (const fixture of [asideToolRound, vscodeRequest]) {
        const parsed = parseChatCompletionRequest(fixture);
        const options = resolveRequestOptions(parsed, model);
        assert.equal(options.stream, true);
        const converted = convertChatCompletionRequest(parsed, model);
        assert.ok(converted.messages.length >= 2);
        assert.equal(converted.tools.length, 1);
    }
    const converted = convertChatCompletionRequest(parseChatCompletionRequest(asideToolRound), model);
    assert.deepEqual(converted.messages.map((m) => m.role), ["system", "user", "assistant", "tool"]);
    assert.equal(converted.messages[1].content[1].type, "file");
    assert.equal(converted.messages[1].content[1].mediaType, "image/png");
    assert.deepEqual(converted.messages[2].content[0], { type: "tool-call", toolCallId: "call_1", toolName: "read", input: { path: "package.json" } });
    assert.equal(converted.messages[3].content[0].toolName, "read");
    assert.equal(converted.images.length, 1);
    // Tool schemas, prior tool calls and tool results all count towards the estimate.
    const segments = converted.textSegments.join("\n");
    for (const needle of ['"path"', "package.json", '{"name":"fixture"}', "Read a file"]) assert.ok(segments.includes(needle), needle);
});

test("unknown parameters are refused by name, never dropped", () => {
    rejects(() => parseChatCompletionRequest({ ...vscodeRequest, logprobs: true }), "unsupported_parameter");
    rejects(() => parseChatCompletionRequest({ ...vscodeRequest, response_format: { type: "json_object" } }), "unsupported_parameter");
    rejects(() => parseChatCompletionRequest({ ...vscodeRequest, api_base: "https://evil.example" }), "unsupported_parameter");
    rejects(() => parseChatCompletionRequest({ model: "x" }), "invalid_request");
});

test("option combinations follow the documented rules", () => {
    const parse = (extra) => parseChatCompletionRequest({ ...vscodeRequest, ...extra });
    rejects(() => resolveRequestOptions(parse({ n: 2 }), model), "unsupported_parameter");
    rejects(() => resolveRequestOptions(parse({ store: true }), model), "unsupported_parameter");
    rejects(() => resolveRequestOptions(parse({ max_tokens: 10, max_completion_tokens: 20 }), model), "conflicting_parameters");
    rejects(() => resolveRequestOptions(parse({ max_tokens: 5000 }), model), "max_tokens_too_large");
    rejects(() => resolveRequestOptions(parse({ reasoning_effort: "high" }), model), "unsupported_parameter");
    rejects(() => resolveRequestOptions(parse({ parallel_tool_calls: false }), model), "unsupported_parameter");
    assert.equal(resolveRequestOptions(parse({ max_completion_tokens: 100, max_tokens: 100 }), model).requestedOutputTokens, 100);
    assert.equal(resolveRequestOptions(parse({ reasoning_effort: "low" }), { ...model, reasoning: true }).stream, true);
    assert.deepEqual(resolveRequestOptions(parse({ stop: "END" }), model).stop, ["END"]);
});

test("images: data URLs only, supported types, size bound, model capability", () => {
    rejects(() => decodeImageDataUrl("https://169.254.169.254/latest/meta-data", "p"), "unsupported_image_url");
    rejects(() => decodeImageDataUrl("file:///etc/passwd", "p"), "unsupported_image_url");
    rejects(() => decodeImageDataUrl("data:image/svg+xml;base64,PHN2Zz4=", "p"), "unsupported_image_type");
    rejects(() => decodeImageDataUrl("data:image/png;base64,", "p"), "invalid_image");
    const big = "data:image/png;base64," + Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64");
    rejects(() => decodeImageDataUrl(big, "p"), "image_too_large");
    assert.equal(decodeImageDataUrl(PNG_1x1, "p").bytes.length > 0, true);
    rejects(
        () => convertChatCompletionRequest(parseChatCompletionRequest(asideToolRound), { vision: false }),
        "model_does_not_support_images"
    );
});

test("tool definitions, choices and results are validated", () => {
    const base = parseChatCompletionRequest(vscodeRequest);
    rejects(() => convertChatCompletionRequest({ ...base, tools: [{ type: "function", function: { name: "bad name" } }] }, model), "invalid_tool");
    rejects(() => convertChatCompletionRequest({ ...base, tools: [...base.tools, ...base.tools] }, model), "invalid_tool");
    rejects(() => convertChatCompletionRequest({ ...base, tool_choice: { type: "function", function: { name: "missing" } } }, model), "invalid_tool_choice");
    rejects(() => convertChatCompletionRequest({ ...base, tools: undefined, tool_choice: "required" }, model), "invalid_tool_choice");
    rejects(
        () => convertChatCompletionRequest({ ...base, messages: [...base.messages, { role: "tool", tool_call_id: "nope", content: "x" }] }, model),
        "invalid_tool_result"
    );
    rejects(
        () =>
            convertChatCompletionRequest(
                { ...base, messages: [...base.messages, { role: "assistant", tool_calls: [{ id: "c", type: "function", function: { name: "run_in_terminal", arguments: "{bad" } }] }] },
                model
            ),
        "invalid_tool_call"
    );
    const choice = convertChatCompletionRequest({ ...base, tool_choice: { type: "function", function: { name: "run_in_terminal" } } }, model);
    assert.deepEqual(choice.toolChoice, { type: "tool", toolName: "run_in_terminal" });
    // Parallel tool results answering one assistant turn become one SDK tool message.
    const parallel = convertChatCompletionRequest(
        {
            ...base,
            messages: [
                ...base.messages,
                {
                    role: "assistant",
                    content: "",
                    tool_calls: [
                        { id: "a", type: "function", function: { name: "run_in_terminal", arguments: "{}" } },
                        { id: "b", type: "function", function: { name: "run_in_terminal", arguments: "" } },
                    ],
                },
                { role: "tool", tool_call_id: "a", content: "1" },
                { role: "tool", tool_call_id: "b", content: [{ type: "text", text: "2" }] },
            ],
        },
        model
    );
    assert.equal(parallel.messages.at(-1).content.length, 2);
});

test("stream translation: role once, tool fragments indexed, final arguments complete", () => {
    const t = createChunkTranslator({ id: "chatcmpl-x", created: 1, model: "fixture" });
    const chunks = [
        ...t.translate({ type: "text-delta", id: "t", text: "Let me look." }),
        ...t.translate({ type: "tool-input-start", id: "call_a", toolName: "read" }),
        ...t.translate({ type: "tool-input-delta", id: "call_a", delta: '{"pa' }),
        ...t.translate({ type: "tool-input-delta", id: "call_a", delta: 'th":"a"}' }),
        ...t.translate({ type: "tool-call", toolCallId: "call_a", toolName: "read", input: { path: "a" } }),
        // A provider that does not stream arguments delivers the whole call at once.
        ...t.translate({ type: "tool-call", toolCallId: "call_b", toolName: "read", input: { path: "b" } }),
        t.finish("tool_calls"),
    ];
    assert.equal(chunks.filter((c) => c.choices[0].delta.role === "assistant").length, 1);
    const fragments = chunks.flatMap((c) => c.choices[0].delta.tool_calls ?? []);
    const byIndex = new Map();
    for (const f of fragments) byIndex.set(f.index, (byIndex.get(f.index) ?? "") + (f.function?.arguments ?? ""));
    assert.deepEqual(JSON.parse(byIndex.get(0)), { path: "a" });
    assert.deepEqual(JSON.parse(byIndex.get(1)), { path: "b" });
    assert.equal(fragments.filter((f) => f.id).length, 2, "id and name only on the first fragment");
    assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
    const collected = t.collected();
    assert.equal(collected.text, "Let me look.");
    assert.deepEqual(collected.toolCalls.map((c) => c.id), ["call_a", "call_b"]);
});

test("tool-only completion has null content and tool_calls finish reason", () => {
    const body = buildChatCompletion({
        id: "chatcmpl-x",
        created: 1,
        model: "fixture",
        text: "",
        reasoning: "",
        toolCalls: [{ id: "c", name: "read", arguments: "{}" }],
        finishReason: toOpenAiFinishReason("tool-calls", true),
        usage: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 4, reasoningTokens: 1 },
    });
    assert.equal(body.choices.length, 1);
    assert.equal(body.choices[0].message.content, null);
    assert.equal(body.choices[0].finish_reason, "tool_calls");
    assert.equal(body.usage.total_tokens, 13);
    assert.equal(body.usage.prompt_tokens_details.cached_tokens, 4);
});

test("missing provider usage is null, never zero", () => {
    assert.equal(toOpenAiUsage(null), null);
    assert.equal(toOpenAiUsage({ inputTokens: 5 }), null);
    assert.equal(toOpenAiFinishReason("length", false), "length");
    assert.equal(toOpenAiFinishReason("other", false), "stop");
    assert.equal(toOpenAiFinishReason("stop", true), "tool_calls");
});
