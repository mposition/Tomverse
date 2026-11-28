import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { buildChatMemoryToolPart, memoryToolAllowed } from "@/lib/chatMemoryTool";
import { MEMORY_EXTRACTION_FLAG_KEY } from "@/lib/memoryAccess";
import type { MemoryExtractionEvalEntry } from "@/lib/memoryExtractionEvalRegister";
import type { ExtractionDecision } from "@/lib/memoryExtractionPipeline";
import { persistExtractionChunkDecisions } from "@/lib/memoryExtractionPersistence";
import { MEMORY_EXTRACTION_PROMPT_VERSION } from "@/lib/memoryExtractionPrompt";
import { nativeMessageDigest } from "@/lib/nativeMemoryEvidence";
import { prisma } from "@/lib/prisma";
import { enqueueNativeChatExtraction, loadNativeChunkConversation } from "@/lib/projectMemoryExtraction";
import { createProject, updateConversationWithProjectGrounds } from "@/lib/projectWorkspaceService";
import { CHAT_AUTO_MEMORY_ENV, CHAT_AUTO_MEMORY_LIMITS } from "@/lib/projectWorkspaceCore";

/**
 * Automatic memory from ordinary (non-project) Chat conversations, against a
 * real database: which conversations are queued, which never are, what the
 * commit refuses after the fact, and that deleting or locking the source
 * still takes the derived memory with it. No provider is contacted: the run is
 * created and the worker is replaced by a stub.
 */

