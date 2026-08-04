import { estimateTextTokens } from "@/lib/chatTokenEstimate";
import {
    STYLE_MEMORY_KINDS,
    memoryStatementKey,
} from "@/lib/memoryValidatorCore";

/**
 * Retrieval v1 (Release B, slice B4) — lexical, deterministic, local.
 *
 * docs/policy/external-conversation-import-and-memory.md §9, §10.
 *
 * **No embeddings, and that is a decision rather than a stopgap.** §9 forbids
 * calling an embedding provider, sending memory text to one, adding a vector
 * column, or shipping an embedding feature under a `retrievalVersion` bump.
 * Introducing one later needs its own policy, privacy, cost, provider-budget
 * and eval approval. So retrieval here is term overlap plus a scoring function
 * whose every input is a stored column: the same account, the same query and
 * the same stored rows always select the same memories, which is also what
 * makes the §10 retrieval-result hash meaningful.
 *
 * Everything in this module is pure. The database query lives in
 * lib/memoryRetrieval.ts, and injecting the result into a prompt is §10's
 * context bundle — deliberately a later step, so this layer can be tested and
 * reviewed without touching a single chat path.
 */

/**
 * Algorithm identity, stored per row so a change of method is visible rather
 * than silently re-ranking existing memories. Bump it when the tokenizer or
 * the scorer changes in a way that would produce different terms or a
 * different order for unchanged input.
 */
export const MEMORY_RETRIEVAL_VERSION = 1;

/** Upper bound on stored terms per memory, so one long statement cannot
 * dominate the GIN index. Statements are capped at 400 code points, so this is
 * generous rather than lossy in practice. */
export const MEMORY_SEARCH_TERM_LIMIT = 128;

const STYLE_KINDS = new Set<string>(STYLE_MEMORY_KINDS);

export const isStyleMemoryKind = (kind: string): boolean =>
    STYLE_KINDS.has(kind);

/**
 * Characters treated as ideographic/syllabic rather than alphabetic: Hangul,
 * Han, Kana. These do not separate words with spaces, so they are indexed as
 * bigrams instead of as whitespace-delimited tokens.
 */
const CJK_PATTERN = /[぀-ヿ㐀-䶿一-鿿가-힯]/u;
const LATIN_TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

const isCjk = (character: string) => CJK_PATTERN.test(character);

/**
 * Lexical terms for one piece of text (§9).
 *
 * Two tokenizations, because the two writing systems need different ones:
 *
 *  - Space-delimited scripts give whole-word tokens. Single characters are
 *    dropped — "a" or "의" as an index entry matches nearly everything and
 *    discriminates nothing.
 *  - Hangul/Han/Kana give **bigrams** over each uninterrupted run. Korean does
 *    not put spaces inside a noun phrase, so whole-token matching would make
 *    "코드 리뷰" and "코드리뷰" different terms; bigrams make them overlap.
 *    A run of a single character is kept as itself, since there is no bigram
 *    to form.
 *
 * NFC first so a decomposed Hangul syllable and a composed one produce the
 * same terms, and lower-cased so case never decides a match.
 */
export function tokenizeMemoryText(text: string): string[] {
    const normalized = text.normalize("NFC").toLowerCase();
    const terms: string[] = [];
    const seen = new Set<string>();
    const push = (term: string) => {
        if (!term || seen.has(term)) return;
        seen.add(term);
        terms.push(term);
    };

    for (const rawToken of normalized.match(LATIN_TOKEN_PATTERN) ?? []) {
        // A token can mix scripts ("gpt5모델"); split it into runs so each half
        // is indexed the way its own script wants.
        let run = "";
        let runIsCjk = false;
        const flush = () => {
            if (!run) return;
            if (runIsCjk) {
                if (run.length === 1) push(run);
                for (let index = 0; index + 1 < run.length; index += 1) {
                    push(run.slice(index, index + 2));
                }
            } else if (run.length >= 2) {
                push(run);
            }
            run = "";
        };
        for (const character of rawToken) {
            const characterIsCjk = isCjk(character);
            if (run && characterIsCjk !== runIsCjk) flush();
            runIsCjk = characterIsCjk;
            run += character;
        }
        flush();
        if (terms.length >= MEMORY_SEARCH_TERM_LIMIT) break;
    }

    return terms.slice(0, MEMORY_SEARCH_TERM_LIMIT);
}

