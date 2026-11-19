import { z } from "zod";

/**
 * The subset of the OpenAI Chat Completions wire format the external API
 * accepts, and the conversion to and from AI SDK messages and stream parts.
 *
 * Pure: no provider, no database. Everything here is decided from the request
 * and the model's declared capabilities, so it can be exercised against
 * recorded client fixtures. It is not a claim of full OpenAI compatibility --
 * docs/policy/external-api.md lists what is supported, and anything else is
 * refused with a typed error rather than dropped.
 */

export class ProtocolError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
        public readonly param: string | null = null,
        public readonly type: string = "invalid_request_error"
    ) {
        super(message);
    }
}

export const PROTOCOL_LIMITS = {
    maxBodyBytes: 12 * 1024 * 1024,
    maxMessages: 400,
    maxTools: 128,
    maxToolSchemaBytes: 64 * 1024,
    maxTotalToolSchemaBytes: 512 * 1024,
    maxImages: 16,
    maxImageBytes: 8 * 1024 * 1024,
    maxStopSequences: 4,
} as const;

const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

// Nested objects are strict too: an unknown field anywhere is refused by
// name rather than silently dropped.
const textPart = z.object({ type: z.literal("text"), text: z.string() }).strict();
const imagePart = z
    .object({
        type: z.literal("image_url"),
        image_url: z
            .object({
                url: z.string().min(1),
                detail: z.enum(["auto", "low", "high"]).optional(),
            })
            .strict(),
    })
    .strict();

/**
 * Providers whose SDK adapter sends a tool's `strict` flag on to the model.
 * For any other provider the flag would be dropped, so `strict: true` is
 * refused there instead of promising schema-exact arguments it cannot give.
 */
const STRICT_TOOL_PROVIDERS = new Set(["openai", "mistral", "moonshot"]);

/** Providers whose adapter takes OpenAI's image `detail`; elsewhere only "auto". */
const IMAGE_DETAIL_PROVIDERS = new Set(["openai"]);

const textContent = z.union([z.string(), z.array(textPart)]);
// A call's `index` is its position in the stream that delivered it; Cursor
// echoes it back with the history. It carries nothing the conversion needs.
const toolCallIndex = z.number().int().nonnegative().optional();
const toolCall = z.discriminatedUnion("type", [
    z.strictObject({
        id: z.string().min(1).max(200),
        index: toolCallIndex,
        type: z.literal("function"),
        function: z.strictObject({ name: z.string().min(1), arguments: z.string() }),
    }),
    // A custom (free-form input) tool's call, as a client echoes it back.
    z.strictObject({
        id: z.string().min(1).max(200),
        index: toolCallIndex,
        type: z.literal("custom"),
        custom: z.strictObject({ name: z.string().min(1), input: z.string() }),
    }),
]);
type ToolCallWire = z.infer<typeof toolCall>;
/** The text a call carries: a function's JSON arguments or a custom tool's input. */
export const toolCallText = (call: ToolCallWire) => (call.type === "custom" ? call.custom.input : call.function.arguments);

const message = z.discriminatedUnion("role", [
    // No `name` on a system, user or assistant message: the providers behind
    // this API have no participant names, so a request that relies on one is
    // refused rather than answered as if every turn came from the same
    // speaker. A tool message's `name` (Cursor sends one) is the tool's name,
    // which its tool_call_id already says; it is accepted and not used.
    z.strictObject({ role: z.literal("system"), content: textContent }),
    z.strictObject({ role: z.literal("developer"), content: textContent }),
    z.strictObject({
        role: z.literal("user"),
        content: z.union([z.string(), z.array(z.union([textPart, imagePart]))]),
    }),
    z.strictObject({
        role: z.literal("assistant"),
        content: z.union([textContent, z.null()]).optional(),
        tool_calls: z.array(toolCall).optional(),
        // Some clients echo a previous turn's reasoning back. It is the
        // client's copy of what this API sent; it is not sent to the provider.
        reasoning_content: z.string().nullable().optional(),
        refusal: z.string().nullable().optional(),
    }),
    z.strictObject({
        role: z.literal("tool"),
        tool_call_id: z.string().min(1).max(200),
        name: z.string().max(200).optional(),
        content: textContent,
    }),
]);

