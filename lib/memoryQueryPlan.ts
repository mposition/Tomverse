import { MEMORY_RETRIEVAL_MAX_TERMS, memoryRetrievalTerms } from "@/lib/memoryRetrievalTerms";
import { SEMANTIC_RETRIEVAL_LIMITS } from "@/lib/semanticRetrievalCore";
import { MEMORY_RERANK_QUERY_POLICY, memorySemanticQuery } from "@/lib/memorySemanticInput";
export { memorySemanticQuery, memoryRelevanceContextEnabled } from "@/lib/memorySemanticInput";
export type { MemorySemanticHistory } from "@/lib/memorySemanticInput";
import type { MemorySemanticHistory } from "@/lib/memorySemanticInput";

/** Query budgets only. Stored indexes and knowledge queries keep their contracts. */
export const MEMORY_QUERY_VERSION = "memory-query-v2";
export const MEMORY_FULL_QUERY_VERSION = MEMORY_RERANK_QUERY_POLICY;
export type MemoryQueryPolicy = "full" | "legacy";
export type MemorySemanticContext = {
    history: readonly MemorySemanticHistory[];
    queryPolicy?: MemoryQueryPolicy;
};
export type MemorySemanticContextInput = MemorySemanticContext | (() => Promise<MemorySemanticContext>);

const GAP = "\n…\n";
const bytes = (text: string) => new TextEncoder().encode(text).length;

const takeBytes = (points: readonly string[], limit: number): string => {
    let used = 0;
    const result: string[] = [];
    for (const point of points) {
        const size = bytes(point);
        if (used + size > limit) break;
        result.push(point);
        used += size;
    }
    return result.join("");
};

export function buildMemoryQueryPlan(query: string, options: {
    queryPolicy?: MemoryQueryPolicy;
    history?: readonly string[];
} = {}) {
    const normalized = query.normalize("NFC");
    const allTerms = memoryRetrievalTerms(normalized, { maxTerms: Infinity });
    const headTerms = Math.ceil(MEMORY_RETRIEVAL_MAX_TERMS / 2);
    const terms = allTerms.length <= MEMORY_RETRIEVAL_MAX_TERMS
        ? allTerms
        : [...allTerms.slice(0, headTerms), ...allTerms.slice(-(MEMORY_RETRIEVAL_MAX_TERMS - headTerms))];
    if (options.queryPolicy === "full") {
        return { version: MEMORY_FULL_QUERY_VERSION, terms,
            semanticQuery: memorySemanticQuery(normalized, options.history) };
    }
    const limit = SEMANTIC_RETRIEVAL_LIMITS.rerankMaxQueryBytes;
    const points = [...normalized];
    const headBytes = Math.ceil((limit - bytes(GAP)) / 2);
    const semanticQuery = bytes(normalized) <= limit ? normalized : [
        takeBytes(points, headBytes),
        GAP,
        [...takeBytes([...points].reverse(), limit - bytes(GAP) - headBytes)].reverse().join(""),
    ].join("");
    return { version: MEMORY_QUERY_VERSION, terms, semanticQuery };
}
