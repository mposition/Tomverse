/**
 * Semantic retrieval through an external rerank / embedding provider (Cohere).
 *
 * docs/policy/external-conversation-import-and-memory.md section 9a. Lexical
 * retrieval v1 stays the default and the fallback: every feature here is off
 * until an operator turns its switch on, and each call needs a model, a price
 * and a budget from the environment before it is made. Nothing in this file
 * calls anything -- it is the configuration, the cost bounds, the wire shapes
 * and the vector maths, kept pure so each can be tested against fixed input.
 *
 * Three things are decided here rather than at the call sites:
 *
 *   * **A price is configuration, not a constant.** The provider's price page
 *     did not publish rerank or embedding prices when this was written, so a
 *     hard-coded number would be a guess that silently mis-reserves. No price
 *     in the environment means no call.
 *   * **The reservation is an upper bound; the settlement is the bill.** Tokens
 *     are bounded by UTF-8 bytes (a token is at least one byte), search units
 *     by the provider's documented splitting rule. The provider's own
 *     `billed_units` moves the hold to what was actually charged.
 *   * **Scores are rounded before they are compared or hashed.** A context
 *     bundle is recomputed on every route of a turn and its fingerprint has to
 *     match; float noise must not be able to reorder two candidates.
 */

import { createHash } from "node:crypto";
import type { SemanticStepsUsed } from "@/lib/chatContextBundleCore";

export const SEMANTIC_RETRIEVAL_PROVIDER = "cohere";

/**
 * Whether the privacy policy publishes the semantic search notice: what is sent
 * to Cohere, to which entity and country, when, for what, how long it is kept,
 * and how to refuse (import/memory policy §16, PIPA art. 28-8(2)).
 *
 * False until that notice is on the live page. While it is false no semantic
 * call is made, whatever the switches and the environment say, and Admin
 * refuses to turn a switch on -- the comment monitor's precedent
 * (lib/privacyNoticeStatus.ts), where a feature that sends personal data out
 * does not run before its notice exists.
 *
 * Deliberately not in lib/privacyNoticeStatus.ts: that file is part of the
 * /privacy page digest (tests/support/amendedDocumentVerifiers.mjs), and this
 * flag must be able to sit at false without moving an approved page version.
 * It is set to true in the change that publishes the notice, which is an owner
 * approval of a new /privacy version.
 */
export const SEMANTIC_RETRIEVAL_PRIVACY_NOTICE_PUBLISHED = false as boolean;

/**
 * The notice flag as the runtime reads it. A test process (NODE_ENV "test")
 * may stand in a published notice so the database suites can exercise the
 * calls; nothing else can, and a production process never runs as "test".
 */
export const semanticRetrievalNoticePublished = (
    env: Record<string, string | undefined> = process.env,
    published: boolean = SEMANTIC_RETRIEVAL_PRIVACY_NOTICE_PUBLISHED
): boolean =>
    published || (env.NODE_ENV === "test" && env.SEMANTIC_RETRIEVAL_TEST_NOTICE === "published");

/** The switches an operator can turn on. All are off without a stored "on". */
export const SEMANTIC_RETRIEVAL_FEATURES = [
    "knowledgeRerank",
    "knowledgeEmbed",
    "knowledgeImagePages",
    "memoryRerank",
    "memoryDuplicates",
] as const;

export type SemanticRetrievalFeature = (typeof SEMANTIC_RETRIEVAL_FEATURES)[number];

export const semanticRetrievalSettingKey = (feature: SemanticRetrievalFeature) =>
    `retrieval.cohere.${feature}`;

/**
 * Whether a retrieval may ask the provider, or may only reuse what is cached.
 *
 * A context bundle is issued by one route and verified by another. Only the
 * issuing routes ("allow") call the provider; the route that verifies and
 * sends ("cached_only") reuses the outcome the issuing route stored and
 * otherwise stays lexical. That is what lets a bundle signed over a lexical
 * selection -- because the provider failed, the budget refused, or the cache
 * itself could not be written -- be reproduced exactly: the verifying route
 * cannot turn it semantic by succeeding where the issuing route did not. It
 * also means the send path never waits on, or pays, the retrieval provider.
 *
 * "off" skips the semantic step entirely, cache included: the verifying route
 * uses it for every step the bundle says was not used.
 */