const toolDefinition = z.discriminatedUnion("type", [
    z.strictObject({
        type: z.literal("function"),
        function: z.strictObject({
            name: z.string(),
            description: z.string().max(8_000).optional(),
            parameters: z.record(z.string(), z.unknown()).optional(),
            strict: z.boolean().nullable().optional(),
        }),
    }),
    // OpenAI's custom tools take one free-form string (Cursor's GPT-5 Agent
    // sends one). Every provider behind this API takes JSON tools only, so it
    // reaches the model as a function with a single `input` string, the
    // grammar written into the description, and goes back to the client as a
    // custom call. The grammar is described to the model, not enforced.
    z.strictObject({
        type: z.literal("custom"),
        custom: z.strictObject({
            name: z.string(),
            description: z.string().max(8_000).optional(),
            format: z
                .discriminatedUnion("type", [
                    z.strictObject({ type: z.literal("text") }),
                    z.strictObject({
                        type: z.literal("grammar"),
                        grammar: z.strictObject({ definition: z.string().max(32_000), syntax: z.enum(["lark", "regex"]) }),
                    }),
                ])
                .optional(),
        }),
    }),
]);

/**
 * Every field the API understands, at every level -- messages, tool calls,
 * tool definitions and tool_choice included. Anything else is refused.
 */
const requestSchema = z
    .object({
        model: z.string().min(1).max(160),
        messages: z.array(message).min(1).max(PROTOCOL_LIMITS.maxMessages),
        stream: z.boolean().optional(),
        stream_options: z
            .object({ include_usage: z.boolean().optional() })
            .strict()
            .nullable()
            .optional(),
        tools: z.array(toolDefinition).max(PROTOCOL_LIMITS.maxTools).optional(),
        tool_choice: z
            .union([
                z.enum(["none", "auto", "required"]),
                z.strictObject({ type: z.literal("function"), function: z.strictObject({ name: z.string() }) }),
                z.strictObject({ type: z.literal("custom"), custom: z.strictObject({ name: z.string() }) }),
            ])
            .optional(),
        parallel_tool_calls: z.boolean().optional(),
        max_tokens: z.number().int().positive().nullable().optional(),
        max_completion_tokens: z.number().int().positive().nullable().optional(),
        temperature: z.number().min(0).max(2).nullable().optional(),
        top_p: z.number().min(0).max(1).nullable().optional(),
        frequency_penalty: z.number().min(-2).max(2).nullable().optional(),
        presence_penalty: z.number().min(-2).max(2).nullable().optional(),
        stop: z
            .union([z.string(), z.array(z.string()).max(PROTOCOL_LIMITS.maxStopSequences)])
            .nullable()
            .optional(),
        n: z.number().int().nullable().optional(),
        store: z.boolean().nullable().optional(),
        user: z.string().max(256).optional(),
        reasoning_effort: z.enum(["minimal", "low", "medium", "high"]).nullable().optional(),
    })
    .strict();

export type ChatCompletionRequest = z.infer<typeof requestSchema>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
/**
 * `{ type: "custom", name, … }` → `{ type: "custom", custom: { name, … } }`.
 * Cursor sends custom tools, tool choices and calls in the flat Responses-API
 * shape on Chat Completions. Everything but `type` (and a call's `id`) moves
 * under `custom`, so an unknown field is still refused there by name.
 */
const nestCustom = (value: unknown, keep: string[] = []) => {
    if (!isRecord(value) || value.type !== "custom" || "custom" in value) return value;
    const custom: Record<string, unknown> = {};
    const nested: Record<string, unknown> = { type: "custom", custom };
    for (const [key, entry] of Object.entries(value)) {
        if (key === "type") continue;
        if (keep.includes(key)) nested[key] = entry;
        else custom[key] = entry;
    }
    return nested;
};
/**
 * A grammar format in the flat Responses shape, `{ type: "grammar", syntax,
 * definition }`, which Cursor sends inside its custom tools, moved under
 * `grammar` as Chat Completions nests it. Other fields stay where they are and
 * are refused by name.
 */
