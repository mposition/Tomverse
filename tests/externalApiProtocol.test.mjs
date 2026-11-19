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

test("nested unknown fields are refused too", () => {
    const withPart = (part) => ({ ...vscodeRequest, messages: [{ role: "user", content: [part] }] });
    rejects(() => parseChatCompletionRequest(withPart({ type: "text", text: "x", cache_control: { type: "ephemeral" } })), "unsupported_parameter");
    rejects(() => parseChatCompletionRequest(withPart({ type: "image_url", image_url: { url: PNG_1x1, fetch: true } })), "unsupported_parameter");
    rejects(() => parseChatCompletionRequest({ ...vscodeRequest, stream_options: { include_usage: true, include_obfuscation: true } }), "unsupported_parameter");
    assert.ok(parseChatCompletionRequest(withPart({ type: "image_url", image_url: { url: PNG_1x1, detail: "low" } })));
    const withMessage = (extra) => ({ ...vscodeRequest, messages: [...vscodeRequest.messages, extra] });
    rejects(() => parseChatCompletionRequest(withMessage({ role: "assistant", content: "x", audio: { id: "a" } })), "unsupported_parameter");
    rejects(() => parseChatCompletionRequest(withMessage({ role: "tool", tool_call_id: "c", content: "x", cache_control: { type: "ephemeral" } })), "unsupported_parameter");
    // Participant names would be dropped by every provider here, so they are refused on every role but
    // tool, whose name is the tool's (Cursor sends it) and is already known from tool_call_id.
    for (const role of ["system", "developer", "user", "assistant"]) {
        rejects(() => parseChatCompletionRequest(withMessage({ role, content: "x", name: "alice" })), "unsupported_parameter");
    }
    rejects(
        () => parseChatCompletionRequest(withMessage({ role: "assistant", tool_calls: [{ id: "c", type: "function", function: { name: "read", arguments: "{}", extra: 1 } }] })),
        "unsupported_parameter"
    );
    rejects(
        () => parseChatCompletionRequest({ ...vscodeRequest, tools: [{ type: "function", function: { name: "read", parameters: {}, examples: [] } }] }),
        "unsupported_parameter"
    );
    rejects(
        () => parseChatCompletionRequest({ ...vscodeRequest, tool_choice: { type: "function", function: { name: "run_in_terminal", args: {} } } }),
        "unsupported_parameter"
    );
});

test("strict tools are forwarded where the provider honours them and refused elsewhere", () => {
    const strictTools = { ...vscodeRequest, tools: [{ type: "function", function: { name: "run_in_terminal", strict: true, parameters: { type: "object", properties: {} } } }] };
    const parsed = parseChatCompletionRequest(strictTools);
    assert.equal(convertChatCompletionRequest(parsed, model).tools[0].strict, true);
    rejects(() => convertChatCompletionRequest(parsed, { ...model, provider: "anthropic" }), "unsupported_parameter");
    // Provider ids as the model registry spells them (lib/models.ts).
    assert.equal(convertChatCompletionRequest(parsed, { ...model, provider: "moonshot" }).tools[0].strict, true);
    assert.equal(convertChatCompletionRequest(parsed, { ...model, provider: "mistral" }).tools[0].strict, true);
    rejects(() => convertChatCompletionRequest(parsed, { vision: true }), "unsupported_parameter");
    const relaxed = parseChatCompletionRequest({ ...strictTools, tools: [{ ...strictTools.tools[0], function: { ...strictTools.tools[0].function, strict: false } }] });
    assert.equal(convertChatCompletionRequest(relaxed, { ...model, provider: "anthropic" }).tools[0].strict, false);
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

test("image detail is forwarded to OpenAI and refused where it would be dropped", () => {
    const withDetail = (detail) =>
        parseChatCompletionRequest({ ...vscodeRequest, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: PNG_1x1, detail } }] }] });
    const low = convertChatCompletionRequest(withDetail("low"), model).messages[0].content[0];
    assert.deepEqual(low.providerOptions, { openai: { imageDetail: "low" } });
    rejects(() => convertChatCompletionRequest(withDetail("high"), { ...model, provider: "anthropic" }), "unsupported_parameter");
    assert.equal(convertChatCompletionRequest(withDetail("auto"), { ...model, provider: "anthropic" }).messages[0].content[0].providerOptions, undefined);
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
    assert.deepEqual(collected.toolCalls.map((c) => c.complete), [true, true]);
    const cut = createChunkTranslator({ id: "x", created: 1, model: "m" });
    cut.translate({ type: "tool-input-start", id: "c", toolName: "write" });
    assert.equal(cut.collected().toolCalls[0].complete, false);
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
    assert.equal(toOpenAiFinishReason("length", true), "length", "truncation wins over started tool calls");
    assert.equal(toOpenAiFinishReason("content-filter", true), "content_filter");
    assert.equal(toOpenAiFinishReason("tool-calls", false), "tool_calls");
    assert.equal(toOpenAiFinishReason("content-filter", false), "content_filter");
});

