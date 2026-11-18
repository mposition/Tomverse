import {
    appendProduced,
    effectiveOutputLimit,
    emptyObservation,
    isRecord,
    NativeProtocolError,
    nonNegative,
    parseJsonEvent,
    type NativeObservation,
    type NativeUsage,
} from "@/lib/externalApiNativeCore";

/**
 * Anthropic Messages, natively, for Claude Code (POST /api/anthropic/v1/messages).
 * Pure: validation, the few rewrites, and reading the provider's stream.
 *
 * The body goes to Anthropic as Claude Code wrote it. Claude Code pairs beta
 * headers with body fields (context_management, output_config, thinking,
 * mid-conversation system messages) and recovers from specific provider 400s,
 * so nothing is filtered by an allowlist of fields. What is checked is what
 * decides money or reach, and each refusal happens before dispatch:
 *
 *   - server tools Anthropic runs and bills on its own (web search, web
 *     fetch, code execution, ...) and remote MCP servers or containers;
 *   - content fetched by the provider from a URL, or a Files API id (which
 *     would read Tomverse's own provider account);
 *   - a prompt-cache TTL other than the 5 minutes the cache premium is
 *     reserved for;
 *   - premium-priced speed modes.
 */

export const ANTHROPIC_VERSION_DEFAULT = "2023-06-01";

/**
 * Tool types the client executes itself. Anything else with a `type` is a
 * server tool Anthropic would run and bill.
 */
const CLIENT_TOOL_TYPE = /^(custom|bash_\d+|text_editor_\d+|computer_\d+)$/;

/** Source types that keep the content inside the request. */
const INLINE_SOURCE_TYPES = new Set(["base64", "text", "content"]);

export type PreparedAnthropicRequest = {
    upstreamBody: string;
    stream: boolean;
    outputLimit: number;
    outputLimitClamped: boolean;
    hasCacheMarker: boolean;
    /** The body as parsed and rewritten, for the input estimate. */
    payload: Record<string, unknown>;
};

const refuse = (code: string, message: string, param: string | null = null) =>
    new NativeProtocolError(400, code, message, param);

/**
 * Validates and rewrites one Messages body for the resolved model. The model
 * id becomes the provider's, and `max_tokens` becomes the limit the
 * reservation prices (never larger than the model gives through Tomverse).
 */