export type SemanticCallMode = "allow" | "cached_only" | "off";

/** One mode per semantic step of a turn. */
export type SemanticStepModes = {
    memoryRerank: SemanticCallMode;
    knowledgeNeighbours: SemanticCallMode;
    knowledgeRerank: SemanticCallMode;
};

/**
 * The modes that rebuild exactly the selection a bundle was issued with.
 *
 * A step the bundle records as used is reproduced from its stored outcome;
 * every other step is off. Neither mode can call the provider, so the
 * verifying route never does -- and a bundle whose steps cannot be read (it
 * will fail verification anyway) is rebuilt with everything off.
 */
export const verifyingSemanticModes = (steps: SemanticStepsUsed | null): SemanticStepModes => ({
    memoryRerank: steps?.memoryRerank ? "cached_only" : "off",
    knowledgeNeighbours: steps?.knowledgeNeighbours ? "cached_only" : "off",
    knowledgeRerank: steps?.knowledgeRerank ? "cached_only" : "off",
});

/** Which API a feature spends on, so a feature is ready only with that config. */
export const SEMANTIC_RETRIEVAL_FEATURE_API: Record<
    SemanticRetrievalFeature,
    "rerank" | "embed" | "embedImage"
> = {
    knowledgeRerank: "rerank",
    knowledgeEmbed: "embed",
    knowledgeImagePages: "embedImage",
    memoryRerank: "rerank",
    memoryDuplicates: "embed",
};

// ---------------------------------------------------------------------------
// Environment configuration
// ---------------------------------------------------------------------------

export const SEMANTIC_RETRIEVAL_ENV = {
    apiKey: "COHERE_API_KEY",
    rerankModel: "COHERE_RERANK_MODEL",
    rerankPrice: "COHERE_RERANK_MICROUSD_PER_SEARCH_UNIT",
    rerankTokenPrice: "COHERE_RERANK_MICROUSD_PER_MILLION_TOKENS",
    embedModel: "COHERE_EMBED_MODEL",
    embedDimension: "COHERE_EMBED_DIMENSION",
    embedTextPrice: "COHERE_EMBED_MICROUSD_PER_MILLION_TEXT_TOKENS",
    embedImagePrice: "COHERE_EMBED_MICROUSD_PER_MILLION_IMAGE_TOKENS",
    budgetDay: "RETRIEVAL_PROVIDER_COHERE_COST_MICROUSD_PER_DAY",
    budgetMonth: "RETRIEVAL_PROVIDER_COHERE_COST_MICROUSD_PER_MONTH",
} as const;

/**
 * How the configured rerank model is billed. Older models bill per search
 * unit; newer ones may bill per token. The operator sets exactly one price,
 * and that choice is the billing unit: the reservation is bounded in it, and
 * settlement reads only the billed figure in that unit.
 */
export type RerankBilling =
    | { unit: "search_unit"; microUsdPerSearchUnit: number }
    | { unit: "token"; microUsdPerMillionTokens: number };

export type SemanticRetrievalConfig = {
    rerank: { model: string; billing: RerankBilling } | null;
    embed: {
        model: string;
        /** Null leaves the provider's default dimension. */
        dimension: number | null;
        microUsdPerMillionTextTokens: number;
        /** Null means image inputs are not priced, so they are not sent. */
        microUsdPerMillionImageTokens: number | null;
    } | null;
    /** Null when either window is missing or invalid: nothing may be spent. */
    budget: { day: number; month: number } | null;
    /** Names of variables that are set but unusable. Never their values. */
    problems: string[];
};

type Env = Record<string, string | undefined>;

const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{1,79}$/i;

const readText = (env: Env, name: string) => {
    const value = env[name]?.trim();
    return value ? value : null;
};

const readPositiveInteger = (env: Env, name: string, problems: string[]) => {
    const raw = readText(env, name);
    if (raw === null) return null;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        problems.push(name);
        return null;
    }
    return parsed;
};

const readModel = (env: Env, name: string, problems: string[]) => {
    const raw = readText(env, name);
    if (raw === null) return null;
    if (!MODEL_ID_PATTERN.test(raw)) {
        problems.push(name);
        return null;
    }
    return raw;
};

