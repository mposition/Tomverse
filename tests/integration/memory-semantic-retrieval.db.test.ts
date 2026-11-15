import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import type { Session } from "next-auth";
import {
    issueChatContextBundle,
    readChatContextBundleSemanticSteps,
    verifyChatContextBundle,
} from "@/lib/chatContextBundleService";
import { buildChatTurnContext } from "@/lib/chatTurnContext";
import { buildChatMemoryContext } from "@/lib/chatMemoryContext";
import { estimatePromptTokens } from "@/lib/chatTokenEstimate";
import { pricedMemoryRetrievalHash } from "@/lib/chatContextBundleCore";
import { buildMemoryQueryPlan } from "@/lib/memoryQueryPlan";
import { prepareMemoryHistoryContext, replayMemoryHistoryContext } from "@/lib/memoryHistorySnapshot";
import { putMemorySettings } from "@/lib/memoryService";
import { MEMORY_INJECTION_FLAG_KEY } from "@/lib/memoryAccess";
import { externalContentDigest } from "@/lib/externalImportDigest";
import { leaseStillHolds } from "@/lib/memoryExtractionCommit";
import { persistExtractionChunkDecisions } from "@/lib/memoryExtractionPersistence";
import type { ExtractionDecision } from "@/lib/memoryExtractionPipeline";
import { retrieveMemoryContext } from "@/lib/memoryRetrievalService";
import { MEMORY_RETRIEVAL_ALGORITHM_VERSION, MEMORY_SEMANTIC_RETRIEVAL_ALGORITHM_VERSION } from "@/lib/memoryRetrievalScoring";
import { MEMORY_RETRIEVAL_VERSION, memoryRetrievalTerms } from "@/lib/memoryRetrievalTerms";
import {
    memoryEmbeddingLabel,
    prepareMemoryDuplicateContext,
    sendableCandidateStatements,
} from "@/lib/memorySemanticDuplicates";
import { prisma } from "@/lib/prisma";
import {
    RETRIEVAL_PROVIDER_BUCKET_KEY,
    semanticRetrievalSettingKey,
    type SemanticRetrievalFeature,
    verifyingSemanticModes,
} from "@/lib/semanticRetrievalCore";
import {
    readSemanticRetrievalSwitches,
    updateSemanticRetrievalSwitches,
} from "@/lib/semanticRetrievalSettings";
import {
    TEST_EMBEDDING_LABEL,
    installTestRetrievalProvider,
} from "./semanticRetrievalTestProvider";

/**
 * Semantic memory retrieval and duplicate detection (docs/policy/external-conversation-import-and-memory.md §9a) against a
 * real database, with a local stand-in for the provider.
 *
 * Two things only a database settles: that an external score can add a
 * relevance-gated memory and can never remove a core one, and that a
 * paraphrase of an active memory goes through the same newer-wins rule as an
 * exact conflict rather than becoming a second memory.
 */

const provider = installTestRetrievalProvider();

