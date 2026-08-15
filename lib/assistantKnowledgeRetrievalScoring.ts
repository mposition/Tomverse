/**
 * Choosing which knowledge chunks reach the prompt (Release C, C2).
 *
 * docs/policy/external-conversation-import-and-memory.md §14, §9: lexical,
 * deterministic, no embeddings, and a `retrievalVersion` that says which
 * algorithm produced a result.
 *
 * Pure: candidates and a query in, a selection out. No Prisma, no clock beyond
 * what the caller passes. The database narrows to this account's ready files
 * and to chunks sharing at least one term; everything about *which* of those
 * are worth the prompt space is decided here, so it can be tested without a
 * database and so two callers cannot disagree.
 *
 * ## Why this is not memory's selector
 *
 * `selectMemoryContext` ranks small independent facts, and its job is largely
 * to decide which tier a fact belongs to. A knowledge chunk has no tier, no
 * pin and no expiry; what it has instead is a *document*, and the questions
 * that matter are ones memory never asks:
 *
 *   * a chunk is 1,200 characters, not a sentence, so the token budget binds
 *     after a handful rather than after fifty;
 *   * ten chunks from one file drown out the other four files the profile
 *     has, so a per-file cap is load-bearing rather than a nicety;
 *   * a chunk's neighbours in the same document are its context, so ties are
 *     broken toward document order rather than toward recency.
 *
 * Sharing one selector would have meant a tier field on chunks that is always
 * the same value, and a per-source cap on memories that nothing sets.
 */

import { memoryRetrievalTerms } from "@/lib/memoryRetrievalTerms";

/**
 * Bumped when the ranking would order the same candidates differently.
 * Recorded on a result so a stale context bundle is detectable (§10).
 */
export const KNOWLEDGE_RETRIEVAL_ALGORITHM_VERSION = 1;

/** Same estimate the memory context uses, for the same reason: it is a bound. */
export const KNOWLEDGE_BYTES_PER_TOKEN = 3;

export const KNOWLEDGE_CONTEXT_DEFAULTS = {
    /**
     * The prompt share knowledge may take. §9.1 puts it fourth — below the
     * profile's own instructions and below approved memory — so this is a
     * slice of what is left, not a claim on the window.
     */
    maxTokens: 1_200,
    /** At most this many chunks, however small they are. */
    maxChunks: 6,
    /**
     * At most this many from one file. Without it a single long document wins
     * every slot and the other files the owner attached are never consulted —
     * which reads to them as "the assistant ignored the file I uploaded".
     */
    maxChunksPerFile: 3,
    /**
     * A chunk has to match at least this many distinct query terms. One
     * shared token is a coincidence at this chunk size: a 1,200-character
     * passage shares "the" with everything.
     */
    minTermHits: 2,
} as const;

export type KnowledgeContextBudget = typeof KNOWLEDGE_CONTEXT_DEFAULTS;

export type RetrievableChunk = {
    id: string;
    fileId: string;
    /** The file's name, so a citation can say which document answered. */
    fileName: string;
    ordinal: number;
    content: string;
    searchTerms: readonly string[];
};

export type ScoredChunk = RetrievableChunk & {
    score: number;
    termHits: number;
    estimatedTokens: number;
};

export type KnowledgeOmissionReason =
    | "below_relevance"
    | "file_cap"
    | "token_budget"
    | "chunk_cap";

export type KnowledgeContextSelection = {
    chunks: ScoredChunk[];
    estimatedTokens: number;
    omitted: Record<KnowledgeOmissionReason, number>;
    retrievalVersion: number;
    /** Distinct files the selection drew on, for the citation line. */
    fileIds: string[];
};

export function estimateChunkTokens(content: string): number {
    return Math.ceil(
        Buffer.byteLength(content, "utf8") / KNOWLEDGE_BYTES_PER_TOKEN
    );
}

/**
 * How much of the question this chunk covers.
 *
 * Divided by the query's distinct term count, not by the chunk's: dividing by
 * the chunk's would reward a short chunk for saying little, which at this size
 * means rewarding a heading over the paragraph that answers.
 */
export function chunkTermOverlap(
    queryTerms: readonly string[],
    chunkTerms: readonly string[]
): { hits: number; relevance: number } {
    const distinctQuery = new Set(queryTerms);
    if (distinctQuery.size === 0 || chunkTerms.length === 0) {
        return { hits: 0, relevance: 0 };
    }
    const chunk = new Set(chunkTerms);
    let hits = 0;
    for (const term of distinctQuery) {
        if (chunk.has(term)) hits += 1;
    }
    return { hits, relevance: hits / distinctQuery.size };
}

