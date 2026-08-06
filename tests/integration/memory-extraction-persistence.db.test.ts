import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { externalContentDigest } from "@/lib/externalImportDigest";
import { persistExtractionChunkDecisions } from "@/lib/memoryExtractionPersistence";
import type { ExtractionDecision } from "@/lib/memoryExtractionPipeline";
import { MEMORY_RETRIEVAL_VERSION } from "@/lib/memoryRetrievalTerms";
import { prisma } from "@/lib/prisma";

/**
 * The storage step of an extraction chunk (§8.3, §8.4, §11), against a real
 * database because every rule it enforces is a database-shaped one: a
 * constraint on what may exist, an idempotent replace, and an advisory lock.
 *
 * No provider is contacted. `analyzeExtractionChunk()` decides what each
 * candidate is; these tests feed those decisions in directly, because what is
 * under test is what the database ends up holding.
 */

const resetData = () =>
    prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "MemoryEvidence",
      "MemoryItem",
      "ExternalMessage",
      "ExternalConversation",
      "ExternalImport",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(resetData);
after(async () => {
    await resetData();
    await prisma.$disconnect();
});

const seed = async () => {
    const user = await prisma.user.create({
        data: { email: `persist-${randomUUID()}@example.test` },
    });
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
            title: "persistence fixture",
            conversationDigest: randomUUID().replaceAll("-", "").repeat(2),
            digestVersion: 1,
            messageCount: 1,
            contentBytes: BigInt(10),
            finalized: true,
        },
    });
    const content = "the user prefers formal Korean";
    const message = await prisma.externalMessage.create({
        data: {
            userId: user.id,
            externalConversationId: conversation.id,
            externalStableId: randomUUID().replaceAll("-", ""),
            role: "user",
            content,
            contentDigest: externalContentDigest(content),
            digestVersion: 1,
            ordinal: 0,
        },
    });
    return { user, message };
};

type EvidenceSource = { id: string; contentDigest: string };

/**
 * The digest is the *message's* stored one, which is what the real label map
 * supplies: §8.4 re-verifies evidence against the row, so a fixture that
 * digested the statement instead would describe evidence the server rejects.
 */
const decision = (
    statement: string,
    outcome: ExtractionDecision["outcome"],
    source: EvidenceSource,
    overrides: {
        sensitivity?: "standard" | "sensitive";
        candidateSensitivity?: "standard" | "sensitive";
    } = {}
): ExtractionDecision =>
    ({
        candidate: {
            kind: "preference",
            statement,
            confidence: 0.9,
            sensitivity: overrides.candidateSensitivity ?? "standard",
            expiresAt: null,
            evidence: [
                {
                    externalMessageId: source.id,
                    evidenceDigest: source.contentDigest,
                    role: "user" as const,
                },
            ],
        },
        validation: {
            disposition:
                outcome === "store_candidate" ? "accepted" : "manual_review_required",
            sensitivity: overrides.sensitivity ?? "standard",
            bulkSafe: outcome === "store_candidate",
            violations: [],
        },
        outcome,
    }) as ExtractionDecision;

const persist = (
    userId: string,
    decisions: readonly ExtractionDecision[],
    chunkIndex = 0,
    runId = "run-1"
) =>
    prisma.$transaction((tx) =>
        persistExtractionChunkDecisions(tx, {
            userId,
            runId,
            chunkIndex,
            extractionModelId: "gpt-5-6-luna",
            promptVersion: "mem-extract-v1",
            decisions,
        })
    );

test("stored candidates carry their provenance, terms and evidence (§9, §12)", async () => {
    const { user, message } = await seed();
    const result = await persist(user.id, [
        decision("the user prefers formal Korean", "store_candidate", message),
    ]);
    assert.equal(result.stored, 1);
    assert.equal(result.discarded, 0);
    assert.equal(result.replaced, 0);

    const item = await prisma.memoryItem.findFirstOrThrow({
        where: { userId: user.id },
        include: { evidences: true },
    });
    assert.equal(item.status, "candidate");
    assert.equal(item.extractionRunId, "run-1");
    assert.equal(item.extractionChunkIndex, 0);
    assert.equal(item.extractionModelId, "gpt-5-6-luna");
    assert.equal(item.promptVersion, "mem-extract-v1");
    // Extraction proposes; only a human approves (§8.1).
    assert.equal(item.approvedAt, null);
    assert.equal(item.userEdited, false);
    // Indexed at write time, not lazily on first search (§9).
    assert.equal(item.retrievalVersion, MEMORY_RETRIEVAL_VERSION);
    assert.ok(item.searchTerms.length > 0);
    assert.ok(item.conflictKey);

    assert.equal(item.evidences.length, 1);
    assert.equal(item.evidences[0].sourceType, "external_message");
    assert.equal(item.evidences[0].externalMessageId, message.id);
    assert.equal(item.evidences[0].manualContent, null);
});

