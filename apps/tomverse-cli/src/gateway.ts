import { createOpenAI } from "@ai-sdk/openai";
import { isEffort, isExplicitEffort, type Effort } from "./effort.js";
import type { LanguageModel } from "ai";
import type { Endpoint } from "./config.js";
import { CLI_VERSION } from "./version.js";

/**
 * The network code for the Tomverse API (reading public web pages is src/web.ts,
 * approved per site). Every request goes to the configured
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
    reasoningEfforts?: Array<Exclude<Effort, "default">>;
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
        reasoning_efforts?: unknown;
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

/** What the web_search tool asks for: the same narrow input as Chat's search tool. */
export type WebSearchInput = {
    query: string | string[];
    country?: string;
    searchLang?: string;
    freshness?: "day" | "week" | "month" | "year";
};

/** The Tomverse API's answer to one web search (POST /web-search). Text in it is third-party and untrusted. */
export type WebSearchReply = {
    requestId: string | null;
    searches: Array<{
        query: string | null;
        status: string;
        results?: Array<{ title: string; url: string; snippet?: string; publishedAt?: string }>;
        reason?: string;
        truncated?: boolean;
    }>;
    sources: string[];
    notice: string | null;
    /** Credits the request was charged; null when the server could not say yet. */
    chargedCredits: number | null;
};

const textOf = (value: unknown, limit: number) => (typeof value === "string" && value ? value.slice(0, limit) : undefined);
const webUrl = (value: unknown) => {
    const url = textOf(value, 2_000);
    return url && /^https?:\/\//i.test(url) ? url : undefined;
};

/** Reads the reply defensively: anything not of the documented shape is dropped, never passed on as it came. */
const readWebSearchReply = (body: unknown): WebSearchReply => {
    const record = (body ?? {}) as Record<string, unknown>;
    if (record.object !== "tomverse.web_search" || !Array.isArray(record.searches)) {
        throw new GatewayError("protocol", "The web search answer has an unexpected shape.");
    }
    const searches = (record.searches as unknown[]).slice(0, 8).map((value) => {
        const entry = (value ?? {}) as Record<string, unknown>;
        const results = Array.isArray(entry.results) ? (entry.results as unknown[]).slice(0, 10).flatMap((item) => {
            const result = (item ?? {}) as Record<string, unknown>;
            const url = webUrl(result.url);
            if (!url) return [];
            const snippet = textOf(result.snippet, 2_000);
            const publishedAt = textOf(result.published_at, 40);
            return [{ title: textOf(result.title, 300) ?? url, url, ...(snippet ? { snippet } : {}), ...(publishedAt ? { publishedAt } : {}) }];
        }) : undefined;
        const reason = textOf(entry.reason, 80);
        return {
            query: textOf(entry.query, 500) ?? null,
            status: textOf(entry.status, 40) ?? "failed",
            ...(results ? { results } : {}),
            ...(reason ? { reason } : {}),
            ...(entry.truncated === true ? { truncated: true } : {}),
        };
    });
    const sources = Array.isArray(record.sources) ? (record.sources as unknown[]).flatMap((value) => webUrl(value) ?? []).slice(0, 25) : [];
    const charged = record.charged_credits;
    return {
        requestId: textOf(record.request_id, 80) ?? null,
        searches,
        sources,
        notice: textOf(record.notice, 1_000) ?? null,
        chargedCredits: typeof charged === "number" && Number.isSafeInteger(charged) && charged >= 0 ? charged : null,
    };
};

export type GatewayErrorKind = "http" | "network" | "tls" | "timeout" | "redirect" | "protocol" | "aborted" | "limit";

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
    transmission?(intent: GenerationIntent, body: unknown): void;
    headers(intent: GenerationIntent, info: { status: number; requestId: string | null; routedModel: string | null; appliedEffort?: Effort }): Promise<void>;
    failed(intent: GenerationIntent, error: GatewayError): Promise<void>;
    ended(intent: GenerationIntent, how: "complete" | "interrupted"): Promise<void>;
};