export const prepareAnthropicMessages = (
    body: unknown,
    model: { apiModel: string; maxOutputTokens: number },
    options: { countTokens?: boolean } = {}
): PreparedAnthropicRequest => {
    if (!isRecord(body)) throw refuse("invalid_request", "The request body must be a JSON object.");
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
        throw refuse("invalid_request", "messages must be a non-empty array.", "messages");
    }
    for (const field of ["mcp_servers", "container"]) {
        if (body[field] !== undefined) {
            throw refuse("unsupported_feature", `${field} is not supported through Tomverse.`, field);
        }
    }
    if (body.speed !== undefined && body.speed !== "standard") {
        throw refuse("unsupported_feature", "Only standard speed is available through Tomverse.", "speed");
    }
    if (body.service_tier !== undefined && body.service_tier !== "standard_only") {
        throw refuse("unsupported_feature", "service_tier is not supported through Tomverse.", "service_tier");
    }
    if (body.tools !== undefined) {
        if (!Array.isArray(body.tools)) throw refuse("invalid_request", "tools must be an array.", "tools");
        for (const tool of body.tools) {
            const type = isRecord(tool) ? tool.type : undefined;
            if (type !== undefined && !(typeof type === "string" && CLIENT_TOOL_TYPE.test(type))) {
                throw refuse(
                    "server_tool_unsupported",
                    `The server tool '${String(type)}' is not available through Tomverse. Client tools are; web search and other provider-run tools are not.`,
                    "tools"
                );
            }
        }
    }

    // Only the places Anthropic reads a marker or a source: the top level,
    // system blocks, tool definitions and message content blocks (with the
    // blocks nested in a tool result). Never inside a tool's schema or a tool
    // call's arguments, which are the client's data.
    let hasCacheMarker = false;
    const checkMarker = (holder: Record<string, unknown>) => {
        if (!isRecord(holder.cache_control)) return;
        hasCacheMarker = true;
        if (holder.cache_control.ttl !== undefined && holder.cache_control.ttl !== "5m") {
            throw refuse(
                "unsupported_cache_ttl",
                "Tomverse supports the 5-minute prompt cache only. Set FORCE_PROMPT_CACHING_5M=1 in Claude Code.",
                "cache_control"
            );
        }
    };
    const checkBlock = (block: unknown) => {
        if (!isRecord(block)) return;
        checkMarker(block);
        if ((block.type === "image" || block.type === "document") && isRecord(block.source)) {
            if (typeof block.source.type !== "string" || !INLINE_SOURCE_TYPES.has(block.source.type)) {
                throw refuse(
                    "remote_content_unsupported",
                    "Images and documents must be sent inline (base64). URL and file sources are not supported through Tomverse.",
                    "messages"
                );
            }
            if (block.source.type === "content" && Array.isArray(block.source.content)) block.source.content.forEach(checkBlock);
        }
        if (block.type === "container_upload" || typeof block.file_id === "string") {
            throw refuse("remote_content_unsupported", "File references are not supported through Tomverse.", "messages");
        }
        if (block.type === "tool_result" && Array.isArray(block.content)) block.content.forEach(checkBlock);
    };
    checkMarker(body);
    if (Array.isArray(body.system)) body.system.forEach(checkBlock);
    if (Array.isArray(body.tools)) body.tools.forEach((tool) => isRecord(tool) && checkMarker(tool));
    for (const message of body.messages) {
        if (isRecord(message) && Array.isArray(message.content)) message.content.forEach(checkBlock);
    }

    const rewritten: Record<string, unknown> = { ...body, model: model.apiModel };
    let outputLimit = 0;
    let outputLimitClamped = false;
    if (!options.countTokens) {
        if (body.max_tokens === undefined) throw refuse("invalid_request", "max_tokens is required.", "max_tokens");
        const output = effectiveOutputLimit(body.max_tokens, model.maxOutputTokens, "max_tokens");
        outputLimit = output.limit;
        outputLimitClamped = output.clamped;
        rewritten.max_tokens = outputLimit;
        const thinking = isRecord(body.thinking) ? body.thinking : null;
        if (thinking?.type === "enabled" && Number.isSafeInteger(thinking.budget_tokens) && (thinking.budget_tokens as number) >= outputLimit) {
            throw refuse(
                "invalid_request",
                `thinking.budget_tokens must be below max_tokens; this model gives at most ${model.maxOutputTokens} output tokens through Tomverse.`,
                "thinking"
            );
        }
    }
    return {
        upstreamBody: JSON.stringify(rewritten),
        stream: body.stream === true,
        outputLimit,
        outputLimitClamped,
        hasCacheMarker,
        payload: rewritten,
    };
};

const ERROR_TYPES: Record<number, string> = {
    400: "invalid_request_error",
    401: "authentication_error",
    402: "billing_error",
    403: "permission_error",
    404: "not_found_error",
    409: "invalid_request_error",
    413: "request_too_large",
    422: "invalid_request_error",
    429: "rate_limit_error",
    499: "invalid_request_error",
    504: "timeout_error",
    529: "overloaded_error",
};

export const anthropicErrorType = (status: number) => ERROR_TYPES[status] ?? (status >= 500 ? "api_error" : "invalid_request_error");

/** An Anthropic-shaped error body. Tomverse's own code rides alongside. */
export const anthropicErrorBody = (status: number, message: string, code?: string, details?: Record<string, unknown>) => ({
    type: "error" as const,
    error: { type: anthropicErrorType(status), message },
    ...(code || details ? { tomverse: { ...(code ? { code } : {}), ...(details ?? {}) } } : {}),
});

/** One SSE `error` event, for a stream Tomverse has to end itself. */
export const anthropicErrorEvent = (status: number, message: string) =>
    `event: error\ndata: ${JSON.stringify(anthropicErrorBody(status, message))}\n\n`;