/** Terms stored on a memory row: what it asserts, and what kind it is. */
export const memorySearchTerms = (input: {
    kind: string;
    statement: string;
}): string[] =>
    tokenizeMemoryText(`${input.kind.replace(/_/g, " ")} ${input.statement}`);

export type RetrievableMemory = {
    id: string;
    kind: string;
    statement: string;
    searchTerms: string[];
    confidence: number;
    importance: number;
    pinned: boolean;
    /** Used for recency; the row's last meaningful change. */
    updatedAt: Date;
    /** Distinct evidence origins, for the §9 same-source diversity limit. */
    sourceKeys: string[];
};

export type ScoredMemory = {
    memory: RetrievableMemory;
    score: number;
    /** Fraction of the query's terms this memory covers, in [0, 1]. */
    coverage: number;
    matchedTerms: number;
};

/** Half-life for the recency term, in days. */
const RECENCY_HALF_LIFE_DAYS = 120;

const WEIGHTS = {
    confidence: 0.25,
    importance: 0.15,
    recency: 0.2,
} as const;

/**
 * Relevance a pinned memory is credited with when the request happens not to
 * mention it. Pinning means "always relevant", so it cannot score zero; it is
 * below 1 so a pinned memory the request *does* match still ranks higher.
 */
const PINNED_RELEVANCE_FLOOR = 0.5;

/**
 * Deterministic relevance score (§9: category, recency, confidence, pin).
 *
 * Quality **multiplies** relevance rather than adding to it, and that is the
 * whole shape of this function. Summed, a memory with maximum confidence,
 * importance and freshness carries a constant floor that an irrelevant memory
 * gets for free — enough to outrank a memory that genuinely answers part of
 * the request but is older or less certain. Multiplying makes confidence and
 * recency what they actually are: tie-breakers among memories that are already
 * relevant, never a way to buy relevance.
 */
export function scoreMemory(
    memory: RetrievableMemory,
    queryTerms: ReadonlySet<string>,
    now: Date
): ScoredMemory {
    let matchedTerms = 0;
    for (const term of memory.searchTerms) {
        if (queryTerms.has(term)) matchedTerms += 1;
    }
    const coverage =
        queryTerms.size === 0
            ? 0
            : Math.min(1, matchedTerms / queryTerms.size);

    const ageDays = Math.max(
        0,
        (now.getTime() - memory.updatedAt.getTime()) / 86_400_000
    );
    const recency = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);

    const quality =
        WEIGHTS.confidence * memory.confidence +
        WEIGHTS.importance * Math.min(1, memory.importance / 10) +
        WEIGHTS.recency * recency;
    const relevance = memory.pinned
        ? Math.max(coverage, PINNED_RELEVANCE_FLOOR)
        : coverage;

    return { memory, score: relevance * (1 + quality), coverage, matchedTerms };
}

export type MemoryContextBudget = {
    /** Hard cap on the tokens memory may occupy. Never exceeded. */
    maxTokens: number;
    /** Cap on memories carried, before the token cap applies. */
    maxItems: number;
    /** §9 diversity: at most this many memories resting on one source. */
    maxPerSource: number;
};

export const DEFAULT_MEMORY_CONTEXT_BUDGET: MemoryContextBudget = {
    maxTokens: 800,
    maxItems: 24,
    maxPerSource: 4,
};

export type MemoryContextSelection = {
    factual: ScoredMemory[];
    style: ScoredMemory[];
    estimatedTokens: number;
    /** Content-free reasons things were left out, for §22 metrics. */
    dropped: {
        belowRelevance: number;
        sourceLimit: number;
        duplicate: number;
        tokenBudget: number;
        itemLimit: number;
    };
};

/** Tokens one memory costs once rendered as a context line. */
export const memoryContextTokens = (memory: {
    kind: string;
    statement: string;
}): number => estimateTextTokens(`- (${memory.kind}) ${memory.statement}`);

/**
 * Duplicate detection: the same kind making the same assertion.
 *
 * Keyed on the validator's canonical statement key rather than on the search
 * terms. Terms drop single characters, so "topic 3" and "topic 7" tokenize
 * identically and a term-based key would silently collapse two memories that
 * differ exactly where it matters (§8.4 already defines what "the same
 * assertion" means; retrieval reuses it rather than inventing a second answer).
 */
const duplicateKey = (memory: RetrievableMemory) =>
    `${memory.kind}:${memoryStatementKey(memory.statement)}`;

