import {
    appendProduced,
    effectiveOutputLimit,
    emptyObservation,
    isRecord,
    NativeProtocolError,
    nonNegative,
    parseJsonEvent,
    refusePriceSelectors,
    type NativeObservation,
    type NativeUsage,
} from "@/lib/externalApiNativeCore";

/**
 * OpenAI Responses, natively, for Codex (POST /api/v1/responses). Pure.
 *
 * Stateless by contract: `store` is always false, and anything that would
 * have the provider keep or look up state for Tomverse's own account
 * (previous_response_id, conversation, background, stored prompts, file ids)
 * is refused before dispatch. Codex sends its full history with encrypted
 * reasoning, which is passed through untouched.
 *
 * Tools: everything the client executes (function, custom/freeform tools such
 * as Codex's apply_patch and exec, namespaces of those, local shell) passes; hosted tools the
 * provider runs and bills separately (web search, file search, code
 * interpreter, image generation, remote MCP) are refused. Codex offers web
 * search by default, so its Tomverse configuration turns it off.
 */

/**
 * Only tool types the client itself executes, as Codex was observed to send
 * them. OpenAI's `shell` and `apply_patch` tool types can run in a
 * provider-side environment, so they are refused with the hosted tools.
 */
const CLIENT_TOOL_TYPES = new Set(["function", "custom", "namespace", "local_shell"]);

export type PreparedResponsesRequest = {
    upstreamBody: string;
    stream: boolean;
    outputLimit: number;
    outputLimitClamped: boolean;
    payload: Record<string, unknown>;
};

const refuse = (code: string, message: string, param: string | null = null) =>
    new NativeProtocolError(400, code, message, param);

const checkTools = (tools: unknown, param: string) => {
    if (tools === undefined) return;
    if (!Array.isArray(tools)) throw refuse("invalid_request", `${param} must be an array.`, param);
    for (const tool of tools) {
        const type = isRecord(tool) ? tool.type : undefined;
        if (typeof type !== "string" || !CLIENT_TOOL_TYPES.has(type)) {
            throw refuse(
                "hosted_tool_unsupported",
                `The hosted tool '${String(type)}' is not available through Tomverse. In Codex, set web_search = "disabled".`,
                param
            );
        }
        if (type === "namespace" && isRecord(tool)) checkTools(tool.tools, param);
    }
};

const checkContentPart = (part: unknown) => {
    if (!isRecord(part)) return;
    if (typeof part.file_id === "string") {
        throw refuse("remote_content_unsupported", "File ids are not supported through Tomverse; send the file inline.", "input");
    }
    if (part.type === "input_image" && typeof part.image_url === "string" && !part.image_url.startsWith("data:")) {
        throw refuse("remote_content_unsupported", "Images must be sent inline as data URLs through Tomverse.", "input");
    }
    if (part.type === "input_file" && part.file_url !== undefined) {
        throw refuse("remote_content_unsupported", "File URLs are not supported through Tomverse; send file_data inline.", "input");
    }
};

export const prepareResponsesRequest = (
    body: unknown,
    model: { apiModel: string; maxOutputTokens: number }
): PreparedResponsesRequest => {
    if (!isRecord(body)) throw refuse("invalid_request", "The request body must be a JSON object.");
    if (typeof body.input !== "string" && !Array.isArray(body.input)) {
        throw refuse("invalid_request", "input must be a string or an array of items.", "input");
    }
    for (const field of ["previous_response_id", "conversation", "prompt"]) {
        if (body[field] !== undefined && body[field] !== null) {
            throw refuse(
                "stateful_request_unsupported",
                `${field} is not supported: the Tomverse API is stateless. Send the full input history instead.`,
                field
            );
        }
    }
    if (body.background === true) {
        throw refuse("stateful_request_unsupported", "Background responses are not supported through Tomverse.", "background");
    }
    refusePriceSelectors(body);
    checkTools(body.tools, "tools");
    if (Array.isArray(body.input)) {
        for (const item of body.input) {
            if (!isRecord(item)) continue;
            if (item.type === "item_reference") {
                throw refuse("stateful_request_unsupported", "Item references are not supported: send the item itself.", "input");
            }
            if (item.type === "additional_tools") checkTools(item.tools, "input");
            for (const parts of [item.content, item.output]) {
                if (Array.isArray(parts)) parts.forEach(checkContentPart);
            }
        }
    }

    const output = effectiveOutputLimit(body.max_output_tokens, model.maxOutputTokens, "max_output_tokens");
    const rewritten: Record<string, unknown> = {
        ...body,
        model: model.apiModel,
        store: false,
        max_output_tokens: output.limit,
    };
    return {
        upstreamBody: JSON.stringify(rewritten),
        stream: body.stream === true,
        outputLimit: output.limit,
        outputLimitClamped: output.clamped,
        payload: rewritten,
    };
};

