import "server-only";

import {
    COHERE_EMBED_URL,
    COHERE_RERANK_URL,
    SEMANTIC_RETRIEVAL_ENV,
    SEMANTIC_RETRIEVAL_LIMITS,
    embedRequestBody,
    parseEmbedResponse,
    parseRerankResponse,
    rerankRequestBody,
    type EmbedInputType,
    type ParsedEmbed,
    type ParsedRerank,
} from "@/lib/semanticRetrievalCore";

/**
 * The two HTTP calls to the retrieval provider.
 *
 * One request each, never retried: a retry of a request whose outcome is
 * unknown may be billed twice, and the caller's fallback (lexical order) is
 * always available. The response body is consumed on every path so a failed
 * call does not leave a socket in the pool, and neither the error object nor
 * the body is logged -- both can carry the user's text or the credential.
 */

export type SemanticRetrievalFailure =
    | "not_configured"
    | "unauthorized"
    | "rate_limited"
    | "timeout"
    | "provider_error"
    | "invalid_response";

export type SemanticCallResult<T> =
    | { ok: true; value: T }
    | { ok: false; failure: SemanticRetrievalFailure; /** False when no request left this process. */ sent: boolean };

type FetchImpl = typeof fetch;

/** The key, read here and nowhere else. Null when the deployment has none. */
export const readSemanticRetrievalKey = (
    env: Record<string, string | undefined> = process.env
): string | null => {
    const value = env[SEMANTIC_RETRIEVAL_ENV.apiKey]?.trim();
    return value ? value : null;
};

const failureForStatus = (status: number): SemanticRetrievalFailure => {
    if (status === 401 || status === 403) return "unauthorized";
    if (status === 429) return "rate_limited";
    return "provider_error";
};

const postJson = async <T>(
    url: string,
    body: unknown,
    parse: (json: unknown) => T | null,
    options: { timeoutMs: number; fetchImpl?: FetchImpl; env?: Record<string, string | undefined> }
): Promise<SemanticCallResult<T>> => {
    const key = readSemanticRetrievalKey(options.env);
    if (!key) return { ok: false, failure: "not_configured", sent: false };

    let response: Response;
    try {
        response = await (options.fetchImpl ?? fetch)(url, {
            method: "POST",
            headers: {
                authorization: `Bearer ${key}`,
                "content-type": "application/json",
                accept: "application/json",
            },
            body: JSON.stringify(body),
            cache: "no-store",
            signal: AbortSignal.timeout(options.timeoutMs),
        });
    } catch (error) {
        const name = error instanceof Error ? error.name : "";
        return {
            ok: false,
            failure: name === "TimeoutError" || name === "AbortError" ? "timeout" : "provider_error",
            sent: true,
        };
    }

    if (!response.ok) {
        try {
            await response.arrayBuffer();
        } catch {}
        return { ok: false, failure: failureForStatus(response.status), sent: true };
    }

    let json: unknown;
    try {
        json = await response.json();
    } catch {
        return { ok: false, failure: "invalid_response", sent: true };
    }
    const value = parse(json);
    return value === null
        ? { ok: false, failure: "invalid_response", sent: true }
        : { ok: true, value };
};

export const callRerank = (
    input: { model: string; query: string; documents: readonly string[] },
    options: { fetchImpl?: FetchImpl; env?: Record<string, string | undefined> } = {}
): Promise<SemanticCallResult<ParsedRerank>> =>
    postJson(
        COHERE_RERANK_URL,
        rerankRequestBody(input),
        (json) => parseRerankResponse(json, input.documents.length),
        { ...options, timeoutMs: SEMANTIC_RETRIEVAL_LIMITS.requestTimeoutMs }
    );

export const callEmbed = (
    input: {
        model: string;
        dimension: number | null;
        inputType: EmbedInputType;
        texts?: readonly string[];
        images?: readonly string[];
    },
    options: {
        fetchImpl?: FetchImpl;
        env?: Record<string, string | undefined>;
        /** True for a call that is not on a user's turn. */
        indexing?: boolean;
    } = {}
): Promise<SemanticCallResult<ParsedEmbed>> =>
    postJson(
        COHERE_EMBED_URL,
        embedRequestBody(input),
        (json) => parseEmbedResponse(json, (input.images ?? input.texts ?? []).length),
        {
            ...options,
            timeoutMs: options.indexing
                ? SEMANTIC_RETRIEVAL_LIMITS.indexingTimeoutMs
                : SEMANTIC_RETRIEVAL_LIMITS.requestTimeoutMs,
        }
    );