/**
 * What this deployment is configured to call, read from the environment.
 *
 * Fail closed at every step: a model without a price, a price that is not a
 * positive integer of micro-USD, or one budget window without the other all
 * resolve to "not configured", and the switch then has nothing to turn on.
 */
export const resolveSemanticRetrievalConfig = (
    env: Env = process.env
): SemanticRetrievalConfig => {
    const problems: string[] = [];

    const rerankModel = readModel(env, SEMANTIC_RETRIEVAL_ENV.rerankModel, problems);
    const rerankPrice = readPositiveInteger(env, SEMANTIC_RETRIEVAL_ENV.rerankPrice, problems);
    const rerankTokenPrice = readPositiveInteger(
        env,
        SEMANTIC_RETRIEVAL_ENV.rerankTokenPrice,
        problems
    );
    // Decided by which variables are *set*, not by which parse: both set is
    // not a configuration -- nothing says which one the invoice uses -- even
    // when one of them is a typo, because the typo may be the one that was
    // meant. And a set price that does not parse turns rerank off rather than
    // leaving it to the other unit.
    const unitPriceSet = readText(env, SEMANTIC_RETRIEVAL_ENV.rerankPrice) !== null;
    const tokenPriceSet = readText(env, SEMANTIC_RETRIEVAL_ENV.rerankTokenPrice) !== null;
    let rerankBilling: RerankBilling | null = null;
    if (unitPriceSet && tokenPriceSet) {
        for (const name of [SEMANTIC_RETRIEVAL_ENV.rerankPrice, SEMANTIC_RETRIEVAL_ENV.rerankTokenPrice]) {
            if (!problems.includes(name)) problems.push(name);
        }
    } else if (unitPriceSet && rerankPrice !== null) {
        rerankBilling = { unit: "search_unit", microUsdPerSearchUnit: rerankPrice };
    } else if (tokenPriceSet && rerankTokenPrice !== null) {
        rerankBilling = { unit: "token", microUsdPerMillionTokens: rerankTokenPrice };
    }

    const embedModel = readModel(env, SEMANTIC_RETRIEVAL_ENV.embedModel, problems);
    const embedDimension = readPositiveInteger(env, SEMANTIC_RETRIEVAL_ENV.embedDimension, problems);
    // A dimension that is set but unusable turns embedding off rather than
    // falling back to the provider's default: vectors of a size nobody chose
    // would be stored, and then discarded when the typo is fixed.
    const embedDimensionUsable =
        embedDimension !== null || readText(env, SEMANTIC_RETRIEVAL_ENV.embedDimension) === null;
    const embedTextPrice = readPositiveInteger(env, SEMANTIC_RETRIEVAL_ENV.embedTextPrice, problems);
    const embedImagePrice = readPositiveInteger(env, SEMANTIC_RETRIEVAL_ENV.embedImagePrice, problems);

    const day = readPositiveInteger(env, SEMANTIC_RETRIEVAL_ENV.budgetDay, problems);
    const month = readPositiveInteger(env, SEMANTIC_RETRIEVAL_ENV.budgetMonth, problems);
    let budget: SemanticRetrievalConfig["budget"] = null;
    if (day !== null && month !== null) {
        if (day <= month) budget = { day, month };
        else problems.push(SEMANTIC_RETRIEVAL_ENV.budgetDay);
    }

    return {
        rerank: rerankModel && rerankBilling ? { model: rerankModel, billing: rerankBilling } : null,
        embed:
            embedModel && embedTextPrice && embedDimensionUsable
                ? {
                      model: embedModel,
                      dimension: embedDimension,
                      microUsdPerMillionTextTokens: embedTextPrice,
                      microUsdPerMillionImageTokens: embedImagePrice,
                  }
                : null,
        budget,
        problems,
    };
};

/** Whether a feature has everything it needs besides its switch and the key. */
export const semanticRetrievalFeatureConfigured = (
    feature: SemanticRetrievalFeature,
    config: SemanticRetrievalConfig
): boolean => {
    if (!config.budget) return false;
    const api = SEMANTIC_RETRIEVAL_FEATURE_API[feature];
    if (api === "rerank") return config.rerank !== null;
    if (api === "embed") return config.embed !== null;
    return config.embed !== null && config.embed.microUsdPerMillionImageTokens !== null;
};

