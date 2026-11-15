/**
 * Prepares the one Memory rerank query used by cache, cost reservation and the
 * provider request. This module is pure: selecting a supported contract does
 * not enable the feature or make a provider call.
 */

/** Contextual adoption changes must invalidate prior signed plans and evaluation provenance. */
export const MEMORY_RERANK_QUERY_POLICY = "memory-query-v4" as const;
export const MEMORY_RELEVANCE_CONTEXT_ENV = "MEMORY_RELEVANCE_CONTEXT_ENABLED" as const;

export type MemorySemanticHistory = { id: string; content: string; digest: string };

export type MemorySemanticFallbackReason =
    | "context_policy_disabled"
    | "empty_current_query"
    | "model_query_contract_unknown"
    | "query_token_count_unavailable"
    | "query_token_limit_exceeded"
    | "billing_contract_unknown"
    | "search_unit_cost_unverifiable";

type BillingUnit = { unit: "search_unit" } | { unit: "token" };

export type PreparedMemorySemanticInput = {
    policy: typeof MEMORY_RERANK_QUERY_POLICY;
    effectiveQuery: string;
    historyCount: number;
    /** Exact when a trusted tokenizer is supplied; otherwise a byte upper bound. */
    queryTokensUpperBound: number;
    tokenCountKind: "exact" | "utf8_byte_upper_bound";
};

type ModelQueryContract = { maxQueryTokens: number };

/** Exact public Cohere model IDs whose v2 query limits are documented. */
const MODEL_QUERY_CONTRACTS: Readonly<Record<string, ModelQueryContract>> = {
    "rerank-v3.5": { maxQueryTokens: 2_048 },
    "rerank-v4.0-fast": { maxQueryTokens: 16_384 },
    "rerank-v4.0-pro": { maxQueryTokens: 16_384 },
    // The general v2 Rerank table applies 2,048 unless a model-specific query
    // section overrides it. V5 documents a shared 32,768 context but no larger
    // query-specific override.
    "rerank-v5.0-fast": { maxQueryTokens: 2_048 },
    "rerank-v5.0-pro": { maxQueryTokens: 2_048 },
};

const SEARCH_UNIT_WINDOW_TOKENS = 500;
const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");

export const memoryRelevanceContextEnabled = (
    env: Record<string, string | undefined> = process.env
) => env[MEMORY_RELEVANCE_CONTEXT_ENV] === "true";

/** History remains data in a structured query, rather than becoming instructions. */
export const memorySemanticQuery = (currentQuery: string, history: readonly string[] = []) => {
    const current = currentQuery.normalize("NFC");
    return history.length === 0
        ? current
        : JSON.stringify({
              current_query: current,
              previous_user_messages: history.map((content) => content.normalize("NFC")),
          });
};

export const prepareMemorySemanticInput = (input: {
    model: string;
    billing: BillingUnit;
    currentQuery: string;
    history?: readonly string[];
    enabled?: boolean;
    /** A trusted local tokenizer, when one exists for the configured model. */
    countTokens?: (query: string, model: string) => number | null;
}):
    | { ok: true; value: PreparedMemorySemanticInput }
    | { ok: false; reason: MemorySemanticFallbackReason } => {
    if (input.enabled === false) return { ok: false, reason: "context_policy_disabled" };
    const currentQuery = input.currentQuery.normalize("NFC");
    if (!currentQuery.trim()) return { ok: false, reason: "empty_current_query" };

    const contract = MODEL_QUERY_CONTRACTS[input.model];
    if (!contract) return { ok: false, reason: "model_query_contract_unknown" };
    if (input.billing.unit === "token" && !input.model.startsWith("rerank-v5.0-")) {
        // The v2 API documents input_tokens on its V5 response. Other model /
        // token-price pairings need an operator contract before they can spend.
        return { ok: false, reason: "billing_contract_unknown" };
    }

    const history = (input.history ?? []).map((content) => content.normalize("NFC"));
    let currentOnlyFailure: MemorySemanticFallbackReason = "query_token_count_unavailable";
    for (let start = 0; start <= history.length; start += 1) {
        const keptHistory = history.slice(start);
        const effectiveQuery = memorySemanticQuery(currentQuery, keptHistory);
        const exactTokens = input.countTokens?.(effectiveQuery, input.model) ?? null;
        const hasExactTokens = exactTokens !== null && Number.isSafeInteger(exactTokens) && exactTokens > 0;
        const queryTokensUpperBound = hasExactTokens ? exactTokens : utf8Bytes(effectiveQuery);
        const withinModelLimit = queryTokensUpperBound <= contract.maxQueryTokens;
        if (!hasExactTokens && !withinModelLimit) {
            // Bytes are only an upper bound. Crossing the token limit in bytes
            // does not prove the model limit was crossed, so it cannot justify
            // silently deleting otherwise valid history.
            return { ok: false, reason: "query_token_count_unavailable" };
        }
        if (withinModelLimit) {
            // History is reduced only for the model's input limit. A billing
            // contract that cannot price the selected query refuses the call;
            // it does not silently remove otherwise valid context.
            if (input.billing.unit === "search_unit" && queryTokensUpperBound >= SEARCH_UNIT_WINDOW_TOKENS) {
                return { ok: false, reason: "search_unit_cost_unverifiable" };
            }
            return {
                ok: true,
                value: {
                    policy: MEMORY_RERANK_QUERY_POLICY,
                    effectiveQuery,
                    historyCount: keptHistory.length,
                    queryTokensUpperBound,
                    tokenCountKind: hasExactTokens ? "exact" : "utf8_byte_upper_bound",
                },
            };
        }

        if (keptHistory.length === 0) {
            if (!withinModelLimit) {
                currentOnlyFailure = hasExactTokens
                    ? "query_token_limit_exceeded"
                    : "query_token_count_unavailable";
            }
        }
    }
    return { ok: false, reason: currentOnlyFailure };
};