test("a discarded candidate is not stored at all (§8.4)", async () => {
    const { user, message } = await seed();
    const result = await persist(user.id, [
        decision("api key sk-live-abc", "discard", message),
        decision("the user prefers formal Korean", "store_candidate", message),
    ]);
    assert.equal(result.stored, 1);
    assert.equal(result.discarded, 1);

    // Not "stored but hidden": a credential does not become safer by being
    // kept for review, so there must be no row and no evidence pointing at
    // the message it came from.
    const items = await prisma.memoryItem.findMany({ where: { userId: user.id } });
    assert.equal(items.length, 1);
    assert.equal(items[0].statement, "the user prefers formal Korean");
    assert.equal(await prisma.memoryEvidence.count({ where: { userId: user.id } }), 1);
});

test("a demoted candidate lands in manual_review_required (§8.3)", async () => {
    const { user, message } = await seed();
    const result = await persist(user.id, [
        decision("the user takes medication daily", "store_for_individual_review", message, {
            sensitivity: "sensitive",
        }),
    ]);
    assert.equal(result.individualReview, 1);
    const item = await prisma.memoryItem.findFirstOrThrow({
        where: { userId: user.id },
    });
    assert.equal(item.status, "manual_review_required");
    assert.equal(item.sensitivity, "sensitive");
});

test("the validator's sensitivity wins over the candidate's claim (§8.4)", async () => {
    // A model that labels a sensitive statement "standard" would otherwise opt
    // itself out of individual review and into bulk approval.
    const { user, message } = await seed();
    await persist(user.id, [
        decision("the user takes medication daily", "store_for_individual_review", message, {
            candidateSensitivity: "standard",
            sensitivity: "sensitive",
        }),
    ]);
    const item = await prisma.memoryItem.findFirstOrThrow({
        where: { userId: user.id },
    });
    assert.equal(item.sensitivity, "sensitive");
});

test("a retried chunk replaces its own rows rather than duplicating them (§11)", async () => {
    const { user, message } = await seed();
    await persist(user.id, [
        decision("the user prefers formal Korean", "store_candidate", message),
    ]);
    // The worker died after the provider answered; the chunk is re-claimed and
    // re-run, and the model's second answer is not identical.
    const second = await persist(user.id, [
        decision("the user prefers formal Korean", "store_candidate", message),
        decision("the user works in Seoul", "store_candidate", message),
    ]);
    assert.equal(second.replaced, 1);
    assert.equal(second.stored, 2);

    const items = await prisma.memoryItem.findMany({ where: { userId: user.id } });
    assert.equal(items.length, 2);
    // The evidence rows of the replaced item went with it.
    assert.equal(await prisma.memoryEvidence.count({ where: { userId: user.id } }), 2);
});

test("a retry never takes back a row the user already acted on (§8.1)", async () => {
    const { user, message } = await seed();
    await persist(user.id, [
        decision("the user prefers formal Korean", "store_candidate", message),
        decision("the user works in Seoul", "store_candidate", message),
    ]);
    const approved = await prisma.memoryItem.findFirstOrThrow({
        where: { userId: user.id, statement: "the user prefers formal Korean" },
    });
    await prisma.memoryItem.update({
        where: { id: approved.id },
        data: { status: "active", approvedAt: new Date() },
    });
    const edited = await prisma.memoryItem.findFirstOrThrow({
        where: { userId: user.id, statement: "the user works in Seoul" },
    });
    await prisma.memoryItem.update({
        where: { id: edited.id },
        data: { userEdited: true },
    });

    const retry = await persist(user.id, [
        decision("something else entirely", "store_candidate", message),
    ]);
    // Neither of the user's rows was replaced.
    assert.equal(retry.replaced, 0);
    const kept = await prisma.memoryItem.findMany({ where: { userId: user.id } });
    assert.equal(kept.length, 3);
    assert.ok(kept.some((item) => item.id === approved.id));
    assert.ok(kept.some((item) => item.id === edited.id));
});

test("another chunk of the same run is untouched by a retry (§11)", async () => {
    const { user, message } = await seed();
    await persist(user.id, [
        decision("chunk zero statement", "store_candidate", message),
    ], 0);
    await persist(user.id, [
        decision("chunk one statement", "store_candidate", message),
    ], 1);

    const retry = await persist(user.id, [
        decision("chunk zero rewritten", "store_candidate", message),
    ], 0);
    assert.equal(retry.replaced, 1);

    const statements = (
        await prisma.memoryItem.findMany({
            where: { userId: user.id },
            orderBy: { statement: "asc" },
        })
    ).map((item) => item.statement);
    assert.deepEqual(statements, ["chunk one statement", "chunk zero rewritten"]);
});