const reset = async () => {
    await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "SemanticRetrievalCache",
      "MemoryEvidence",
      "MemoryItem",
      "ExternalMessage",
      "ExternalConversation",
      "ExternalImport",
      "User"
    RESTART IDENTITY CASCADE
  `);
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: "retrieval.cohere." } } });
    await prisma.appSetting.deleteMany({ where: { key: MEMORY_INJECTION_FLAG_KEY } });
    await prisma.$executeRaw`DELETE FROM "ChatUsageBucket" WHERE "key" = ${RETRIEVAL_PROVIDER_BUCKET_KEY}`;
    provider.reset();
};

beforeEach(reset);
after(async () => {
    await reset();
    provider.restore();
    await prisma.$disconnect();
});

const turnOn = (feature: SemanticRetrievalFeature) =>
    prisma.appSetting.create({
        data: { key: semanticRetrievalSettingKey(feature), value: "on" },
    });

const createUser = () =>
    prisma.user.create({ data: { email: `memory-semantic-${randomUUID()}@example.test` } });

const createMemory = (userId: string, kind: string, statement: string) =>
    prisma.memoryItem.create({
        data: {
            userId,
            kind,
            statement,
            status: "active",
            confidence: 0.9,
            approvedAt: new Date("2026-11-01T00:00:00.000Z"),
            searchTerms: memoryRetrievalTerms(statement),
            retrievalVersion: MEMORY_RETRIEVAL_VERSION,
        },
    });

// Shares no term with the question: 카페인/줄이 against 커피/추천.
const CAFFEINE = "사용자는 카페인을 줄이는 중이다";
const HIKING = "사용자는 주말마다 등산을 한다";
const ENGINEER = "사용자는 백엔드 엔지니어다";
const COFFEE_QUESTION = "커피 추천해줘";
const NOW = new Date("2026-11-12T00:00:00.000Z");

/* ---------------------------------------------------------------- rerank */

test("with the switch off a memory that shares no term with the request is not selected", async () => {
    const user = await createUser();
    await createMemory(user.id, "preference", CAFFEINE);
    await createMemory(user.id, "identity", ENGINEER);

    const result = await retrieveMemoryContext({ userId: user.id, query: COFFEE_QUESTION, now: NOW });

    assert.equal(provider.state.calls.length, 0);
    assert.equal(result.algorithmVersion, MEMORY_RETRIEVAL_ALGORITHM_VERSION);
    assert.deepEqual(
        result.selected.map((entry) => entry.memory.statement),
        [ENGINEER]
    );
});

test("reranking selects a relevant memory by meaning and never removes a core one", async () => {
    const user = await createUser();
    await createMemory(user.id, "preference", CAFFEINE);
    await createMemory(user.id, "preference", HIKING);
    await createMemory(user.id, "identity", ENGINEER);
    await turnOn("memoryRerank");
    // The core memory would score zero if it were ever sent.
    provider.state.rerankScore = (_query, document) => (document.includes("카페인") ? 0.8 : 0);

    const result = await retrieveMemoryContext({ userId: user.id, query: COFFEE_QUESTION, now: NOW });

    assert.equal(result.algorithmVersion, MEMORY_SEMANTIC_RETRIEVAL_ALGORITHM_VERSION);
    assert.deepEqual(
        result.selected.map((entry) => entry.memory.statement).sort(),
        [CAFFEINE, ENGINEER].sort()
    );
    // Only the relevance-gated memories are sent: the core one never leaves.
    const sent = provider.state.calls[0].body.documents as string[];
    assert.deepEqual([...sent].sort(), [CAFFEINE, HIKING].sort());
});

test("a rebuilt context reuses the first ranking, so its hash does not move", async () => {
    const user = await createUser();
    await createMemory(user.id, "preference", CAFFEINE);
    await turnOn("memoryRerank");
    provider.state.rerankScore = () => 0.8;
    const input = { userId: user.id, query: COFFEE_QUESTION, now: NOW };

    const first = await retrieveMemoryContext(input);
    provider.state.rerankScore = () => 0.3;
    const second = await retrieveMemoryContext(input);

    assert.equal(provider.state.calls.length, 1);
    assert.equal(second.resultHash, first.resultHash);
});

test("a failed rerank falls back to the lexical selection and its version", async () => {
    const user = await createUser();
    await createMemory(user.id, "preference", CAFFEINE);
    await createMemory(user.id, "identity", ENGINEER);
    await turnOn("memoryRerank");
    provider.state.failing = true;

    const result = await retrieveMemoryContext({ userId: user.id, query: COFFEE_QUESTION, now: NOW });

    assert.equal(result.algorithmVersion, MEMORY_RETRIEVAL_ALGORITHM_VERSION);
    assert.deepEqual(
        result.selected.map((entry) => entry.memory.statement),
        [ENGINEER]
    );
});

/* ------------------------------------------------------------ duplicates */

const seedSource = async () => {
    const user = await createUser();
    const importRow = await prisma.externalImport.create({
        data: {
            userId: user.id,
            provider: "chatgpt",
            status: "completed",
            parserVersion: "test-1",
            digestVersion: 1,
        },
    });
    const conversation = await prisma.externalConversation.create({
        data: {
            userId: user.id,
            importId: importRow.id,
            provider: "chatgpt",
            externalStableId: randomUUID().replaceAll("-", ""),
            title: "duplicate fixture",
            conversationDigest: randomUUID().replaceAll("-", "").repeat(2),
            digestVersion: 1,
            messageCount: 2,
            contentBytes: BigInt(20),
            finalized: true,
        },
    });
    const message = (content: string, ordinal: number, at: string) =>
        prisma.externalMessage.create({
            data: {
                userId: user.id,
                externalConversationId: conversation.id,
                externalStableId: randomUUID().replaceAll("-", ""),
                role: "user",
                content,
                contentDigest: externalContentDigest(content),
                digestVersion: 1,
                ordinal,
                sourceTimestamp: new Date(at),
            },
        });
    const older = await message("I really like coffee", 0, "2026-01-01T00:00:00.000Z");
    const newer = await message("I am such a coffee lover", 1, "2026-06-01T00:00:00.000Z");
    return { user, older, newer };
};

const decision = (
    statement: string,
    source: { id: string; contentDigest: string },
    evidenceQuote: string
): ExtractionDecision =>
    ({
        candidate: {
            kind: "preference",
            polarity: "affirmed" as const,
            canonicalKey: null,
            statement,
            confidence: 0.9,
            sensitivity: "standard",
            expiresAt: null,
            evidence: [
                {
                    externalMessageId: source.id,
                    evidenceDigest: source.contentDigest,
                    role: "user" as const,
                    evidenceQuote,
                },
            ],
        },
        validation: {
            disposition: "accepted",
            sensitivity: "standard",
            bulkSafe: true,
            violations: [],
        },
        outcome: "store_candidate",
    }) as ExtractionDecision;

/** What `commitExtractionChunk` does around the write, without the lease. */
const persistChunk = async (userId: string, decisions: ExtractionDecision[], chunkIndex: number) => {
    const semanticDuplicates = await prepareMemoryDuplicateContext({
        userId,
        statements: decisions.map((entry) => entry.candidate.statement),
    });
    return prisma.$transaction((tx) =>
        persistExtractionChunkDecisions(tx, {
            userId,
            runId: "run-1",
            chunkIndex,
            extractionModelId: "gpt-5-6-luna",
            promptVersion: "mem-extract-v1",
            decisions,
            semanticDuplicates,
        })
    );
};

const LIKES = "the user likes coffee";
const LOVER = "the user is a coffee lover";

const activeStatements = async (userId: string) =>
    (
        await prisma.memoryItem.findMany({
            where: { userId, status: "active" },
            orderBy: { statement: "asc" },
            select: { statement: true },
        })
    ).map((row) => row.statement);

test("with the switch off a paraphrase is stored as a second memory", async () => {
    const { user, older, newer } = await seedSource();

    await persistChunk(user.id, [decision(LIKES, older, "like coffee")], 0);
    const second = await persistChunk(user.id, [decision(LOVER, newer, "coffee lover")], 1);

    assert.equal(provider.state.calls.length, 0);
    assert.equal(second.stored, 1);
    assert.equal(second.superseded, 0);
    assert.deepEqual(await activeStatements(user.id), [LOVER, LIKES].sort());
});

test("a newer paraphrase supersedes the memory it restates", async () => {
    const { user, older, newer } = await seedSource();
    await turnOn("memoryDuplicates");

    await persistChunk(user.id, [decision(LIKES, older, "like coffee")], 0);
    const stored = await prisma.memoryItem.findFirstOrThrow({ where: { userId: user.id } });
    assert.equal(stored.embeddingModel, memoryEmbeddingLabel(TEST_EMBEDDING_LABEL, LIKES));
    assert.ok(stored.embedding);

    const second = await persistChunk(user.id, [decision(LOVER, newer, "coffee lover")], 1);

    assert.equal(second.stored, 1);
    assert.equal(second.superseded, 1);
    assert.deepEqual(await activeStatements(user.id), [LOVER]);
});

test("an older paraphrase does not replace the newer memory", async () => {
    const { user, older, newer } = await seedSource();
    await turnOn("memoryDuplicates");

    await persistChunk(user.id, [decision(LOVER, newer, "coffee lover")], 0);
    const second = await persistChunk(user.id, [decision(LIKES, older, "like coffee")], 1);

    assert.equal(second.stored, 0);
    assert.equal(second.outranked, 1);
    assert.deepEqual(await activeStatements(user.id), [LOVER]);
});

test("a memory the user wrote is never replaced by a paraphrase from an import", async () => {
    const { user, newer } = await seedSource();
    await turnOn("memoryDuplicates");
    // User-authored: no extraction run. It has no vector until the first
    // preparation embeds it.
    const manual = await createMemory(user.id, "preference", LIKES);

    const result = await persistChunk(user.id, [decision(LOVER, newer, "coffee lover")], 0);

    const backfilled = await prisma.memoryItem.findUniqueOrThrow({ where: { id: manual.id } });
    assert.equal(backfilled.embeddingModel, memoryEmbeddingLabel(TEST_EMBEDDING_LABEL, LIKES));
    assert.equal(result.stored, 0);
    assert.equal(result.outranked, 1);
    assert.deepEqual(await activeStatements(user.id), [LIKES]);
});

test("a vector for wording that was since edited is ignored", async () => {
    const { user, older, newer } = await seedSource();
    await turnOn("memoryDuplicates");
    await persistChunk(user.id, [decision(LIKES, older, "like coffee")], 0);
    // Edited in place by a path that knows nothing about vectors: the label
    // still names the old wording, so the stored vector must not be used.
    await prisma.memoryItem.updateMany({
        where: { userId: user.id },
        data: { statement: "the user goes hiking every weekend" },
    });
    provider.state.calls.length = 0;

    const second = await persistChunk(user.id, [decision(LOVER, newer, "coffee lover")], 1);

    // The edited memory was re-embedded under its new wording, which is about
    // something else, so the candidate is simply a new memory.
    assert.equal(second.stored, 1);
    assert.equal(second.superseded, 0);
    assert.deepEqual(await activeStatements(user.id), [
        "the user goes hiking every weekend",
        LOVER,
    ].sort());
});

/* ------------------------------------------- what may leave, and when */

test("a candidate is sendable only while its source exists, matches and is unlocked", async () => {
    const { user, older, newer } = await seedSource();
    const decisions = [
        decision(LIKES, older, "like coffee"),
        decision(LOVER, newer, "coffee lover"),
    ];
    assert.deepEqual(await sendableCandidateStatements({ userId: user.id, decisions }), [LIKES, LOVER]);

    // The cited message is gone: its candidate has nothing left to stand on.
    await prisma.externalMessage.delete({ where: { id: older.id } });
    assert.deepEqual(await sendableCandidateStatements({ userId: user.id, decisions }), [LOVER]);

    // A digest that no longer matches is evidence of something else.
    assert.deepEqual(
        await sendableCandidateStatements({
            userId: user.id,
            decisions: [decision(LOVER, { id: newer.id, contentDigest: "0".repeat(64) }, "coffee lover")],
        }),
        []
    );

    // The owner locked the source while the extraction call was answering.
    await prisma.externalConversation.updateMany({
        where: { userId: user.id },
        data: { password: "locked" },
    });
    assert.deepEqual(await sendableCandidateStatements({ userId: user.id, decisions }), []);
});

test("an account with memory off sends nothing, however the call is reached", async () => {
    const { user, newer } = await seedSource();
    await turnOn("memoryDuplicates");
    await createMemory(user.id, "preference", LIKES);
    await prisma.userMemorySettings.create({ data: { userId: user.id, masterEnabled: false } });

    const decisions = [decision(LOVER, newer, "coffee lover")];
    assert.deepEqual(await sendableCandidateStatements({ userId: user.id, decisions }), []);
    // And the preparation refuses by itself, for a caller that skipped the check.
    assert.equal(await prepareMemoryDuplicateContext({ userId: user.id, statements: [LOVER] }), null);
    assert.equal(provider.state.calls.length, 0);
});

test("a memory whose only source is locked is not sent for backfill", async () => {
    const { user, older, newer } = await seedSource();
    await turnOn("memoryDuplicates");
    await persistChunk(user.id, [decision(LIKES, older, "like coffee")], 0);
    // Locked, and the reconciliation that would suspend the memory has not run.
    await prisma.externalConversation.updateMany({
        where: { userId: user.id },
        data: { password: "locked" },
    });
    await prisma.memoryItem.updateMany({ where: { userId: user.id }, data: { embeddingModel: null } });
    provider.state.calls.length = 0;

    await prepareMemoryDuplicateContext({ userId: user.id, statements: ["the user plays chess"] });

    const sent = provider.state.calls.flatMap((call) => (call.body.texts as string[]) ?? []);
    assert.deepEqual(sent, ["the user plays chess"]);
    void newer;
});

test("a worker without the lease is told so before it sends anything", async () => {
    const user = await createUser();
    assert.equal(
        await leaseStillHolds({
            lease: { runId: "no-such-run", userId: user.id, leaseGeneration: 1 },
            chunkIndex: 0,
        }),
        false
    );
});

/* ------------------------------------------------------------- switches */

test("a set of switch changes is written and audited together", async () => {
    const session = {
        user: { id: `semantic-switch-${randomUUID()}`, email: "semantic-switch@example.test" },
        expires: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    } as Session;
    const actor = { session, request: new Request("https://tomverse.test/api/admin/semantic-retrieval") };
    await turnOn("memoryDuplicates");

    const changed = await updateSemanticRetrievalSwitches(actor, {
        knowledgeRerank: true,
        memoryRerank: true,
        // Already on: not written and not audited.
        memoryDuplicates: true,
    });

    assert.deepEqual(changed, ["knowledgeRerank", "memoryRerank"]);
    const switches = await readSemanticRetrievalSwitches();
    assert.deepEqual(
        [switches.knowledgeRerank, switches.memoryRerank, switches.memoryDuplicates, switches.knowledgeEmbed],
        [true, true, true, false]
    );
    const audited = await prisma.adminAuditLog.findMany({
        where: { action: "retrieval.semantic_switch.updated", actorUserId: session.user.id },
        select: { targetId: true },
        orderBy: { targetId: "asc" },
    });
    assert.deepEqual(
        audited.map((row) => row.targetId),
        [semanticRetrievalSettingKey("knowledgeRerank"), semanticRetrievalSettingKey("memoryRerank")].sort()
    );

    assert.deepEqual(await updateSemanticRetrievalSwitches(actor, { knowledgeRerank: false }), [
        "knowledgeRerank",
    ]);
    assert.equal((await readSemanticRetrievalSwitches()).knowledgeRerank, false);
});

/* ------------------------------------------ the lexical query is untouched */

test("extra candidates never push a lexical one out, and a failed rerank restores the lexical result", async () => {
    const user = await createUser();
    // More relevance-gated memories than the candidate limit, all outranking
    // the one that actually matches the request and none sharing a term with it.
    await prisma.memoryItem.createMany({
        data: Array.from({ length: 420 }, (_, index) => {
            const statement = `사용자는 주제 ${index}번 자료를 정리했다`;
            return {
                userId: user.id,
                kind: "project",
                statement,
                status: "active",
                confidence: 0.9,
                importance: 5,
                approvedAt: new Date("2026-11-01T00:00:00.000Z"),
                searchTerms: memoryRetrievalTerms(statement),
                retrievalVersion: MEMORY_RETRIEVAL_VERSION,
            };
        }),
    });
    const match = await createMemory(user.id, "preference", "사용자는 커피를 자주 마신다");
    const input = { userId: user.id, query: COFFEE_QUESTION, now: NOW };

    const lexical = await retrieveMemoryContext(input);
    assert.deepEqual(
        lexical.selected.map((entry) => entry.memory.id),
        [match.id]
    );

    // On, and the provider fails: the same selection, the same hash.
    await turnOn("memoryRerank");
    provider.state.failing = true;
    const fallback = await retrieveMemoryContext(input);
    assert.equal(fallback.algorithmVersion, MEMORY_RETRIEVAL_ALGORITHM_VERSION);
    assert.equal(fallback.resultHash, lexical.resultHash);

    // On, and the provider answers: the lexical match is still a candidate.
    provider.state.failing = false;
    provider.state.rerankScore = (_query, document) => (document.includes("커피") ? 0.9 : 0);
    const ranked = await retrieveMemoryContext({ ...input, query: `${COFFEE_QUESTION} 부탁해` });
    assert.equal(ranked.algorithmVersion, MEMORY_SEMANTIC_RETRIEVAL_ALGORITHM_VERSION);
    assert.deepEqual(
        ranked.selected.map((entry) => entry.memory.id),
        [match.id]
    );
    // One search unit's worth of statements at most, the lexical match among them.
    const sent = provider.state.calls.at(-1)?.body.documents as string[];
    assert.ok(sent.length <= 100);
    assert.ok(sent.includes("사용자는 커피를 자주 마신다"));
});

test("a request with no usable term asks the reranker nothing", async () => {
    const user = await createUser();
    await createMemory(user.id, "preference", CAFFEINE);
    await turnOn("memoryRerank");

    const result = await retrieveMemoryContext({ userId: user.id, query: "?!", now: NOW });

    assert.equal(provider.state.calls.length, 0);
    assert.equal(result.algorithmVersion, MEMORY_RETRIEVAL_ALGORITHM_VERSION);
});

/* ------------------------------------------------ the route that verifies */

test("the verifying route reuses the issued ranking and never asks the reranker itself", async () => {
    const user = await createUser();
    await createMemory(user.id, "preference", CAFFEINE);
    await createMemory(user.id, "identity", ENGINEER);
    await turnOn("memoryRerank");
    provider.state.rerankScore = () => 0.8;
    const input = { userId: user.id, query: COFFEE_QUESTION, now: NOW };

    // Verified without ever having been issued: lexical, and nobody is asked.
    const cold = await retrieveMemoryContext({ ...input, semantic: "cached_only" });
    assert.equal(provider.state.calls.length, 0);
    assert.equal(cold.algorithmVersion, MEMORY_RETRIEVAL_ALGORITHM_VERSION);

    const issued = await retrieveMemoryContext(input);
    assert.equal(issued.algorithmVersion, MEMORY_SEMANTIC_RETRIEVAL_ALGORITHM_VERSION);
    assert.equal(provider.state.calls.length, 1);

    provider.state.failing = true;
    const verified = await retrieveMemoryContext({ ...input, semantic: "cached_only" });
    assert.equal(provider.state.calls.length, 1);
    assert.equal(verified.resultHash, issued.resultHash);
});

test("a bundle issued over a failed rerank verifies as lexical after the provider recovers", async () => {
    const user = await createUser();
    await createMemory(user.id, "preference", CAFFEINE);
    await createMemory(user.id, "identity", ENGINEER);
    await turnOn("memoryRerank");
    const input = { userId: user.id, query: COFFEE_QUESTION, now: NOW };

    provider.state.failing = true;
    const issued = await retrieveMemoryContext(input);
    assert.equal(issued.algorithmVersion, MEMORY_RETRIEVAL_ALGORITHM_VERSION);

    provider.state.failing = false;
    provider.state.rerankScore = () => 0.9;
    const verified = await retrieveMemoryContext({ ...input, semantic: "cached_only" });
    assert.equal(provider.state.calls.length, 1);
    assert.equal(verified.resultHash, issued.resultHash);
});

/* --------------------------- the bundle signs the steps; verify follows them */

const MODEL = "gpt-5-6-luna";

/** What the issuing routes do: build, then sign what was built. */
const issueTurn = async (userId: string, query: string) => {
    const context = await buildChatTurnContext({ userId, query, profileVersionId: null, now: NOW });
    const bundle = issueChatContextBundle({
        subjectKey: userId,
        conversationId: null,
        modelIds: [MODEL],
        context,
        now: new Date(),
    });
    return { context, token: bundle.token };
};

/** What /api/chat does: rebuild from the bundle's own steps, then verify. */
const verifyTurn = async (userId: string, query: string, token: string) => {
    const context = await buildChatTurnContext({
        userId,
        query,
        profileVersionId: null,
        now: NOW,
        semantic: verifyingSemanticModes(readChatContextBundleSemanticSteps(token)),
    });
    return verifyChatContextBundle(token, {
        subjectKey: userId,
        conversationId: null,
        modelId: MODEL,
        currentFingerprint: context.fingerprint,
    });
};

const withCacheUnavailable = async <T>(run: () => Promise<T>): Promise<T> => {
    await prisma.$executeRawUnsafe(
        'ALTER TABLE "SemanticRetrievalCache" RENAME TO "SemanticRetrievalCacheUnavailable"'
    );
    try {
        return await run();
    } finally {
        await prisma.$executeRawUnsafe(
            'ALTER TABLE "SemanticRetrievalCacheUnavailable" RENAME TO "SemanticRetrievalCache"'
        );
    }
};

test("a lexical bundle still verifies after a later issue of the same question stored a ranking", async () => {
    const user = await createUser();
    await createMemory(user.id, "preference", CAFFEINE);
    await createMemory(user.id, "identity", ENGINEER);
    await prisma.appSetting.create({ data: { key: MEMORY_INJECTION_FLAG_KEY, value: "true" } });
    await turnOn("memoryRerank");
    provider.state.rerankScore = () => 0.8;

    // Bundle one: the cache is down, so the ranking is not used and not signed.
    const one = await withCacheUnavailable(() => issueTurn(user.id, COFFEE_QUESTION));
    assert.equal(one.context.semanticSteps.memoryRerank, false);
    assert.equal(one.context.memory.prompt.usedCount, 1);

    // Bundle two: same question, the cache is back, the ranking is stored and used.
    const two = await issueTurn(user.id, COFFEE_QUESTION);
    assert.equal(two.context.semanticSteps.memoryRerank, true);
    assert.equal(two.context.memory.prompt.usedCount, 2);
    assert.notEqual(two.context.fingerprint, one.context.fingerprint);
    const callsAfterIssuing = provider.state.calls.length;

    // Each verifies against what it signed, with one rebuild and no provider call.
    assert.equal((await verifyTurn(user.id, COFFEE_QUESTION, one.token)).ok, true);
    assert.equal((await verifyTurn(user.id, COFFEE_QUESTION, two.token)).ok, true);
    assert.equal(provider.state.calls.length, callsAfterIssuing);
});

test("a bundle whose stored ranking is gone is stale, and verifying still asks nobody", async () => {
    const user = await createUser();
    await createMemory(user.id, "preference", CAFFEINE);
    await createMemory(user.id, "identity", ENGINEER);
    await prisma.appSetting.create({ data: { key: MEMORY_INJECTION_FLAG_KEY, value: "true" } });
    await turnOn("memoryRerank");
    provider.state.rerankScore = () => 0.8;

    const issued = await issueTurn(user.id, COFFEE_QUESTION);
    assert.equal(issued.context.semanticSteps.memoryRerank, true);
    await prisma.semanticRetrievalCache.deleteMany();
    const callsAfterIssuing = provider.state.calls.length;

    const verification = await verifyTurn(user.id, COFFEE_QUESTION, issued.token);

    assert.deepEqual(verification, { ok: false, reason: "stale" });
    assert.equal(provider.state.calls.length, callsAfterIssuing);
});

test("with no switch on the bundle records no step and verifies as before", async () => {
    const user = await createUser();
    await createMemory(user.id, "identity", ENGINEER);
    await prisma.appSetting.create({ data: { key: MEMORY_INJECTION_FLAG_KEY, value: "true" } });

    const issued = await issueTurn(user.id, COFFEE_QUESTION);

    assert.deepEqual(issued.context.semanticSteps, {
        memoryRerank: false,
        knowledgeNeighbours: false,
        knowledgeRerank: false,
    });
    assert.equal((await verifyTurn(user.id, COFFEE_QUESTION, issued.token)).ok, true);
    assert.equal(provider.state.calls.length, 0);
});

/* --------------------------- duplicates send only relevance-gated memories */

test("duplicate detection never sends a core, style or pinned memory", async () => {
    const { user, newer } = await seedSource();
    await turnOn("memoryDuplicates");
    // Existing memories of every kind, none embedded yet: all would be
    // backfill candidates if kind and pin were not part of the rule.
    await createMemory(user.id, "identity", ENGINEER);
    await createMemory(user.id, "tone", "사용자는 존댓말 답변을 선호한다");
    const pinned = await createMemory(user.id, "preference", "the user pinned this preference");
    await prisma.memoryItem.update({ where: { id: pinned.id }, data: { pinned: true } });
    await createMemory(user.id, "preference", LIKES);

    // A chunk with a core candidate and an ordinary one.
    const decisions = [
        { ...decision("the user is a backend engineer", newer, "coffee lover") },
        decision(LOVER, newer, "coffee lover"),
    ];
    decisions[0] = {
        ...decisions[0],
        candidate: { ...decisions[0].candidate, kind: "occupation" },
    } as ExtractionDecision;

    const sendable = await sendableCandidateStatements({ userId: user.id, decisions });
    assert.deepEqual(sendable, [LOVER]);
    await prepareMemoryDuplicateContext({ userId: user.id, statements: sendable });

    const sent = provider.state.calls.flatMap((call) => (call.body.texts as string[]) ?? []);
    assert.deepEqual([...sent].sort(), [LIKES, LOVER].sort());
    for (const text of [ENGINEER, "사용자는 존댓말 답변을 선호한다", "the user pinned this preference"]) {
        assert.ok(!sent.includes(text), `${text} must not leave`);
    }
    // And none of them was given a vector to be compared with.
    const embedded = await prisma.memoryItem.findMany({
        where: { userId: user.id, embedding: { not: null } },
        select: { statement: true },
    });
    assert.deepEqual(
        embedded.map((row) => row.statement),
        [LIKES]
    );
});

test("a core memory with a stored vector is still not compared", async () => {
    const { user, newer } = await seedSource();
    await turnOn("memoryDuplicates");
    // A vector written before this rule, or by any other path: the comparison
    // still leaves it out, so the core memory cannot be superseded by a paraphrase.
    const core = await createMemory(user.id, "preference", LIKES);
    await prisma.memoryItem.update({ where: { id: core.id }, data: { kind: "identity" } });
    await prisma.memoryItem.update({
        where: { id: core.id },
        data: {
            embedding: Uint8Array.from([100, 100, 0, 0, 0]),
            embeddingModel: memoryEmbeddingLabel(TEST_EMBEDDING_LABEL, LIKES),
        },
    });

    const result = await persistChunk(user.id, [decision(LOVER, newer, "coffee lover")], 0);

    assert.equal(result.stored, 1);
    assert.equal(result.superseded, 0);
    assert.equal(
        (await prisma.memoryItem.findUniqueOrThrow({ where: { id: core.id } })).status,
        "active"
    );
});


// These are synthetic provider scores, testing candidate supply and fallback only.
// They are not evidence of semantic quality or a successful external evaluation.
test("a saturated lexical pool leaves rerank slots for recent extras, including term matches beyond DB400", async () => {
    const user = await createUser();
    await prisma.memoryItem.createMany({
        data: Array.from({ length: 400 }, (_, index) => ({
            id: `lexical-${String(index).padStart(3, "0")}`,
            userId: user.id, kind: "project", statement: `coffee archive ${index}`,
            status: "active", confidence: 0.1, importance: 10,
            createdAt: new Date("2026-10-01T00:00:00Z"),
            approvedAt: NOW, searchTerms: ["coffee", "archive", String(index)],
            retrievalVersion: MEMORY_RETRIEVAL_VERSION,
        })),
    });
    const overflow = await createMemory(user.id, "project", "coffee overflow target");
    const semanticOnly = await createMemory(user.id, "project", "caffeine target");
    await createMemory(user.id, "identity", ENGINEER);
    await createMemory(user.id, "tone", "Respond politely");
    const pinned = await createMemory(user.id, "preference", "Pinned preference");
    await prisma.memoryItem.update({ where: { id: pinned.id }, data: { pinned: true } });
    await turnOn("memoryRerank");
    provider.state.rerankScore = (_query, document) => document.includes("target") ? 0.95 : 0;

    const result = await retrieveMemoryContext({ userId: user.id, query: "coffee", now: NOW });
    const sent = provider.state.calls[0].body.documents as string[];
    assert.equal(sent.length, 100);
    assert.ok(sent.some(text => text.startsWith("coffee archive")), "lexical pool keeps slots");
    assert.ok(sent.includes(overflow.statement), "extra is ID-based, even with a matching word");
    assert.ok(sent.includes(semanticOnly.statement), "recent nonmatching extras keep slots");
    for (const text of [ENGINEER, "Respond politely", "Pinned preference"]) assert.ok(!sent.includes(text));
    const selected = result.selected.map(row => row.memory.id);
    assert.ok(selected.includes(overflow.id));
    assert.ok(selected.includes(semanticOnly.id));
    assert.equal(new Set(sent).size, sent.length);
    assert.equal(result.algorithmVersion, MEMORY_SEMANTIC_RETRIEVAL_ALGORITHM_VERSION);
});

test("extras the provider did not score cannot enter by lexical overlap", async () => {
    const user = await createUser();
    await prisma.memoryItem.createMany({
        data: Array.from({ length: 400 }, (_, index) => ({
            id: `lexical-${String(index).padStart(3, "0")}`,
            userId: user.id, kind: "project", statement: `coffee lexical ${index}`,
            status: "active", confidence: 0.1, importance: 10,
            createdAt: new Date("2026-10-01T00:00:00Z"),
            searchTerms: ["coffee", "lexical", String(index)], retrievalVersion: MEMORY_RETRIEVAL_VERSION,
        })),
    });
    await prisma.memoryItem.createMany({
        data: Array.from({ length: 100 }, (_, index) => ({
            id: `extra-${String(index).padStart(3, "0")}`,
            userId: user.id, kind: "project", statement: `coffee extra ${index}`,
            status: "active", confidence: 1, importance: 0,
            createdAt: new Date(NOW.getTime() - index * 1_000),
            approvedAt: NOW, searchTerms: ["coffee", "extra", String(index)],
            retrievalVersion: MEMORY_RETRIEVAL_VERSION,
        })),
    });
    await turnOn("memoryRerank");
    provider.state.rerankScore = () => 0;
    const result = await retrieveMemoryContext({ userId: user.id, query: "coffee", now: NOW });
    const sent = new Set(provider.state.calls[0].body.documents as string[]);
    assert.equal(sent.size, 100);
    for (const row of result.selected) {
        if (row.memory.id.startsWith("extra-")) {
            assert.ok(sent.has(row.memory.statement), "only scored extras may enter selection");
        }
    }
    assert.ok(result.selected.some(row => row.memory.id.startsWith("lexical-")), "unscored original lexical rows remain eligible");
});

test("invalid scores and a refused budget reproduce the new-query lexical baseline", async () => {
    const user = await createUser();
    await createMemory(user.id, "project", "coffee target");
    await createMemory(user.id, "project", "caffeine target");
    const query = `start ${Array.from({ length: 120 }, (_, index) => `filler${index}`).join(" ")} coffee`;
    const input = { userId: user.id, query, now: NOW };
    const baseline = await retrieveMemoryContext({ ...input, semantic: "off" });
    await turnOn("memoryRerank");
    provider.state.rerankScore = () => Number.NaN;
    const invalid = await retrieveMemoryContext(input);
    assert.equal(invalid.resultHash, baseline.resultHash);
    assert.equal(invalid.algorithmVersion, MEMORY_RETRIEVAL_ALGORITHM_VERSION);
    assert.equal(provider.state.calls.length, 1);
    const verified = await retrieveMemoryContext({ ...input, semantic: "cached_only" });
    assert.equal(verified.resultHash, baseline.resultHash);
    assert.equal(provider.state.calls.length, 1);

    await prisma.semanticRetrievalCache.deleteMany();
    provider.setEnv("RETRIEVAL_PROVIDER_COHERE_COST_MICROUSD_PER_DAY", "1");
    provider.state.rerankScore = () => 1;
    const refused = await retrieveMemoryContext(input);
    assert.equal(refused.resultHash, baseline.resultHash);
    assert.equal(provider.state.calls.length, 1, "refused budget makes no request");
});

test("an unconfirmed cache write discards extras and preserves the lexical baseline", async () => {
    const user = await createUser();
    await createMemory(user.id, "project", "coffee preference");
    await createMemory(user.id, "project", "caffeine preference");
    const input = { userId: user.id, query: "coffee", now: NOW };
    const baseline = await retrieveMemoryContext({ ...input, semantic: "off" });
    await turnOn("memoryRerank");
    provider.state.rerankScore = () => 1;
    const fallback = await withCacheUnavailable(() => retrieveMemoryContext(input));
    assert.equal(fallback.resultHash, baseline.resultHash);
    assert.equal(fallback.algorithmVersion, MEMORY_RETRIEVAL_ALGORITHM_VERSION);
    assert.equal(provider.state.calls.length, 1);
    const verified = await retrieveMemoryContext({ ...input, semantic: "off" });
    assert.equal(verified.resultHash, baseline.resultHash);
    assert.equal(provider.state.calls.length, 1);
});


test("all semantic candidate entry paths enforce owner, active, expiry, provenance, and reachable evidence", async () => {
    const { user, older } = await seedSource();
    const stranger = await createUser();
    await createMemory(stranger.id, "project", "stranger caffeine");
    for (const status of ["superseded", "deleted", "candidate", "suspended_by_source_delete"]) {
        const item = await createMemory(user.id, "project", `inactive caffeine ${status}`);
        await prisma.memoryItem.update({ where: { id: item.id }, data: { status } });
    }
    const expired = await createMemory(user.id, "project", "expired caffeine");
    await prisma.memoryItem.update({ where: { id: expired.id }, data: { expiresAt: NOW } });
    const revoked = await createMemory(user.id, "project", "revoked caffeine");
    await prisma.memoryItem.update({ where: { id: revoked.id }, data: {
        extractionModelId: "revoked-model", promptVersion: "revoked-prompt",
    } });
    const locked = await createMemory(user.id, "project", "locked caffeine");
    const manualBacked = await createMemory(user.id, "project", "manual caffeine");
    for (const item of [locked, manualBacked]) {
        await prisma.memoryEvidence.create({ data: {
            userId: user.id, memoryItemId: item.id, sourceType: "external_message",
            externalMessageId: older.id, evidenceDigest: older.contentDigest,
        } });
    }
    await prisma.externalConversation.update({ where: { id: older.externalConversationId }, data: { password: "locked" } });
    await prisma.memoryEvidence.create({ data: {
        userId: user.id, memoryItemId: manualBacked.id, sourceType: "manual",
        manualContent: "The user independently confirmed this preference", evidenceDigest: "manual-fixture",
    } });
    const evidenceLess = await createMemory(user.id, "project", "independent caffeine");
    await turnOn("memoryRerank");
    provider.state.rerankScore = () => 0.8;
    const result = await retrieveMemoryContext({ userId: user.id, query: "coffee", now: NOW, approvedPairs: [] });
    const sent = provider.state.calls[0].body.documents as string[];
    assert.deepEqual([...sent].sort(), [manualBacked.statement, evidenceLess.statement].sort());
    assert.deepEqual(result.selected.map(row => row.memory.id).sort(), [manualBacked.id, evidenceLess.id].sort());
});

test("conversation and profile off skip semantic work without changing saved account settings", async () => {
    const user = await createUser();
    await createMemory(user.id, "project", "coffee preference");
    await prisma.appSetting.create({ data: { key: MEMORY_INJECTION_FLAG_KEY, value: "true" } });
    await turnOn("memoryRerank");
    const input = { userId: user.id, query: "coffee", now: NOW };
    const conversationOff = await buildChatMemoryContext({ ...input, conversationMode: "off" });
    assert.deepEqual(conversationOff.decision, { allowed: false, reason: "conversation_off" });
    const profileOff = await buildChatMemoryContext({ ...input, profileMemoryPolicy: { useAccountMemory: false } });
    assert.deepEqual(profileOff.decision, { allowed: false, reason: "profile_off" });
    await putMemorySettings(user.id, { masterEnabled: false, styleEnabled: true, defaultConversationMode: "on" });
    const accountOff = await buildChatMemoryContext({ ...input, conversationMode: "on" });
    assert.deepEqual(accountOff.decision, { allowed: false, reason: "account_off" });
    for (const context of [conversationOff, profileOff, accountOff]) {
        assert.equal(context.memoryTokens, 0);
        assert.equal(context.prompt.data, null);
        assert.equal(context.prompt.rules, null);
    }
    assert.equal(provider.state.calls.length, 0);
    const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId: user.id } });
    assert.equal(settings.masterEnabled, false);
    assert.equal(settings.defaultConversationMode, "on");
});

test("an account state change after preparation makes the signed memory bundle stale", async () => {
    const user = await createUser();
    await createMemory(user.id, "identity", ENGINEER);
    await prisma.appSetting.create({ data: { key: MEMORY_INJECTION_FLAG_KEY, value: "true" } });
    const issued = await issueTurn(user.id, COFFEE_QUESTION);
    assert.equal(issued.context.memory.prompt.usedCount, 1);
    await putMemorySettings(user.id, { masterEnabled: false, styleEnabled: true, defaultConversationMode: "on" });
    assert.deepEqual(await verifyTurn(user.id, COFFEE_QUESTION, issued.token), { ok: false, reason: "stale" });
    assert.equal(provider.state.calls.length, 0);
});


test("prepared context prices and binds memory rules and user data together", async () => {
    const user = await createUser();
    const item = await createMemory(user.id, "identity", ENGINEER);
    await prisma.appSetting.create({ data: { key: MEMORY_INJECTION_FLAG_KEY, value: "true" } });
    const query = COFFEE_QUESTION;
    const issued = await issueTurn(user.id, query);
    const prompt = issued.context.memory.prompt;
    assert.ok(prompt.rules && prompt.data);
    assert.equal(issued.context.memoryTokens, estimatePromptTokens(prompt.rules) + estimatePromptTokens(prompt.data));
    assert.equal(issued.context.memoryTokens, issued.context.memory.memoryTokens);
    assert.ok(issued.context.systemPrompt?.includes(prompt.rules));
    assert.ok(!issued.context.systemPrompt?.includes(ENGINEER));
    assert.equal(issued.context.fingerprintInput.retrievalHash, pricedMemoryRetrievalHash(
        [item.id], JSON.stringify({ rules: prompt.rules, data: prompt.data }), JSON.stringify(buildMemoryQueryPlan(query))));
    assert.equal((await verifyTurn(user.id, query, issued.token)).ok, true);
    // Same selected rows and state timestamp: only rendered data/hash changes.
    await prisma.memoryItem.update({ where: { id: item.id }, data: {
        statement: `${ENGINEER} and maintains storage systems`, updatedAt: item.updatedAt,
    } });
    assert.deepEqual(await verifyTurn(user.id, query, issued.token), { ok: false, reason: "stale" });
    assert.equal(provider.state.calls.length, 0);
});

test("the signed query plan changes even when lexical terms and selected memories stay equal", async () => {
    const user = await createUser();
    await createMemory(user.id, "identity", ENGINEER);
    await prisma.appSetting.create({ data: { key: MEMORY_INJECTION_FLAG_KEY, value: "true" } });
    const issued = await issueTurn(user.id, COFFEE_QUESTION);
    assert.deepEqual(await verifyTurn(user.id, `${COFFEE_QUESTION}!!!`, issued.token), { ok: false, reason: "stale" });
    assert.equal(provider.state.calls.length, 0);
});

/* ---------------- full-query history: real cache, signing and source reads */

// Token pricing and scores are local operator/provider fixtures, never live settings.
const withFullMemoryQuery = async <T>(run: () => Promise<T>): Promise<T> => {
    const previousFlag = process.env.MEMORY_RELEVANCE_CONTEXT_ENABLED;
    provider.setEnv("MEMORY_RELEVANCE_CONTEXT_ENABLED", "true");
    provider.setEnv("COHERE_RERANK_MODEL", "rerank-v5.0-fast");
    provider.setEnv("COHERE_RERANK_MICROUSD_PER_SEARCH_UNIT", "");
    provider.setEnv("COHERE_RERANK_MICROUSD_PER_MILLION_TOKENS", "1000000");
    provider.state.rerankBilled = { input_tokens: 100 };
    provider.state.rerankScore = (_query, document) => document.includes("아틀라스") ? 0.95 : 0;
    try {
        return await run();
    } finally {
        if (previousFlag === undefined) delete process.env.MEMORY_RELEVANCE_CONTEXT_ENABLED;
        else process.env.MEMORY_RELEVANCE_CONTEXT_ENABLED = previousFlag;
    }
};

const fullQueryFixture = async () => {
    const user = await createUser();
    const conversation = await prisma.conversation.create({ data: {
        userId: user.id, title: "Memory snapshot fixture", selectedModels: JSON.stringify([MODEL]),
        memoryMode: "on",
    } });
    const contents = ["Older unrelated user context", "아틀라스 프로젝트 출시 일정을 정리하자.", "내가 맡은 작업은 문서 검수다."];
    const sources = [];
    for (const [index, content] of contents.entries()) {
        sources.push(await prisma.message.create({ data: {
            conversationId: conversation.id, role: "user", content,
            createdAt: new Date(NOW.getTime() + index * 1_000),
        } }));
    }
    await prisma.message.create({ data: {
        conversationId: conversation.id, role: "assistant", content: "Assistant context must not be a source.",
        createdAt: new Date(NOW.getTime() + 3_000),
    } });
    await createMemory(user.id, "identity", ENGINEER);
    await createMemory(user.id, "project", "아틀라스 프로젝트 문서 검수 마감은 다음 화요일이다.");
    await createMemory(user.id, "project", "다른 프로젝트 마감은 금요일이다.");
    await prisma.appSetting.create({ data: { key: MEMORY_INJECTION_FLAG_KEY, value: "true" } });
    await turnOn("memoryRerank");
    const query = `${"앞선 조건을 확인하고 ".repeat(16)}중간 핵심 조건: 금요일이 아닌 다음 화요일을 기준으로 그 프로젝트에서 내가 맡은 마감만 알려줘.${" 추가 조건도 유지해줘.".repeat(16)}`;
    assert.ok(Buffer.byteLength(query, "utf8") > 400);
    const request = new Request("http://localhost/api/chat/context");
    const access = { request, userId: user.id, conversationId: conversation.id };
    const buildInput = { userId: user.id, query, conversationMode: conversation.memoryMode, profileVersionId: null, now: NOW };
    const prepare = () => buildChatTurnContext({
        ...buildInput,
        memorySemanticContext: prepareMemoryHistoryContext({ ...access, query, modelIds: [MODEL] }),
    });
    const sign = (context: Awaited<ReturnType<typeof buildChatTurnContext>>) => issueChatContextBundle({
        subjectKey: user.id, conversationId: conversation.id, modelIds: [MODEL, "comparison-sibling"], context,
    }).token;
    const append = async () => {
        await prisma.message.createMany({ data: [
            { conversationId: conversation.id, role: "user", content: query, createdAt: new Date(NOW.getTime() + 4_000) },
            { conversationId: conversation.id, role: "user", content: "Another tab appended a different project.", createdAt: new Date(NOW.getTime() + 5_000) },
            { conversationId: conversation.id, role: "assistant", modelId: "comparison-sibling", content: "Sibling completed.", createdAt: new Date(NOW.getTime() + 6_000) },
        ] });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date(NOW.getTime() + 6_000) } });
    };
    const rebuild = async (token: string) => {
        // Match send ordering: verify the subject/conversation/model envelope before source lookup.
        const envelope = verifyChatContextBundle(token, { subjectKey: user.id, conversationId: conversation.id, modelId: MODEL });
        assert.ok(envelope.ok);
        const replayed = await replayMemoryHistoryContext({ ...access, query, payload: envelope.payload });
        assert.ok(replayed);
        const context = await buildChatTurnContext({
            ...buildInput, memorySemanticContext: replayed, semantic: verifyingSemanticModes(envelope.payload.semanticSteps),
        });
        return { context, replayed, payload: envelope.payload, verification: verifyChatContextBundle(token, {
            subjectKey: user.id, conversationId: conversation.id, modelId: MODEL, currentFingerprint: context.fingerprint,
        }) };
    };
    return { ...access, query, sources: sources.slice(-2), buildInput, prepare, sign, append, rebuild };
};

test("history displacement returns the current lexical result and replays without an unused anchor or another call", () => withFullMemoryQuery(async () => {
    const user = await createUser();
    const conversation = await prisma.conversation.create({ data: {
        userId: user.id, title: "Current query precedence", selectedModels: JSON.stringify([MODEL]), memoryMode: "on",
    } });
    const source = await prisma.message.create({ data: {
        conversationId: conversation.id, role: "user", content: "아틀라스 일정 이야기를 마쳤다.", createdAt: NOW,
    } });
    const coffee = await createMemory(user.id, "preference", "사용자는 커피를 마시지 않는다.");
    await createMemory(user.id, "project", "아틀라스 프로젝트에서 사용자는 출시 QA를 맡고 마감은 11월 28일이다.");
    await prisma.appSetting.create({ data: { key: MEMORY_INJECTION_FLAG_KEY, value: "true" } });
    await turnOn("memoryRerank");
    // Recorded V5 failure: history elevated Atlas and suppressed coffee.
    provider.state.rerankScore = (_query, document) => document.includes("커피") ? 0.0757 : 0.1268;
    const query = "커피 대신 뭘 마실까요?";
    const request = new Request("http://localhost/api/chat/context");
    const access = { request, userId: user.id, conversationId: conversation.id };
    const loadHistory = prepareMemoryHistoryContext({ ...access, query, modelIds: [MODEL] });
    assert.ok(loadHistory);
    const memorySemanticContext = await loadHistory();
    const input = { userId: user.id, query, conversationMode: "on", now: NOW, memorySemanticContext };
    const baseline = await buildChatTurnContext({ ...input, semantic: "off" });
    const prepared = await buildChatTurnContext(input);
    assert.equal(provider.state.calls.length, 1);
    assert.deepEqual(JSON.parse(String(provider.state.calls[0].body.query)), {
        current_query: query, previous_user_messages: [source.content],
    });
    assert.equal(prepared.semanticSteps.memoryRerank, false);
    assert.equal(prepared.memory.memoryHistorySources, undefined);
    assert.equal(prepared.fingerprint, baseline.fingerprint);
    assert.ok(prepared.memory.prompt.data?.includes(coffee.statement));
    assert.ok(!prepared.memory.prompt.data?.includes("아틀라스"));

    const retrieval = await retrieveMemoryContext({ userId: user.id, query, now: NOW, memorySemanticContext });
    assert.equal(retrieval.semanticFallbackReason, "history_displaced_current_query");
    assert.equal(retrieval.algorithmVersion, MEMORY_RETRIEVAL_ALGORITHM_VERSION);
    assert.deepEqual(retrieval.selected.map(row => row.memory.id), [coffee.id]);
    assert.equal(provider.state.calls.length, 1, "repeated preparation validates the cached response without dispatch");
    const token = issueChatContextBundle({ subjectKey: user.id, conversationId: conversation.id,
        modelIds: [MODEL], context: prepared }).token;
    const envelope = verifyChatContextBundle(token, { subjectKey: user.id, conversationId: conversation.id, modelId: MODEL });
    assert.ok(envelope.ok);
    assert.equal(envelope.payload.memoryHistory, undefined);
    await prisma.message.create({ data: { conversationId: conversation.id, role: "user", content: query } });
    await prisma.message.update({ where: { id: source.id }, data: { content: "Changed unused history" } });
    const replayed = await replayMemoryHistoryContext({ ...access, query, payload: envelope.payload });
    assert.ok(replayed);
    assert.deepEqual(replayed.history, []);
    const sent = await buildChatTurnContext({ ...input, memorySemanticContext: replayed,
        semantic: verifyingSemanticModes(envelope.payload.semanticSteps) });
    assert.equal(sent.fingerprint, prepared.fingerprint);
    assert.equal(verifyChatContextBundle(token, { subjectKey: user.id, conversationId: conversation.id,
        modelId: MODEL, currentFingerprint: sent.fingerprint }).ok, true);
    assert.equal(provider.state.calls.length, 1, "send cannot dispatch or bind the rejected history");
}));

test("full Memory query preserves Korean middle conditions and the signed history across save, append and sibling answers", () => withFullMemoryQuery(async () => {
    const fixture = await fullQueryFixture();
    const context = await fixture.prepare();
    assert.equal(context.semanticSteps.memoryRerank, true);
    assert.deepEqual(context.memory.memoryHistorySources?.map(source => source.id), fixture.sources.map(source => source.id));
    const token = fixture.sign(context);
    assert.equal(provider.state.calls.length, 1);
    const wireQuery = provider.state.calls[0].body.query as string;
    assert.ok(Buffer.byteLength(wireQuery, "utf8") > 400);
    assert.ok(wireQuery.includes("중간 핵심 조건: 금요일이 아닌 다음 화요일"));
    assert.deepEqual(JSON.parse(wireQuery), {
        current_query: fixture.query.normalize("NFC"), previous_user_messages: fixture.sources.map(source => source.content.normalize("NFC")),
    });
    const signedBody = Buffer.from(token.split(".")[0], "base64url").toString("utf8");
    assert.ok(!signedBody.includes(fixture.query));
    assert.ok(!signedBody.includes(fixture.sources[0].content));
    await fixture.append();
    const replay = await fixture.rebuild(token);
    assert.deepEqual(replay.replayed.history.map(source => source.id), fixture.sources.map(source => source.id));
    assert.equal(replay.verification.ok, true);
    assert.equal(replay.context.fingerprint, context.fingerprint);
    assert.equal(provider.state.calls.length, 1, "send must use the stored ranking without another provider call");
    assert.equal(verifyChatContextBundle(token, {
        subjectKey: fixture.userId, conversationId: fixture.conversationId,
        modelId: "comparison-sibling", currentFingerprint: replay.context.fingerprint,
    }).ok, true);
    const reprepared = await buildChatTurnContext({
        ...fixture.buildInput,
        memorySemanticContext: prepareMemoryHistoryContext({
            request: fixture.request, userId: fixture.userId, conversationId: fixture.conversationId,
            query: fixture.query, modelIds: [MODEL, "comparison-sibling"], previousContextBundle: token,
        }),
    });
    assert.equal(reprepared.fingerprint, context.fingerprint);
    assert.deepEqual(reprepared.memory.memoryHistorySources, context.memory.memoryHistorySources);
    const refreshedToken = fixture.sign(reprepared);
    assert.notEqual(refreshedToken, token, "re-preparation issues a fresh nonce while preserving sources");
    assert.equal((await fixture.rebuild(refreshedToken)).verification.ok, true);
    assert.equal(provider.state.calls.length, 1, "same-subset re-preparation also reuses the cached ranking");
}));

test("separate project facts and scope rules are priced, signed and reproduced when rerank order favors the older project", () => withFullMemoryQuery(async () => {
    const fixture = await fullQueryFixture();
    await prisma.message.update({ where: { id: fixture.sources[1].id }, data: {
        content: "정정: 베가는 제외하고 아틀라스 프로젝트만 다룬다.",
    } });
    const vega = "베가 프로젝트 디자인 마감은 12월 15일이다.";
    await prisma.memoryItem.updateMany({ where: { userId: fixture.userId, statement: "다른 프로젝트 마감은 금요일이다." }, data: {
        statement: vega, searchTerms: memoryRetrievalTerms(vega),
    } });
    provider.state.rerankScore = (_query, document) => document.includes("베가") ? 0.95 : 0.8;
    const prepared = await fixture.prepare();
    assert.equal(prepared.semanticSteps.memoryRerank, true);
    assert.ok(prepared.memory.prompt.data?.includes(vega));
    assert.ok(prepared.memory.prompt.data?.includes("아틀라스 프로젝트 문서 검수 마감은 다음 화요일이다."));
    assert.ok(prepared.systemPrompt?.includes("latest explicit project switch or correction"));
    assert.ok(prepared.systemPrompt?.includes("Never fill a missing detail with another project's facts"));
    assert.ok(!prepared.systemPrompt?.includes(vega), "project facts remain user data, never app instructions");
    assert.equal(prepared.memoryTokens, estimatePromptTokens(prepared.memory.prompt.rules!) + estimatePromptTokens(prepared.memory.prompt.data!));
    const token = fixture.sign(prepared);
    const previousVersion = fixture.sign({ ...prepared,
        fingerprintInput: { ...prepared.fingerprintInput, promptVersion: "mem-context-v2" } });
    await fixture.append();
    const replay = await fixture.rebuild(token);
    assert.equal(replay.verification.ok, true);
    assert.equal(replay.context.memoryTokens, prepared.memoryTokens);
    assert.deepEqual(replay.context.memory.prompt, prepared.memory.prompt);
    assert.deepEqual((await fixture.rebuild(previousVersion)).verification, { ok: false, reason: "stale" });
    assert.equal(provider.state.calls.length, 1);
}));

test("a full-query contextual success becomes stale after cache loss without another paid dispatch", () => withFullMemoryQuery(async () => {
    const fixture = await fullQueryFixture();
    const context = await fixture.prepare();
    assert.equal(context.semanticSteps.memoryRerank, true);
    const token = fixture.sign(context);
    await fixture.append();
    await prisma.semanticRetrievalCache.deleteMany();
    const replay = await fixture.rebuild(token);
    assert.deepEqual(replay.verification, { ok: false, reason: "stale" });
    assert.equal(replay.context.semanticSteps.memoryRerank, false);
    assert.equal(replay.context.memory.memoryHistorySources, undefined);
    assert.equal(provider.state.calls.length, 1);
}));

for (const failure of ["provider", "budget", "cache_write"] as const) test(`a full-query ${failure} failure signs and reproduces lexical context without an unused history anchor`, () => withFullMemoryQuery(async () => {
    const fixture = await fullQueryFixture();
    const baseline = await buildChatTurnContext({ ...fixture.buildInput, semantic: "off" });
    if (failure === "provider") provider.state.failing = true;
    if (failure === "budget") provider.setEnv("RETRIEVAL_PROVIDER_COHERE_COST_MICROUSD_PER_DAY", "1");
    const context = failure === "cache_write"
        ? await withCacheUnavailable(fixture.prepare) : await fixture.prepare();
    assert.equal(context.semanticSteps.memoryRerank, false);
    assert.equal(context.fingerprint, baseline.fingerprint);
    assert.equal(context.memory.memoryHistorySources, undefined);
    const token = fixture.sign(context);
    const calls = provider.state.calls.length;
    assert.equal(calls, failure === "budget" ? 0 : 1);
    provider.state.failing = false;
    provider.setEnv("RETRIEVAL_PROVIDER_COHERE_COST_MICROUSD_PER_DAY", "5000000");
    await fixture.append();
    const replay = await fixture.rebuild(token);
    assert.equal(replay.payload.memoryHistory, undefined, "attempted history is not an adopted signed anchor");
    assert.deepEqual(replay.replayed.history, []);
    assert.equal(replay.verification.ok, true);
    assert.equal(replay.context.fingerprint, baseline.fingerprint);
    assert.equal(provider.state.calls.length, calls, "fallback replay cannot call the recovered provider");
}));