const nestGrammar = (definition: unknown) => {
    if (!isRecord(definition) || definition.type !== "custom" || !isRecord(definition.custom)) return definition;
    const format = definition.custom.format;
    if (!isRecord(format) || format.type !== "grammar" || "grammar" in format) return definition;
    const { syntax, definition: grammarDefinition, ...rest } = format;
    return { ...definition, custom: { ...definition.custom, format: { ...rest, grammar: { syntax, definition: grammarDefinition } } } };
};
const normalizeCustomShapes = (body: unknown) => {
    if (!isRecord(body)) return body;
    const next: Record<string, unknown> = { ...body };
    if (Array.isArray(body.tools)) next.tools = body.tools.map((definition) => nestGrammar(nestCustom(definition)));
    if (body.tool_choice !== undefined) next.tool_choice = nestCustom(body.tool_choice);
    if (Array.isArray(body.messages)) {
        next.messages = body.messages.map((message) =>
            isRecord(message) && Array.isArray(message.tool_calls)
                ? { ...message, tool_calls: message.tool_calls.map((call) => nestCustom(call, ["id", "index"])) }
                : message
        );
    }
    return next;
};

export const parseChatCompletionRequest = (body: unknown): ChatCompletionRequest => {
    const parsed = requestSchema.safeParse(normalizeCustomShapes(body));
    if (parsed.success) return parsed.data;
    const issue = parsed.error.issues[0];
    if (issue?.code === "unrecognized_keys") {
        const key = issue.keys[0] ?? "unknown";
        throw new ProtocolError(
            400,
            "unsupported_parameter",
            `The parameter '${key}' is not supported by the Tomverse API.`,
            key
        );
    }
    const param = issue?.path?.length ? issue.path.join(".") : null;
    throw new ProtocolError(
        400,
        "invalid_request",
        issue ? `Invalid request: ${param ?? "body"}: ${issue.message}` : "Invalid request body.",
        param
    );
};

export type ModelCapabilityView = {
    id: string;
    provider: string;
    vision: boolean;
    reasoning: boolean;
    maxOutputTokens: number;
};

/** Validates option combinations against the model. Returns the output cap. */
export const resolveRequestOptions = (
    request: ChatCompletionRequest,
    model: ModelCapabilityView
) => {
    if (request.n !== undefined && request.n !== null && request.n !== 1) {
        throw new ProtocolError(400, "unsupported_parameter", "Only n=1 is supported.", "n");
    }
    if (request.store === true) {
        throw new ProtocolError(
            400,
            "unsupported_parameter",
            "The Tomverse API is stateless and does not store completions. Send store=false or omit it.",
            "store"
        );
    }
    if (
        request.max_tokens != null &&
        request.max_completion_tokens != null &&
        request.max_tokens !== request.max_completion_tokens
    ) {
        throw new ProtocolError(
            400,
            "conflicting_parameters",
            "max_tokens and max_completion_tokens disagree. Send one of them.",
            "max_completion_tokens"
        );
    }
    const requestedOutput = request.max_completion_tokens ?? request.max_tokens ?? null;
    if (requestedOutput !== null && requestedOutput > model.maxOutputTokens) {
        throw new ProtocolError(
            400,
            "max_tokens_too_large",
            `This model accepts at most ${model.maxOutputTokens} output tokens through the Tomverse API.`,
            request.max_completion_tokens != null ? "max_completion_tokens" : "max_tokens"
        );
    }
    if (request.reasoning_effort != null && !(model.reasoning && model.provider === "openai")) {
        throw new ProtocolError(
            400,
            "unsupported_parameter",
            "reasoning_effort is not supported for this model.",
            "reasoning_effort"
        );
    }
    if (request.parallel_tool_calls === false && request.tools?.length) {
        // Not every provider can be told to call at most one tool, and
        // pretending to honour it would be silently dropping it.
        throw new ProtocolError(
            400,
            "unsupported_parameter",
            "parallel_tool_calls=false is not supported.",
            "parallel_tool_calls"
        );
    }
    const stop =
        request.stop == null ? undefined : Array.isArray(request.stop) ? request.stop : [request.stop];
    return {
        requestedOutputTokens: requestedOutput,
        stream: request.stream === true,
        includeUsage: request.stream_options?.include_usage === true,
        stop: stop?.length ? stop : undefined,
    };
};

