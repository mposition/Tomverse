import { MEMORY_RETRIEVAL_MAX_TERMS, memoryRetrievalTerms } from "@/lib/memoryRetrievalTerms";
import { SEMANTIC_RETRIEVAL_LIMITS } from "@/lib/semanticRetrievalCore";

/** Query budgets only. Stored indexes and knowledge queries keep their contracts. */
export const MEMORY_QUERY_VERSION = "memory-query-v2";
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

export function buildMemoryQueryPlan(query: string) {
    const normalized = query.normalize("NFC");
    const allTerms = memoryRetrievalTerms(normalized, { maxTerms: Infinity });
    const headTerms = Math.ceil(MEMORY_RETRIEVAL_MAX_TERMS / 2);
    const terms = allTerms.length <= MEMORY_RETRIEVAL_MAX_TERMS
        ? allTerms
        : [...allTerms.slice(0, headTerms), ...allTerms.slice(-(MEMORY_RETRIEVAL_MAX_TERMS - headTerms))];
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
