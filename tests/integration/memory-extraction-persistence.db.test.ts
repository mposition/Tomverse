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
 * under test is what the database ends up holding. Since 2026-10-24 that is
 * active memories only: there is no review queue.
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
        canonicalKey?: string;
    } = {}
): ExtractionDecision =>
    ({
        candidate: {
            kind: "preference",
            polarity: "affirmed" as const,
            canonicalKey: overrides.canonicalKey ?? null,
            statement,
            confidence: 0.9,
            sensitivity: overrides.candidateSensitivity ?? "standard",
            expiresAt: null,
            evidence: [
                {
                    externalMessageId: source.id,
                    evidenceDigest: source.contentDigest,
                    role: "user" as const,
                    // A span of the fixture message above, because a parsed
                    // candidate can only carry one that occurs in the message
                    // it cites.
                    evidenceQuote: "prefers formal Korean",
                },
            ],
        },
        validation: {
            disposition:
                outcome === "store_candidate" ? "accepted" : "manual_review_required",
            sensitivity: overrides.sensitivity ?? "standard",
            bulkSafe:
                outcome === "store_candidate" &&
                (overrides.sensitivity ?? "standard") === "standard",
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

test("a safe candidate is stored active with its provenance, terms and evidence", async () => {
    const { user, message } = await seed();
    const result = await persist(user.id, [
        decision("the user prefers formal Korean", "store_candidate", message),
    ]);
    assert.equal(result.stored, 1);
    assert.equal(result.discarded, 0);

    const item = await prisma.memoryItem.findFirstOrThrow({
        where: { userId: user.id },
        include: { evidences: true },
    });
    // No review queue (owner decision 2026-10-24).
    assert.equal(item.status, "active");
    assert.ok(item.approvedAt);
    assert.equal(item.extractionRunId, "run-1");
    assert.equal(item.extractionChunkIndex, 0);
    assert.equal(item.extractionModelId, "gpt-5-6-luna");
    assert.equal(item.promptVersion, "mem-extract-v1");
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

test("a candidate that needs a judgement is not stored at all", async () => {
    // Without a review queue nobody would ever be shown it.
    const { user, message } = await seed();
    const result = await persist(user.id, [
        decision("the user takes medication daily", "store_for_individual_review", message, {
            sensitivity: "sensitive",
        }),
    ]);
    assert.equal(result.withheld, 1);
    assert.equal(result.stored, 0);
    assert.equal(await prisma.memoryItem.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.memoryEvidence.count({ where: { userId: user.id } }), 0);
});

test("the validator's sensitivity wins over the candidate's claim (§8.4)", async () => {
    // A model that labels a sensitive statement "standard" must not get it
    // activated: the validator's verdict is what the storage step reads.
    const { user, message } = await seed();
    const result = await persist(user.id, [
        decision("the user takes medication daily", "store_candidate", message, {
            candidateSensitivity: "standard",
            sensitivity: "sensitive",
        }),
    ]);
    assert.equal(result.withheld, 1);
    assert.equal(await prisma.memoryItem.count({ where: { userId: user.id } }), 0);
});

test("a retried chunk keeps what it stored and adds only what is new", async () => {
    const { user, message } = await seed();
    await persist(user.id, [
        decision("the user prefers formal Korean", "store_candidate", message),
    ]);
    // The worker died after the commit and before the report; the chunk is
    // re-run and the model's second answer is not identical.
    const second = await persist(user.id, [
        decision("the user prefers formal Korean", "store_candidate", message),
        decision("the user works in Seoul", "store_candidate", message),
    ]);
    assert.equal(second.stored, 1);
    assert.equal(second.outranked, 1, "the repeat is a duplicate");

    const items = await prisma.memoryItem.findMany({ where: { userId: user.id } });
    assert.equal(items.length, 2);
    assert.equal(await prisma.memoryEvidence.count({ where: { userId: user.id } }), 2);
});

test("a retry never deletes what the first attempt stored, whatever became of it", async () => {
    // The first attempt's row may already be suspended by a source lock, or
    // superseding something; deleting it on retry would lose both.
    const { user, message } = await seed();
    await persist(user.id, [
        decision("the user prefers formal Korean", "store_candidate", message),
    ]);
    await prisma.memoryItem.updateMany({
        where: { userId: user.id },
        data: { status: "suspended_by_source_lock" },
    });
    await persist(user.id, [
        decision("something else entirely", "store_candidate", message),
    ]);
    const statuses = (
        await prisma.memoryItem.findMany({
            where: { userId: user.id },
            orderBy: { statement: "asc" },
        })
    ).map((item) => [item.statement, item.status]);
    assert.deepEqual(statuses, [
        ["something else entirely", "active"],
        ["the user prefers formal Korean", "suspended_by_source_lock"],
    ]);
});

test("nothing is stored once the account has turned memory off", async () => {
    const { user, message } = await seed();
    await prisma.userMemorySettings.create({
        data: { userId: user.id, masterEnabled: false },
    });
    const result = await persist(user.id, [
        decision("the user prefers formal Korean", "store_candidate", message),
    ]);
    // Reported as memory off, not as an ordinary empty chunk, so the chunk
    // is not recorded done and runs again once memory is back on.
    assert.equal(result.memoryOff, true);
    assert.equal(result.stored, 0);
    assert.equal(await prisma.memoryItem.count({ where: { userId: user.id } }), 0);
});

test("a retry does not store a second copy beside a row that was suspended since", async () => {
    const { user, message } = await seed();
    await persist(user.id, [
        decision("the user prefers formal Korean", "store_candidate", message),
    ]);
    await prisma.memoryItem.updateMany({
        where: { userId: user.id },
        data: { status: "suspended_by_source_lock" },
    });
    const retry = await persist(user.id, [
        decision("the user prefers formal Korean", "store_candidate", message),
    ]);
    assert.equal(retry.stored, 0);
    assert.equal(retry.outranked, 1);
    assert.equal(await prisma.memoryItem.count({ where: { userId: user.id } }), 1);
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
                        evidenceQuote: "a second supporting message",
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

/* ------------------------------------------- newest statement wins a topic -- */

const messageAt = async (
    source: { userId: string; externalConversationId: string },
    content: string,
    ordinal: number,
    sourceTimestamp: Date
) =>
    prisma.externalMessage.create({
        data: {
            userId: source.userId,
            externalConversationId: source.externalConversationId,
            externalStableId: randomUUID().replaceAll("-", ""),
            role: "user",
            content,
            contentDigest: externalContentDigest(content),
            digestVersion: 1,
            ordinal,
            sourceTimestamp,
        },
    });

const topicDecision = (statement: string, source: EvidenceSource) => {
    const base = decision(statement, "store_candidate", source, {
        canonicalKey: "drink.coffee",
    });
    return {
        ...base,
        candidate: {
            ...base.candidate,
            evidence: [{ ...base.candidate.evidence[0], evidenceQuote: statement }],
        },
    } as ExtractionDecision;
};

test("a newer statement on a topic supersedes the older memory", async () => {
    const { user, message } = await seed();
    const older = await messageAt(message, "the user drinks coffee", 1, new Date("2025-01-01T00:00:00Z"));
    const newer = await messageAt(message, "the user does not drink coffee", 2, new Date("2026-01-01T00:00:00Z"));

    await persist(user.id, [topicDecision("the user drinks coffee", older)], 0);
    const result = await persist(user.id, [topicDecision("the user does not drink coffee", newer)], 1);
    assert.equal(result.stored, 1);
    assert.equal(result.superseded, 1);

    const rows = await prisma.memoryItem.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "asc" },
    });
    assert.deepEqual(
        rows.map((row) => [row.statement, row.status]),
        [
            ["the user drinks coffee", "superseded"],
            ["the user does not drink coffee", "active"],
        ]
    );
});

test("an older statement on a topic does not replace a newer memory", async () => {
    // Chunks run in id order, not in the order the conversations happened,
    // so the newer memory can be the one already stored.
    const { user, message } = await seed();
    const older = await messageAt(message, "the user drinks coffee", 1, new Date("2025-01-01T00:00:00Z"));
    const newer = await messageAt(message, "the user does not drink coffee", 2, new Date("2026-01-01T00:00:00Z"));

    await persist(user.id, [topicDecision("the user does not drink coffee", newer)], 0);
    const result = await persist(user.id, [topicDecision("the user drinks coffee", older)], 1);
    assert.equal(result.stored, 0);
    assert.equal(result.outranked, 1);

    const active = await prisma.memoryItem.findMany({
        where: { userId: user.id, status: "active" },
    });
    assert.deepEqual(active.map((row) => row.statement), ["the user does not drink coffee"]);
});

test("extraction never supersedes a memory the user wrote, edited or pinned", async () => {
    const { user, message } = await seed();
    const older = await messageAt(message, "the user drinks coffee", 1, new Date("2025-01-01T00:00:00Z"));
    const newer = await messageAt(message, "the user does not drink coffee", 2, new Date("2026-01-01T00:00:00Z"));
    await persist(user.id, [topicDecision("the user drinks coffee", older)], 0);
    for (const data of [{ userEdited: true }, { userEdited: false, pinned: true }]) {
        await prisma.memoryItem.updateMany({ where: { userId: user.id }, data });
        const result = await persist(user.id, [topicDecision("the user does not drink coffee", newer)], 1);
        assert.equal(result.outranked, 1);
        const active = await prisma.memoryItem.findMany({
            where: { userId: user.id, status: "active" },
        });
        assert.deepEqual(active.map((row) => row.statement), ["the user drinks coffee"]);
    }
});

test("a duplicate of an active memory adds nothing", async () => {
    const { user, message } = await seed();
    await persist(user.id, [
        decision("the user prefers formal Korean", "store_candidate", message),
    ], 0);
    const result = await persist(user.id, [
        decision("the user prefers formal Korean", "store_candidate", message),
    ], 1);
    assert.equal(result.stored, 0);
    assert.equal(result.outranked, 1);
    assert.equal(await prisma.memoryItem.count({ where: { userId: user.id } }), 1);
});
