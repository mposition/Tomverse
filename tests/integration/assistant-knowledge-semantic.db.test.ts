import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { chunkKnowledgeText } from "@/lib/assistantKnowledgeChunking";
import {
    KNOWLEDGE_IMAGE_PAGE_KIND,
    embedKnowledgeChunks,
    imagePageChunkContent,
} from "@/lib/assistantKnowledgeEmbedding";
import { retrieveKnowledgeContext } from "@/lib/assistantKnowledgeRetrieval";
import { prisma } from "@/lib/prisma";
import {
    reserveRetrievalCost,
    settleRetrievalCost,
    sweepSemanticRetrievalCache,
} from "@/lib/semanticRetrieval";
import {
    RETRIEVAL_PROVIDER_BUCKET_KEY,
    encodeVector,
    semanticRetrievalSettingKey,
    type SemanticRetrievalFeature,
} from "@/lib/semanticRetrievalCore";
import {
    TEST_EMBEDDING_LABEL,
    installTestRetrievalProvider,
    toyVector,
} from "./semanticRetrievalTestProvider";

/**
 * Semantic knowledge retrieval (docs/policy/external-conversation-import-and-memory.md §9a) against a real database.
 *
 * The provider is a local stand-in; what is under test is everything around
 * it that only a database settles: that an off switch sends nothing, that the
 * budget is held and settled in its own bucket, that the first outcome of a
 * call is the outcome of every rebuild of the same turn, and that a vector
 * never lets one account read another's chunk.
 */

const provider = installTestRetrievalProvider();