const joinText = (content: string | { text: string }[] | null | undefined) =>
    content == null ? "" : typeof content === "string" ? content : content.map((part) => part.text).join("");

/**
 * Whether a model can take this request's optional features, by the same rules
 * `resolveRequestOptions` and `convertChatCompletionRequest` refuse with: strict
 * tool schemas, an image `detail`, `reasoning_effort`. Smart Adaptive keeps a
 * model as a candidate only when this holds, so the pick never decides whether
 * the request succeeds.
 */
export const modelTakesRequestFeatures = (request: ChatCompletionRequest, model: ModelCapabilityView) => {
    const strict = (request.tools ?? []).some((definition) => definition.type === "function" && definition.function.strict === true);
    const detail = request.messages.some(
        (message) =>
            message.role === "user" &&
            Array.isArray(message.content) &&
            message.content.some(
                (part) => part.type === "image_url" && (part.image_url.detail === "low" || part.image_url.detail === "high")
            )
    );
    return (
        (!strict || STRICT_TOOL_PROVIDERS.has(model.provider ?? "")) &&
        (!detail || IMAGE_DETAIL_PROVIDERS.has(model.provider ?? "")) &&
        (request.reasoning_effort == null || (model.reasoning && model.provider === "openai"))
    );
};

export type DecodedImage = { mediaType: string; bytes: Uint8Array };

/**
 * Accepts `data:` URLs only. A remote URL would make this server fetch an
 * address a caller chose; it is refused rather than fetched.
 */
export const decodeImageDataUrl = (url: string, param: string): DecodedImage => {
    if (!url.startsWith("data:")) {
        throw new ProtocolError(
            400,
            "unsupported_image_url",
            "Images must be sent inline as base64 data URLs; remote image URLs are not fetched.",
            param
        );
    }
    const match = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(url);
    if (!match) {
        throw new ProtocolError(400, "invalid_image", "The image data URL is malformed.", param);
    }
    const mediaType = match[1].toLowerCase();
    if (!SUPPORTED_IMAGE_TYPES.has(mediaType)) {
        throw new ProtocolError(
            400,
            "unsupported_image_type",
            "Supported image types are PNG, JPEG, WebP and GIF.",
            param
        );
    }
    const bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
    if (bytes.length === 0) {
        throw new ProtocolError(400, "invalid_image", "The image is empty.", param);
    }
    if (bytes.length > PROTOCOL_LIMITS.maxImageBytes) {
        throw new ProtocolError(413, "image_too_large", "An image is larger than 8 MB.", param);
    }
    return { mediaType, bytes: new Uint8Array(bytes) };
};

type SdkContentPart =
    | { type: "text"; text: string }
    | {
          type: "file";
          mediaType: string;
          data: Uint8Array;
          providerOptions?: { openai: { imageDetail: "low" | "high" } };
      }
    | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
    | {
          type: "tool-result";
          toolCallId: string;
          toolName: string;
          output: { type: "text"; value: string };
      };

export type SdkMessage =
    | { role: "system"; content: string }
    | { role: "user"; content: string | SdkContentPart[] }
    | { role: "assistant"; content: SdkContentPart[] }
    | { role: "tool"; content: SdkContentPart[] };

export type ConvertedRequest = {
    messages: SdkMessage[];
    /** Every piece of text that will reach the provider, for the estimate. */
    textSegments: string[];
    images: DecodedImage[];
    tools: { name: string; description?: string; parameters: Record<string, unknown>; strict?: boolean }[];
    /** Tools the client declared as custom: their calls go back as custom calls. */
    customTools: Set<string>;
    toolChoice:
        | "none"
        | "auto"
        | "required"
        | { type: "tool"; toolName: string }
        | undefined;
};