/**
 * The label stored beside a vector. A row whose label is not the current one
 * was produced by another model or dimension and is not comparable, so it is
 * skipped until it is re-embedded rather than compared and trusted.
 */
export const embeddingModelLabel = (embed: NonNullable<SemanticRetrievalConfig["embed"]>) =>
    `${SEMANTIC_RETRIEVAL_PROVIDER}:${embed.model}:${embed.dimension ?? "default"}:int8`;

// ---------------------------------------------------------------------------
// Bucket names (ChatUsageBucket)
// ---------------------------------------------------------------------------

/**
 * Its own prefix and periods, on the search and voice budgets' precedent: this
 * is a different invoice from any model provider's tokens, and the `provider:`
 * prefix is what settlement keys a model provider's bucket on.
 */
export const RETRIEVAL_PROVIDER_BUCKET_KEY = `retrieval-provider:${SEMANTIC_RETRIEVAL_PROVIDER}`;

export const RETRIEVAL_PROVIDER_BUDGET_PERIODS = [
    "retrieval-cost-day",
    "retrieval-cost-month",
] as const;

export const retrievalBudgetPeriods = (now: Date) => [
    {
        period: RETRIEVAL_PROVIDER_BUDGET_PERIODS[0],
        start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
    },
    {
        period: RETRIEVAL_PROVIDER_BUDGET_PERIODS[1],
        start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    },
];

// ---------------------------------------------------------------------------
// Request limits and cost bounds
// ---------------------------------------------------------------------------

export const SEMANTIC_RETRIEVAL_LIMITS = {
    /** One request; a retry could be billed twice. */
    requestTimeoutMs: 4_000,
    /** Indexing is not on a user's turn, so it may wait longer. */
    indexingTimeoutMs: 20_000,
    /** The provider bills one search unit per 100 documents. */
    maxRerankDocuments: 100,
    maxQueryCharacters: 2_000,
    /**
     * The question as sent for reranking, in UTF-8 bytes. The provider splits
     * a document into pieces of about 500 tokens *including the query*, so the
     * query's length is part of what is billed; bounding it in bytes bounds
     * it in tokens, and keeps every piece at least 100 tokens of document.
     */
    rerankMaxQueryBytes: 400,
    /** Sent as `max_tokens_per_doc`, so a document's cost is bounded. */
    rerankMaxTokensPerDocument: 1_024,
    /** The provider's documented embed batch size. */
    maxEmbedInputsPerRequest: 96,
    /**
     * Page images per embed request. Far below the provider's 20 MB request
     * limit at the rendered page size, so one refused batch costs few pages.
     */
    maxEmbedImagesPerRequest: 8,
    /** An upper bound for one page image, replaced by the billed figure. */
    imageTokenUpperBound: 8_000,
    /**
     * Longer than a context bundle lives (five minutes), and counted from the
     * last read: a bundle signed from a cached outcome must find that outcome
     * for its whole life, however old the entry already was.
     */
    cacheTtlMs: 10 * 60 * 1000,
} as const;

/**
 * The provider's billing window: a document longer than this many tokens,
 * query included, is billed as several documents.
 */
const RERANK_BILLING_WINDOW_TOKENS = 500;

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");

/**
 * The question exactly as a rerank request sends it: NFC, and cut at
 * `rerankMaxQueryBytes` without splitting a character.
 */
export const boundRerankQuery = (query: string): string => {
    const limit = SEMANTIC_RETRIEVAL_LIMITS.rerankMaxQueryBytes;
    let bounded = "";
    let bytes = 0;
    for (const character of query.normalize("NFC")) {
        const size = utf8Bytes(character);
        if (bytes + size > limit) break;
        bounded += character;
        bytes += size;
    }
    return bounded;
};

/**
 * The most search units one rerank request can be billed.
 *
 * Every quantity is an upper bound: a token is at least one byte, so the
 * query's tokens are at most its bytes and a document's at most its bytes or
 * the per-document cap; each piece holds at least the window minus the
 * query. The query is bounded the way the request bounds it, so the figure
 * reserved is never below the figure billed.
 */