const reset = () =>
    prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "MemoryEvidence",
      "MemoryItem",
      "MemoryExtractionProviderCall",
      "MemoryExtractionChunk",
      "MemoryExtractionCreditReservation",
      "MemoryExtractionRun",
      "UserMemorySettings",
      "Message",
      "Conversation",
      "ConversationProject",
      "AppSetting"
    RESTART IDENTITY CASCADE
  `);

beforeEach(reset);
after(async () => {
    await reset();
    await prisma.$disconnect();
});

const REGISTER: readonly MemoryExtractionEvalEntry[] = [
    {
        extractionModelId: "gpt-5-6-luna",
        promptVersion: MEMORY_EXTRACTION_PROMPT_VERSION,
        status: "approved",
        owner: "@qa",
        registeredAt: "2026-10-24",
        evalBudget: null,
        evaluation: null,
        ownerLaunch: { approver: "@qa", approvedAt: "2026-10-24", decisionRef: "test fixture", knownLimitations: "test fixture" },
    },
];

const ON = { [CHAT_AUTO_MEMORY_ENV]: "true" };

const setFeatureFlag = (value: boolean) =>
    prisma.appSetting.upsert({
        where: { key: MEMORY_EXTRACTION_FLAG_KEY },
        create: { key: MEMORY_EXTRACTION_FLAG_KEY, value: String(value) },
        update: { value: String(value) },
    });

const user = () => prisma.user.create({ data: { email: `chat-auto-memory-${randomUUID()}@example.test` } });

const conversation = (userId: string, data: Record<string, unknown> = {}) =>
    prisma.conversation.create({
        data: { userId, title: "chat", selectedModels: JSON.stringify(["gpt-test"]), productKey: "chat", ...data } as never,
    });

/** user, assistant, user: two new user messages, oldest first. */
const exchange = async (conversationId: string, userTurns = 2) => {
    const base = Date.now() - 6 * 60 * 60 * 1000;
    const ids: string[] = [];
    let tick = 0;
    for (let turn = 0; turn < userTurns; turn += 1) {
        const said = await prisma.message.create({
            data: { conversationId, role: "user", content: `I always want formal Korean answers (${turn})`, createdAt: new Date(base + tick++ * 1000) },
        });
        ids.push(said.id);
        await prisma.message.create({
            data: { conversationId, role: "assistant", content: "Understood.", createdAt: new Date(base + tick++ * 1000) },
        });
    }
    return ids;
};

const enqueue = (userId: string, conversationId: string, environment: Record<string, string | undefined> = ON) =>
    enqueueNativeChatExtraction({ userId, conversationId, register: REGISTER, environment, kick: async () => undefined });

const runCount = () => prisma.memoryExtractionRun.count();

test("an ordinary Chat conversation with enough new user messages is queued as a project-less run that costs no user credit", async () => {
    await setFeatureFlag(true);
    const owner = await user();
    const chat = await conversation(owner.id);
    await exchange(chat.id);
    const started = await enqueue(owner.id, chat.id);
    assert.equal(started.outcome, "started");
    const run = await prisma.memoryExtractionRun.findFirstOrThrow({ where: { userId: owner.id } });
    assert.equal(run.sourceKind, "native");
    assert.equal(run.projectId, null);
    assert.equal(run.sourceConversationId, chat.id);
    assert.equal((run.sourceSelection as { projectId: unknown }).projectId, null);
    const reservation = await prisma.memoryExtractionCreditReservation.findFirstOrThrow({ where: { runId: run.id } });
    assert.equal(reservation.reservedCredits, 0, "extraction is Tomverse's own provider cost, not the user's credits");
    // The window is cut once: a second answer right after is not another run.
    assert.deepEqual(await enqueue(owner.id, chat.id), { outcome: "skipped", reason: "snapshot_in_progress" });
    assert.equal(await runCount(), 1);
});

test("nothing is queued, and no run row exists, while a switch is off or for conversations Chat memory never reads", async () => {
    await setFeatureFlag(true);
    const owner = await user();
    const skipped = async (chatId: string, reason: string, environment?: Record<string, string | undefined>) => {
        assert.deepEqual(await enqueue(owner.id, chatId, environment), { outcome: "skipped", reason });
        assert.equal(await runCount(), 0);
    };

    const ordinary = await conversation(owner.id);
    await exchange(ordinary.id);
    await skipped(ordinary.id, "operator_off", {});
    await setFeatureFlag(false);
    await skipped(ordinary.id, "feature_off");
    await setFeatureFlag(true);

    const temporary = await conversation(owner.id, { memoryMode: "off", temporaryExpiresAt: new Date(Date.now() + 3_600_000) });
    await exchange(temporary.id);
    await skipped(temporary.id, "temporary");

    const locked = await conversation(owner.id, { password: "hash" });
    await exchange(locked.id);
    await skipped(locked.id, "locked");

    const memoryOff = await conversation(owner.id, { memoryMode: "off" });
    await exchange(memoryOff.id);
    await skipped(memoryOff.id, "conversation_memory_off");

    const image = await conversation(owner.id, { kind: "image", productKey: "studio" });
    await exchange(image.id);
    await skipped(image.id, "not_chat");

    const review = await conversation(owner.id, { productKey: "review" });
    await exchange(review.id);
    await skipped(review.id, "not_chat_product");

    const folder = await createProject(owner.id, { name: "Folder" });
    const inProject = await conversation(owner.id, { projectId: folder.id });
    await exchange(inProject.id);
    await skipped(inProject.id, "in_project");

    const lone = await conversation(owner.id);
    await exchange(lone.id, 1);
    await skipped(lone.id, "too_little_new");
});

test("the account master switch and a default of memory off stop extraction, whatever the conversation says", async () => {
    await setFeatureFlag(true);
    const owner = await user();
    const chat = await conversation(owner.id);
    await exchange(chat.id);
    await prisma.userMemorySettings.create({ data: { userId: owner.id, masterEnabled: false } });
    assert.deepEqual(await enqueue(owner.id, chat.id), { outcome: "skipped", reason: "memory_off" });
    await prisma.userMemorySettings.update({ where: { userId: owner.id }, data: { masterEnabled: true, defaultConversationMode: "off" } });
    assert.deepEqual(await enqueue(owner.id, chat.id), { outcome: "skipped", reason: "conversation_memory_off" });
    // A conversation that says "on" overrides the account default, but not the master switch.
    await prisma.conversation.update({ where: { id: chat.id }, data: { memoryMode: "on" } });
    assert.equal((await enqueue(owner.id, chat.id)).outcome, "started");
    assert.equal(await runCount(), 1);
});

test("a conversation is cut at most every 15 minutes and an account at most ten times a day", async () => {
    await setFeatureFlag(true);
    const owner = await user();
    const first = await conversation(owner.id);
    await exchange(first.id);
    assert.equal((await enqueue(owner.id, first.id)).outcome, "started");
    await prisma.memoryExtractionRun.updateMany({ where: { userId: owner.id }, data: { status: "completed" } });
    // New messages arrive, but the previous cut was just now.
    const base = Date.now();
    for (let turn = 0; turn < 2; turn += 1) {
        await prisma.message.create({ data: { conversationId: first.id, role: "user", content: `more ${turn}`, createdAt: new Date(base + turn) } });
    }
    assert.deepEqual(await enqueue(owner.id, first.id), { outcome: "skipped", reason: "too_soon" });

    // Fill the day with runs of other conversations.
    for (let index = 0; index < CHAT_AUTO_MEMORY_LIMITS.runsPerDay - 1; index += 1) {
        const other = await conversation(owner.id);
        await prisma.memoryExtractionRun.create({
            data: {
                userId: owner.id, extractionModelId: "test", promptVersion: "test", sourceSelection: { kind: "native" },
                chunkTotal: 1, sourceKind: "native", projectId: null, sourceConversationId: other.id,
                sourceKey: `native:v1:${other.id}:${randomUUID()}`, status: "completed",
            },
        });
    }
    const next = await conversation(owner.id);
    await exchange(next.id);
    assert.deepEqual(await enqueue(owner.id, next.id), { outcome: "skipped", reason: "daily_cap" });
    // Another account is unaffected by this one's cap.
    const other = await user();
    const theirs = await conversation(other.id);
    await exchange(theirs.id);
    assert.equal((await enqueue(other.id, theirs.id)).outcome, "started");
});

// ------------------------------------------------------------ commit

const decision = (statement: string, messageId: string, content: string): ExtractionDecision => ({
    candidate: {
        kind: "preference", polarity: "affirmed", canonicalKey: null, statement, confidence: 0.9, sensitivity: "standard", expiresAt: null,
        evidence: [{
            externalMessageId: messageId, evidenceDigest: nativeMessageDigest(content), role: "user",
            evidenceQuote: content.slice(0, 12), sourceType: "tomverse_message",
        }],
    },
    validation: { disposition: "accepted", sensitivity: "standard", bulkSafe: true, violations: [] },
    outcome: "store_candidate",
}) as unknown as ExtractionDecision;

const chatRun = async (userId: string, conversationId: string, projectId: string | null = null, selectionProject: string | null = null) =>
    prisma.memoryExtractionRun.create({
        data: {
            userId, extractionModelId: "test-model", promptVersion: "test-prompt",
            sourceSelection: {
                kind: "native", projectId: selectionProject, conversationId, afterMessageCreatedAt: null, afterMessageId: null,
                throughMessageCreatedAt: new Date().toISOString(), throughMessageId: "m",
            },
            chunkTotal: 1, sourceKind: "native", projectId, sourceConversationId: conversationId,
            sourceKey: `native:v1:${conversationId}:${randomUUID()}`,
        },
    });

const persist = (userId: string, runId: string, statement: string, messageId: string, content: string) =>
    prisma.$transaction((tx) => persistExtractionChunkDecisions(tx, {
        userId, runId, chunkIndex: 0, extractionModelId: "test-model", promptVersion: "test-prompt",
        decisions: [decision(statement, messageId, content)],
    }));

test("a Chat run stores a personal memory on verified user evidence, and stores nothing once the source can no longer be read", async () => {
    const owner = await user();
    const chat = await conversation(owner.id);
    const content = "Please answer me in formal Korean from now on";
    const said = await prisma.message.create({ data: { conversationId: chat.id, role: "user", content } });
    const run = await chatRun(owner.id, chat.id);
    const stored = await persist(owner.id, run.id, "The user prefers formal Korean answers", said.id, content);
    assert.equal(stored.stored, 1);
    const memory = await prisma.memoryItem.findFirstOrThrow({ where: { userId: owner.id }, include: { evidences: true } });
    assert.equal(memory.projectId, null, "an ordinary Chat memory is personal");
    assert.equal(memory.extractionRunId, run.id);
    assert.equal(memory.evidences[0].sourceType, "tomverse_message");
    assert.equal(memory.evidences[0].tomverseMessageId, said.id);

    // Locked while the provider answered: nothing is stored.
    const second = await conversation(owner.id);
    const secondContent = "My team works in Busan";
    const secondSaid = await prisma.message.create({ data: { conversationId: second.id, role: "user", content: secondContent } });
    const secondRun = await chatRun(owner.id, second.id);
    await prisma.conversation.update({ where: { id: second.id }, data: { password: "hash" } });
    assert.equal((await persist(owner.id, secondRun.id, "The user's team works in Busan", secondSaid.id, secondContent)).stored, 0);

    // Memory turned off for the conversation while the provider answered: nothing is stored.
    const third = await conversation(owner.id);
    const thirdContent = "I am learning Rust this year";
    const thirdSaid = await prisma.message.create({ data: { conversationId: third.id, role: "user", content: thirdContent } });
    const thirdRun = await chatRun(owner.id, third.id);
    await prisma.conversation.update({ where: { id: third.id }, data: { memoryMode: "off" } });
    assert.equal((await persist(owner.id, thirdRun.id, "The user is learning Rust", thirdSaid.id, thirdContent)).stored, 0);

    // Moved into a project while the provider answered: nothing is stored as personal memory.
    const fourth = await conversation(owner.id);
    const fourthContent = "Our launch is in March";
    const fourthSaid = await prisma.message.create({ data: { conversationId: fourth.id, role: "user", content: fourthContent } });
    const fourthRun = await chatRun(owner.id, fourth.id);
    const project = await createProject(owner.id, { name: "Launch", contextEnabled: true });
    await prisma.conversation.update({ where: { id: fourth.id }, data: { projectId: project.id } });
    assert.equal((await persist(owner.id, fourthRun.id, "The launch is in March", fourthSaid.id, fourthContent)).stored, 0);
    assert.equal(await prisma.memoryItem.count({ where: { userId: owner.id } }), 1);
});

test("a run whose project was deleted never becomes a personal-memory run", async () => {
    const owner = await user();
    const project = await createProject(owner.id, { name: "Gone", contextEnabled: true });
    const chat = await conversation(owner.id, { projectId: project.id });
    const content = "We use Postgres for the Gone project";
    const said = await prisma.message.create({ data: { conversationId: chat.id, role: "user", content } });
    // The project column is SET NULL on delete; the selection still names the project.
    const run = await chatRun(owner.id, chat.id, null, project.id);
    assert.equal((await persist(owner.id, run.id, "The Gone project uses Postgres", said.id, content)).stored, 0);
    assert.deepEqual(
        await loadNativeChunkConversation({ userId: owner.id, projectId: null, selection: run.sourceSelection }),
        { conversations: [], contentBytes: 0 }
    );
});

test("a Chat run's window is read back only while the conversation is still eligible", async () => {
    await setFeatureFlag(true);
    const owner = await user();
    const chat = await conversation(owner.id);
    await exchange(chat.id);
    assert.equal((await enqueue(owner.id, chat.id)).outcome, "started");
    const run = await prisma.memoryExtractionRun.findFirstOrThrow({ where: { userId: owner.id } });
    const read = () => loadNativeChunkConversation({ userId: owner.id, projectId: null, selection: run.sourceSelection });
    assert.equal((await read()).conversations.length, 1);
    await prisma.conversation.update({ where: { id: chat.id }, data: { memoryMode: "off" } });
    assert.equal((await read()).conversations.length, 0);
    await prisma.conversation.update({ where: { id: chat.id }, data: { memoryMode: "inherit", password: "hash" } });
    assert.equal((await read()).conversations.length, 0);
});

test("locking or deleting the source conversation takes a memory learned from it out of use", async () => {
    const owner = await user();
    const chat = await conversation(owner.id);
    const content = "I prefer short answers";
    const said = await prisma.message.create({ data: { conversationId: chat.id, role: "user", content } });
    const run = await chatRun(owner.id, chat.id);
    assert.equal((await persist(owner.id, run.id, "The user prefers short answers", said.id, content)).stored, 1);
    const memory = await prisma.memoryItem.findFirstOrThrow({ where: { userId: owner.id } });
    await updateConversationWithProjectGrounds({
        userId: owner.id,
        conversationId: chat.id,
        update: (tx) => tx.conversation.update({ where: { id: chat.id }, data: { password: "hash" } }),
    });
    assert.equal((await prisma.memoryItem.findUniqueOrThrow({ where: { id: memory.id } })).status, "suspended_by_source_lock");
    await updateConversationWithProjectGrounds({
        userId: owner.id,
        conversationId: chat.id,
        update: (tx) => tx.conversation.update({ where: { id: chat.id }, data: { password: null } }),
    });
    assert.equal((await prisma.memoryItem.findUniqueOrThrow({ where: { id: memory.id } })).status, "active");
});

test("save_memory stores a personal, user-grounded memory through the manual service and is offered only where Chat memory may run", async () => {
    await setFeatureFlag(true);
    const owner = await user();
    const chat = await conversation(owner.id);
    assert.equal(await memoryToolAllowed({ userId: owner.id, conversationId: chat.id }), true);

    const part = buildChatMemoryToolPart({
        userId: owner.id,
        conversationId: chat.id,
        userMessages: ["Please remember that I am vegetarian"],
        request: new Request("https://tomverse.app/api/chat"),
        signal: new AbortController().signal,
        rateLimit: async () => undefined,
    });
    const call = (statement: string) =>
        part.tools.save_memory.execute!(
            { memories: [{ kind: "preference", statement, quote: "remember that I am vegetarian", sensitive: false }] },
            { toolCallId: "t", messages: [] }
        ) as Promise<{ status: string }>;
    assert.equal((await call("The user is vegetarian")).status, "saved");
    const memory = await prisma.memoryItem.findFirstOrThrow({ where: { userId: owner.id }, include: { evidences: true } });
    assert.equal(memory.status, "active");
    assert.equal(memory.projectId, null);
    assert.equal(memory.userEdited, true, "a memory the user asked for is theirs: extraction never replaces it");
    assert.equal(memory.evidences[0].sourceType, "manual");
    assert.equal(memory.evidences[0].manualContent, "remember that I am vegetarian");
    // Saving the same sentence again replaces itself rather than failing or duplicating.
    assert.equal((await call("The user is vegetarian")).status, "saved");
    assert.equal(await prisma.memoryItem.count({ where: { userId: owner.id, status: "active" } }), 1);

    const closed = async (data: Record<string, unknown>) => {
        const other = await conversation(owner.id, data);
        return memoryToolAllowed({ userId: owner.id, conversationId: other.id });
    };
    assert.equal(await closed({ password: "hash" }), false);
    assert.equal(await closed({ memoryMode: "off" }), false);
    assert.equal(await closed({ memoryMode: "off", temporaryExpiresAt: new Date(Date.now() + 3_600_000) }), false);
    assert.equal(await closed({ productKey: "review" }), false);
    const folder = await createProject(owner.id, { name: "Folder" });
    assert.equal(await closed({ projectId: folder.id }), false);
    await prisma.userMemorySettings.create({ data: { userId: owner.id, masterEnabled: false } });
    assert.equal(await memoryToolAllowed({ userId: owner.id, conversationId: chat.id }), false);
    await prisma.userMemorySettings.update({ where: { userId: owner.id }, data: { masterEnabled: true } });
    await setFeatureFlag(false);
    assert.equal(await memoryToolAllowed({ userId: owner.id, conversationId: chat.id }), false);
});
