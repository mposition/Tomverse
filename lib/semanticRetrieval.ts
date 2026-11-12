import "server-only";

import { Prisma } from "@prisma/client";
import { holdChatUsageBucket } from "@/lib/chatSecurity";
import { prisma } from "@/lib/prisma";
import { callEmbed, callRerank, readSemanticRetrievalKey } from "@/lib/semanticRetrievalClient";
import {
    RETRIEVAL_PROVIDER_BUCKET_KEY,
    SEMANTIC_RETRIEVAL_LIMITS,
    boundQuery,
    decodeVector,
    embedCostMicroUsd,
    embedTextWorstCaseTokens,
    embeddingModelLabel,
    encodeVector,
    parseSemanticCacheValue,
    queryEmbeddingCacheKey,
    rerankCacheKey,
    rerankCostMicroUsd,
    rerankWorstCaseSearchUnits,
    resolveSemanticRetrievalConfig,
    retrievalBudgetPeriods,
    semanticRetrievalFeatureConfigured,
    type SemanticCacheValue,
    type SemanticRetrievalConfig,
    type SemanticRetrievalFeature,
} from "@/lib/semanticRetrievalCore";
import { readSemanticRetrievalSwitch } from "@/lib/semanticRetrievalSettings";

/**
 * Semantic retrieval calls, each behind its switch, its configuration, the
 * retrieval provider's own budget and an outcome cache.
 *
 * Every function here answers "use this, or carry on without it": null means
 * the caller keeps what lexical retrieval produced. Nothing throws into a
 * chat turn or a file-processing run, and money fails closed -- no switch, no
 * price, no budget or no room in the budget all mean no request is sent.
 *
 * The cache is what keeps a turn consistent. A context bundle is rebuilt on up
 * to three routes and refused when the rebuilt fingerprint differs from the
 * signed one, so the first outcome for a (question, candidates) pair -- a
 * ranking or a failure -- is the outcome for every rebuild within the bundle's
 * lifetime. It also means the provider is paid once per turn rather than three
 * times.
 */

type ReadyFeature = { config: SemanticRetrievalConfig; budget: { day: number; month: number } };

/** The feature's configuration when its switch is on and it can be paid for. */
export const semanticFeatureReady = async (
    feature: SemanticRetrievalFeature
): Promise<ReadyFeature | null> => {
    const config = resolveSemanticRetrievalConfig();
    if (!semanticRetrievalFeatureConfigured(feature, config) || !config.budget) return null;
    if (!readSemanticRetrievalKey()) return null;
    if (!(await readSemanticRetrievalSwitch(feature))) return null;
    return { config, budget: config.budget };
};

const log = (fields: Record<string, unknown>) =>
    console.info(JSON.stringify({ event: "semantic_retrieval", ...fields }));

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

class RetrievalBudgetRefused extends Error {}

/**
 * Holds a call's worst case under the day and month budgets, both or neither.
 * False -- and no call -- when either is spent or the hold cannot be written.
 * Exported for the database test.
 */
