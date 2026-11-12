import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import type { Session } from "next-auth";
import { externalContentDigest } from "@/lib/externalImportDigest";
import { leaseStillHolds } from "@/lib/memoryExtractionCommit";
import { persistExtractionChunkDecisions } from "@/lib/memoryExtractionPersistence";
import type { ExtractionDecision } from "@/lib/memoryExtractionPipeline";
import { retrieveMemoryContext } from "@/lib/memoryRetrievalService";
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
    assert.equal(result.algorithmVersion, 2);
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

    assert.equal(result.algorithmVersion, 3);
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

    assert.equal(result.algorithmVersion, 2);
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
    assert.equal(fallback.algorithmVersion, 2);
    assert.equal(fallback.resultHash, lexical.resultHash);

    // On, and the provider answers: the lexical match is still a candidate.
    provider.state.failing = false;
    provider.state.rerankScore = (_query, document) => (document.includes("커피") ? 0.9 : 0);
    const ranked = await retrieveMemoryContext({ ...input, query: `${COFFEE_QUESTION} 부탁해` });
    assert.equal(ranked.algorithmVersion, 3);
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
    assert.equal(result.algorithmVersion, 2);
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
    assert.equal(cold.algorithmVersion, 2);

    const issued = await retrieveMemoryContext(input);
    assert.equal(issued.algorithmVersion, 3);
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
    assert.equal(issued.algorithmVersion, 2);

    provider.state.failing = false;
    provider.state.rerankScore = () => 0.9;
    const verified = await retrieveMemoryContext({ ...input, semantic: "cached_only" });
    assert.equal(provider.state.calls.length, 1);
    assert.equal(verified.resultHash, issued.resultHash);
});