/**
 * A credential that is not a fixed key: Tomverse Desktop's signed-in session (docs/policy/external-api.md section
 * 11.2). `identity` is a stable, non-secret name for it -- what sessions are recorded and looked up under, as a key's
 * prefix is -- and `bearer` the access token in force now, read on every request because the app renews it; null
 * once the person signed out, and nothing is sent then. `headers` are what the server needs to read it as a Desktop
 * session (its origin).
 */
export type GatewayCredential = {
    identity: string;
    bearer: () => string | null;
    headers?: Readonly<Record<string, string>>;
};

export class Gateway {
    constructor(
        readonly endpoint: Endpoint,
        private readonly key: string | GatewayCredential,
        private readonly fetchImpl: typeof fetch = globalThis.fetch,
        private readonly client = `tomverse-cli/${CLI_VERSION}`,
        private readonly maximumKeyCreditCap?: number
    ) {
        if (maximumKeyCreditCap !== undefined && (!Number.isSafeInteger(maximumKeyCreditCap) || maximumKeyCreditCap <= 0)) {
            throw new GatewayError("protocol", "An approved continuation requires a positive credit cap.");
        }
    }

    /** The key's public prefix (a session's identity's): lookups only find requests of this key. */
    get keyPrefix() {
        return (typeof this.key === "string" ? this.key : this.key.identity).slice(0, 12);
    }

    /** Whether text carries this key, whole or its secret part (or the session's token): such text is never sent anywhere but as the credential itself. */
    carriesKey(text: string) {
        if (typeof this.key !== "string") {
            const bearer = this.key.bearer();
            return text.includes(this.key.identity) || (!!bearer && bearer.length >= 16 && text.includes(bearer));
        }
        const secret = this.key.slice(13);
        return text.includes(this.key) || (secret.length >= 16 && text.includes(secret));
    }

    /** The Authorization value in force now; a signed-out session refuses before anything is sent or recorded. */
    private authorization() {
        if (typeof this.key === "string") return `Bearer ${this.key}`;
        const bearer = this.key.bearer();
        if (!bearer) {
            throw new GatewayError("http", "Sign in to Tomverse Desktop to continue. Nothing was sent.", { status: 401, code: "desktop_session_required" });
        }
        return `Bearer ${bearer}`;
    }

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
        headers.set("authorization", this.authorization());
        if (typeof this.key !== "string") for (const [name, value] of Object.entries(this.key.headers ?? {})) headers.set(name, value);
        headers.set("user-agent", this.client);
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