test("the provenance columns are set together or not at all", async () => {
    // The CHECK constraint behind the idempotent replace: a row naming a run
    // but no chunk could never be replaced by any chunk's retry, so it would
    // survive as a duplicate of whatever that retry writes.
    const { user } = await seed();
    await assert.rejects(
        prisma.memoryItem.create({
            data: {
                userId: user.id,
                kind: "preference",
                statement: "half-provenanced",
                confidence: 0.5,
                extractionRunId: "run-1",
            },
        })
    );
});

/* ------------------------------------------- §8.4 evidence re-verification -- */

test("a candidate whose source was deleted mid-run is dropped, not stored", async () => {
    // The failure this exists for: the chunk is read, the provider is called,
    // and the user deletes the import while that call is in flight. Without
    // the re-verification the evidence insert violates its foreign key and
    // takes the whole chunk down with an opaque database error, so tidying up
    // an import turns a running extraction into a failing one.
    const { user, message } = await seed();
    const gone = await prisma.externalMessage.create({
        data: {
            userId: user.id,
            externalConversationId: message.externalConversationId,
            externalStableId: randomUUID().replaceAll("-", ""),
            role: "user",
            content: "a message about to be deleted",
            contentDigest: externalContentDigest("a message about to be deleted"),
            digestVersion: 1,
            ordinal: 1,
        },
    });
    await prisma.externalMessage.delete({ where: { id: gone.id } });

    const result = await persist(user.id, [
        decision("grounded in a deleted message", "store_candidate", gone),
        decision("the user prefers formal Korean", "store_candidate", message),
    ]);
    assert.equal(result.unsourced, 1);
    assert.equal(result.stored, 1);
    // Not counted as a validator rejection: the statement was never judged
    // unacceptable, it simply has nothing left to stand on.
    assert.equal(result.discarded, 0);

    const items = await prisma.memoryItem.findMany({ where: { userId: user.id } });
    assert.equal(items.length, 1);
    assert.equal(items[0].statement, "the user prefers formal Korean");
});

test("evidence pinned to content whose digest moved does not re-attach (§8.4)", async () => {
    const { user, message } = await seed();
    const stale = { id: message.id, contentDigest: externalContentDigest("different content") };
    const result = await persist(user.id, [
        decision("the user prefers formal Korean", "store_candidate", stale),
    ]);
    assert.equal(result.unsourced, 1);
    assert.equal(result.stored, 0);
    assert.equal(
        await prisma.memoryEvidence.count({ where: { userId: user.id } }),
        0
    );
});

test("another account's message never verifies, whatever digest is claimed", async () => {
    // Ownership is the server's to establish. A cross-account reference is the
    // same outcome as a missing one, so nothing learns that the id is real.
    const mine = await seed();
    const theirs = await seed();
    const result = await persist(mine.user.id, [
        decision("borrowed from another account", "store_candidate", theirs.message),
    ]);
    assert.equal(result.unsourced, 1);
    assert.equal(result.stored, 0);
});

test("losing one reference of several keeps the candidate on what remains", async () => {
    const { user, message } = await seed();
    const second = await prisma.externalMessage.create({
        data: {
            userId: user.id,
            externalConversationId: message.externalConversationId,
            externalStableId: randomUUID().replaceAll("-", ""),
            role: "user",
            content: "a second supporting message",
            contentDigest: externalContentDigest("a second supporting message"),
            digestVersion: 1,
            ordinal: 2,
        },
    });
    await prisma.externalMessage.delete({ where: { id: second.id } });

    const twoSources = decision(
        "the user prefers formal Korean",
        "store_candidate",
        message
    );
    const result = await persist(user.id, [
        {
            ...twoSources,
            candidate: {
                ...twoSources.candidate,
                evidence: [
                    ...twoSources.candidate.evidence,
                    {
                        externalMessageId: second.id,
                        evidenceDigest: second.contentDigest,
                        role: "user" as const,
                    },
                ],
            },
        } as ExtractionDecision,
    ]);
    assert.equal(result.stored, 1);
    assert.equal(result.unsourced, 0);

    const item = await prisma.memoryItem.findFirstOrThrow({
        where: { userId: user.id },
        include: { evidences: true },
    });
    assert.equal(item.evidences.length, 1);
    assert.equal(item.evidences[0].externalMessageId, message.id);
});
