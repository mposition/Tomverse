/**
 * The pure part of Smart Adaptive as a coding router: what the router reads
 * of a request, how a conversation is known, and the rule that its model only
 * moves up. The routing itself is in lib/externalApiSmartAdaptive.ts (Chat
 * Completions) and lib/externalApiNativeSmartAdaptive.ts (Claude Code, Codex).
 */
import { createHash } from "node:crypto";
import { boundedToolResult, type CodingRouterContext } from "@/lib/autoLlmRouterCore";
import { estimateTextTokens } from "@/lib/chatTokenEstimate";
import { estimateNativeInput, isRecord } from "@/lib/externalApiNativeCore";
import { NATIVE_PROTOCOL_PROVIDER } from "@/lib/externalApiProtocols";
import { toolCallText, type ChatCompletionRequest } from "@/lib/openAiChatProtocol";

export type NativeSmartProtocol = keyof typeof NATIVE_PROTOCOL_PROVIDER;

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);

/**
 * Within one conversation the model only moves up: the router's pick, unless
 * it costs fewer credits than the model already working on the conversation.
 * A switch mid-task loses the cache and the reasoning; a task that needs more
 * can still move to a stronger model.
 */
export const escalateOnly = <E extends { capabilities: { creditWeight: number } }>(
    current: E | undefined,
    picked: E
): { entry: E; held: boolean } =>
    current && picked.capabilities.creditWeight < current.capabilities.creditWeight
        ? { entry: current, held: true }
        : { entry: picked, held: false };

/**
 * Whether a conversation's remembered model may become one costing
 * `nextCredits`, once admission accepted it. Checked when it is written, not
 * only when it was picked: two messages of one conversation can be routed at
 * once, and the dearer pick admitted first must not be overwritten by the
 * cheaper one admitted after it. `onlyUp` is false when the remembered model
 * could no longer take the request (window, retirement), so the memory may
 * then move to whatever answered.
 */
export const conversationModelMayMove = (
    existing: { creditWeight: number; at: number } | undefined,
    nextCredits: number,
    now: number,
    ttlMs: number,
    onlyUp: boolean
) => !onlyUp || !existing || now - existing.at >= ttlMs || nextCredits >= existing.creditWeight;

// ---- Chat Completions ----

export const chatText = (content: unknown): string =>
    typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
                .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
                .filter(Boolean)
                .join("\n")
          : "";

/** A rough size of the request, to leave out models it cannot fit and to tell the router. */
export const estimatedChatInputTokens = (request: ChatCompletionRequest) =>
    estimateTextTokens(
        request.messages
            .map((message) =>
                [
                    chatText(message.content),
                    ...(message.role === "assistant" ? (message.tool_calls ?? []).map(toolCallText) : []),
                ].join("\n")
            )
            .join("\n") + JSON.stringify(request.tools ?? [])
    );

/** The conversation this request belongs to: its key and the opening of its history. */
export const smartAdaptiveConversationKey = (keyId: string, request: ChatCompletionRequest) => {
    const firstAnswer = request.messages.findIndex((message) => message.role === "assistant");
    const opening = firstAnswer < 0 ? request.messages : request.messages.slice(0, firstAnswer);
    return `${keyId}\0${digest(JSON.stringify(opening))}`;
};

/** What the coding router reads of a Chat Completions request besides the message. */
export const smartAdaptiveCodingContext = (
    request: ChatCompletionRequest,
    userAgent: string | null,
    currentModelId: string | null
): CodingRouterContext => {
    let lastToolResult: string | null = null;
    for (let index = request.messages.length - 1; index >= 0; index -= 1) {
        const message = request.messages[index];
        if (message.role === "tool") {
            lastToolResult = boundedToolResult(chatText(message.content));
            break;
        }
    }
    return {
        client: userAgent?.slice(0, 80) || null,
        toolCount: request.tools?.length ?? 0,
        modelTurns: request.messages.filter((message) => message.role === "assistant").length,
        inputTokens: estimatedChatInputTokens(request),
        lastToolResult,
        currentModelId,
    };
};

// ---- Native protocols ----

/** Items a provider produced: their presence means the conversation is under way. */
const RESPONSES_OUTPUT_TYPES = new Set(["reasoning", "compaction", "item_reference"]);
const isResponsesOutput = (item: unknown) =>
    isRecord(item) &&
    (item.role === "assistant" ||
        (typeof item.type === "string" &&
            (RESPONSES_OUTPUT_TYPES.has(item.type) || item.type.endsWith("_call") || item.type.endsWith("_call_output"))));