export const rerankWorstCaseSearchUnits = (
    query: string,
    documents: readonly string[]
): number => {
    const queryTokens = utf8Bytes(boundRerankQuery(query));
    const documentRoom = RERANK_BILLING_WINDOW_TOKENS - queryTokens;
    let pieces = 0;
    for (const document of documents) {
        const tokens = Math.min(
            utf8Bytes(document),
            SEMANTIC_RETRIEVAL_LIMITS.rerankMaxTokensPerDocument
        );
        pieces += Math.max(1, Math.ceil(tokens / documentRoom));
    }
    return Math.max(1, Math.ceil(pieces / SEMANTIC_RETRIEVAL_LIMITS.maxRerankDocuments));
};

export const rerankCostMicroUsd = (searchUnits: number, microUsdPerSearchUnit: number) =>
    Math.ceil(searchUnits * microUsdPerSearchUnit);

/**
 * The most tokens one rerank request can be billed, for a model billed per
 * token. Every document is counted with the whole question beside it, as if
 * the question were billed once per document: an over-count when it is billed
 * once, and the point of an upper bound when nothing published says which.
 */
export const rerankWorstCaseTokens = (query: string, documents: readonly string[]): number => {
    const queryTokens = utf8Bytes(boundRerankQuery(query));
    let tokens = queryTokens;
    for (const document of documents) {
        tokens +=
            queryTokens +
            Math.min(utf8Bytes(document), SEMANTIC_RETRIEVAL_LIMITS.rerankMaxTokensPerDocument);
    }
    return Math.max(1, tokens);
};

/** The worst case of one rerank request in micro-USD, in the configured unit. */
export const rerankWorstCaseMicroUsd = (
    billing: RerankBilling,
    query: string,
    documents: readonly string[]
): number =>
    billing.unit === "search_unit"
        ? rerankCostMicroUsd(rerankWorstCaseSearchUnits(query, documents), billing.microUsdPerSearchUnit)
        : embedCostMicroUsd(rerankWorstCaseTokens(query, documents), billing.microUsdPerMillionTokens);

/**
 * What a rerank response says it billed, in the configured unit, or null when
 * it reports nothing in that unit. Null keeps the whole hold: a figure in
 * another unit is a model whose billing the configuration does not describe,
 * and guessing a conversion would settle to a number nobody chose.
 */
export const rerankBilledMicroUsd = (
    billing: RerankBilling,
    billed: { searchUnits: number | null; inputTokens: number | null }
): number | null => {
    if (billing.unit === "search_unit") {
        return billed.searchUnits === null
            ? null
            : rerankCostMicroUsd(billed.searchUnits, billing.microUsdPerSearchUnit);
    }
    return billed.inputTokens === null
        ? null
        : embedCostMicroUsd(billed.inputTokens, billing.microUsdPerMillionTokens);
};

/** A token is at least one byte, so bytes bound the tokens of any text. */
export const embedTextWorstCaseTokens = (texts: readonly string[]) =>
    texts.reduce((total, text) => total + Math.max(1, utf8Bytes(text)), 0);

export const embedCostMicroUsd = (tokens: number, microUsdPerMillionTokens: number) =>
    Math.ceil((tokens * microUsdPerMillionTokens) / 1_000_000);

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export const COHERE_RERANK_URL = "https://api.cohere.com/v2/rerank";
export const COHERE_EMBED_URL = "https://api.cohere.com/v2/embed";

export const boundQuery = (query: string) =>
    query.normalize("NFC").slice(0, SEMANTIC_RETRIEVAL_LIMITS.maxQueryCharacters);

export const rerankRequestBody = (input: {
    model: string;
    query: string;
    documents: readonly string[];
}) => ({
    model: input.model,
    query: boundRerankQuery(input.query),
    documents: [...input.documents],
    max_tokens_per_doc: SEMANTIC_RETRIEVAL_LIMITS.rerankMaxTokensPerDocument,
});

export type EmbedInputType = "search_document" | "search_query";