export const convertChatCompletionRequest = (
    request: ChatCompletionRequest,
    model: Pick<ModelCapabilityView, "vision"> & Partial<Pick<ModelCapabilityView, "provider">>
): ConvertedRequest => {
    const textSegments: string[] = [];
    const images: DecodedImage[] = [];
    const toolNamesById = new Map<string, string>();
    const messages: SdkMessage[] = [];

    const customTools = new Set<string>();
    const tools = (request.tools ?? []).map((definition, index) => {
        const name = definition.type === "custom" ? definition.custom.name : definition.function.name;
        if (!TOOL_NAME_PATTERN.test(name)) {
            throw new ProtocolError(
                400,
                "invalid_tool",
                "Tool names must be 1-64 letters, digits, underscores or hyphens.",
                `tools.${index}.${definition.type}.name`
            );
        }
        if (definition.type === "custom") {
            customTools.add(name);
            const format = definition.custom.format;
            const description = [
                definition.custom.description ?? "",
                format?.type === "grammar"
                    ? `The input must match this ${format.grammar.syntax} grammar:\n${format.grammar.definition}`
                    : "",
            ]
                .filter(Boolean)
                .join("\n\n");
            const parameters = {
                type: "object",
                properties: { input: { type: "string", description: "The tool's complete input, as free-form text." } },
                required: ["input"],
                additionalProperties: false,
            };
            const schemaText = JSON.stringify(parameters);
            if (Buffer.byteLength(description, "utf8") > PROTOCOL_LIMITS.maxToolSchemaBytes) {
                throw new ProtocolError(413, "tool_schema_too_large", "A tool schema is larger than 64 KB.", `tools.${index}`);
            }
            textSegments.push(name, description, schemaText);
            return { name, description: description || undefined, parameters, strict: undefined };
        }
        const parameters = definition.function.parameters ?? { type: "object", properties: {} };
        const schemaText = JSON.stringify(parameters);
        if (Buffer.byteLength(schemaText, "utf8") > PROTOCOL_LIMITS.maxToolSchemaBytes) {
            throw new ProtocolError(413, "tool_schema_too_large", "A tool schema is larger than 64 KB.", `tools.${index}`);
        }
        const strict = definition.function.strict ?? undefined;
        if (strict === true && !STRICT_TOOL_PROVIDERS.has(model.provider ?? "")) {
            throw new ProtocolError(
                400,
                "unsupported_parameter",
                "strict tool schemas are not supported for this model.",
                `tools.${index}.function.strict`
            );
        }
        textSegments.push(name, definition.function.description ?? "", schemaText);
        return { name, description: definition.function.description, parameters, strict };
    });
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
        throw new ProtocolError(400, "invalid_tool", "Tool names must be unique.", "tools");
    }
    const totalSchemaBytes = tools.reduce(
        (total, tool) => total + Buffer.byteLength(JSON.stringify(tool.parameters), "utf8"),
        0
    );
    if (totalSchemaBytes > PROTOCOL_LIMITS.maxTotalToolSchemaBytes) {
        throw new ProtocolError(413, "tool_schema_too_large", "The tool schemas together exceed 512 KB.", "tools");
    }

    let toolChoice: ConvertedRequest["toolChoice"];
    if (request.tool_choice !== undefined) {
        if (typeof request.tool_choice === "string") {
            toolChoice = request.tool_choice;
            if (toolChoice === "required" && tools.length === 0) {
                throw new ProtocolError(400, "invalid_tool_choice", "tool_choice=required needs at least one tool.", "tool_choice");
            }
        } else {
            const toolName = request.tool_choice.type === "custom" ? request.tool_choice.custom.name : request.tool_choice.function.name;
            if (!tools.some((tool) => tool.name === toolName)) {
                throw new ProtocolError(400, "invalid_tool_choice", `tool_choice names an undefined tool '${toolName}'.`, "tool_choice");
            }
            toolChoice = { type: "tool", toolName };
        }
    }

    request.messages.forEach((entry, index) => {
        const at = `messages.${index}`;
        switch (entry.role) {
            case "system":
            case "developer": {
                const text = joinText(entry.content);
                textSegments.push(text);
                messages.push({ role: "system", content: text });
                return;
            }
            case "user": {
                if (typeof entry.content === "string") {
                    textSegments.push(entry.content);
                    messages.push({ role: "user", content: entry.content });
                    return;
                }
                const parts: SdkContentPart[] = entry.content.map((part, partIndex) => {
                    if (part.type === "text") {
                        textSegments.push(part.text);
                        return { type: "text", text: part.text };
                    }
                    const param = `${at}.content.${partIndex}.image_url.url`;
                    if (!model.vision) {
                        throw new ProtocolError(400, "model_does_not_support_images", "This model does not accept image input.", param);
                    }
                    const image = decodeImageDataUrl(part.image_url.url, param);
                    images.push(image);
                    if (images.length > PROTOCOL_LIMITS.maxImages) {
                        throw new ProtocolError(413, "too_many_images", `At most ${PROTOCOL_LIMITS.maxImages} images per request.`, param);
                    }
                    const detail = part.image_url.detail;
                    if (detail === "low" || detail === "high") {
                        if (!IMAGE_DETAIL_PROVIDERS.has(model.provider ?? "")) {
                            throw new ProtocolError(
                                400,
                                "unsupported_parameter",
                                "image_url.detail other than auto is not supported for this model.",
                                `${at}.content.${partIndex}.image_url.detail`
                            );
                        }
                        return {
                            type: "file",
                            mediaType: image.mediaType,
                            data: image.bytes,
                            providerOptions: { openai: { imageDetail: detail } },
                        };
                    }
                    return { type: "file", mediaType: image.mediaType, data: image.bytes };
                });
                messages.push({ role: "user", content: parts });
                return;
            }
            case "assistant": {
                const parts: SdkContentPart[] = [];
                const text = joinText(entry.content);
                if (text) {
                    textSegments.push(text);
                    parts.push({ type: "text", text });
                }
                (entry.tool_calls ?? []).forEach((call, callIndex) => {
                    if (call.type === "custom") {
                        textSegments.push(call.custom.name, call.custom.input);
                        toolNamesById.set(call.id, call.custom.name);
                        parts.push({ type: "tool-call", toolCallId: call.id, toolName: call.custom.name, input: { input: call.custom.input } });
                        return;
                    }
                    let input: unknown;
                    try {
                        input = call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {};
                    } catch {
                        throw new ProtocolError(
                            400,
                            "invalid_tool_call",
                            "A previous tool call's arguments are not valid JSON.",
                            `${at}.tool_calls.${callIndex}.function.arguments`
                        );
                    }
                    textSegments.push(call.function.name, call.function.arguments);
                    toolNamesById.set(call.id, call.function.name);
                    parts.push({ type: "tool-call", toolCallId: call.id, toolName: call.function.name, input });
                });
                if (parts.length === 0) return;
                messages.push({ role: "assistant", content: parts });
                return;
            }
            case "tool": {
                const toolName = toolNamesById.get(entry.tool_call_id);
                if (!toolName) {
                    throw new ProtocolError(
                        400,
                        "invalid_tool_result",
                        "A tool message answers a tool_call_id no earlier assistant message made.",
                        `${at}.tool_call_id`
                    );
                }
                const value = joinText(entry.content);
                textSegments.push(value);
                const result: SdkContentPart = {
                    type: "tool-result",
                    toolCallId: entry.tool_call_id,
                    toolName,
                    output: { type: "text", value },
                };
                // Consecutive tool messages answer one assistant turn; the SDK
                // expects them as one tool message.
                const previous = messages[messages.length - 1];
                if (previous?.role === "tool") previous.content.push(result);
                else messages.push({ role: "tool", content: [result] });
                return;
            }
        }
    });
    if (!messages.some((entry) => entry.role !== "system")) {
        throw new ProtocolError(400, "invalid_request", "At least one non-system message is required.", "messages");
    }
    return { messages, textSegments, images, tools, customTools, toolChoice };
};

