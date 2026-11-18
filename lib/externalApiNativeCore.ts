import { estimateNativeAttachmentTokens } from "@/lib/chatAttachmentTokens";
import { estimateImageInputTokens, readImageDimensions } from "@/lib/chatImageInputTokens";
import { atLeastOneToken, createTokenEstimateAccumulator, type TokenEstimateBreakdown } from "@/lib/chatTokenEstimate";

/**
 * What the native-protocol adapters (Anthropic Messages for Claude Code,
 * OpenAI Responses for Codex) share, kept pure so the parsers are tested
 * without a server. See docs/policy/external-api.md, "Native protocols".
 *
 * The adapters pass the client's body through unchanged except for the fields
 * that decide money or reach: the model id, the output limit and (Responses)
 * `store`. Everything else -- tool schemas, thinking signatures, encrypted
 * reasoning, beta fields the client pairs with its headers -- goes upstream
 * byte-for-byte in meaning, because a translation layer would break the
 * client's own state and fall behind every client release.
 */

export const EXTERNAL_API_PROTOCOLS = ["chat_completions", "anthropic_messages", "responses"] as const;
export type ExternalApiProtocol = (typeof EXTERNAL_API_PROTOCOLS)[number];

/** Which runtime providers a native protocol can carry without translation. */
export const NATIVE_PROTOCOL_PROVIDER: Record<Exclude<ExternalApiProtocol, "chat_completions">, string> = {
    anthropic_messages: "anthropic",
    responses: "openai",
};

/** Every protocol a model of this provider can be called through. */
export const protocolsForProvider = (provider: string): ExternalApiProtocol[] => [
    "chat_completions",
    ...(Object.entries(NATIVE_PROTOCOL_PROVIDER)
        .filter(([, owner]) => owner === provider)
        .map(([protocol]) => protocol as ExternalApiProtocol)),
];

type Env = Record<string, string | undefined>;

/**
 * Each native family has its own default-off switch on top of
 * EXTERNAL_API_ENABLED, the allowlist and the Admin switches.
 */
export const nativeProtocolEnabled = (env: Env, protocol: Exclude<ExternalApiProtocol, "chat_completions">) =>
    protocol === "anthropic_messages"
        ? env.EXTERNAL_API_ANTHROPIC_ENABLED === "true"
        : env.EXTERNAL_API_RESPONSES_ENABLED === "true";

/**
 * The request digest that tells a retry from a reuse of an Idempotency-Key.
 * Chat Completions keeps the bare body digest its receipts were written with;
 * a native protocol prefixes its name, so one key reused across endpoints is
 * a different request (a conflict), never a replay of the other one.
 */
export const requestDigestInput = (protocol: ExternalApiProtocol, raw: string) =>
    protocol === "chat_completions" ? raw : `${protocol}\n${raw}`;

/** A refusal raised before dispatch; each adapter renders it in its own shape. */
export class NativeProtocolError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
        readonly param: string | null = null
    ) {
        super(message);
        this.name = "NativeProtocolError";
    }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Server-sent events, decoded across arbitrary chunk boundaries. Feed it text
 * from a streaming TextDecoder; it calls back once per complete event.
 */
export const createSseParser = (onEvent: (event: { event: string | null; data: string }) => void) => {
    let buffer = "";
    let eventName: string | null = null;
    let data: string[] = [];
    const dispatch = () => {
        if (data.length) onEvent({ event: eventName, data: data.join("\n") });
        eventName = null;
        data = [];
    };
    const line = (text: string) => {
        if (text === "") return dispatch();
        if (text.startsWith(":")) return;
        const colon = text.indexOf(":");
        const field = colon === -1 ? text : text.slice(0, colon);
        let value = colon === -1 ? "" : text.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") eventName = value;
        else if (field === "data") data.push(value);
    };
    return {
        push(chunk: string) {
            buffer += chunk;
            for (;;) {
                const newline = buffer.search(/\r\n|\r|\n/);
                if (newline === -1) break;
                const width = buffer.startsWith("\r\n", newline) ? 2 : 1;
                // A lone \r at the very end may be the first half of \r\n.
                if (width === 1 && buffer[newline] === "\r" && newline === buffer.length - 1) break;
                line(buffer.slice(0, newline));
                buffer = buffer.slice(newline + width);
            }
        },
        end() {
            if (buffer) line(buffer);
            buffer = "";
            dispatch();
        },
    };
};