export const embedRequestBody = (input: {
    model: string;
    dimension: number | null;
    inputType: EmbedInputType;
    texts?: readonly string[];
    /** `data:image/...;base64,...` URIs. */
    images?: readonly string[];
}) => ({
    model: input.model,
    input_type: input.inputType,
    embedding_types: ["int8"],
    truncate: "END",
    ...(input.dimension ? { output_dimension: input.dimension } : {}),
    ...(input.images
        ? {
              inputs: input.images.map((url) => ({
                  content: [{ type: "image_url", image_url: { url } }],
              })),
          }
        : { texts: [...(input.texts ?? [])] }),
});

const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;

const billedUnit = (body: Record<string, unknown>, name: string): number | null => {
    const billed = asRecord(asRecord(body.meta)?.billed_units);
    const value = billed?.[name];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
};

/** Fixed precision, so float noise cannot reorder candidates or move a hash. */
export const SEMANTIC_SCORE_SCALE = 10_000;

export const roundSemanticScore = (score: number) =>
    Math.round(Math.min(1, Math.max(0, score)) * SEMANTIC_SCORE_SCALE) / SEMANTIC_SCORE_SCALE;

export type ParsedRerank = {
    /** One score per submitted document index; rounded, in [0, 1]. */
    scores: number[];
    /** Null when the provider did not say what it billed in search units. */
    searchUnits: number | null;
    /** Null when the provider did not say what it billed in tokens. */
    inputTokens: number | null;
};

/**
 * A rerank answer is used only when it scores every document exactly once.
 *
 * The one cheap check on model output at this boundary: an index outside the
 * submitted list, a repeated index or a missing one would let the provider's
 * answer decide which stored text reaches a prompt in a way nothing here
 * asked for. A partial answer is discarded and lexical order stands.
 */
export const parseRerankResponse = (body: unknown, documentCount: number): ParsedRerank | null => {
    const record = asRecord(body);
    if (!record || !Array.isArray(record.results)) return null;
    if (record.results.length !== documentCount) return null;
    const scores = new Array<number>(documentCount).fill(Number.NaN);
    for (const entry of record.results) {
        const result = asRecord(entry);
        if (!result) return null;
        const index = result.index;
        const score = result.relevance_score;
        if (typeof index !== "number" || !Number.isInteger(index)) return null;
        if (index < 0 || index >= documentCount || !Number.isNaN(scores[index])) return null;
        if (typeof score !== "number" || !Number.isFinite(score)) return null;
        scores[index] = roundSemanticScore(score);
    }
    return {
        scores,
        searchUnits: billedUnit(record, "search_units"),
        inputTokens: billedUnit(record, "input_tokens"),
    };
};

export type ParsedEmbed = {
    vectors: Int8Array[];
    inputTokens: number | null;
    imageTokens: number | null;
};

/** Embeddings are used only when there is one int8 vector per input, all one length. */
export const parseEmbedResponse = (body: unknown, inputCount: number): ParsedEmbed | null => {
    const record = asRecord(body);
    const raw = asRecord(record?.embeddings)?.int8;
    if (!record || !Array.isArray(raw) || raw.length !== inputCount) return null;
    const vectors: Int8Array[] = [];
    let length = -1;
    for (const entry of raw) {
        if (!Array.isArray(entry) || entry.length === 0 || entry.length > 4_096) return null;
        if (length === -1) length = entry.length;
        if (entry.length !== length) return null;
        const vector = new Int8Array(entry.length);
        for (let index = 0; index < entry.length; index += 1) {
            const value = entry[index];
            if (typeof value !== "number" || !Number.isInteger(value) || value < -128 || value > 127) {
                return null;
            }
            vector[index] = value;
        }
        vectors.push(vector);
    }
    return {
        vectors,
        inputTokens: billedUnit(record, "input_tokens"),
        imageTokens: billedUnit(record, "image_tokens"),
    };
};

// ---------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------

/** A copy, in the exact byte type a Prisma `Bytes` column accepts. */
export const encodeVector = (vector: Int8Array): Uint8Array<ArrayBuffer> => {
    const bytes = new Uint8Array(vector.length);
    bytes.set(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
    return bytes;
};

export const decodeVector = (bytes: Uint8Array | null | undefined): Int8Array | null =>
    bytes && bytes.byteLength > 0
        ? new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : null;

/** Cosine similarity, rounded; 0 for vectors that cannot be compared. */
export const cosineSimilarity = (a: Int8Array, b: Int8Array): number => {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let index = 0; index < a.length; index += 1) {
        dot += a[index] * b[index];
        normA += a[index] * a[index];
        normB += b[index] * b[index];
    }
    if (normA === 0 || normB === 0) return 0;
    const cosine = dot / Math.sqrt(normA * normB);
    return Math.round(cosine * SEMANTIC_SCORE_SCALE) / SEMANTIC_SCORE_SCALE;
};