const reset = async () => {
    await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "SemanticRetrievalCache",
      "AssistantKnowledgeChunk",
      "AssistantKnowledgeFile",
      "AssistantKnowledgeCleanup",
      "AssistantProfileVersion",
      "AssistantProfile"
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
    prisma.user.create({ data: { email: `knowledge-semantic-${randomUUID()}@example.test` } });

const createProfile = (userId: string) =>
    prisma.assistantProfile.create({ data: { userId, name: "Helper" } });

const storeFile = async (input: { userId: string; profileId: string; name: string; text: string }) => {
    const chunks = chunkKnowledgeText(input.text);
    const file = await prisma.assistantKnowledgeFile.create({
        data: {
            profileId: input.profileId,
            userId: input.userId,
            name: input.name,
            mime: "text/plain",
            bytes: Buffer.byteLength(input.text, "utf8"),
            digest: `sha256-${randomUUID()}`,
            r2Key: `assistant-knowledge/${randomUUID()}`,
            processingStatus: "ready",
            extractedCharacters: [...input.text].length,
            chunkCount: chunks.length,
        },
    });
    await prisma.assistantKnowledgeChunk.createMany({
        data: chunks.map((chunk) => ({
            fileId: file.id,
            userId: input.userId,
            ordinal: chunk.ordinal,
            content: chunk.content,
            searchTerms: chunk.searchTerms,
            retrievalVersion: chunk.retrievalVersion,
            sourceMetadata: chunk.sourceMetadata,
        })),
    });
    return file;
};

// Shares no term with the question below: 반품/취소/정책 against 환불/규정.
const RETURNS_DOC = "반품 및 취소 정책: 구매 후 삼십일 이내에 반품을 접수하면 전액 돌려드립니다.";
const SHIPPING_DOC = "배송은 영업일 기준 삼일이 걸립니다.";
const REFUND_QUESTION = "환불 규정 알려줘";

const WINDOW_DOC = "Refunds are processed within thirty days. The refund window starts at delivery.";
const GIFT_DOC = "The refund window does not apply to gift cards; a gift card refund is declined.";
const GIFT_QUESTION = "refund window for a gift card";

const bucketCounts = async () =>
    (
        await prisma.$queryRaw<Array<{ period: string; count: bigint }>>`
            SELECT "period", "count" FROM "ChatUsageBucket"
            WHERE "key" = ${RETRIEVAL_PROVIDER_BUCKET_KEY}
            ORDER BY "period" ASC
        `
    ).map((row) => [row.period, Number(row.count)] as const);

const seedTwoFiles = async (first: string, second: string) => {
    const user = await createUser();
    const profile = await createProfile(user.id);
    const a = await storeFile({ userId: user.id, profileId: profile.id, name: "a.txt", text: first });
    const b = await storeFile({ userId: user.id, profileId: profile.id, name: "b.txt", text: second });
    return { user, profile, a, b, fileIds: [a.id, b.id] };
};

/* ------------------------------------------------------------ off is off */

test("with every switch off nothing is sent and the selection is the lexical one", async () => {
    const { user, fileIds } = await seedTwoFiles(RETURNS_DOC, SHIPPING_DOC);

    const selection = await retrieveKnowledgeContext({
        userId: user.id,
        fileIds,
        query: REFUND_QUESTION,
    });

    assert.equal(provider.state.calls.length, 0);
    assert.equal(selection.retrievalVersion, 1);
    // The passage that answers shares no term with the question, which is the
    // gap the switches exist to close.
    assert.deepEqual(selection.chunks, []);
});

test("a switch that is on does nothing without a configured budget", async () => {
    const { user, fileIds } = await seedTwoFiles(WINDOW_DOC, GIFT_DOC);
    await turnOn("knowledgeRerank");
    delete process.env.RETRIEVAL_PROVIDER_COHERE_COST_MICROUSD_PER_MONTH;

    const selection = await retrieveKnowledgeContext({
        userId: user.id,
        fileIds,
        query: GIFT_QUESTION,
    });

    assert.equal(provider.state.calls.length, 0);
    assert.equal(selection.retrievalVersion, 1);
});

/* ------------------------------------------------------------- embedding */

test("an embedded passage is found by meaning when it shares no term with the question", async () => {
    const { user, a, fileIds } = await seedTwoFiles(RETURNS_DOC, SHIPPING_DOC);
    await turnOn("knowledgeEmbed");

    const indexed = await embedKnowledgeChunks();
    assert.deepEqual(indexed, { considered: 2, embedded: 2 });
    const stored = await prisma.assistantKnowledgeChunk.findMany({
        select: { embeddingModel: true, embedding: true },
    });
    assert.ok(stored.every((row) => row.embeddingModel === TEST_EMBEDDING_LABEL && row.embedding));

    // Idempotent: nothing is left to embed, so nothing is sent.
    const callsAfterIndexing = provider.state.calls.length;
    assert.deepEqual(await embedKnowledgeChunks(), { considered: 0, embedded: 0 });
    assert.equal(provider.state.calls.length, callsAfterIndexing);

    const selection = await retrieveKnowledgeContext({
        userId: user.id,
        fileIds,
        query: REFUND_QUESTION,
    });
    assert.deepEqual(
        selection.chunks.map((chunk) => chunk.fileId),
        [a.id]
    );
    assert.equal(selection.retrievalVersion, 2);
});

test("the question is embedded once per turn however many times the context is rebuilt", async () => {
    const { user, fileIds } = await seedTwoFiles(RETURNS_DOC, SHIPPING_DOC);
    await turnOn("knowledgeEmbed");
    await embedKnowledgeChunks();
    provider.state.calls.length = 0;

    const input = { userId: user.id, fileIds, query: REFUND_QUESTION };
    const first = await retrieveKnowledgeContext(input);
    const second = await retrieveKnowledgeContext(input);
    const third = await retrieveKnowledgeContext(input);

    assert.equal(provider.state.calls.length, 1);
    assert.deepEqual(
        [second, third].map((selection) => selection.chunks.map((chunk) => chunk.id)),
        [first.chunks.map((chunk) => chunk.id), first.chunks.map((chunk) => chunk.id)]
    );
});

test("a vector never reaches across accounts", async () => {
    const { user, fileIds } = await seedTwoFiles(SHIPPING_DOC, SHIPPING_DOC);
    const other = await seedTwoFiles(RETURNS_DOC, RETURNS_DOC);
    await turnOn("knowledgeEmbed");
    await embedKnowledgeChunks();

    // The other account's file ids are named outright, as a forged manifest
    // would name them. Ownership is a column on the chunk, not a property of
    // the id list.
    const selection = await retrieveKnowledgeContext({
        userId: user.id,
        fileIds: [...fileIds, ...other.fileIds],
        query: REFUND_QUESTION,
    });
    assert.deepEqual(selection.chunks, []);
});

test("a scanned page is retrieved as a pointer and is never re-embedded as text", async () => {
    const { user, a, fileIds } = await seedTwoFiles(SHIPPING_DOC, SHIPPING_DOC);
    await turnOn("knowledgeEmbed");
    const pageVector = encodeVector(Int8Array.from(toyVector("refund")));
    const page = await prisma.assistantKnowledgeChunk.create({
        data: {
            fileId: a.id,
            userId: user.id,
            ordinal: 50,
            content: imagePageChunkContent(3),
            searchTerms: [],
            sourceMetadata: { kind: KNOWLEDGE_IMAGE_PAGE_KIND, page: 3 },
            embedding: pageVector,
            // A label from another model: the text sweep must still leave it.
            embeddingModel: "cohere:older-model:default:int8",
        },
    });

    await embedKnowledgeChunks();
    const untouched = await prisma.assistantKnowledgeChunk.findUniqueOrThrow({
        where: { id: page.id },
        select: { embeddingModel: true },
    });
    assert.equal(untouched.embeddingModel, "cohere:older-model:default:int8");

    await prisma.assistantKnowledgeChunk.update({
        where: { id: page.id },
        data: { embeddingModel: TEST_EMBEDDING_LABEL },
    });
    const selection = await retrieveKnowledgeContext({
        userId: user.id,
        fileIds,
        query: REFUND_QUESTION,
    });
    assert.deepEqual(
        selection.chunks.map((chunk) => chunk.id),
        [page.id]
    );
    assert.match(selection.chunks[0].content, /^\[Page 3\]/);
});

/* ---------------------------------------------------------------- rerank */

test("reranking decides relevance, and the hold settles to what was billed", async () => {
    const { user, b, fileIds } = await seedTwoFiles(WINDOW_DOC, GIFT_DOC);
    await turnOn("knowledgeRerank");
    provider.state.rerankScore = (_query, document) => (document.includes("gift") ? 0.9 : 0.02);

    const selection = await retrieveKnowledgeContext({
        userId: user.id,
        fileIds,
        query: GIFT_QUESTION,
    });

    // Both passages share terms with the question, so the lexical selection
    // would carry both; the reranker's floor drops the one that does not answer.
    assert.deepEqual(
        selection.chunks.map((chunk) => chunk.fileId),
        [b.id]
    );
    assert.equal(selection.retrievalVersion, 2);
    assert.equal(provider.state.calls.filter((call) => call.api === "rerank").length, 1);
    // One billed search unit at the configured price, in both windows.
    assert.deepEqual(await bucketCounts(), [
        ["retrieval-cost-day", 2000],
        ["retrieval-cost-month", 2000],
    ]);
});

test("the first ranking of a turn is every rebuild's ranking, and is paid for once", async () => {
    const { user, fileIds } = await seedTwoFiles(WINDOW_DOC, GIFT_DOC);
    await turnOn("knowledgeRerank");
    provider.state.rerankScore = (_query, document) => (document.includes("gift") ? 0.9 : 0.4);
    const input = { userId: user.id, fileIds, query: GIFT_QUESTION };

    const first = await retrieveKnowledgeContext(input);
    // A provider that would now answer differently must not be asked again.
    provider.state.rerankScore = () => 0.01;
    const second = await retrieveKnowledgeContext(input);

    assert.equal(provider.state.calls.length, 1);
    assert.deepEqual(
        second.chunks.map((chunk) => chunk.id),
        first.chunks.map((chunk) => chunk.id)
    );
    assert.deepEqual(await bucketCounts(), [
        ["retrieval-cost-day", 2000],
        ["retrieval-cost-month", 2000],
    ]);
});

test("a failed call is remembered, so later rebuilds fall back the same way", async () => {
    const { user, fileIds } = await seedTwoFiles(WINDOW_DOC, GIFT_DOC);
    await turnOn("knowledgeRerank");
    const input = { userId: user.id, fileIds, query: GIFT_QUESTION };

    provider.state.failing = true;
    const first = await retrieveKnowledgeContext(input);
    assert.equal(first.retrievalVersion, 1);
    assert.equal(first.chunks.length, 2);
    // The request left the process and may have been billed: the whole hold stays.
    const held = await bucketCounts();
    assert.ok(held[0][1] >= 2000);

    provider.state.failing = false;
    const second = await retrieveKnowledgeContext(input);
    assert.equal(provider.state.calls.length, 1);
    assert.equal(second.retrievalVersion, 1);
    assert.deepEqual(
        second.chunks.map((chunk) => chunk.id),
        first.chunks.map((chunk) => chunk.id)
    );
});

test("a budget with no room refuses the call before anything is sent", async () => {
    const { user, fileIds } = await seedTwoFiles(WINDOW_DOC, GIFT_DOC);
    await turnOn("knowledgeRerank");
    provider.setEnv("RETRIEVAL_PROVIDER_COHERE_COST_MICROUSD_PER_DAY", "10");
    provider.setEnv("RETRIEVAL_PROVIDER_COHERE_COST_MICROUSD_PER_MONTH", "10");

    const selection = await retrieveKnowledgeContext({
        userId: user.id,
        fileIds,
        query: GIFT_QUESTION,
    });

    assert.equal(provider.state.calls.length, 0);
    assert.equal(selection.retrievalVersion, 1);
    assert.deepEqual(await bucketCounts(), []);
});

/* ------------------------------------------------------- budget and cache */

test("a hold is written to both windows or to neither, and settles by its difference", async () => {
    const now = new Date("2026-11-12T03:00:00.000Z");
    const limits = { day: 1000, month: 5000 };

    assert.equal(await reserveRetrievalCost(600, limits, now), true);
    // The day window has 400 left: a second 600 must not land in the month.
    assert.equal(await reserveRetrievalCost(600, limits, now), false);
    assert.deepEqual(await bucketCounts(), [
        ["retrieval-cost-day", 600],
        ["retrieval-cost-month", 600],
    ]);

    await settleRetrievalCost(-450, now);
    assert.deepEqual(await bucketCounts(), [
        ["retrieval-cost-day", 150],
        ["retrieval-cost-month", 150],
    ]);
});

test("the sweep removes cache rows past their expiry and leaves live ones", async () => {
    const user = await createUser();
    await prisma.$executeRaw`
        INSERT INTO "SemanticRetrievalCache" ("key", "userId", "value", "expiresAt", "createdAt")
        VALUES
            ('expired', ${user.id}, '{"kind":"failed"}'::jsonb, NOW() - INTERVAL '1 minute', NOW()),
            ('live', ${user.id}, '{"kind":"failed"}'::jsonb, NOW() + INTERVAL '5 minutes', NOW())
    `;

    assert.equal(await sweepSemanticRetrievalCache(), 1);
    assert.deepEqual(
        (await prisma.semanticRetrievalCache.findMany({ select: { key: true } })).map((row) => row.key),
        ["live"]
    );

    // And the rest goes with the account.
    await prisma.user.delete({ where: { id: user.id } });
    assert.equal(await prisma.semanticRetrievalCache.count(), 0);
});

/* --------------------------------------------- what a signed bundle relies on */

test("an index that fills in mid-turn does not change that turn's neighbours", async () => {
    const { user, a, fileIds } = await seedTwoFiles(RETURNS_DOC, SHIPPING_DOC);
    await turnOn("knowledgeEmbed");
    const input = { userId: user.id, fileIds, query: REFUND_QUESTION };

    // Nothing is embedded yet, so the first build of the turn finds no
    // neighbour and its bundle is signed over the lexical selection.
    const first = await retrieveKnowledgeContext(input);
    assert.deepEqual(first.chunks, []);
    assert.equal(first.retrievalVersion, 1);

    // The sweep catches up before the turn's next route rebuilds the context.
    await embedKnowledgeChunks();
    const rebuilt = await retrieveKnowledgeContext(input);
    assert.deepEqual(rebuilt.chunks, []);
    assert.equal(rebuilt.retrievalVersion, 1);

    // A different question is a different turn, and sees the filled index.
    const next = await retrieveKnowledgeContext({ ...input, query: `${REFUND_QUESTION} 다시` });
    assert.deepEqual(
        next.chunks.map((chunk) => chunk.fileId),
        [a.id]
    );
});

const secondsUntilExpiry = async () =>
    (
        await prisma.$queryRaw<Array<{ seconds: number }>>`
            SELECT EXTRACT(EPOCH FROM ("expiresAt" - NOW()))::float8 AS "seconds"
            FROM "SemanticRetrievalCache"
            ORDER BY "expiresAt" ASC
        `
    ).map((row) => row.seconds);

test("reading an outcome keeps it alive for a whole bundle lifetime", async () => {
    const { user, fileIds } = await seedTwoFiles(WINDOW_DOC, GIFT_DOC);
    await turnOn("knowledgeRerank");
    const input = { userId: user.id, fileIds, query: GIFT_QUESTION };
    await retrieveKnowledgeContext(input);

    // The entry is nearly at the end of its first ten minutes when a new
    // bundle is built from it.
    await prisma.$executeRaw`
        UPDATE "SemanticRetrievalCache" SET "expiresAt" = NOW() + INTERVAL '20 seconds'
    `;
    await retrieveKnowledgeContext(input);

    assert.equal(provider.state.calls.length, 1);
    // Five minutes is how long a context bundle lives.
    assert.ok((await secondsUntilExpiry()).every((seconds) => seconds > 5 * 60));
});

test("a recorded failure is kept alive the same way, however old it is", async () => {
    const { user, fileIds } = await seedTwoFiles(WINDOW_DOC, GIFT_DOC);
    await turnOn("knowledgeRerank");
    const input = { userId: user.id, fileIds, query: GIFT_QUESTION };
    provider.state.failing = true;
    const first = await retrieveKnowledgeContext(input);
    provider.state.failing = false;

    // Recorded long ago and about to lapse when a new bundle is built from
    // it. Any age limit here would be a moment at which that bundle loses the
    // outcome it was signed over, so there is none.
    await prisma.$executeRaw`
        UPDATE "SemanticRetrievalCache"
        SET "createdAt" = NOW() - INTERVAL '3 hours', "expiresAt" = NOW() + INTERVAL '20 seconds'
    `;
    const rebuilt = await retrieveKnowledgeContext(input);

    assert.equal(provider.state.calls.length, 1);
    assert.equal(rebuilt.retrievalVersion, first.retrievalVersion);
    assert.ok((await secondsUntilExpiry()).every((seconds) => seconds > 5 * 60));

    // Left alone past its expiry, the same question asks the provider again.
    await prisma.$executeRaw`
        UPDATE "SemanticRetrievalCache" SET "expiresAt" = NOW() - INTERVAL '1 second'
    `;
    const later = await retrieveKnowledgeContext(input);
    assert.equal(provider.state.calls.length, 2);
    assert.equal(later.retrievalVersion, 2);
});

test("a question with no usable term sends nothing and retrieves nothing", async () => {
    const { user, fileIds } = await seedTwoFiles(RETURNS_DOC, SHIPPING_DOC);
    await turnOn("knowledgeEmbed");
    await turnOn("knowledgeRerank");
    await embedKnowledgeChunks();
    provider.state.calls.length = 0;

    for (const query of ["", "   ", "?!", "a"]) {
        const selection = await retrieveKnowledgeContext({ userId: user.id, fileIds, query });
        assert.deepEqual(selection.chunks, [], `query ${JSON.stringify(query)}`);
        assert.equal(selection.retrievalVersion, 1);
    }
    assert.equal(provider.state.calls.length, 0);
});