const readUsage = (usage: unknown): NativeUsage | null => {
    if (!isRecord(usage)) return null;
    const input = nonNegative(usage.input_tokens);
    const output = nonNegative(usage.output_tokens);
    if (input === undefined || output === undefined) return null;
    const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : {};
    const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {};
    return {
        // input_tokens already includes cached tokens; output includes reasoning.
        inputTokens: input,
        cachedInputTokens: Math.min(input, nonNegative(inputDetails.cached_tokens) ?? 0),
        // OpenAI's cache has no write charge.
        cacheWriteInputTokens: 0,
        outputTokens: output,
        reasoningTokens: nonNegative(outputDetails.reasoning_tokens),
    };
};

const TERMINAL_EVENTS = new Set(["response.completed", "response.incomplete", "response.failed"]);

const readResponse = (observation: NativeObservation, response: unknown) => {
    if (!isRecord(response)) return;
    if (typeof response.id === "string") observation.providerResponseId = response.id;
    if (typeof response.status === "string") observation.finishReason = response.status;
    if (Array.isArray(response.output) && response.output.length > observation.outputItems) {
        observation.outputItems = response.output.length;
    }
    const usage = readUsage(response.usage);
    if (usage) observation.usage = usage;
};

/**
 * Reads a Responses stream as it passes through. Every `*.delta` string --
 * text, reasoning summaries, function arguments, custom tool input -- counts
 * as produced output; the terminal event carries status and usage.
 */
export const createResponsesStreamObserver = () => {
    const observation = emptyObservation();
    let completed = false;
    return {
        observe(event: { event: string | null; data: string }) {
            const data = parseJsonEvent(event.data);
            if (!data) return;
            const type = typeof data.type === "string" ? data.type : event.event ?? "";
            if (type === "response.created" || type === "response.in_progress") {
                readResponse(observation, data.response);
            } else if (type === "response.output_item.added") {
                observation.outputItems += 1;
            } else if (type.endsWith(".delta")) {
                appendProduced(observation, data.delta);
            } else if (TERMINAL_EVENTS.has(type)) {
                readResponse(observation, data.response);
                if (type === "response.failed") observation.providerError = true;
                else completed = true;
            } else if (type === "error") {
                observation.providerError = true;
            }
        },
        final(): NativeObservation {
            return { ...observation, terminal: completed };
        },
    };
};

export const observeResponsesJson = (json: unknown): NativeObservation => {
    const observation = emptyObservation();
    readResponse(observation, json);
    if (isRecord(json)) {
        observation.terminal = json.status === "completed" || json.status === "incomplete";
        observation.providerError = json.status === "failed";
        for (const item of Array.isArray(json.output) ? json.output : []) {
            if (!isRecord(item)) continue;
            appendProduced(observation, typeof item.arguments === "string" ? item.arguments : item.input);
            for (const part of Array.isArray(item.content) ? item.content : []) {
                if (isRecord(part)) appendProduced(observation, part.text);
            }
        }
    }
    return observation;
};

/** An SSE error event in the Responses stream's own shape. */
export const responsesErrorEvent = (code: string, message: string) =>
    `event: error\ndata: ${JSON.stringify({ type: "error", code, message, param: null })}\n\n`;