/**
 * The ids nearest a query vector, best first, ties broken by id.
 *
 * Total order on purpose: two identical requests must pick the same
 * neighbours whichever order the database returned the rows in.
 */
export const nearestByCosine = <T extends { id: string; vector: Int8Array }>(
    query: Int8Array,
    rows: readonly T[],
    options: { limit: number; minSimilarity: number }
): Array<{ id: string; similarity: number }> =>
    rows
        .map((row) => ({ id: row.id, similarity: cosineSimilarity(query, row.vector) }))
        .filter((row) => row.similarity >= options.minSimilarity)
        .sort((a, b) =>
            b.similarity !== a.similarity
                ? b.similarity - a.similarity
                : a.id < b.id
                  ? -1
                  : a.id > b.id
                    ? 1
                    : 0
        )
        .slice(0, options.limit);

// ---------------------------------------------------------------------------
// Outcome cache
// ---------------------------------------------------------------------------

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The cache key of one rerank: the model, the question and exactly which texts
 * were ranked. The texts are hashed rather than named by id alone, because a
 * memory can be edited in place and an edited statement is a different
 * document under the same id.
 */
export const rerankCacheKey = (input: {
    feature: SemanticRetrievalFeature;
    userId: string;
    model: string;
    query: string;
    documents: ReadonlyArray<{ id: string; text: string }>;
}) =>
    sha256(
        JSON.stringify([
            "rerank-v1",
            input.feature,
            input.userId,
            input.model,
            boundRerankQuery(input.query),
            input.documents.map((document) => [document.id, sha256(document.text)]),
        ])
    );

export const queryEmbeddingCacheKey = (input: {
    userId: string;
    modelLabel: string;
    query: string;
}) => sha256(JSON.stringify(["query-embed-v1", input.userId, input.modelLabel, boundQuery(input.query)]));

/**
 * The cache key of one neighbour search: the model, the question and which
 * files were in scope. Not the vectors searched -- that is the point. The
 * index keeps filling in while a turn is in flight, and a rebuild of the same
 * turn has to see the neighbours the signed bundle saw.
 */
export const neighbourCacheKey = (input: {
    userId: string;
    modelLabel: string;
    query: string;
    fileIds: readonly string[];
}) =>
    sha256(
        JSON.stringify([
            "neighbours-v1",
            input.userId,
            input.modelLabel,
            boundQuery(input.query),
            [...new Set(input.fileIds)].sort(),
        ])
    );

/**
 * What the cache stores for one key.
 *
 * `failed` is stored too. A turn's context is rebuilt on up to three routes
 * and all of them have to reach the same selection; if the first attempt fell
 * back to lexical order, the later ones must fall back as well rather than
 * succeed and disagree with a bundle that was already signed.
 */
export type SemanticCacheValue =
    | { kind: "rerank"; scores: Array<[string, number]> }
    | { kind: "neighbours"; scores: Array<[string, number]> }
    | { kind: "embedding"; vector: string }
    | { kind: "failed" };

export const parseSemanticCacheValue = (value: unknown): SemanticCacheValue | null => {
    const record = asRecord(value);
    if (!record) return null;
    if (record.kind === "failed") return { kind: "failed" };
    if (record.kind === "embedding" && typeof record.vector === "string" && record.vector) {
        return { kind: "embedding", vector: record.vector };
    }
    if ((record.kind === "rerank" || record.kind === "neighbours") && Array.isArray(record.scores)) {
        const scores: Array<[string, number]> = [];
        for (const entry of record.scores) {
            if (!Array.isArray(entry) || entry.length !== 2) return null;
            const [id, score] = entry;
            if (typeof id !== "string" || typeof score !== "number" || !Number.isFinite(score)) {
                return null;
            }
            scores.push([id, score]);
        }
        return { kind: record.kind, scores };
    }
    return null;
};