const readUsage = (usage: unknown, into: Partial<Record<string, number>>) => {
    if (!isRecord(usage)) return;
    for (const field of ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"]) {
        const value = nonNegative(usage[field]);
        // Cumulative: a later event's figure replaces the earlier one, it is
        // never added to it.
        if (value !== undefined) into[field] = value;
    }
};

const toLedgerUsage = (fields: Partial<Record<string, number>>): NativeUsage | null => {
    if (fields.output_tokens === undefined || fields.input_tokens === undefined) return null;
    const cacheRead = fields.cache_read_input_tokens ?? 0;
    const cacheWrite = fields.cache_creation_input_tokens ?? 0;
    return {
        // The ledger's input is the whole prompt: uncached + read + written.
        inputTokens: fields.input_tokens + cacheRead + cacheWrite,
        cachedInputTokens: cacheRead,
        cacheWriteInputTokens: cacheWrite,
        // Thinking is inside output_tokens.
        outputTokens: fields.output_tokens,
    };
};

/**
 * Reads Anthropic's stream as it passes through, untouched: usage (cumulative
 * across message_start and message_delta), the stop reason, produced output
 * and whether the stream reached message_stop.
 */
export const createAnthropicStreamObserver = () => {
    const observation = emptyObservation();
    const usage: Partial<Record<string, number>> = {};
    let sawDelta = false;
    return {
        observe(event: { event: string | null; data: string }) {
            const data = parseJsonEvent(event.data);
            if (!data) return;
            const type = typeof data.type === "string" ? data.type : event.event;
            if (type === "message_start" && isRecord(data.message)) {
                observation.providerResponseId = typeof data.message.id === "string" ? data.message.id : null;
                readUsage(data.message.usage, usage);
            } else if (type === "content_block_start") {
                observation.outputItems += 1;
                const block = isRecord(data.content_block) ? data.content_block : null;
                if (block?.type === "text") appendProduced(observation, block.text);
            } else if (type === "content_block_delta" && isRecord(data.delta)) {
                appendProduced(observation, data.delta.text ?? data.delta.thinking ?? data.delta.partial_json);
            } else if (type === "message_delta") {
                sawDelta = true;
                if (isRecord(data.delta) && typeof data.delta.stop_reason === "string") {
                    observation.finishReason = data.delta.stop_reason;
                }
                readUsage(data.usage, usage);
            } else if (type === "message_stop") {
                observation.terminal = true;
            } else if (type === "error") {
                observation.providerError = true;
            }
        },
        final(): NativeObservation {
            return { ...observation, usage: sawDelta ? toLedgerUsage(usage) : null };
        },
    };
};

/** The same reading of a non-streaming Messages response. */
export const observeAnthropicMessage = (json: unknown): NativeObservation => {
    const observation = emptyObservation();
    if (!isRecord(json)) return observation;
    observation.terminal = json.type === "message";
    observation.providerResponseId = typeof json.id === "string" ? json.id : null;
    observation.finishReason = typeof json.stop_reason === "string" ? json.stop_reason : null;
    if (Array.isArray(json.content)) {
        observation.outputItems = json.content.length;
        for (const block of json.content) {
            if (!isRecord(block)) continue;
            appendProduced(observation, block.text ?? block.thinking);
            if (block.input !== undefined) appendProduced(observation, JSON.stringify(block.input));
        }
    }
    const fields: Partial<Record<string, number>> = {};
    readUsage(json.usage, fields);
    observation.usage = toLedgerUsage(fields);
    return observation;
};

/** Anthropic's `GET /v1/models` shape, for Claude Code's model discovery. */
export const toAnthropicModelList = (models: readonly { id: string; name: string }[]) => ({
    data: models.map((model) => ({
        type: "model" as const,
        id: model.id,
        display_name: `${model.name} (Tomverse)`,
        created_at: "2026-01-01T00:00:00Z",
    })),
    has_more: false,
    first_id: models[0]?.id ?? null,
    last_id: models.at(-1)?.id ?? null,
});
