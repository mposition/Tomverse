/**
 * Retrieval v1 scoring and the context budget (policy §9).
 *
 * Given the memories an account has approved and the terms of the current
 * request, this decides which ones go into the prompt and in what order.
 * Everything here is pure and takes `now` as an argument, so the same inputs
 * always produce the same selection — which is what lets §10 bind a retrieval
 * result to a signed context bundle and detect that it changed.
 *
 * Three rules from §9 shape the design, and each has a failure mode worth
 * naming:
 *
 *   * **Core and pinned memories are not relevance-gated.** "The user is a
 *     backend engineer" is worth knowing whether or not the request mentions
 *     engineering, and a pinned item is the user saying so explicitly. Scoring
 *     them purely on term overlap would drop exactly the memories the feature
 *     exists for.
 *   * **Memory never crowds out the request.** The budget is a hard cap, and
 *     when it binds the reduction order is fixed: low importance, then
 *     duplicates, then low relevance, then style. Selection stops; it never
 *     borrows from the space the user's own message needs.
 *   * **One source may not dominate.** Without a per-source cap, a single
 *     long imported conversation can supply every selected memory, which
 *     reads to the model as consensus rather than as one conversation.
 *
 * Ordering is fully determined: scores are compared at a fixed precision and
 * ties break on id. A selection that depended on the database's row order
 * would differ between two identical requests, and the bundle check in §10
 * would report that as tampering.
 */

import { memoryRetrievalTerms } from "@/lib/memoryRetrievalTerms";
import { FACTUAL_MEMORY_KINDS, STYLE_MEMORY_KINDS } from "@/lib/memoryValidatorCore";

/**
 * Identifies the scoring and selection algorithm — deliberately separate from
 * `MEMORY_RETRIEVAL_VERSION`, which identifies the token shape stored on each
 * row. Changing a weight here changes which memories are chosen and must
 * invalidate a context bundle, but it does not change a single stored term,
 * so folding the two together would force a pointless re-index of every row.
 */
export const MEMORY_RETRIEVAL_ALGORITHM_VERSION = 1;

/**
 * Kinds that describe who the user is rather than what they were doing.
 * Always considered, never relevance-gated (§9 "core/pinned first").
 */
export const CORE_MEMORY_KINDS = [
    "identity",
    "occupation",
    "expertise",
    "constraint",
    "long_term_goal",
] as const;

const CORE_KIND_SET: ReadonlySet<string> = new Set(CORE_MEMORY_KINDS);
const STYLE_KIND_SET: ReadonlySet<string> = new Set(STYLE_MEMORY_KINDS);
const FACTUAL_KIND_SET: ReadonlySet<string> = new Set(FACTUAL_MEMORY_KINDS);

/** Same bytes-per-token heuristic the extraction estimate uses (§11). */
export const MEMORY_CONTEXT_BYTES_PER_TOKEN = 3;

/** Framing cost of one rendered memory line: bullet, kind label, separator. */
export const MEMORY_CONTEXT_ITEM_OVERHEAD_TOKENS = 6;

export const MEMORY_CONTEXT_DEFAULTS = {
    /** Hard cap across everything memory contributes. */
    maxTokens: 900,
    /** Style is capped inside the total so it cannot displace facts. */
    maxStyleTokens: 200,
    maxItems: 24,
    maxStyleItems: 6,
    /** How many selected memories may come from one source conversation. */
    maxPerSource: 3,
    /**
     * How many request terms an ordinary factual memory must share to be
     * considered at all.
     *
     * Gating on overlap rather than on the combined score is deliberate:
     * confidence and recency are non-zero for every stored memory, so a score
     * threshold admits memories that share not one word with the request —
     * which is how unrelated facts end up in a prompt. Relevance still orders
     * what survives; this only decides what is in the running.
     */
    minRelevantTermHits: 1,
    /** Half-life of the recency term, in days. */
    recencyHalfLifeDays: 180,
} as const;

export type MemoryContextBudget = typeof MEMORY_CONTEXT_DEFAULTS;

export type RetrievableMemory = {
    id: string;
    kind: string;
    statement: string;
    /** Normalized grouping key; equal keys are the same claim (§8.3). */
    conflictKey: string | null;
    confidence: number;
    importance: number;
    pinned: boolean;
    searchTerms: readonly string[];
    /** approvedAt ?? createdAt — when this became true for the account. */
    effectiveAt: Date;
    expiresAt: Date | null;
    /**
     * Source conversations backing this memory, for the diversity cap. Empty
     * for user-authored memories, which are therefore never capped against
     * each other.
     */
    sourceIds: readonly string[];
};