test("a model takes a request's optional features by the rules the request is validated with", async () => {
    const { modelTakesRequestFeatures } = await import("../lib/openAiChatProtocol.ts");
    const openai = { id: "o", provider: "openai", vision: true, reasoning: true, maxOutputTokens: 1000 };
    const deepseek = { id: "d", provider: "deepseek", vision: false, reasoning: true, maxOutputTokens: 1000 };
    const plain = parseChatCompletionRequest({ model: "smart-adaptive", messages: [{ role: "user", content: "hi" }] });
    assert.equal(modelTakesRequestFeatures(plain, deepseek), true);
    const strict = parseChatCompletionRequest({ model: "smart-adaptive", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "t", strict: true, parameters: { type: "object", properties: {} } } }] });
    assert.equal(modelTakesRequestFeatures(strict, openai), true);
    assert.equal(modelTakesRequestFeatures(strict, deepseek), false);
    const effort = parseChatCompletionRequest({ model: "smart-adaptive", reasoning_effort: "low", messages: [{ role: "user", content: "hi" }] });
    assert.equal(modelTakesRequestFeatures(effort, openai), true);
    assert.equal(modelTakesRequestFeatures(effort, deepseek), false);
    const detail = parseChatCompletionRequest({ model: "smart-adaptive", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==", detail: "high" } }] }] });
    assert.equal(modelTakesRequestFeatures(detail, openai), true);
    assert.equal(modelTakesRequestFeatures(detail, { ...openai, provider: "anthropic" }), false);
});

// Cursor's GPT-5 Agent declares its patch tool as an OpenAI custom tool
// (free-form input) beside ordinary function tools. Shape per the Chat
// Completions reference, with no real tool text.
const cursorCustomToolRound = {
    model: "fixture",
    stream: true,
    messages: [
        { role: "system", content: "You are a coding agent." },
        { role: "user", content: "Fix sum.js" },
        {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_patch", type: "custom", custom: { name: "apply_patch", input: "*** Begin Patch\n*** End Patch" } }],
        },
        { role: "tool", tool_call_id: "call_patch", content: "Done" },
    ],
    tools: [
        { type: "function", function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } } },
        {
            type: "custom",
            custom: {
                name: "apply_patch",
                description: "Apply a patch.",
                format: { type: "grammar", grammar: { syntax: "lark", definition: "start: \"*** Begin Patch\"" } },
            },
        },
        { type: "custom", custom: { name: "note", format: { type: "text" } } },
    ],
    tool_choice: "auto",
};