/** Fixed precision, so float noise cannot reorder two chunks. */
const rank = (score: number) => Math.round(score * 1e6);

/**
 * Ties break toward the earlier chunk of the earlier file, and then by id.
 *
 * Document order rather than an arbitrary one because two chunks that score
 * identically are usually adjacent passages of the same section, and giving
 * the model those in the order the document wrote them is the difference
 * between a quotation and a shuffle. The id is the last resort so the order is
 * total — a comparator that can return 0 for two different rows makes the
 * whole selection depend on how the database happened to sort them.
 */
const byScoreThenPosition = (a: ScoredChunk, b: ScoredChunk): number => {
    const scored = rank(b.score) - rank(a.score);
    if (scored !== 0) return scored;
    if (a.fileId !== b.fileId) return a.fileId < b.fileId ? -1 : 1;
    if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

export function scoreChunk(
    chunk: RetrievableChunk,
    queryTerms: readonly string[]
): ScoredChunk {
    const { hits, relevance } = chunkTermOverlap(queryTerms, chunk.searchTerms);
    return {
        ...chunk,
        termHits: hits,
        // Relevance alone, deliberately. There is no recency here (a document
        // does not get less true), no confidence (nobody scored the file), and
        // no pin (§14 has explicit file selection, which the caller applies by
        // narrowing the candidates rather than by weighting them). A single
        // term is what the score means, and a second factor would be one
        // nobody could explain when a chunk lost.
        score: relevance,
        estimatedTokens: estimateChunkTokens(chunk.content),
    };
}

/**
 * The chunks worth the prompt space, in the order they should be presented.
 *
 * Selection is by score; *presentation* is by document position, so the model
 * reads a document's passages in the order they were written even when a later
 * one scored higher. The two orders being different is the point — ranking is
 * about what gets in, and reading order is about whether what got in makes
 * sense.
 */
export function selectKnowledgeContext(input: {
    chunks: readonly RetrievableChunk[];
    /** The current request, raw or already tokenized. */
    query: string | readonly string[];
    budget?: Partial<KnowledgeContextBudget>;
}): KnowledgeContextSelection {
    const budget = { ...KNOWLEDGE_CONTEXT_DEFAULTS, ...(input.budget ?? {}) };
    const queryTerms =
        typeof input.query === "string"
            ? memoryRetrievalTerms(input.query)
            : input.query;

    const omitted: Record<KnowledgeOmissionReason, number> = {
        below_relevance: 0,
        file_cap: 0,
        token_budget: 0,
        chunk_cap: 0,
    };

    const scored: ScoredChunk[] = [];
    for (const chunk of input.chunks) {
        const candidate = scoreChunk(chunk, queryTerms);
        if (candidate.termHits < budget.minTermHits) {
            omitted.below_relevance += 1;
            continue;
        }
        scored.push(candidate);
    }
    scored.sort(byScoreThenPosition);

    const selected: ScoredChunk[] = [];
    const perFile = new Map<string, number>();
    let tokens = 0;

    for (const candidate of scored) {
        if (selected.length >= budget.maxChunks) {
            omitted.chunk_cap += 1;
            continue;
        }
        const fromThisFile = perFile.get(candidate.fileId) ?? 0;
        if (fromThisFile >= budget.maxChunksPerFile) {
            omitted.file_cap += 1;
            continue;
        }
        if (tokens + candidate.estimatedTokens > budget.maxTokens) {
            // Not a break. A later chunk may be small enough to fit, and
            // stopping at the first oversized one would drop a whole file
            // because one of its passages was long.
            omitted.token_budget += 1;
            continue;
        }
        selected.push(candidate);
        perFile.set(candidate.fileId, fromThisFile + 1);
        tokens += candidate.estimatedTokens;
    }

    selected.sort((a, b) => {
        if (a.fileId !== b.fileId) return a.fileId < b.fileId ? -1 : 1;
        return a.ordinal - b.ordinal;
    });

    return {
        chunks: selected,
        estimatedTokens: tokens,
        omitted,
        retrievalVersion: KNOWLEDGE_RETRIEVAL_ALGORITHM_VERSION,
        fileIds: [...new Set(selected.map((chunk) => chunk.fileId))],
    };
}