/**
 * Chooses what actually goes into the prompt (§9 context budget).
 *
 * Order of preference: pinned first, then relevance. The reduction order §9
 * fixes — lower importance, then duplicates, then lower relevance, then style
 * examples — falls out of processing factual memories before style ones in
 * descending score, and of the caller's budget being a hard cap: whatever does
 * not fit is simply not carried, and style is last in line by construction.
 *
 * `maxTokens` is the caller's, deliberately. §9 says memory must never push
 * out the current user request or the required output budget, and only the
 * caller knows what those are; a default here would be a guess that silently
 * wins over a real constraint.
 */
export function selectMemoryContext(
    scored: readonly ScoredMemory[],
    budget: MemoryContextBudget = DEFAULT_MEMORY_CONTEXT_BUDGET,
    options: { minimumCoverage?: number } = {}
): MemoryContextSelection {
    const minimumCoverage = options.minimumCoverage ?? 0;
    const dropped = {
        belowRelevance: 0,
        sourceLimit: 0,
        duplicate: 0,
        tokenBudget: 0,
        itemLimit: 0,
    };

    const eligible = scored.filter((entry) => {
        // A pinned memory is carried whether or not the request mentions it:
        // pinning is the user saying "this is always relevant".
        if (entry.memory.pinned) return true;
        if (entry.coverage >= minimumCoverage && entry.matchedTerms > 0) {
            return true;
        }
        dropped.belowRelevance += 1;
        return false;
    });

    const ordered = [...eligible].sort((left, right) => {
        if (left.memory.pinned !== right.memory.pinned) {
            return left.memory.pinned ? -1 : 1;
        }
        if (right.score !== left.score) return right.score - left.score;
        // Stable and reproducible: the §10 bundle hashes this result, so two
        // equally-scored memories must not swap places between two runs.
        return left.memory.id < right.memory.id ? -1 : 1;
    });

    const factual: ScoredMemory[] = [];
    const style: ScoredMemory[] = [];
    const perSource = new Map<string, number>();
    const seenDuplicates = new Set<string>();
    let estimatedTokens = 0;

    const carry = (entry: ScoredMemory): boolean => {
        const key = duplicateKey(entry.memory);
        if (seenDuplicates.has(key)) {
            dropped.duplicate += 1;
            return false;
        }
        const overloadedSource = entry.memory.sourceKeys.find(
            (source) => (perSource.get(source) ?? 0) >= budget.maxPerSource
        );
        if (overloadedSource) {
            // One imported conversation must not fill the whole budget with
            // its own view of the user (§9 same-source diversity).
            dropped.sourceLimit += 1;
            return false;
        }
        if (factual.length + style.length >= budget.maxItems) {
            dropped.itemLimit += 1;
            return false;
        }
        const cost = memoryContextTokens(entry.memory);
        if (estimatedTokens + cost > budget.maxTokens) {
            dropped.tokenBudget += 1;
            return false;
        }

        estimatedTokens += cost;
        seenDuplicates.add(key);
        for (const source of entry.memory.sourceKeys) {
            perSource.set(source, (perSource.get(source) ?? 0) + 1);
        }
        return true;
    };

    // Factual first: §9.1 puts approved factual memory above answer style in
    // the prompt, and a budget that ran out on style examples has lost less
    // than one that ran out on facts.
    for (const entry of ordered) {
        if (isStyleMemoryKind(entry.memory.kind)) continue;
        if (carry(entry)) factual.push(entry);
    }
    for (const entry of ordered) {
        if (!isStyleMemoryKind(entry.memory.kind)) continue;
        if (carry(entry)) style.push(entry);
    }

    return { factual, style, estimatedTokens, dropped };
}

/**
 * Stable hash of a selection, for the §10 context bundle.
 *
 * Covers what was chosen and in what order, plus the algorithm identity: a
 * retrieval that produced the same memories under a different version is a
 * different snapshot, because the next request would not necessarily reproduce
 * it. Returned as material to hash rather than a digest, so the caller uses
 * whatever hash the bundle format specifies.
 */
export function retrievalResultMaterial(
    selection: MemoryContextSelection
): string {
    return [
        `v${MEMORY_RETRIEVAL_VERSION}`,
        ...selection.factual.map((entry) => `f:${entry.memory.id}`),
        ...selection.style.map((entry) => `s:${entry.memory.id}`),
    ].join("|");
}