export async function reserveRetrievalCost(
    microUsd: number,
    limits: { day: number; month: number },
    now: Date
): Promise<boolean> {
    const windows = [limits.day, limits.month];
    try {
        await prisma.$transaction(async (tx) => {
            for (const [index, { period, start }] of retrievalBudgetPeriods(now).entries()) {
                const held = await holdChatUsageBucket(
                    tx,
                    RETRIEVAL_PROVIDER_BUCKET_KEY,
                    period,
                    start,
                    windows[index],
                    microUsd
                );
                if (!held) throw new RetrievalBudgetRefused();
            }
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * Moves a hold to what the provider says it billed. Only called with billed
 * units the provider reported: a failed or timed-out request keeps its whole
 * hold, because it may still have been charged. Exported for the database test.
 */
export async function settleRetrievalCost(deltaMicroUsd: number, reservedAt: Date): Promise<void> {
    if (!Number.isSafeInteger(deltaMicroUsd) || deltaMicroUsd === 0) return;
    try {
        await prisma.$transaction(async (tx) => {
            for (const { period, start } of retrievalBudgetPeriods(reservedAt)) {
                await tx.$executeRaw`
                    UPDATE "ChatUsageBucket"
                    SET "count" = GREATEST(0, "count" + ${deltaMicroUsd}), "updatedAt" = NOW()
                    WHERE "key" = ${RETRIEVAL_PROVIDER_BUCKET_KEY}
                      AND "period" = ${period}
                      AND "periodStart" = ${start}
                `;
            }
        });
    } catch (error) {
        console.error(
            JSON.stringify({
                event: "semantic_retrieval_settle_failed",
                error: error instanceof Error ? error.name : "unknown",
            })
        );
    }
}

// ---------------------------------------------------------------------------
// Outcome cache
// ---------------------------------------------------------------------------

/**
 * A live outcome, and every read of one pushes its expiry a full TTL out.
 *
 * The extension is what makes the cache safe to sign against. A bundle lives
 * five minutes from the moment it is issued, and it may be issued from an
 * entry that was already nine minutes old; without the extension that entry
 * would expire inside the bundle's life and its rebuild would ask the
 * provider again and could disagree. A recorded failure is extended only
 * until it is `failedCacheMaxAgeMs` old, so an outage ends.
 */
const readCache = async (key: string): Promise<SemanticCacheValue | null> => {
    try {
        const rows = await prisma.$queryRaw<Array<{ value: unknown }>>`
            UPDATE "SemanticRetrievalCache"
            SET "expiresAt" = CASE
                WHEN ("value"->>'kind') = 'failed' THEN LEAST(
                    GREATEST(
                        "expiresAt",
                        NOW() + (${SEMANTIC_RETRIEVAL_LIMITS.cacheTtlMs} * INTERVAL '1 millisecond')
                    ),
                    GREATEST(
                        "expiresAt",
                        "createdAt" + (${SEMANTIC_RETRIEVAL_LIMITS.failedCacheMaxAgeMs} * INTERVAL '1 millisecond')
                    )
                )
                ELSE GREATEST(
                    "expiresAt",
                    NOW() + (${SEMANTIC_RETRIEVAL_LIMITS.cacheTtlMs} * INTERVAL '1 millisecond')
                )
            END
            WHERE "key" = ${key} AND "expiresAt" > NOW()
            RETURNING "value"
        `;
        return rows.length > 0 ? parseSemanticCacheValue(rows[0].value) : null;
    } catch {
        return null;
    }
};

/**
 * Stores an outcome unless a live one is already there, and returns whichever
 * is stored. Two routes of one turn can both miss and both call; the first
 * write wins so they still agree. The clock is the database's on both sides.
 */
const writeCache = async (
    key: string,
    userId: string,
    value: SemanticCacheValue
): Promise<SemanticCacheValue> => {
    try {
        const written = await prisma.$queryRaw<Array<{ value: unknown }>>`
            INSERT INTO "SemanticRetrievalCache" ("key", "userId", "value", "expiresAt", "createdAt")
            VALUES (
                ${key},
                ${userId},
                ${JSON.stringify(value)}::jsonb,
                NOW() + (${SEMANTIC_RETRIEVAL_LIMITS.cacheTtlMs} * INTERVAL '1 millisecond'),
                NOW()
            )
            ON CONFLICT ("key") DO UPDATE SET
                "userId" = EXCLUDED."userId",
                "value" = EXCLUDED."value",
                "expiresAt" = EXCLUDED."expiresAt",
                "createdAt" = EXCLUDED."createdAt"
            WHERE "SemanticRetrievalCache"."expiresAt" <= NOW()
            RETURNING "value"
        `;
        if (written.length > 0) return value;
        return (await readCache(key)) ?? value;
    } catch {
        return value;
    }
};

/** The cache, for a caller that computes its own outcome (neighbour search). */
export const readSemanticCache = readCache;
export const writeSemanticCache = writeCache;

/** Removes expired cache rows. Called from scheduled maintenance. */
export async function sweepSemanticRetrievalCache(limit = 5_000): Promise<number> {
    const removed = await prisma.$executeRaw(
        Prisma.sql`
            DELETE FROM "SemanticRetrievalCache"
            WHERE "key" IN (
                SELECT "key" FROM "SemanticRetrievalCache"
                WHERE "expiresAt" <= NOW()
                ORDER BY "expiresAt" ASC
                LIMIT ${limit}
            )
        `
    );
    return Number(removed);
}

// ---------------------------------------------------------------------------
// Rerank
// ---------------------------------------------------------------------------

/**
 * A relevance score in [0, 1] for each document, or null to keep lexical order.
 *
 * At most `maxRerankDocuments` are sent, in the order given; the caller's
 * order is already deterministic, so the same request ranks the same slice.
 */
export async function rerankForRetrieval(input: {
    feature: Extract<SemanticRetrievalFeature, "knowledgeRerank" | "memoryRerank">;
    userId: string;
    query: string;
    documents: ReadonlyArray<{ id: string; text: string }>;
    now?: Date;
}): Promise<ReadonlyMap<string, number> | null> {
    const query = boundQuery(input.query).trim();
    const documents = input.documents.slice(0, SEMANTIC_RETRIEVAL_LIMITS.maxRerankDocuments);
    if (!query || documents.length === 0) return null;

    const ready = await semanticFeatureReady(input.feature);
    if (!ready?.config.rerank) return null;
    const { model, microUsdPerSearchUnit } = ready.config.rerank;

    const key = rerankCacheKey({ feature: input.feature, userId: input.userId, model, query, documents });
    const cached = await readCache(key);
    if (cached) {
        log({ feature: input.feature, api: "rerank", outcome: cached.kind === "rerank" ? "cached" : "cached_failure" });
        return cached.kind === "rerank" ? new Map(cached.scores) : null;
    }

    const startedAt = Date.now();
    const reservedAt = input.now ?? new Date();
    const texts = documents.map((document) => document.text);
    const worstCase = rerankCostMicroUsd(rerankWorstCaseSearchUnits(texts), microUsdPerSearchUnit);
    const finish = async (value: SemanticCacheValue, fields: Record<string, unknown>) => {
        const stored = await writeCache(key, input.userId, value);
        log({
            feature: input.feature,
            api: "rerank",
            model,
            documents: documents.length,
            latencyMs: Date.now() - startedAt,
            ...fields,
        });
        return stored.kind === "rerank" ? new Map(stored.scores) : null;
    };

    if (!(await reserveRetrievalCost(worstCase, ready.budget, reservedAt))) {
        return finish({ kind: "failed" }, { outcome: "budget_refused" });
    }
    const result = await callRerank({ model, query, documents: texts });
    if (!result.ok) {
        // Nothing left this process: give the whole hold back.
        if (!result.sent) await settleRetrievalCost(-worstCase, reservedAt);
        return finish({ kind: "failed" }, { outcome: result.failure });
    }
    if (result.value.searchUnits !== null) {
        await settleRetrievalCost(
            rerankCostMicroUsd(result.value.searchUnits, microUsdPerSearchUnit) - worstCase,
            reservedAt
        );
    }
    return finish(
        {
            kind: "rerank",
            scores: documents.map((document, index) => [document.id, result.value.scores[index]]),
        },
        { outcome: "ranked", searchUnits: result.value.searchUnits }
    );
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

type EmbedFeature = Extract<
    SemanticRetrievalFeature,
    "knowledgeEmbed" | "knowledgeImagePages" | "memoryDuplicates"
>;

/** The label a stored vector must carry to be comparable right now, or null. */
export async function currentEmbeddingLabel(feature: EmbedFeature): Promise<string | null> {
    const ready = await semanticFeatureReady(feature);
    return ready?.config.embed ? embeddingModelLabel(ready.config.embed) : null;
}

/** The query's vector for this turn, or null to stay lexical. Cached like a ranking. */
export async function embedQueryForRetrieval(input: {
    feature: Extract<EmbedFeature, "knowledgeEmbed">;
    userId: string;
    query: string;
    now?: Date;
}): Promise<{ vector: Int8Array; modelLabel: string } | null> {
    const query = boundQuery(input.query).trim();
    if (!query) return null;
    const ready = await semanticFeatureReady(input.feature);
    const embed = ready?.config.embed;
    if (!ready || !embed) return null;
    const modelLabel = embeddingModelLabel(embed);

    const key = queryEmbeddingCacheKey({ userId: input.userId, modelLabel, query });
    const fromCache = (value: SemanticCacheValue | null) => {
        if (value?.kind !== "embedding") return null;
        const vector = decodeVector(Buffer.from(value.vector, "base64"));
        return vector ? { vector, modelLabel } : null;
    };
    const cached = await readCache(key);
    if (cached) {
        log({ feature: input.feature, api: "embed_query", outcome: cached.kind === "embedding" ? "cached" : "cached_failure" });
        return fromCache(cached);
    }

    const startedAt = Date.now();
    const reservedAt = input.now ?? new Date();
    const worstCase = embedCostMicroUsd(
        embedTextWorstCaseTokens([query]),
        embed.microUsdPerMillionTextTokens
    );
    const finish = async (value: SemanticCacheValue, fields: Record<string, unknown>) => {
        const stored = await writeCache(key, input.userId, value);
        log({
            feature: input.feature,
            api: "embed_query",
            model: embed.model,
            latencyMs: Date.now() - startedAt,
            ...fields,
        });
        return fromCache(stored);
    };

    if (!(await reserveRetrievalCost(worstCase, ready.budget, reservedAt))) {
        return finish({ kind: "failed" }, { outcome: "budget_refused" });
    }
    const result = await callEmbed({
        model: embed.model,
        dimension: embed.dimension,
        inputType: "search_query",
        texts: [query],
    });
    if (!result.ok) {
        if (!result.sent) await settleRetrievalCost(-worstCase, reservedAt);
        return finish({ kind: "failed" }, { outcome: result.failure });
    }
    if (result.value.inputTokens !== null) {
        await settleRetrievalCost(
            embedCostMicroUsd(result.value.inputTokens, embed.microUsdPerMillionTextTokens) - worstCase,
            reservedAt
        );
    }
    return finish(
        {
            kind: "embedding",
            vector: Buffer.from(encodeVector(result.value.vectors[0])).toString("base64"),
        },
        { outcome: "embedded", inputTokens: result.value.inputTokens }
    );
}

export type IndexedEmbeddings = { vectors: Array<Int8Array | null>; modelLabel: string };

/**
 * Vectors for stored texts or page images, for indexing rather than for a turn.
 *
 * Batched at the provider's request size. A batch that fails leaves nulls in
 * its positions and the rest carry on: an unembedded row is simply found by
 * lexical retrieval only, and a later run embeds what is still missing.
 */
export async function embedForIndexing(input: {
    feature: EmbedFeature;
    kind: "text" | "image";
    /** Texts, or `data:image/...;base64,...` URIs when `kind` is "image". */
    inputs: readonly string[];
    now?: Date;
}): Promise<IndexedEmbeddings | null> {
    if (input.inputs.length === 0) return null;
    const ready = await semanticFeatureReady(input.feature);
    const embed = ready?.config.embed;
    if (!ready || !embed) return null;
    const imagePrice = embed.microUsdPerMillionImageTokens;
    if (input.kind === "image" && imagePrice === null) return null;

    const vectors: Array<Int8Array | null> = new Array(input.inputs.length).fill(null);
    const size =
        input.kind === "image" ? 8 : SEMANTIC_RETRIEVAL_LIMITS.maxEmbedInputsPerRequest;
    let embedded = 0;
    const startedAt = Date.now();

    for (let offset = 0; offset < input.inputs.length; offset += size) {
        const batch = input.inputs.slice(offset, offset + size);
        const reservedAt = input.now ?? new Date();
        const price = input.kind === "image" ? (imagePrice as number) : embed.microUsdPerMillionTextTokens;
        const worstTokens =
            input.kind === "image"
                ? batch.length * SEMANTIC_RETRIEVAL_LIMITS.imageTokenUpperBound
                : embedTextWorstCaseTokens(batch);
        const worstCase = embedCostMicroUsd(worstTokens, price);
        if (!(await reserveRetrievalCost(worstCase, ready.budget, reservedAt))) {
            log({ feature: input.feature, api: "embed_index", outcome: "budget_refused" });
            break;
        }
        const result = await callEmbed(
            {
                model: embed.model,
                dimension: embed.dimension,
                inputType: "search_document",
                ...(input.kind === "image" ? { images: batch } : { texts: batch }),
            },
            { indexing: true }
        );
        if (!result.ok) {
            if (!result.sent) await settleRetrievalCost(-worstCase, reservedAt);
            log({ feature: input.feature, api: "embed_index", outcome: result.failure });
            continue;
        }
        const billed = input.kind === "image" ? result.value.imageTokens : result.value.inputTokens;
        if (billed !== null) {
            await settleRetrievalCost(embedCostMicroUsd(billed, price) - worstCase, reservedAt);
        }
        result.value.vectors.forEach((vector, index) => {
            vectors[offset + index] = vector;
        });
        embedded += batch.length;
    }

    log({
        feature: input.feature,
        api: "embed_index",
        kind: input.kind,
        model: embed.model,
        inputs: input.inputs.length,
        embedded,
        latencyMs: Date.now() - startedAt,
        outcome: embedded === input.inputs.length ? "embedded" : embedded > 0 ? "partial" : "none",
    });
    return embedded > 0 ? { vectors, modelLabel: embeddingModelLabel(embed) } : null;
}