test("custom tools reach the model as one-string functions and their history converts", () => {
    const converted = convertChatCompletionRequest(parseChatCompletionRequest(cursorCustomToolRound), model);
    assert.deepEqual([...converted.customTools], ["apply_patch", "note"]);
    const patch = converted.tools.find((tool) => tool.name === "apply_patch");
    assert.deepEqual(patch.parameters.required, ["input"]);
    assert.equal(patch.parameters.properties.input.type, "string");
    assert.match(patch.description, /Apply a patch\./);
    assert.match(patch.description, /lark grammar/);
    assert.equal(converted.tools.find((tool) => tool.name === "note").description, undefined);
    const assistant = converted.messages.find((entry) => entry.role === "assistant");
    assert.deepEqual(assistant.content[0], {
        type: "tool-call",
        toolCallId: "call_patch",
        toolName: "apply_patch",
        input: { input: "*** Begin Patch\n*** End Patch" },
    });
    const toolResult = converted.messages.find((entry) => entry.role === "tool");
    assert.equal(toolResult.content[0].toolName, "apply_patch");
    // A custom tool_choice names a declared custom tool.
    const choice = convertChatCompletionRequest(
        parseChatCompletionRequest({ ...cursorCustomToolRound, tool_choice: { type: "custom", custom: { name: "apply_patch" } } }),
        model
    );
    assert.deepEqual(choice.toolChoice, { type: "tool", toolName: "apply_patch" });
    // Unknown custom fields and formats are still refused by name.
    rejects(
        () => parseChatCompletionRequest({ ...cursorCustomToolRound, tools: [{ type: "custom", custom: { name: "x", extra: 1 } }] }),
        "unsupported_parameter"
    );
});

test("a custom tool's call goes back in function form carrying the raw input", () => {
    const translator = createChunkTranslator({ id: "chatcmpl-x", created: 1, model: "fixture" }, new Set(["apply_patch"]));
    const chunks = [
        ...translator.translate({ type: "tool-input-start", id: "c1", toolName: "apply_patch" }),
        ...translator.translate({ type: "tool-input-delta", id: "c1", delta: '{"input":"*** Begin' }),
        ...translator.translate({ type: "tool-input-delta", id: "c1", delta: ' Patch"}' }),
        ...translator.translate({ type: "tool-call", toolCallId: "c1", toolName: "apply_patch", input: { input: "*** Begin Patch" } }),
        ...translator.translate({ type: "tool-call", toolCallId: "c2", toolName: "read_file", input: { path: "a" } }),
    ];
    const calls = chunks.flatMap((chunk) => chunk.choices[0].delta.tool_calls ?? []);
    // Function form, as Cursor's Agent reads it: `arguments` is the raw input.
    assert.deepEqual(calls[0], { index: 0, id: "c1", type: "function", function: { name: "apply_patch", arguments: "" } });
    // The JSON fragments are held back; the decoded input arrives once.
    assert.deepEqual(calls[1], { index: 0, function: { arguments: "*** Begin Patch" } });
    assert.equal(calls[2].type, "function");
    assert.equal(calls.filter((call) => call.index === 0).length, 2);
    const collected = translator.collected();
    assert.deepEqual(
        collected.toolCalls.map(({ id, name, arguments: text }) => ({ id, name, text })),
        [
            { id: "c1", name: "apply_patch", text: "*** Begin Patch" },
            { id: "c2", name: "read_file", text: '{"path":"a"}' },
        ]
    );
    const completion = buildChatCompletion({
        id: "chatcmpl-x",
        created: 1,
        model: "fixture",
        text: "",
        reasoning: "",
        toolCalls: collected.toolCalls,
        finishReason: "tool_calls",
        usage: null,
    });
    assert.deepEqual(completion.choices[0].message.tool_calls[0], {
        id: "c1",
        type: "function",
        function: { name: "apply_patch", arguments: "*** Begin Patch" },
    });
    assert.equal(completion.choices[0].message.tool_calls[1].type, "function");
});