    private async getJson<T>(path: string, { requireCappedContinuation, ...init }: {
        headers?: Record<string, string>; signal?: AbortSignal; requireCappedContinuation?: boolean;
    } = {}) {
        const response = await this.send(this.url(path), { method: "GET", ...init, timeoutMs: 20_000 });
        if (!response.ok) throw await readError(response);
        if (requireCappedContinuation && response.headers.get("x-tomverse-code-capped-continuation") !== "key-cap-v1") {
            await response.body?.cancel().catch(() => undefined);
            throw new GatewayError("protocol", "The Code API has not enabled capped continuation.");
        }
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
            reasoningEfforts: Array.isArray(entry.tomverse?.reasoning_efforts)
                ? entry.tomverse.reasoning_efforts.filter(isExplicitEffort) : undefined,
            protocols: Array.isArray(entry.tomverse?.protocols) ? (entry.tomverse.protocols as unknown[]).map(String) : [],
            contextWindowTokens: Number(entry.tomverse?.context_window_tokens ?? 0),
            maxOutputTokens: Number(entry.tomverse?.max_output_tokens ?? 0),
            creditsPerRequest: Number(entry.tomverse?.credits_per_request ?? 0),
        }));
    }

    usage(limit = 20, options?: { signal?: AbortSignal; requireCappedContinuation?: boolean }) {
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
        }>(`/usage?limit=${limit}`, options);
    }

    async verifyCappedContinuation(signal: AbortSignal) {
        const maximum = this.maximumKeyCreditCap;
        if (maximum === undefined) throw new GatewayError("protocol", "No continuation credit cap was approved.");
        const { key } = await this.usage(1, { signal, requireCappedContinuation: true });
        const cap = key?.credit_cap;
        const remaining = key?.remaining_cap_credits;
        if (key?.prefix !== this.keyPrefix || typeof cap !== "number" || !Number.isSafeInteger(cap) || cap <= 0 || cap > maximum ||
            typeof remaining !== "number" || !Number.isSafeInteger(remaining) || remaining <= 0 || remaining > cap) {
            throw new GatewayError("limit", "The API key needs available credits and a cap within the approved continuation limit.");
        }
        return { cap, remaining };
    }

    /**
     * One web search through the Tomverse API (POST /web-search), charged to this key's account like a request and
     * listed in its receipts. Never sent twice: the Idempotency-Key is the tool call's own, and a request whose answer
     * was lost is reported, not repeated (its receipt says whether it was charged).
     */
    async webSearch(input: WebSearchInput, idempotencyKey: string, signal: AbortSignal): Promise<WebSearchReply> {
        const body = {
            query: input.query,
            ...(input.country ? { country: input.country } : {}),
            ...(input.searchLang ? { search_lang: input.searchLang } : {}),
            ...(input.freshness ? { freshness: input.freshness } : {}),
        };
        const response = await this.send(this.url("/web-search"), {
            method: "POST",
            headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
            body: JSON.stringify(body),
            signal,
            timeoutMs: 90_000,
        });
        if (!response.ok) throw await readError(response);
        let parsed: unknown;
        try {
            parsed = await response.json();
        } catch {
            throw new GatewayError("protocol", "The web search answer is not JSON.");
        }
        return readWebSearchReply(parsed);
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
    generationFetch(hooks: GenerationHooks, effort?: Effort): typeof fetch {
        const allowed = this.url("/chat/completions").href;
        return (async (input: string | URL | Request, init?: RequestInit) => {
            const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (href !== allowed || (init?.method ?? "GET").toUpperCase() !== "POST") {
                throw new GatewayError("protocol", "Refused a model request outside POST /chat/completions.");
            }
            const requestBody = isExplicitEffort(effort) || this.maximumKeyCreditCap !== undefined
                ? JSON.stringify({
                    ...JSON.parse(String(init?.body)),
                    ...(isExplicitEffort(effort) ? { tomverse_effort: effort } : {}),
                    // Older servers reject this unknown body field before dispatch.
                    ...(this.maximumKeyCreditCap !== undefined ? { tomverse_max_key_credit_cap: this.maximumKeyCreditCap } : {}),
                })
                : init?.body;
            // A signed-out session is refused here, before an intent is recorded: nothing was sent, so nothing is unknown.
            this.authorization();
            const intent = await hooks.before();
            hooks.transmission?.(intent, requestBody);
            const headers = new Headers(init?.headers);
            // The SDK's own key header is replaced by send(); one source of truth.
            headers.delete("authorization");
            headers.set("idempotency-key", intent.idempotencyKey);
            let response: Response;
            try {
                response = await this.send(new URL(allowed), { ...init, headers, body: requestBody });
            } catch (error) {
                const failure = error instanceof GatewayError ? error : describeFetchFailure(error, this.endpoint.origin);
                await hooks.failed(intent, failure);
                throw failure;
            }
            const appliedEffort = response.headers.get("x-tomverse-applied-effort");
            await hooks.headers(intent, {
                status: response.status,
                requestId: response.headers.get("x-request-id"),
                routedModel: response.headers.get("x-tomverse-routed-model"),
                ...(isEffort(appliedEffort) ? { appliedEffort } : {}),
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
    chatModel(modelId: string, hooks: GenerationHooks, effort?: Effort): LanguageModel {
        const provider = createOpenAI({
            baseURL: this.endpoint.base,
            // Sent by send(), not by the SDK; set so the SDK never reads OPENAI_API_KEY.
            apiKey: "tomverse-cli-key-is-added-by-the-transport",
            name: "tomverse",
            fetch: this.generationFetch(hooks, effort),
        });
        return provider.chat(modelId);
    }
}
