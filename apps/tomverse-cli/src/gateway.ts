import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { Endpoint } from "./config.js";
import { CLI_VERSION } from "./version.js";

/**
 * The only network code in the CLI. Every request goes to the configured
 * endpoint's origin and below its API root; a redirect is never followed, so
 * the key cannot be carried to another address; and the AI SDK is given an
 * explicit provider instance with this base URL, key and fetch, so no
 * environment variable or default gateway can pick another destination.
 */

export type CatalogModel = {
    id: string;
    name: string;
    provider: string;
    tools: boolean;
    vision: boolean;
    reasoning: boolean;
    protocols: string[];
    contextWindowTokens: number;
    maxOutputTokens: number;
    creditsPerRequest: number;
};

type CatalogEntry = {
    id?: unknown;
    tomverse?: {
        name?: unknown;
        provider?: unknown;
        capabilities?: { tools?: unknown; vision?: unknown; reasoning?: unknown };
        protocols?: unknown;
        context_window_tokens?: unknown;
        max_output_tokens?: unknown;
        credits_per_request?: unknown;
    };
};

export type Receipt = {
    requestId: string;
    modelId: string;
    protocol: string;
    status: string;
    outcome: string | null;
    heldCredits: number;
    chargedCredits: number | null;
    finishReason: string | null;
    errorCode: string | null;
    createdAt: string;
    completedAt: string | null;
    usage: { inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number } | null;
};

export type GatewayErrorKind = "http" | "network" | "tls" | "timeout" | "redirect" | "protocol" | "aborted";

export class GatewayError extends Error {
    constructor(
        readonly kind: GatewayErrorKind,
        message: string,
        readonly extra: { status?: number; code?: string; requestId?: string; retryAfter?: number } = {}
    ) {
        super(message);
    }
}

const TLS_CODES = new Set([
    "CERT_HAS_EXPIRED",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "CERT_NOT_YET_VALID",
]);

/** Turns a fetch failure into a message a person can act on. */
export const describeFetchFailure = (error: unknown, origin: string): GatewayError => {
    if (error instanceof GatewayError) return error;
    const name = (error as { name?: string })?.name;
    if (name === "AbortError") return new GatewayError("aborted", "The request was cancelled.");
    if (name === "TimeoutError") return new GatewayError("timeout", `No answer from ${origin} in time.`);
    const cause = (error as { cause?: { code?: string } })?.cause;
    const code = cause?.code;
    if (code && TLS_CODES.has(code)) {
        return new GatewayError("tls", `The TLS certificate of ${origin} could not be verified (${code}). Nothing was sent.`);
    }
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new GatewayError("network", `Cannot resolve ${origin} (${code}).`);
    if (code === "ECONNREFUSED") return new GatewayError("network", `${origin} refused the connection.`);
    return new GatewayError("network", `Could not reach ${origin}${code ? ` (${code})` : ""}.`);
};

const readError = async (response: Response) => {
    const requestId = response.headers.get("x-request-id") ?? undefined;
    const retryAfter = Number(response.headers.get("retry-after")) || undefined;
    let code: string | undefined;
    let message = `The API answered ${response.status}.`;
    try {
        const body = (await response.json()) as { error?: { message?: string; code?: string } };
        if (body.error?.code) code = body.error.code;
        if (body.error?.message) message = body.error.message;
    } catch {
        // Not JSON: keep the status line.
    }
    return new GatewayError("http", message, { status: response.status, code, requestId, retryAfter });
};

export type GenerationIntent = {
    /** Sent as Idempotency-Key; unique per generation, recorded before sending. */
    idempotencyKey: string;
};

/**
 * What the session journal does around one generation request. Every call
 * the SDK makes to /chat/completions goes through these, in order:
 * `before` (durable intent; may refuse), then `headers` or `failed`, then
 * `ended` when the body has been read to its end or broke off.
 */
export type GenerationHooks = {
    before(): Promise<GenerationIntent>;
    headers(intent: GenerationIntent, info: { status: number; requestId: string | null; routedModel: string | null }): Promise<void>;
    failed(intent: GenerationIntent, error: GatewayError): Promise<void>;
    ended(intent: GenerationIntent, how: "complete" | "interrupted"): Promise<void>;
};

export class Gateway {
    constructor(
        readonly endpoint: Endpoint,
        private readonly key: string,
        private readonly fetchImpl: typeof fetch = globalThis.fetch
    ) {}

    /** Builds a URL under the API root, refusing anything that leaves it. */
    url(path: string) {
        const url = new URL(`${this.endpoint.base}${path}`);
        if (url.origin !== this.endpoint.origin || !url.pathname.startsWith(`${this.endpoint.basePath}/`)) {
            throw new GatewayError("protocol", "Refused a request outside the configured API endpoint.");
        }
        return url;
    }