test("Cursor's flat custom tool shape is read as the nested Chat Completions one", () => {
    const flat = {
        ...cursorCustomToolRound,
        messages: [
            { role: "user", content: "Fix sum.js" },
            { role: "assistant", content: null, tool_calls: [{ id: "call_patch", type: "custom", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" }] },
            { role: "tool", tool_call_id: "call_patch", content: "Done" },
        ],
        tools: [
            { type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } },
            // Cursor flattens the grammar too: { type: "grammar", syntax, definition }.
            { type: "custom", name: "apply_patch", description: "Apply a patch.", format: { type: "grammar", syntax: "lark", definition: "start: \"x\"" } },
            { type: "custom", name: "note", format: { type: "grammar", grammar: { syntax: "regex", definition: "^ok$" } } },
        ],
        tool_choice: { type: "custom", name: "apply_patch" },
    };
    const converted = convertChatCompletionRequest(parseChatCompletionRequest(flat), model);
    assert.deepEqual([...converted.customTools], ["apply_patch", "note"]);
    assert.match(converted.tools[1].description, /lark grammar/);
    assert.match(converted.tools[1].description, /start: "x"/);
    assert.match(converted.tools[2].description, /regex grammar/);
    assert.deepEqual(converted.toolChoice, { type: "tool", toolName: "apply_patch" });
    assert.deepEqual(converted.messages[1].content[0].input, { input: "*** Begin Patch\n*** End Patch" });
    // An unknown field on the flat shape is still refused by name.
    rejects(() => parseChatCompletionRequest({ ...flat, tools: [{ type: "custom", name: "x", defer_loading: true }] }), "unsupported_parameter");
});

test("Cursor's tool round: a call's stream index and a tool message's name are accepted and unused", () => {
    // The shape Cursor sends after its first tool calls (field names seen on
    // dev, 2026-11-19; no real content).
    const round = {
        model: "fixture",
        stream: true,
        user: "u",
        stream_options: { include_usage: true },
        messages: [
            { role: "system", content: "s" },
            { role: "user", content: [{ type: "text", text: "explain sum.js" }] },
            {
                role: "assistant",
                content: [],
                tool_calls: [
                    { id: "c1", index: 0, type: "function", function: { name: "Glob", arguments: '{"pattern":"*.js"}' } },
                    { id: "c2", index: 1, type: "function", function: { name: "Glob", arguments: '{"pattern":"*.ts"}' } },
                    { id: "c3", index: 2, type: "custom", name: "ApplyPatch", input: "*** Begin Patch\n*** End Patch" },
                ],
            },
            { role: "tool", name: "Glob", tool_call_id: "c1", content: [{ type: "text", text: "sum.js" }] },
            { role: "tool", name: "Glob", tool_call_id: "c2", content: [{ type: "text", text: "" }] },
            { role: "tool", name: "ApplyPatch", tool_call_id: "c3", content: "Done" },
        ],
        tools: [
            { type: "function", function: { name: "Glob", parameters: { type: "object", properties: {} } } },
            { type: "custom", name: "ApplyPatch", format: { type: "grammar", syntax: "lark", definition: "start: x" } },
        ],
    };
    const converted = convertChatCompletionRequest(parseChatCompletionRequest(round), model);
    const assistant = converted.messages.find((entry) => entry.role === "assistant");
    assert.deepEqual(assistant.content.map((part) => [part.toolCallId, part.toolName]), [["c1", "Glob"], ["c2", "Glob"], ["c3", "ApplyPatch"]]);
    assert.deepEqual(assistant.content[2].input, { input: "*** Begin Patch\n*** End Patch" });
    const results = converted.messages.find((entry) => entry.role === "tool").content;
    assert.deepEqual(results.map((part) => [part.toolCallId, part.toolName]), [["c1", "Glob"], ["c2", "Glob"], ["c3", "ApplyPatch"]]);
    // A name on any other message is still refused.
    rejects(() => parseChatCompletionRequest({ ...round, messages: [{ role: "user", name: "x", content: "hi" }] }), "unsupported_parameter");
});

test("a custom tool's call echoed back in function form converts to the model's { input } call", () => {
    // Raw, as it was sent, or as an { input } object.
    for (const args of ["*** Begin Patch", JSON.stringify({ input: "*** Begin Patch" })]) {
        const converted = convertChatCompletionRequest(
            parseChatCompletionRequest({
                model: "fixture",
                messages: [
                    { role: "user", content: "fix" },
                    { role: "assistant", content: [], tool_calls: [{ id: "p1", index: 0, type: "function", function: { name: "ApplyPatch", arguments: args } }] },
                    { role: "tool", name: "ApplyPatch", tool_call_id: "p1", content: "ok" },
                ],
                tools: [{ type: "custom", name: "ApplyPatch", format: { type: "grammar", syntax: "lark", definition: "start: x" } }],
            }),
            model
        );
        assert.deepEqual(converted.messages[1].content[0].input, { input: "*** Begin Patch" });
    }
});