/* ------------------------------------------------------------ responses -- */

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter";

export const toOpenAiFinishReason = (
    sdkReason: string | undefined,
    sawToolCalls: boolean
): FinishReason => {
    // A provider that stopped for length or a content filter is reported as
    // such even when tool calls were started: an argument cut off by the
    // output limit must not reach the client as a finished call.
    if (sdkReason === "length") return "length";
    if (sdkReason === "content-filter") return "content_filter";
    if (sawToolCalls || sdkReason === "tool-calls") return "tool_calls";
    return "stop";
};

export type UsageView = {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
};

/**
 * OpenAI usage. `null` when the provider reported none: a missing count is
 * not zero, and reporting it as zero is how a client would conclude a call
 * was free.
 */
export const toOpenAiUsage = (usage: UsageView | null) => {
    if (!usage || usage.inputTokens === undefined || usage.outputTokens === undefined) return null;
    return {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens,
        prompt_tokens_details: { cached_tokens: usage.cachedInputTokens ?? 0 },
        completion_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 },
    };
};

/**
 * One call the model made. `arguments` is a function's JSON arguments, or a
 * custom tool's raw input when `custom` is set.
 */
export type CollectedToolCall = { id: string; name: string; arguments: string; custom?: boolean };

/** A custom tool's input from the `{ input }` object its function form took. */
const customInputOf = (input: unknown) => {
    const value = typeof input === "string" ? safeJson(input) : input;
    if (value && typeof value === "object" && typeof (value as { input?: unknown }).input === "string") {
        return (value as { input: string }).input;
    }
    return typeof input === "string" ? input : JSON.stringify(input ?? {});
};
const safeJson = (text: string): unknown => {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
};