export type ScoredMemory = {
    memory: RetrievableMemory;
    /** Term overlap with the request, 0–1. */
    relevance: number;
    /** How many distinct request terms this memory carries. */
    termHits: number;
    score: number;
    tier: "core" | "relevant" | "style";
    tokens: number;
};

export type OmissionReason =
    | "expired"
    | "below_relevance"
    | "duplicate"
    | "source_cap"
    | "token_budget"
    | "item_cap";

export type MemoryContextSelection = {
    selected: ScoredMemory[];
    tokens: number;
    /** Content-free counters for §22. */
    omitted: Record<OmissionReason, number>;
    /**
     * Deterministic description of what was selected, for the §10 bundle to
     * hash. Contains ids and the algorithm version — never statement text,
     * because a bundle binding must not carry memory content around.
     */
    signature: string;
};

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

export function estimateMemoryTokens(statement: string): number {
    return (
        Math.ceil(utf8Bytes(statement) / MEMORY_CONTEXT_BYTES_PER_TOKEN) +
        MEMORY_CONTEXT_ITEM_OVERHEAD_TOKENS
    );
}

/**
 * Term overlap, measured against the *request* rather than the memory.
 *
 * Dividing by the query size asks "how much of what was asked does this
 * memory cover", which is what relevance means here. Dividing by the memory's
 * own term count instead would reward short memories for saying little.
 */
export function termOverlap(
    queryTerms: readonly string[],
    memoryTerms: readonly string[]
): { hits: number; relevance: number } {
    const distinctQuery = new Set(queryTerms);
    if (distinctQuery.size === 0 || memoryTerms.length === 0) {
        return { hits: 0, relevance: 0 };
    }
    const memory = new Set(memoryTerms);
    let hits = 0;
    for (const term of distinctQuery) {
        if (memory.has(term)) hits += 1;
    }
    return { hits, relevance: hits / distinctQuery.size };
}

export function termRelevance(
    queryTerms: readonly string[],
    memoryTerms: readonly string[]
): number {
    return termOverlap(queryTerms, memoryTerms).relevance;
}

const recencyWeight = (effectiveAt: Date, now: Date, halfLifeDays: number) => {
    const ageMs = Math.max(0, now.getTime() - effectiveAt.getTime());
    const halfLives = ageMs / (halfLifeDays * 86_400_000);
    return 0.5 ** halfLives;
};

const tierFor = (memory: RetrievableMemory): ScoredMemory["tier"] => {
    if (STYLE_KIND_SET.has(memory.kind)) return "style";
    if (memory.pinned || CORE_KIND_SET.has(memory.kind)) return "core";
    return "relevant";
};

/** Compared at fixed precision so float noise cannot reorder two memories. */
const rank = (score: number) => Math.round(score * 1e6);

export function scoreMemory(
    memory: RetrievableMemory,
    queryTerms: readonly string[],
    now: Date,
    budget: MemoryContextBudget = MEMORY_CONTEXT_DEFAULTS
): ScoredMemory {
    const { hits, relevance } = termOverlap(queryTerms, memory.searchTerms);
    const recency = recencyWeight(
        memory.effectiveAt,
        now,
        budget.recencyHalfLifeDays
    );
    const tier = tierFor(memory);
    // Importance is a small integer set by the validator; normalized so one
    // very important memory cannot outweigh relevance entirely.
    const importance = Math.min(1, Math.max(0, memory.importance / 10));
    const score =
        0.45 * relevance +
        0.2 * Math.min(1, Math.max(0, memory.confidence)) +
        0.15 * recency +
        0.1 * importance +
        (memory.pinned ? 0.1 : 0) +
        (CORE_KIND_SET.has(memory.kind) ? 0.05 : 0);
    return {
        memory,
        relevance,
        termHits: hits,
        score,
        tier,
        tokens: estimateMemoryTokens(memory.statement),
    };
}

/**
 * Highest score first; ties on id so the order never depends on the order
 * rows arrived in.
 */
const byScoreThenId = (left: ScoredMemory, right: ScoredMemory) => {
    const difference = rank(right.score) - rank(left.score);
    if (difference !== 0) return difference;
    return left.memory.id < right.memory.id ? -1 : 1;
};