export const parseJsonEvent = (data: string): Record<string, unknown> | null => {
    try {
        const parsed = JSON.parse(data);
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
};

/**
 * Fields whose value is opaque provider state: a thinking signature, a
 * redacted thinking block, encrypted reasoning or compaction output. Their
 * text means nothing to a tokenizer estimate, but they stand for context the
 * provider will bill, so they count at bytes/4 -- above the ciphertext's own
 * token density, the safe direction for a reservation.
 */
const OPAQUE_KEYS = new Set(["signature", "encrypted_content", "redacted_thinking"]);

const BASE64_DATA_URL = /^data:([^;,]+)?;base64,/;

/**
 * Everything a native body sends the provider, as a token estimate: every
 * string and every object key (tool schemas are mostly keys), images by their
 * measured size, other inline files at the flat per-attachment allowance, and
 * opaque state by length. Mirrors the Chat Completions estimate: the measured
 * image size counts against the input limit, the rest of the flat image
 * allowance goes to the reservation only.
 */
export const estimateNativeInput = (
    payload: unknown,
    provider: string
): { breakdown: TokenEstimateBreakdown; reservationOnlyInputTokens: number; images: number; files: number } => {
    const estimate = createTokenEstimateAccumulator();
    let measuredImageTokens = 0;
    let images = 0;
    let files = 0;
    const addImage = (base64: string) => {
        images += 1;
        let bytes: Uint8Array;
        try {
            bytes = Buffer.from(base64, "base64");
        } catch {
            bytes = new Uint8Array();
        }
        const tokens = estimateImageInputTokens(provider, readImageDimensions(bytes));
        measuredImageTokens += tokens;
        estimate.addTokens(tokens);
    };
    const visit = (value: unknown, key: string | null, parent: Record<string, unknown> | null) => {
        if (typeof value === "string") {
            if (key && OPAQUE_KEYS.has(key)) return void estimate.addTokens(Math.ceil(value.length / 4));
            // Anthropic: { type: "image", source: { type: "base64", data } }.
            if (key === "data" && parent?.type === "base64") {
                return void (String(parent.media_type ?? "").startsWith("image/")
                    ? addImage(value)
                    : ((files += 1), estimate.addTokens(estimateNativeAttachmentTokens(1))));
            }
            // A redacted thinking block's payload.
            if (key === "data" && parent?.type === "redacted_thinking") {
                return void estimate.addTokens(Math.ceil(value.length / 4));
            }
            // Responses: input_image.image_url / input_file.file_data as data URLs.
            const dataUrl = BASE64_DATA_URL.exec(value);
            if (dataUrl && (key === "image_url" || key === "file_data" || key === "url")) {
                const payloadText = value.slice(dataUrl[0].length);
                return void ((dataUrl[1] ?? "").startsWith("image/")
                    ? addImage(payloadText)
                    : ((files += 1), estimate.addTokens(estimateNativeAttachmentTokens(1))));
            }
            return void estimate.addText(value);
        }
        if (Array.isArray(value)) {
            estimate.addTokens(1);
            for (const item of value) visit(item, null, null);
            return;
        }
        if (isRecord(value)) {
            estimate.addTokens(2);
            for (const [childKey, child] of Object.entries(value)) {
                estimate.addText(childKey);
                visit(child, childKey, value);
            }
            return;
        }
        if (typeof value === "number" || typeof value === "boolean") estimate.addTokens(1);
    };
    visit(payload, null, null);
    return {
        breakdown: atLeastOneToken(estimate.breakdown()),
        reservationOnlyInputTokens: Math.max(0, estimateNativeAttachmentTokens(images) - measuredImageTokens),
        images,
        files,
    };
};

/** Visits every object in a JSON value, depth first. */
export const forEachObject = (value: unknown, visit: (object: Record<string, unknown>, key: string | null) => void, key: string | null = null) => {
    if (Array.isArray(value)) {
        for (const item of value) forEachObject(item, visit, key);
    } else if (isRecord(value)) {
        visit(value, key);
        for (const [childKey, child] of Object.entries(value)) forEachObject(child, visit, childKey);
    }
};

/**
 * The output limit sent to the provider, which is also the output the
 * reservation prices. A client that asks for more than the model gives through
 * Tomverse, or for nothing, gets the model's limit -- never a provider limit
 * larger than what was reserved.
 */
export const effectiveOutputLimit = (requested: unknown, modelMaxOutputTokens: number, param: string) => {
    if (requested === undefined || requested === null) return { limit: modelMaxOutputTokens, clamped: false };
    if (!Number.isSafeInteger(requested) || (requested as number) < 1) {
        throw new NativeProtocolError(400, "invalid_request", `${param} must be a positive integer.`, param);
    }
    const value = requested as number;
    return value > modelMaxOutputTokens
        ? { limit: modelMaxOutputTokens, clamped: true }
        : { limit: value, clamped: false };
};

/**
 * Upstream error text that may describe Tomverse's own provider account (its
 * balance, limits, organisation or keys) rather than the client's request.
 */
const ACCOUNT_DETAIL = /credit|balance|billing|quota|organi[sz]ation|workspace|api[ _-]?key|x-api-key|rate limit|tier|spend|invoice|payment/i;

/**
 * What of an upstream error the client may see. A request the provider found
 * invalid keeps the provider's own message: Claude Code and Codex recover from
 * specific 400s (a thinking signature, an unsupported field) by reading it.
 * Anything about Tomverse's provider account, limits or availability is
 * replaced with a neutral message.
 */
export const publicUpstreamError = (status: number, message: unknown) => {
    const text = typeof message === "string" ? message.slice(0, 2_000) : "";
    const clientFault = [400, 404, 413, 422].includes(status);
    if (clientFault && text && !ACCOUNT_DETAIL.test(text)) {
        return { status, message: text, kind: "invalid_request" as const };
    }
    if (clientFault) {
        return { status, message: "The model provider could not accept this request.", kind: "invalid_request" as const };
    }
    if (status === 408 || status === 504) {
        return { status: 504, message: "The model provider did not respond in time.", kind: "timeout" as const };
    }
    return { status: 529, message: "The model provider is temporarily unavailable. Try again shortly.", kind: "unavailable" as const };
};

/**
 * Whether a provider HTTP refusal is evidence nothing was billed: any 4xx but
 * a timeout. A 5xx or 408 may come after the work was done.
 */
export const upstreamRefusedBeforeWork = (status: number) => status >= 400 && status < 500 && status !== 408;

/** Usage in the shared ledger's terms: input includes cache reads and writes. */
export type NativeUsage = {
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
};

export type NativeObservation = {
    /** The provider's terminal success event (or a complete JSON body). */
    terminal: boolean;
    /** A terminal or in-stream error event from the provider. */
    providerError: boolean;
    finishReason: string | null;
    usage: NativeUsage | null;
    /** Bytes of produced text, thinking and tool input seen in deltas. */
    producedBytes: number;
    producedText: string;
    /** Content blocks or output items of any kind (text, tool, reasoning). */
    outputItems: number;
    providerResponseId: string | null;
};

export const emptyObservation = (): NativeObservation => ({
    terminal: false,
    providerError: false,
    finishReason: null,
    usage: null,
    producedBytes: 0,
    producedText: "",
    outputItems: 0,
    providerResponseId: null,
});

/** Keeps only a bounded sample of produced text for the cancellation estimate. */
export const appendProduced = (observation: NativeObservation, text: unknown) => {
    if (typeof text !== "string" || !text) return;
    observation.producedBytes += Buffer.byteLength(text, "utf8");
    if (observation.producedText.length < 200_000) observation.producedText += text;
};

const nonNegative = (value: unknown) => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined);
export { nonNegative };