export const buildChatCompletion = (input: {
    id: string;
    created: number;
    model: string;
    text: string;
    reasoning: string;
    toolCalls: CollectedToolCall[];
    finishReason: FinishReason;
    usage: UsageView | null;
    tomverse?: Record<string, unknown>;
}) => ({
    id: input.id,
    object: "chat.completion" as const,
    created: input.created,
    model: input.model,
    choices: [
        {
            index: 0,
            message: {
                role: "assistant" as const,
                // Null, not "", when the model answered with tool calls only:
                // clients read an empty string as an empty reply.
                content: input.text.length > 0 ? input.text : null,
                ...(input.reasoning ? { reasoning_content: input.reasoning } : {}),
                ...(input.toolCalls.length
                    ? {
                          tool_calls: input.toolCalls.map((call) =>
                              call.custom
                                  ? { id: call.id, type: "custom" as const, custom: { name: call.name, input: call.arguments } }
                                  : { id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments } }
                          ),
                      }
                    : {}),
            },
            logprobs: null,
            finish_reason: input.finishReason,
        },
    ],
    usage: toOpenAiUsage(input.usage),
    ...(input.tomverse ? { tomverse: input.tomverse } : {}),
});

export const buildChunk = (
    base: { id: string; created: number; model: string },
    delta: Record<string, unknown>,
    finishReason: FinishReason | null = null
) => ({
    id: base.id,
    object: "chat.completion.chunk" as const,
    created: base.created,
    model: base.model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
});

export const buildUsageChunk = (
    base: { id: string; created: number; model: string },
    usage: UsageView | null
) => ({
    id: base.id,
    object: "chat.completion.chunk" as const,
    created: base.created,
    model: base.model,
    choices: [],
    usage: toOpenAiUsage(usage),
});

export const sseData = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
export const SSE_DONE = "data: [DONE]\n\n";

export const openAiError = (
    message: string,
    code: string,
    type = "invalid_request_error",
    param: string | null = null
) => ({ error: { message, type, code, param } });

/**
 * Translates AI SDK stream parts to Chat Completions chunks for one choice.
 *
 * Stateful: OpenAI numbers tool calls 0..n by first appearance and sends the
 * id and name only on a call's first fragment. The SDK keys them by id.
 */
