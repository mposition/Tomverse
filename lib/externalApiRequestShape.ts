/**
 * Content-free descriptions of a Chat Completions request and of a stream
 * failure, for finding out what a client (Cursor) really sends. Behind
 * EXTERNAL_API_REQUEST_SHAPE_LOG, default off, meant for dev only and to be
 * removed once the client works. Field names, types, counts, tool kinds and
 * names, and numbers and booleans are kept; no message text, code, argument,
 * schema body or header value ever is.
 */

export const requestShapeLogEnabled = (env: Record<string, string | undefined>) =>
    env.EXTERNAL_API_REQUEST_SHAPE_LOG === "true";

const typeOf = (value: unknown) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
/** Identifiers only: a tool name, a model id, an enum value. Anything else is withheld. */
const SAFE_TOKEN = /^[A-Za-z0-9_.:/-]{1,80}$/;
const token = (value: unknown) => (typeof value === "string" && SAFE_TOKEN.test(value) ? value : value === undefined ? undefined : `<${typeOf(value)}>`);
/** Numbers and booleans as they are; every other value as its type. */
const scalar = (value: unknown) => (typeof value === "number" || typeof value === "boolean" ? value : typeOf(value));

const keysWithTypes = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, typeOf(entry)]));

const describeTool = (tool: unknown) => {
    if (!isRecord(tool)) return typeOf(tool);
    const inner = isRecord(tool.function) ? tool.function : isRecord(tool.custom) ? tool.custom : null;
    const format = isRecord(inner?.format) ? inner.format : isRecord(tool.format) ? tool.format : null;
    return {
        type: token(tool.type),
        name: token(inner?.name ?? tool.name),
        keys: keysWithTypes(tool),
        ...(inner ? { innerKeys: keysWithTypes(inner) } : {}),
        ...(format ? { format: { type: token(format.type), keys: Object.keys(format) } } : {}),
    };
};

const describeContent = (content: unknown) =>
    Array.isArray(content) ? content.map((part) => (isRecord(part) ? token(part.type) : typeOf(part))) : typeOf(content);

const describeMessage = (message: unknown) => {
    if (!isRecord(message)) return typeOf(message);
    return {
        role: token(message.role),
        keys: Object.keys(message),
        content: describeContent(message.content),
        ...(Array.isArray(message.tool_calls)
            ? {
                  toolCalls: message.tool_calls.map((call) =>
                      isRecord(call) ? { type: token(call.type), keys: Object.keys(call), name: token((isRecord(call.function) ? call.function : isRecord(call.custom) ? call.custom : call).name) } : typeOf(call)
                  ),
              }
            : {}),
    };
};

export const describeRequestShape = (body: unknown, headerNames: string[]) => {
    if (!isRecord(body)) return { body: typeOf(body), headers: headerNames };
    const top: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
        if (key === "messages" || key === "tools") continue;
        top[key] = key === "model" || key === "reasoning_effort" || key === "verbosity" ? token(value) : isRecord(value) ? keysWithTypes(value) : scalar(value);
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    return {
        top,
        headers: headerNames.sort(),
        tools: Array.isArray(body.tools) ? body.tools.map(describeTool) : typeOf(body.tools),
        messageCount: messages.length,
        // The first and last few are where a client's conventions show; the
        // middle of a long session repeats them.
        messages: messages.length > 24 ? [...messages.slice(0, 12), ...messages.slice(-12)].map(describeMessage) : messages.map(describeMessage),
    };
};

/**
 * A stream failure without its message: name, code, and the stack's frames
 * (function and file positions). A Node internal error's fixed message is kept
 * (`ERR_INVALID_STATE: Invalid state: Controller is already closed`).
 */
export const describeStreamFailure = (error: unknown) => {
    const value = error as { name?: unknown; code?: unknown; message?: unknown; stack?: unknown; cause?: unknown } | null;
    const code = typeof value?.code === "string" && /^[A-Z0-9_]{1,60}$/.test(value.code) ? value.code : undefined;
    const frames =
        typeof value?.stack === "string"
            ? value.stack
                  .split("\n")
                  .filter((line) => line.trimStart().startsWith("at "))
                  .slice(0, 15)
                  .map((line) => line.trim().slice(0, 200))
            : [];
    return {
        name: token(value?.name),
        code,
        ...(code?.startsWith("ERR_") && typeof value?.message === "string" ? { message: value.message.slice(0, 120) } : {}),
        frames,
        ...(value?.cause ? { cause: { name: token((value.cause as { name?: unknown }).name), code: token((value.cause as { code?: unknown }).code) } } : {}),
    };
};

/**
 * One emitted Chat Completions chunk as kinds only: `text`, `reasoning`,
 * `role`, a tool call's type, name and which payload field it carried
 * (`tool:custom:ApplyPatch:input`), `finish:<reason>`, `usage`. No text,
 * argument or input is kept.
 */
export const describeChunk = (chunk: unknown): string[] => {
    if (!isRecord(chunk)) return [typeOf(chunk)];
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    if (choices.length === 0) return [chunk.usage !== undefined ? "usage" : "empty"];
    const kinds: string[] = [];
    for (const choice of choices) {
        if (!isRecord(choice)) continue;
        const delta = isRecord(choice.delta) ? choice.delta : {};
        if (delta.role !== undefined) kinds.push("role");
        if (typeof delta.content === "string") kinds.push("text");
        if (typeof delta.reasoning_content === "string") kinds.push("reasoning");
        if (Array.isArray(delta.tool_calls)) {
            for (const call of delta.tool_calls) {
                if (!isRecord(call)) continue;
                const inner = isRecord(call.function) ? call.function : isRecord(call.custom) ? call.custom : {};
                const payload = "arguments" in inner ? "arguments" : "input" in inner ? "input" : "";
                kinds.push(["tool", call.type === undefined ? "+" : token(call.type), token(inner.name) ?? "", payload].join(":"));
            }
        }
        if (choice.finish_reason) kinds.push(`finish:${token(choice.finish_reason)}`);
    }
    return kinds.length ? kinds : ["empty"];
};

/** Consecutive repeats collapsed: ["text","text","text"] → ["text×3"]. */
export const collapseKinds = (kinds: readonly string[]) => {
    const out: string[] = [];
    let last = "";
    let count = 0;
    const flush = () => {
        if (count) out.push(count > 1 ? `${last}×${count}` : last);
    };
    for (const kind of kinds) {
        if (kind === last) count += 1;
        else {
            flush();
            last = kind;
            count = 1;
        }
    }
    flush();
    return out;
};