    private async send(url: URL, init: RequestInit & { timeoutMs?: number }) {
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${this.key}`);
        headers.set("user-agent", `tomverse-cli/${CLI_VERSION}`);
        const signals = [init.signal, init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : undefined].filter(
            (s): s is AbortSignal => Boolean(s)
        );
        let response: Response;
        try {
            response = await this.fetchImpl(url, {
                ...init,
                headers,
                redirect: "manual",
                signal: signals.length ? AbortSignal.any(signals) : undefined,
            });
        } catch (error) {
            throw describeFetchFailure(error, this.endpoint.origin);
        }
        if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel().catch(() => undefined);
            throw new GatewayError(
                "redirect",
                `${this.endpoint.origin} answered with a redirect. The CLI does not follow redirects, so your key is never sent anywhere else; set the exact API endpoint.`,
                { status: response.status }
            );
        }
        return response;
    }

    private async getJson<T>(path: string, init: { headers?: Record<string, string>; signal?: AbortSignal } = {}) {
        const response = await this.send(this.url(path), { method: "GET", ...init, timeoutMs: 20_000 });
        if (!response.ok) throw await readError(response);
        try {
            return (await response.json()) as T;
        } catch {
            throw new GatewayError("protocol", `The API answered ${path} with something that is not JSON. Is the endpoint right?`);
        }
    }

    async models(): Promise<CatalogModel[]> {
        const body = await this.getJson<{ data?: CatalogEntry[] }>("/models");
        if (!Array.isArray(body.data)) throw new GatewayError("protocol", "The model list has an unexpected shape.");
        return body.data.map((entry) => ({
            id: String(entry.id),
            name: String(entry.tomverse?.name ?? entry.id),
            provider: String(entry.tomverse?.provider ?? "unknown"),
            tools: entry.tomverse?.capabilities?.tools === true,
            vision: entry.tomverse?.capabilities?.vision === true,
            reasoning: entry.tomverse?.capabilities?.reasoning === true,
            protocols: Array.isArray(entry.tomverse?.protocols) ? (entry.tomverse.protocols as unknown[]).map(String) : [],
            contextWindowTokens: Number(entry.tomverse?.context_window_tokens ?? 0),
            maxOutputTokens: Number(entry.tomverse?.max_output_tokens ?? 0),
            creditsPerRequest: Number(entry.tomverse?.credits_per_request ?? 0),
        }));
    }

    usage(limit = 20) {
        return this.getJson<{
            key: null | {
                prefix: string;
                name: string;
                credit_cap: number | null;
                committed_credits: number;
                held_credits: number;
                remaining_cap_credits: number | null;
                expires_at: string | null;
            };
            requests: Receipt[];
        }>(`/usage?limit=${limit}`);
    }

    /**
     * One request of this key, by receipt id or by the Idempotency-Key the CLI
     * recorded before sending it. `not_found` is not evidence it was never
     * sent: it may not have arrived or been admitted yet.
     */
    async requestStatus(selector: { requestId: string } | { idempotencyKey: string }): Promise<{ found: true; receipt: Receipt } | { found: false }> {
        const path = "requestId" in selector ? `/requests/status?request_id=${encodeURIComponent(selector.requestId)}` : "/requests/status";
        const headers: Record<string, string> = "idempotencyKey" in selector ? { "idempotency-key": selector.idempotencyKey } : {};
        try {
            const body = await this.getJson<{ request: Receipt }>(path, { headers });
            return { found: true, receipt: body.request };
        } catch (error) {
            if (error instanceof GatewayError && error.extra.status === 404 && error.extra.code === "request_not_found") return { found: false };
            throw error;
        }
    }

    /**
     * The fetch the AI SDK uses for generations. Only POST /chat/completions
     * is allowed; each call gets its own durable intent and Idempotency-Key
     * before anything is sent, and the outcome is reported back.
     */
    generationFetch(hooks: GenerationHooks): typeof fetch {
        const allowed = this.url("/chat/completions").href;
        return (async (input: string | URL | Request, init?: RequestInit) => {
            const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (href !== allowed || (init?.method ?? "GET").toUpperCase() !== "POST") {
                throw new GatewayError("protocol", "Refused a model request outside POST /chat/completions.");
            }
            const intent = await hooks.before();
            const headers = new Headers(init?.headers);
            // The SDK's own key header is replaced by send(); one source of truth.
            headers.delete("authorization");
            headers.set("idempotency-key", intent.idempotencyKey);
            let response: Response;
            try {
                response = await this.send(new URL(allowed), { ...init, headers });
            } catch (error) {
                const failure = error instanceof GatewayError ? error : describeFetchFailure(error, this.endpoint.origin);
                await hooks.failed(intent, failure);
                throw failure;
            }
            await hooks.headers(intent, {
                status: response.status,
                requestId: response.headers.get("x-request-id"),
                routedModel: response.headers.get("x-tomverse-routed-model"),
            });
            if (!response.body) {
                await hooks.ended(intent, "complete");
                return response;
            }
            const reader = response.body.getReader();
            let settled = false;
            const end = async (how: "complete" | "interrupted") => {
                if (settled) return;
                settled = true;
                await hooks.ended(intent, how);
            };
            const body = new ReadableStream<Uint8Array>({
                async pull(controller) {
                    try {
                        const next = await reader.read();
                        if (next.done) {
                            await end("complete");
                            controller.close();
                        } else controller.enqueue(next.value);
                    } catch (error) {
                        await end("interrupted");
                        controller.error(error);
                    }
                },
                async cancel(reason) {
                    await end("interrupted");
                    await reader.cancel(reason).catch(() => undefined);
                },
            });
            return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
        }) as typeof fetch;
    }

    /** The explicit Chat Completions model; never a model string or default provider. */
    chatModel(modelId: string, hooks: GenerationHooks): LanguageModel {
        const provider = createOpenAI({
            baseURL: this.endpoint.base,
            // Sent by send(), not by the SDK; set so the SDK never reads OPENAI_API_KEY.
            apiKey: "tomverse-cli-key-is-added-by-the-transport",
            name: "tomverse",
            fetch: this.generationFetch(hooks),
        });
        return provider.chat(modelId);
    }
}
