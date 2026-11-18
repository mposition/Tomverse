import "server-only";
import {
    ANTHROPIC_VERSION_DEFAULT,
    anthropicErrorBody,
    anthropicErrorEvent,
    createAnthropicStreamObserver,
    observeAnthropicMessage,
    prepareAnthropicMessages,
} from "@/lib/anthropicMessagesProtocol";
import { externalApiErrorResponse } from "@/lib/externalApiInference";
import type { NativeProtocolSpec } from "@/lib/externalApiNative";
import {
    createResponsesStreamObserver,
    observeResponsesJson,
    prepareResponsesRequest,
    responsesErrorEvent,
} from "@/lib/openAiResponsesProtocol";

/** The two native protocols, as configuration of the one lifecycle. */

const anthropicError: typeof externalApiErrorResponse = (status, message, code, extra) => {
    const headers = new Headers({ "Cache-Control": "no-store", "Content-Type": "application/json" });
    if (extra?.requestId) {
        headers.set("x-request-id", extra.requestId);
        headers.set("request-id", extra.requestId);
    }
    if (extra?.retryAfter) headers.set("Retry-After", String(extra.retryAfter));
    return new Response(JSON.stringify(anthropicErrorBody(status, message, code, extra?.details)), { status, headers });
};

/** Only the query Claude Code sends on Messages; anything else stays here. */
const anthropicPath = (base: string) => (request: Request) =>
    new URL(request.url).searchParams.get("beta") === "true" ? `${base}?beta=true` : base;

const anthropicHeaders = (request: Request): Record<string, string> => {
    // anthropic-beta is forwarded as sent: Claude Code pairs beta values with
    // body fields, and filtering one half yields a 400. The cost-bearing
    // features those betas unlock are checked in the body instead.
    const beta = request.headers.get("anthropic-beta");
    return {
        "anthropic-version": request.headers.get("anthropic-version") ?? ANTHROPIC_VERSION_DEFAULT,
        ...(beta ? { "anthropic-beta": beta } : {}),
        accept: request.headers.get("accept") ?? "application/json",
    };
};

export const anthropicMessagesSpec: NativeProtocolSpec = {
    protocol: "anthropic_messages",
    provider: "anthropic",
    upstreamPath: anthropicPath("/v1/messages"),
    upstreamHeaders: anthropicHeaders,
    responseHeaders: (requestId) => ({ "request-id": requestId }),
    acceptsXApiKey: true,
    render: anthropicError,
    prepare: (body, model) => prepareAnthropicMessages(body, model),
    createObserver: createAnthropicStreamObserver,
    observeJson: observeAnthropicMessage,
    streamErrorEvent: (status, _code, message) => anthropicErrorEvent(status, message),
};

export const anthropicCountTokensPath = anthropicPath("/v1/messages/count_tokens");

export const responsesSpec: NativeProtocolSpec = {
    protocol: "responses",
    provider: "openai",
    upstreamPath: () => "/responses",
    upstreamHeaders: (_request, prepared) => ({ accept: prepared.stream ? "text/event-stream" : "application/json" }),
    render: externalApiErrorResponse,
    prepare: prepareResponsesRequest,
    createObserver: createResponsesStreamObserver,
    observeJson: observeResponsesJson,
    streamErrorEvent: (_status, code, message) => responsesErrorEvent(code, message),
};
