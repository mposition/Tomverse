import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { enqueueKnowledgeCleanupForFiles } from "@/lib/assistantKnowledgeLifecycle";
import { prisma } from "@/lib/prisma";

/**
 * Release C2 storage invariants against a real database.
 *
 * docs/policy/external-conversation-import-and-memory.md §14, §14.2, §20
 * (릴리스 C). The pure modules decide what should be written; this is about
 * what the database refuses whatever the writer believed, and about the one
 * ordering that a comment cannot enforce — rows first, bytes second.
 *
 * The processing state machine is the part most worth pinning. A file's status
 * decides two different things in two different places: the worker claims
 * "pending" and retrieval reads "ready". A row that drifts out of that
 * vocabulary is invisible to both while looking perfectly fine in a list.
 */

const resetKnowledgeData = async () => {
    await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AssistantKnowledgeChunk",
      "AssistantKnowledgeFile",
      "AssistantKnowledgeCleanup",
      "AssistantProfileVersion",
      "AssistantProfile"
    RESTART IDENTITY CASCADE
  `);
};

const createUser = () =>
    prisma.user.create({
        data: { email: `assistant-knowledge-${randomUUID()}@example.test` },
    });

const createProfile = (userId: string) =>
    prisma.assistantProfile.create({ data: { userId, name: "Helper" } });

const fileData = (
    profileId: string,
    userId: string,
    overrides: Record<string, unknown> = {}
) => ({
    profileId,
    userId,
    name: "handbook.pdf",
    mime: "application/pdf",
    bytes: 4_096,
    digest: `digest-${randomUUID()}`,
    r2Key: `assistant-knowledge/${randomUUID()}`,
    ...overrides,
});

beforeEach(resetKnowledgeData);
after(async () => {
    await resetKnowledgeData();
    await prisma.$disconnect();
});

/* ------------------------------------------------- the state machine */

test("a processing status nobody enumerated is refused", async () => {
    const user = await createUser();
    const profile = await createProfile(user.id);
    await assert.rejects(
        prisma.assistantKnowledgeFile.create({
            data: fileData(profile.id, user.id, { processingStatus: "indexing" }),
        }),
        /processingStatus_allowed|constraint/i
    );
});

test("a failure code belongs to a failure, and only to a failure", async () => {
    const user = await createUser();
    const profile = await createProfile(user.id);

    // Ready with a failure code: two answers to one question.
    await assert.rejects(
        prisma.assistantKnowledgeFile.create({
            data: fileData(profile.id, user.id, {
                processingStatus: "ready",
                failureCode: "ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE",
            }),
        }),
        /failureCode_matches_status|constraint/i
    );

    // Failed with no reason: a file the owner cannot be told anything about.
    await assert.rejects(
        prisma.assistantKnowledgeFile.create({
            data: fileData(profile.id, user.id, { processingStatus: "failed" }),
        }),
        /failureCode_matches_status|constraint/i
    );

    const failed = await prisma.assistantKnowledgeFile.create({
        data: fileData(profile.id, user.id, {
            processingStatus: "failed",
            failureCode: "ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE",
        }),
    });
    assert.equal(failed.processingStatus, "failed");
});

test("only a ready file may claim chunks", async () => {
    // This is what retrieval depends on. A pending row claiming 40 chunks
    // would be retrieved from before anything had been extracted.
    const user = await createUser();
    const profile = await createProfile(user.id);
    for (const processingStatus of ["pending", "processing"]) {
        await assert.rejects(
            prisma.assistantKnowledgeFile.create({
                data: fileData(profile.id, user.id, {
                    processingStatus,
                    chunkCount: 3,
                }),
            }),
            /chunkCount_requires_ready|constraint/i,
            `${processingStatus} was allowed to claim chunks`
        );
    }
    const ready = await prisma.assistantKnowledgeFile.create({
        data: fileData(profile.id, user.id, {
            processingStatus: "ready",
            chunkCount: 3,
        }),
    });
    assert.equal(ready.chunkCount, 3);
});

test("an empty file and a negative ordinal are both refused", async () => {
    const user = await createUser();
    const profile = await createProfile(user.id);
    await assert.rejects(
        prisma.assistantKnowledgeFile.create({
            data: fileData(profile.id, user.id, { bytes: 0 }),
        }),
        /bytes_positive|constraint/i
    );

    const file = await prisma.assistantKnowledgeFile.create({
        data: fileData(profile.id, user.id),
    });
    await assert.rejects(
        prisma.assistantKnowledgeChunk.create({
            data: {
                fileId: file.id,
                userId: user.id,
                ordinal: -1,
                content: "text",
            },
        }),
        /ordinal_non_negative|constraint/i
    );
});

test("a chunk ordinal is unique within its file", async () => {
    const user = await createUser();
    const profile = await createProfile(user.id);
    const file = await prisma.assistantKnowledgeFile.create({
        data: fileData(profile.id, user.id),
    });
    const chunk = (ordinal: number) => ({
        fileId: file.id,
        userId: user.id,
        ordinal,
        content: `chunk ${ordinal}`,
        searchTerms: [`term${ordinal}`],
    });
    await prisma.assistantKnowledgeChunk.create({ data: chunk(0) });
    await assert.rejects(
        prisma.assistantKnowledgeChunk.create({ data: chunk(0) }),
        /Unique constraint|P2002/
    );
    await prisma.assistantKnowledgeChunk.create({ data: chunk(1) });
});

/* --------------------------------------------------- the same bytes twice */

test("re-uploading the same bytes is a new file, not a rejected duplicate", async () => {
    // §14 is explicit that a re-upload does not reconnect to a past version,
    // which requires it to be possible at all. A unique key on (profile,
    // digest) would have made the manifest contract untestable.
    const user = await createUser();
    const profile = await createProfile(user.id);
    const digest = "sha256-identical";
    const first = await prisma.assistantKnowledgeFile.create({
        data: fileData(profile.id, user.id, { digest }),
    });
    const second = await prisma.assistantKnowledgeFile.create({
        data: fileData(profile.id, user.id, { digest }),
    });
    assert.notEqual(first.id, second.id);
});

test("one object key belongs to one file", async () => {
    const user = await createUser();
    const profile = await createProfile(user.id);
    const r2Key = "assistant-knowledge/shared-key";
    await prisma.assistantKnowledgeFile.create({
        data: fileData(profile.id, user.id, { r2Key }),
    });
    await assert.rejects(
        prisma.assistantKnowledgeFile.create({
            data: fileData(profile.id, user.id, { r2Key }),
        }),
        /Unique constraint|P2002/
    );
});

/* -------------------------------------------------------------- cascades */

test("deleting a profile removes its files and their chunks; so does deleting the account", async () => {
    const user = await createUser();
    const profile = await createProfile(user.id);
    const file = await prisma.assistantKnowledgeFile.create({
        data: fileData(profile.id, user.id),
    });
    await prisma.assistantKnowledgeChunk.create({
        data: { fileId: file.id, userId: user.id, ordinal: 0, content: "a" },
    });

    await prisma.assistantProfile.delete({ where: { id: profile.id } });
    assert.equal(await prisma.assistantKnowledgeFile.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.assistantKnowledgeChunk.count({ where: { userId: user.id } }), 0);

    const second = await createProfile(user.id);
    const secondFile = await prisma.assistantKnowledgeFile.create({
        data: fileData(second.id, user.id),
    });
    await prisma.assistantKnowledgeChunk.create({
        data: { fileId: secondFile.id, userId: user.id, ordinal: 0, content: "a" },
    });
    await prisma.user.delete({ where: { id: user.id } });
    assert.equal(await prisma.assistantKnowledgeFile.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.assistantKnowledgeChunk.count({ where: { userId: user.id } }), 0);
});

test("a chunk is reachable by its own owner column, not only through its file", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const profile = await createProfile(owner.id);
    const file = await prisma.assistantKnowledgeFile.create({
        data: fileData(profile.id, owner.id),
    });
    await prisma.assistantKnowledgeChunk.create({
        data: { fileId: file.id, userId: owner.id, ordinal: 0, content: "a" },
    });
    assert.equal(
        await prisma.assistantKnowledgeChunk.count({ where: { userId: owner.id } }),
        1
    );
    assert.equal(
        await prisma.assistantKnowledgeChunk.count({ where: { userId: stranger.id } }),
        0
    );
});

/* ------------------------------------------------- deletion is DB-first */

test("deleting files enqueues their object keys in the same transaction", async () => {
    // §14.2: the rows go and the tombstones appear together, so a crash
    // between them cannot leave a chunk pointing at bytes that are gone.
    const user = await createUser();
    const profile = await createProfile(user.id);
    const files = await Promise.all([
        prisma.assistantKnowledgeFile.create({ data: fileData(profile.id, user.id) }),
        prisma.assistantKnowledgeFile.create({ data: fileData(profile.id, user.id) }),
    ]);

    await prisma.$transaction(async (tx) => {
        const enqueued = await enqueueKnowledgeCleanupForFiles(
            tx,
            { profileId: profile.id },
            "profile_deleted"
        );
        assert.equal(enqueued, 2);
        await tx.assistantKnowledgeFile.deleteMany({ where: { profileId: profile.id } });
    });

    const tombstones = await prisma.assistantKnowledgeCleanup.findMany({
        orderBy: { createdAt: "asc" },
        select: { r2Key: true, reason: true, completedAt: true },
    });
    assert.equal(tombstones.length, 2);
    assert.deepEqual(
        tombstones.map((row) => row.r2Key).sort(),
        files.map((file) => file.r2Key).sort()
    );
    assert.equal(tombstones[0].reason, "profile_deleted");
    assert.equal(tombstones[0].completedAt, null);
});

test("enqueueing the same key twice converges on one tombstone", async () => {
    // A re-deleted profile or a retried request must not fail on the unique
    // key -- the second attempt has the same work to do, not different work.
    const user = await createUser();
    const profile = await createProfile(user.id);
    await prisma.assistantKnowledgeFile.create({ data: fileData(profile.id, user.id) });

    await prisma.$transaction((tx) =>
        enqueueKnowledgeCleanupForFiles(tx, { profileId: profile.id }, "file_deleted")
    );
    await prisma.$transaction((tx) =>
        enqueueKnowledgeCleanupForFiles(tx, { profileId: profile.id }, "file_deleted")
    );

    assert.equal(await prisma.assistantKnowledgeCleanup.count(), 1);
});

test("a cleanup reason nobody enumerated is refused", async () => {
    await assert.rejects(
        prisma.assistantKnowledgeCleanup.create({
            data: { r2Key: "assistant-knowledge/x", reason: "because" },
        }),
        /reason_allowed|constraint/i
    );
});

/* ------------------------------------------------------ lexical retrieval */

test("chunks are searchable by term through the array index", async () => {
    // Retrieval v1 is this query and nothing else -- no embedding, no vector
    // column. Running it here is what proves the GIN index the migration
    // creates is actually usable, rather than a line of SQL nobody exercises.
    const user = await createUser();
    const profile = await createProfile(user.id);
    const file = await prisma.assistantKnowledgeFile.create({
        data: fileData(profile.id, user.id, {
            processingStatus: "ready",
            chunkCount: 2,
        }),
    });
    await prisma.assistantKnowledgeChunk.createMany({
        data: [
            {
                fileId: file.id,
                userId: user.id,
                ordinal: 0,
                content: "환불 정책",
                searchTerms: ["환불", "정책", "refund"],
            },
            {
                fileId: file.id,
                userId: user.id,
                ordinal: 1,
                content: "배송 정책",
                searchTerms: ["배송", "정책"],
            },
        ],
    });

    const matches = await prisma.assistantKnowledgeChunk.findMany({
        where: { userId: user.id, searchTerms: { hasSome: ["환불"] } },
        select: { ordinal: true },
    });
    assert.deepEqual(matches, [{ ordinal: 0 }]);

    const both = await prisma.assistantKnowledgeChunk.findMany({
        where: { userId: user.id, searchTerms: { hasSome: ["정책"] } },
        select: { ordinal: true },
        orderBy: { ordinal: "asc" },
    });
    assert.deepEqual(both, [{ ordinal: 0 }, { ordinal: 1 }]);
});