export const nativeHistory = (protocol: NativeSmartProtocol, body: Record<string, unknown>): unknown[] => {
    if (protocol === "anthropic_messages") return Array.isArray(body.messages) ? body.messages : [];
    if (Array.isArray(body.input)) return body.input;
    return typeof body.input === "string" ? [{ role: "user", content: body.input }] : [];
};

export const isNativeOutput = (protocol: NativeSmartProtocol, item: unknown) =>
    protocol === "anthropic_messages" ? isRecord(item) && item.role === "assistant" : isResponsesOutput(item);

export const nativeText = (content: unknown): string =>
    typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
                .map((part) =>
                    isRecord(part) &&
                    (part.type === "text" || part.type === "input_text" || part.type === "output_text") &&
                    typeof part.text === "string"
                        ? part.text
                        : ""
                )
                .filter(Boolean)
                .join("\n")
          : "";

/** The index of the latest user item that carries text, or -1. */
const latestUserTextIndex = (items: readonly unknown[]) => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (isRecord(item) && item.role === "user" && nativeText(item.content)) return index;
    }
    return -1;
};

/** The latest user text, for the router. */
export const nativeLatestPrompt = (protocol: NativeSmartProtocol, body: Record<string, unknown>) => {
    const items = nativeHistory(protocol, body);
    const index = latestUserTextIndex(items);
    return index < 0 ? "" : nativeText((items[index] as Record<string, unknown>).content);
};

/** The assistant text just before the latest user text, as Chat Completions passes it. */
export const nativePreviousAnswer = (protocol: NativeSmartProtocol, body: Record<string, unknown>): string | null => {
    const items = nativeHistory(protocol, body);
    for (let index = latestUserTextIndex(items) - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (!isRecord(item)) continue;
        if (item.role === "user" && nativeText(item.content)) return null;
        if (item.role === "assistant") {
            const text = nativeText(item.content).trim();
            if (text) return text;
        }
    }
    return null;
};

/**
 * Whether the request ends with a message the user wrote, rather than a tool
 * round (Anthropic: a user message carrying a tool_result; Responses: a tool
 * output item). Read from the structure, never the text.
 */
export const nativeUserTurn = (protocol: NativeSmartProtocol, body: Record<string, unknown>) => {
    const items = nativeHistory(protocol, body);
    const last = items[items.length - 1];
    if (!isRecord(last) || last.role !== "user") return false;
    if (protocol !== "anthropic_messages") return last.type === undefined || last.type === "message";
    return !(Array.isArray(last.content) && last.content.some((part) => isRecord(part) && part.type === "tool_result"));
};

/** The latest tool result's text: an Anthropic tool_result block, or a Responses tool output. */
const latestNativeToolResult = (protocol: NativeSmartProtocol, body: Record<string, unknown>): string | null => {
    const items = nativeHistory(protocol, body);
    for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (!isRecord(item)) continue;
        if (protocol === "anthropic_messages") {
            const blocks = Array.isArray(item.content) ? item.content : [];
            for (let at = blocks.length - 1; at >= 0; at -= 1) {
                const block = blocks[at];
                if (isRecord(block) && block.type === "tool_result") {
                    return typeof block.content === "string" ? block.content : nativeText(block.content);
                }
            }
        } else if (typeof item.type === "string" && item.type.endsWith("_call_output")) {
            return typeof item.output === "string" ? item.output : nativeText(item.output);
        }
    }
    return null;
};

/** What the coding router reads of a native request besides the message. */
export const nativeCodingContext = (
    protocol: NativeSmartProtocol,
    userAgent: string | null,
    body: Record<string, unknown>,
    currentModelId: string | null
): CodingRouterContext => {
    const items = nativeHistory(protocol, body);
    return {
        client: userAgent?.slice(0, 80) || null,
        toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
        modelTurns: items.filter((item) => isNativeOutput(protocol, item)).length,
        // The gateway's own estimate: tools counted, images and files by their own rules.
        inputTokens: estimateNativeInput(body, NATIVE_PROTOCOL_PROVIDER[protocol]).breakdown.rawTotal,
        lastToolResult: boundedToolResult(latestNativeToolResult(protocol, body)),
        currentModelId,
    };
};
