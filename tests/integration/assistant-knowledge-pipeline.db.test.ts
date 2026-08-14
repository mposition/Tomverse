import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { chunkKnowledgeText } from "@/lib/assistantKnowledgeChunking";
import { KNOWLEDGE_FAILURE_CODES } from "@/lib/assistantKnowledgeProcessor";
import {
    availableKnowledgeFiles,
    retrieveKnowledgeContext,
} from "@/lib/assistantKnowledgeRetrieval";
import { knowledgeUsage } from "@/lib/assistantKnowledgeService";
import { prisma } from "@/lib/prisma";

/**
 * Release C2's pipeline against a real database.
 *
 * The processing worker itself needs R2, which this suite deliberately does
 * not have -- so the extraction step is exercised by writing exactly what it
 * writes, using the same pure chunker, and the assertions are about the parts
 * that only a database can settle: what usage counts, what retrieval returns,
 * whose rows it can reach, and that a manifest resolves against what exists
 * now rather than what was listed then.
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
        data: { email: `knowledge-pipeline-${randomUUID()}@example.test` },
    });

const createProfile = (userId: string) =>
    prisma.assistantProfile.create({ data: { userId, name: "Helper" } });

/** A file plus the chunks the processor would have written for `text`. */
const storeProcessedFile = async (input: {
    userId: string;
    profileId: string;
    name: string;
    text: string;
}) => {
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

const REFUND_DOC = [
    "환불 정책 안내입니다. 구매 후 삼십일 이내에 환불을 요청할 수 있습니다.",
    "Refunds are processed within thirty days of an approved request.",
    "Shipping delays do not extend the refund window.",
].join("\n\n");

const ONBOARDING_DOC = [
    "Onboarding checklist for new engineers joining the platform team.",
    "Set up the local database, then run the integration suite once.",
].join("\n\n");

beforeEach(resetKnowledgeData);
after(async () => {
    await resetKnowledgeData();
    await prisma.$disconnect();
});

/* --------------------------------------------------------------- usage */

test("usage counts stored bytes for every file and text only for ready ones", async () => {
    // A failed file's bytes are still stored until the sweep takes them, so
    // they still cost the account. Its text does not exist, so it costs
    // nothing against the text budget -- counting it would charge an owner for
    // a file that never worked.
    const user = await createUser();
    const profile = await createProfile(user.id);
    const ready = await storeProcessedFile({
        userId: user.id,
        profileId: profile.id,
        name: "refunds.txt",
        text: REFUND_DOC,
    });
    await prisma.assistantKnowledgeFile.create({
        data: {
            profileId: profile.id,
            userId: user.id,
            name: "broken.pdf",
            mime: "application/pdf",
            bytes: 5_000,
            digest: `sha256-${randomUUID()}`,
            r2Key: `assistant-knowledge/${randomUUID()}`,
            processingStatus: "failed",
            failureCode: KNOWLEDGE_FAILURE_CODES.unreadable,
        },
    });

    const usage = await knowledgeUsage(user.id, profile.id);
    assert.equal(usage.filesInProfile, 2);
    assert.equal(usage.filesInAccount, 2);
    assert.equal(usage.objectBytesInAccount, ready.bytes + 5_000);
    assert.equal(usage.extractedBytesInAccount, [...REFUND_DOC].length);
});

test("usage is per profile for the profile ceiling and per account for the rest", async () => {
    const user = await createUser();
    const first = await createProfile(user.id);
    const second = await createProfile(user.id);
    await storeProcessedFile({
        userId: user.id,
        profileId: first.id,
        name: "a.txt",
        text: REFUND_DOC,
    });
    await storeProcessedFile({
        userId: user.id,
        profileId: second.id,
        name: "b.txt",
        text: ONBOARDING_DOC,
    });

    const usage = await knowledgeUsage(user.id, first.id);
    assert.equal(usage.filesInProfile, 1);
    assert.equal(usage.filesInAccount, 2);
});

/* ----------------------------------------------------------- retrieval */

test("retrieval answers from the file that matches, in document order", async () => {
    const user = await createUser();
    const profile = await createProfile(user.id);
    const refunds = await storeProcessedFile({
        userId: user.id,
        profileId: profile.id,
        name: "refunds.txt",
        text: REFUND_DOC,
    });
    const onboarding = await storeProcessedFile({
        userId: user.id,
        profileId: profile.id,
        name: "onboarding.txt",
        text: ONBOARDING_DOC,
    });

    const selection = await retrieveKnowledgeContext({
        userId: user.id,
        fileIds: [refunds.id, onboarding.id],
        query: "What is the refund window in days?",
    });

    assert.ok(selection.chunks.length > 0, "nothing was retrieved");
    assert.deepEqual(selection.fileIds, [refunds.id]);
    const ordinals = selection.chunks.map((chunk) => chunk.ordinal);
    assert.deepEqual(ordinals, [...ordinals].sort((a, b) => a - b));
});

test("a Korean question reaches a Korean passage", async () => {
    // The bigram half of the tokenizer is what makes this work at all; without
    // it a Hangul query tokenises to nothing and retrieval is silently empty
    // for every Korean user.
    const user = await createUser();
    const profile = await createProfile(user.id);
    const file = await storeProcessedFile({
        userId: user.id,
        profileId: profile.id,
        name: "refunds.txt",
        text: REFUND_DOC,
    });

    const selection = await retrieveKnowledgeContext({
        userId: user.id,
        fileIds: [file.id],
        query: "환불 정책이 어떻게 되나요?",
    });
    assert.ok(selection.chunks.length > 0, "a Korean query retrieved nothing");
    assert.match(selection.chunks[0].content, /환불/);
});

test("retrieval never reaches another account's chunks", async () => {
    // The file ids are supplied by the caller's own profile version, but the
    // owner filter is what makes a wrong id harmless rather than a disclosure.
    const owner = await createUser();
    const stranger = await createUser();
    const ownerProfile = await createProfile(owner.id);
    const strangerProfile = await createProfile(stranger.id);
    const ownerFile = await storeProcessedFile({
        userId: owner.id,
        profileId: ownerProfile.id,
        name: "refunds.txt",
        text: REFUND_DOC,
    });
    const strangerFile = await storeProcessedFile({
        userId: stranger.id,
        profileId: strangerProfile.id,
        name: "secret.txt",
        text: REFUND_DOC,
    });

    const selection = await retrieveKnowledgeContext({
        userId: owner.id,
        fileIds: [ownerFile.id, strangerFile.id],
        query: "refund window in days",
    });
    assert.deepEqual(selection.fileIds, [ownerFile.id]);
});

test("a file that is not ready is not retrieved from", async () => {
    const user = await createUser();
    const profile = await createProfile(user.id);
    const file = await storeProcessedFile({
        userId: user.id,
        profileId: profile.id,
        name: "refunds.txt",
        text: REFUND_DOC,
    });
    // Chunks stay, status moves. Retrieval has to read the status rather than
    // assume that having chunks means being usable.
    await prisma.assistantKnowledgeFile.update({
        where: { id: file.id },
        data: { chunkCount: 0, processingStatus: "processing" },
    });

    const selection = await retrieveKnowledgeContext({
        userId: user.id,
        fileIds: [file.id],
        query: "refund window in days",
    });
    assert.equal(selection.chunks.length, 0);
});

test("no files in scope and no usable query terms both retrieve nothing", async () => {
    const user = await createUser();
    const profile = await createProfile(user.id);
    const file = await storeProcessedFile({
        userId: user.id,
        profileId: profile.id,
        name: "refunds.txt",
        text: REFUND_DOC,
    });
    assert.equal(
        (
            await retrieveKnowledgeContext({
                userId: user.id,
                fileIds: [],
                query: "refund window",
            })
        ).chunks.length,
        0
    );
    assert.equal(
        (
            await retrieveKnowledgeContext({
                userId: user.id,
                fileIds: [file.id],
                query: "   ",
            })
        ).chunks.length,
        0
    );
});

/* ------------------------------------------------------------ manifest */

test("a manifest resolves against what exists now, per owner", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const profile = await createProfile(owner.id);
    const strangerProfile = await createProfile(stranger.id);
    const kept = await storeProcessedFile({
        userId: owner.id,
        profileId: profile.id,
        name: "kept.txt",
        text: REFUND_DOC,
    });
    const strangerFile = await storeProcessedFile({
        userId: stranger.id,
        profileId: strangerProfile.id,
        name: "theirs.txt",
        text: REFUND_DOC,
    });

    const available = await availableKnowledgeFiles(owner.id, [
        kept.id,
        strangerFile.id,
        "f-deleted",
    ]);
    assert.deepEqual(
        available.map((file) => file.fileId),
        [kept.id]
    );
    assert.equal(available[0].processed, true);
    assert.equal(available[0].digest, kept.digest);
});

test("a file still processing is reported as not processed, not as absent", async () => {
    // The difference matters to the caller: absent means "gone", not processed
    // means "not yet", and a screen that shows both the same way tells an
    // owner their file was deleted.
    const user = await createUser();
    const profile = await createProfile(user.id);
    const file = await prisma.assistantKnowledgeFile.create({
        data: {
            profileId: profile.id,
            userId: user.id,
            name: "pending.pdf",
            mime: "application/pdf",
            bytes: 1_000,
            digest: "sha256-pending",
            r2Key: `assistant-knowledge/${randomUUID()}`,
            processingStatus: "pending",
        },
    });
    const [entry] = await availableKnowledgeFiles(user.id, [file.id]);
    assert.equal(entry.fileId, file.id);
    assert.equal(entry.processed, false);
});