/**
 * The duplicate key. `conflictKey` is the server's own grouping of claims
 * that mean the same thing, so two rows sharing one are the same fact stated
 * twice — including it once and dropping the rest is what §9 means by
 * removing duplicates before removing relevance.
 */
const duplicateKey = (memory: RetrievableMemory) =>
    memory.conflictKey ?? `id:${memory.id}`;

export function selectMemoryContext(input: {
    memories: readonly RetrievableMemory[];
    /** The current request, already tokenized, or the raw text. */
    query: string | readonly string[];
    now: Date;
    /** False drops the style tier entirely (§8.1 style toggle). */
    styleEnabled?: boolean;
    budget?: Partial<MemoryContextBudget>;
}): MemoryContextSelection {
    const budget = { ...MEMORY_CONTEXT_DEFAULTS, ...(input.budget ?? {}) };
    const queryTerms =
        typeof input.query === "string"
            ? memoryRetrievalTerms(input.query)
            : input.query;
    const omitted: Record<OmissionReason, number> = {
        expired: 0,
        below_relevance: 0,
        duplicate: 0,
        source_cap: 0,
        token_budget: 0,
        item_cap: 0,
    };

    const scored: ScoredMemory[] = [];
    for (const memory of input.memories) {
        if (memory.expiresAt && memory.expiresAt.getTime() <= input.now.getTime()) {
            omitted.expired += 1;
            continue;
        }
        const candidate = scoreMemory(memory, queryTerms, input.now, budget);
        if (candidate.tier === "style" && input.styleEnabled === false) continue;
        if (
            candidate.tier === "relevant" &&
            candidate.termHits < budget.minRelevantTermHits
        ) {
            omitted.below_relevance += 1;
            continue;
        }
        scored.push(candidate);
    }
    scored.sort(byScoreThenId);

    const selected: ScoredMemory[] = [];
    const seenDuplicates = new Set<string>();
    const perSource = new Map<string, number>();
    let tokens = 0;
    let styleTokens = 0;
    let styleItems = 0;

    // Core first, then relevant, then style — the §9 priority order. Within a
    // tier the sort above decides, and a later tier can only use what earlier
    // tiers left.
    const tiers: ScoredMemory["tier"][] = ["core", "relevant", "style"];
    for (const tier of tiers) {
        for (const candidate of scored) {
            if (candidate.tier !== tier) continue;
            if (selected.length >= budget.maxItems) {
                omitted.item_cap += 1;
                continue;
            }

            const key = duplicateKey(candidate.memory);
            if (seenDuplicates.has(key)) {
                omitted.duplicate += 1;
                continue;
            }

            // A memory drawn from several conversations counts against each,
            // and is capped if any one of them is already full: the point is
            // that no single source dominates what the model sees.
            const sources = candidate.memory.sourceIds;
            if (
                sources.some(
                    (source) => (perSource.get(source) ?? 0) >= budget.maxPerSource
                )
            ) {
                omitted.source_cap += 1;
                continue;
            }

            if (tier === "style") {
                if (
                    styleItems >= budget.maxStyleItems ||
                    styleTokens + candidate.tokens > budget.maxStyleTokens
                ) {
                    omitted.item_cap += 1;
                    continue;
                }
            }
            if (tokens + candidate.tokens > budget.maxTokens) {
                // Never partial: half a statement is a different claim.
                omitted.token_budget += 1;
                continue;
            }

            selected.push(candidate);
            seenDuplicates.add(key);
            tokens += candidate.tokens;
            if (tier === "style") {
                styleTokens += candidate.tokens;
                styleItems += 1;
            }
            for (const source of sources) {
                perSource.set(source, (perSource.get(source) ?? 0) + 1);
            }
        }
    }

    return {
        selected,
        tokens,
        omitted,
        signature: [
            `v${MEMORY_RETRIEVAL_ALGORITHM_VERSION}`,
            ...selected.map(
                (candidate) => `${candidate.memory.id}:${rank(candidate.score)}`
            ),
        ].join(" "),
    };
}

/** True for kinds this release knows how to place in the prompt (§9.1). */
export const isRetrievableKind = (kind: string) =>
    FACTUAL_KIND_SET.has(kind) || STYLE_KIND_SET.has(kind);