export const createChunkTranslator = (
    base: { id: string; created: number; model: string },
    /**
     * Custom tools (see `toolDefinition`). Their function-form JSON fragments
     * are held back and the decoded input is sent once, when the call is
     * complete: a prefix of `{"input":"…` is not a prefix of the input.
     */
    customTools: ReadonlySet<string> = new Set()
) => {
    let roleSent = false;
    const toolIndexById = new Map<string, number>();
    const argumentsById = new Map<string, string>();
    const namesById = new Map<string, string>();
    const completedIds = new Set<string>();
    let text = "";
    let reasoning = "";

    const withRole = (delta: Record<string, unknown>) => {
        if (roleSent) return delta;
        roleSent = true;
        return { role: "assistant", ...delta };
    };

    const startTool = (id: string, name: string) => {
        if (toolIndexById.has(id)) return null;
        const index = toolIndexById.size;
        toolIndexById.set(id, index);
        namesById.set(id, name);
        argumentsById.set(id, "");
        const call = customTools.has(name)
            ? { index, id, type: "custom", custom: { name, input: "" } }
            : { index, id, type: "function", function: { name, arguments: "" } };
        return buildChunk(base, withRole({ tool_calls: [call] }));
    };
    const isCustom = (id: string) => customTools.has(namesById.get(id) ?? "");

    return {
        /** Returns the chunks this part produces, possibly none. */
        translate(part: { type: string; [key: string]: unknown }): unknown[] {
            switch (part.type) {
                case "text-delta": {
                    const delta = String(part.text ?? "");
                    if (!delta) return [];
                    text += delta;
                    return [buildChunk(base, withRole({ content: delta }))];
                }
                case "reasoning-delta": {
                    const delta = String(part.text ?? "");
                    if (!delta) return [];
                    reasoning += delta;
                    return [buildChunk(base, withRole({ reasoning_content: delta }))];
                }
                case "tool-input-start": {
                    const chunk = startTool(String(part.id), String(part.toolName));
                    return chunk ? [chunk] : [];
                }
                case "tool-input-delta": {
                    const id = String(part.id);
                    const index = toolIndexById.get(id);
                    const delta = String(part.delta ?? "");
                    if (index === undefined || !delta || isCustom(id)) return [];
                    argumentsById.set(id, (argumentsById.get(id) ?? "") + delta);
                    return [buildChunk(base, { tool_calls: [{ index, function: { arguments: delta } }] })];
                }
                case "tool-call": {
                    // The final, complete call. A provider that streamed the
                    // arguments has already been forwarded; one that did not
                    // (or sent only part) gets the remainder here, so the
                    // concatenated fragments always equal the final input.
                    const id = String(part.toolCallId);
                    const name = String(part.toolName);
                    completedIds.add(id);
                    const complete =
                        typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {});
                    const chunks: unknown[] = [];
                    const started = startTool(id, name);
                    if (started) chunks.push(started);
                    if (isCustom(id)) {
                        const input = customInputOf(part.input);
                        argumentsById.set(id, input);
                        if (input) {
                            chunks.push(buildChunk(base, { tool_calls: [{ index: toolIndexById.get(id), custom: { input } }] }));
                        }
                        return chunks;
                    }
                    const sent = argumentsById.get(id) ?? "";
                    if (complete.startsWith(sent) && complete.length > sent.length) {
                        const rest = complete.slice(sent.length);
                        argumentsById.set(id, complete);
                        chunks.push(
                            buildChunk(base, {
                                tool_calls: [{ index: toolIndexById.get(id), function: { arguments: rest } }],
                            })
                        );
                    } else if (!complete.startsWith(sent)) {
                        // Streamed fragments that do not prefix the final input
                        // cannot be repaired after the fact; record the final.
                        argumentsById.set(id, complete);
                    }
                    return chunks;
                }
                default:
                    return [];
            }
        },
        finish(finishReason: FinishReason) {
            return buildChunk(base, withRole({}), finishReason);
        },
        collected() {
            return {
                text,
                reasoning,
                toolCalls: [...toolIndexById.entries()]
                    .sort((a, b) => a[1] - b[1])
                    .map(([id]) => ({
                        id,
                        name: namesById.get(id) ?? "",
                        arguments: argumentsById.get(id) ?? "",
                        ...(isCustom(id) ? { custom: true } : {}),
                        /** False when the provider started the call and never finished it. */
                        complete: completedIds.has(id),
                    })),
            };
        },
    };
};
