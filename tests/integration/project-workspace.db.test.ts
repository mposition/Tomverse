import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { deleteTomverseAccount } from "@/lib/accountDeletion";
import { retrieveKnowledgeContext } from "@/lib/assistantKnowledgeRetrieval";
import { finalizeKnowledgeUpload, knowledgeUsage } from "@/lib/assistantKnowledgeService";
import { buildChatTurnContext } from "@/lib/chatTurnContext";
import type { ExtractionDecision } from "@/lib/memoryExtractionPipeline";
import { persistExtractionChunkDecisions } from "@/lib/memoryExtractionPersistence";
import { retrieveMemoryContext } from "@/lib/memoryRetrievalService";
import { memoryRetrievalTerms } from "@/lib/memoryRetrievalTerms";
import { createManualMemory, moveMemoryScope } from "@/lib/memoryService";
import { nativeMessageDigest } from "@/lib/nativeMemoryEvidence";
import { prisma } from "@/lib/prisma";
import { enqueueNativeProjectExtraction, loadNativeChunkConversation } from "@/lib/projectMemoryExtraction";
import { readProjectSource, searchProjectSources } from "@/lib/projectSourceAccess";
import {
    applyNativeSourceDeletion,
    createProject,
    deleteProject,
    onConversationLockChanged,
    onConversationProjectChanged,
    resolveConversationProjectScope,
    updateConversationWithProjectGrounds,
    updateProject,
} from "@/lib/projectWorkspaceService";
import { PROJECT_LIMITS, nativeExtractionSourceKey } from "@/lib/projectWorkspaceCore";

/**
 * Project workspace against a real database: scope isolation (A / B /
 * personal), conflict keys per scope, native evidence and its lifecycle
 * (move, lock, delete), explicit scope moves, project deletion, the
 * knowledge owner container, account deletion, and the turn context's
 * identity across a settings change between prepare and send.
 */

const reset = async () => {
    await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ProjectAnswerReceipt",
      "MemoryEvidence",
      "MemoryItem",
      "MemoryExtractionProviderCall",
      "MemoryExtractionChunk",
      "MemoryExtractionCreditReservation",
      "MemoryExtractionRun",
      "UserMemorySettings",
      "AssistantKnowledgeChunk",
      "AssistantKnowledgeCleanup",
      "AssistantKnowledgeFile",
      "Message",
      "Conversation",
      "ConversationProject",
      "AssistantProfile"
    RESTART IDENTITY CASCADE
  `);
};

beforeEach(reset);
after(async () => {
    await reset();
    await prisma.$disconnect();
});

const user = () => prisma.user.create({ data: { email: `project-ws-${randomUUID()}@example.test` } });

const project = async (userId: string, name: string, overrides: Record<string, unknown> = {}) => {
    const created = await createProject(userId, { name, contextEnabled: true, ...overrides });
    return created;
};

const conversation = (userId: string, projectId: string | null, title = "chat") =>
    prisma.conversation.create({
        data: { userId, title, projectId, selectedModels: JSON.stringify(["gpt-test"]), productKey: "chat" },
    });

const message = (conversationId: string, role: "user" | "assistant", content: string, createdAt = new Date()) =>
    prisma.message.create({ data: { conversationId, role, content, createdAt } });

const seedMemory = (userId: string, projectId: string | null, statement: string, extra: Record<string, unknown> = {}) =>
    prisma.memoryItem.create({
        data: {
            userId,
            projectId,
            kind: "project",
            statement,
            status: "active",
            confidence: 1,
            approvedAt: new Date(),
            searchTerms: memoryRetrievalTerms(statement),
            ...extra,
        },
    });

const nativeDecision = (statement: string, messageId: string, content: string): ExtractionDecision => ({
    candidate: {
        kind: "preference",
        polarity: "affirmed",
        canonicalKey: null,
        statement,
        confidence: 0.9,
        sensitivity: "standard",
        expiresAt: null,
        evidence: [{
            externalMessageId: messageId,
            evidenceDigest: nativeMessageDigest(content),
            role: "user",
            evidenceQuote: content.slice(0, 12),
            sourceType: "tomverse_message",
        }],
    },
    validation: { disposition: "accepted", sensitivity: "standard", bulkSafe: true, violations: [] },
    outcome: "store_candidate",
}) as unknown as ExtractionDecision;

const nativeRun = (userId: string, projectId: string, conversationId: string) =>
    prisma.memoryExtractionRun.create({
        data: {
            userId,
            extractionModelId: "test-model",
            promptVersion: "test-prompt",
            sourceSelection: { kind: "native" },
            chunkTotal: 1,
            sourceKind: "native",
            projectId,
            sourceConversationId: conversationId,
            sourceKey: nativeExtractionSourceKey(conversationId, randomUUID()),
        },
    });

// ------------------------------------------------------------ retrieval

test("memory retrieval keeps A, B and personal memories apart, before the candidate limit", async () => {
    const owner = await user();
    const a = await project(owner.id, "Alpha");
    const b = await project(owner.id, "Beta");
    await seedMemory(owner.id, null, "Launch plan personal note about rockets");
    await seedMemory(owner.id, a.id, "Launch date for Alpha rockets is June");
    await seedMemory(owner.id, b.id, "Launch date for Beta rockets is September");
    const ids = async (scope: Parameters<typeof retrieveMemoryContext>[0]["scope"]) =>
        (await retrieveMemoryContext({ userId: owner.id, query: "rockets launch date", scope, semantic: "off" }))
            .selected.map(({ memory }) => memory.statement).sort();
    assert.deepEqual(await ids(undefined), ["Launch plan personal note about rockets"]);
    assert.deepEqual(await ids({ projectId: a.id, includePersonal: false }), ["Launch date for Alpha rockets is June"]);
    assert.deepEqual(await ids({ projectId: a.id, includePersonal: true }),
        ["Launch date for Alpha rockets is June", "Launch plan personal note about rockets"]);
    assert.ok(!(await ids({ projectId: a.id, includePersonal: true })).some((s) => s.includes("Beta")));
});

test("the same conflict key in two projects and in personal memory does not conflict", async () => {
    const owner = await user();
    const a = await project(owner.id, "Alpha");
    const b = await project(owner.id, "Beta");
    const input = { userId: owner.id, kind: "project", statement: "The release date is June 1", groundsText: "I said so" };
    await createManualMemory({ ...input, projectId: a.id });
    await createManualMemory({ ...input, projectId: b.id });
    await createManualMemory({ ...input });
    await assert.rejects(createManualMemory({ ...input, projectId: a.id }), (error: { code?: string }) => error.code === "MEMORY_ITEM_CONFLICT");
    assert.equal(await prisma.memoryItem.count({ where: { userId: owner.id, status: "active" } }), 3);
});

// -------------------------------------------------- native extraction

test("native extraction stores project memory on verified user evidence and never touches other scopes", async () => {
    const owner = await user();
    const a = await project(owner.id, "Alpha", { autoMemoryEnabled: true });
    const chat = await conversation(owner.id, a.id);
    const content = "Please always answer me in formal Korean for this project";
    const said = await message(chat.id, "user", content);
    await seedMemory(owner.id, null, "Answer in formal Korean", { kind: "preference" });
    const run = await nativeRun(owner.id, a.id, chat.id);
    const result = await prisma.$transaction((tx) => persistExtractionChunkDecisions(tx, {
        userId: owner.id, runId: run.id, chunkIndex: 0, extractionModelId: "test-model", promptVersion: "test-prompt",
        decisions: [nativeDecision("Answer in formal Korean", said.id, content)],
    }));
    assert.equal(result.stored, 1);
    const stored = await prisma.memoryItem.findFirstOrThrow({ where: { userId: owner.id, projectId: a.id }, include: { evidences: true } });
    assert.equal(stored.evidences[0].sourceType, "tomverse_message");
    assert.equal(stored.evidences[0].tomverseMessageId, said.id);
    // The identical personal memory is untouched (not superseded).
    assert.equal(await prisma.memoryItem.count({ where: { userId: owner.id, projectId: null, status: "active" } }), 1);
});

test("native extraction stores nothing when the source left the project, was edited, or auto memory was turned off", async () => {
    const owner = await user();
    const a = await project(owner.id, "Alpha", { autoMemoryEnabled: true });
    const b = await project(owner.id, "Beta", { autoMemoryEnabled: true });
    const chat = await conversation(owner.id, a.id);
    const content = "My team uses Postgres for this product";
    const said = await message(chat.id, "user", content);
    const run = await nativeRun(owner.id, a.id, chat.id);
    const persist = () => prisma.$transaction((tx) => persistExtractionChunkDecisions(tx, {
        userId: owner.id, runId: run.id, chunkIndex: 0, extractionModelId: "test-model", promptVersion: "test-prompt",
        decisions: [nativeDecision("The team uses Postgres", said.id, content)],
    }));
    await prisma.conversation.update({ where: { id: chat.id }, data: { projectId: b.id } });
    assert.equal((await persist()).unsourced, 1);
    await prisma.conversation.update({ where: { id: chat.id }, data: { projectId: a.id } });
    await prisma.message.update({ where: { id: said.id }, data: { content: "edited" } });
    assert.equal((await persist()).unsourced, 1);
    await prisma.message.update({ where: { id: said.id }, data: { content } });
    const current = await prisma.conversationProject.findUniqueOrThrow({ where: { id: a.id } });
    await updateProject(owner.id, a.id, { expectedRevision: current.revision, autoMemoryEnabled: false });
    assert.equal((await persist()).stored, 0);
    assert.equal(await prisma.memoryItem.count({ where: { userId: owner.id } }), 0);
});

test("the native window reader re-checks project membership and lock and keeps the cursor window", async () => {
    const owner = await user();
    const a = await project(owner.id, "Alpha");
    const chat = await conversation(owner.id, a.id);
    const t0 = new Date("2026-11-20T00:00:00Z");
    const m1 = await message(chat.id, "user", "first", t0);
    const m2 = await message(chat.id, "assistant", "second", new Date(t0.getTime() + 1000));
    const m3 = await message(chat.id, "user", "third", new Date(t0.getTime() + 2000));
    const selection = {
        kind: "native", projectId: a.id, conversationId: chat.id,
        afterMessageCreatedAt: m1.createdAt.toISOString(), afterMessageId: m1.id,
        throughMessageCreatedAt: m3.createdAt.toISOString(), throughMessageId: m3.id,
    };
    const read = await loadNativeChunkConversation({ userId: owner.id, projectId: a.id, selection });
    assert.deepEqual(read.conversations[0].messages.map((m) => m.externalMessageId), [m2.id, m3.id]);
    assert.ok(read.conversations[0].messages.every((m) => m.sourceType === "tomverse_message"));
    await prisma.conversation.update({ where: { id: chat.id }, data: { password: "locked-hash" } });
    assert.equal((await loadNativeChunkConversation({ userId: owner.id, projectId: a.id, selection })).conversations.length, 0);
});

test("enqueue is a recorded skip while the operator switch is off, and never runs for a folder project", async () => {
    const owner = await user();
    const a = await project(owner.id, "Alpha", { autoMemoryEnabled: true });
    const chat = await conversation(owner.id, a.id);
    await message(chat.id, "user", "We decided to ship weekly");
    assert.deepEqual(await enqueueNativeProjectExtraction({ userId: owner.id, conversationId: chat.id, environment: {} }),
        { outcome: "skipped", reason: "operator_off" });
    const folder = await createProject(owner.id, { name: "Folder" });
    const folderChat = await conversation(owner.id, folder.id);
    await message(folderChat.id, "user", "Something");
    const skipped = await enqueueNativeProjectExtraction({
        userId: owner.id, conversationId: folderChat.id, environment: { TOMVERSE_PROJECT_AUTO_MEMORY_ENABLED: "true" },
    });
    assert.equal(skipped.outcome, "skipped");
    assert.equal(await prisma.memoryExtractionRun.count(), 0);
});

// ------------------------------------------------ source lifecycle

test("moving a conversation suspends memories grounded only in it, and moving it back restores them", async () => {
    const owner = await user();
    const a = await project(owner.id, "Alpha");
    const b = await project(owner.id, "Beta");
    const chat = await conversation(owner.id, a.id);
    const said = await message(chat.id, "user", "We picked Rust");
    const memory = await seedMemory(owner.id, a.id, "The project uses Rust", {
        evidences: { create: { userId: owner.id, sourceType: "tomverse_message", tomverseMessageId: said.id, evidenceDigest: nativeMessageDigest("We picked Rust") } },
    });
    await prisma.conversation.update({ where: { id: chat.id }, data: { projectId: b.id } });
    await onConversationProjectChanged({ userId: owner.id, conversationId: chat.id, fromProjectId: a.id, toProjectId: b.id });
    let row = await prisma.memoryItem.findUniqueOrThrow({ where: { id: memory.id } });
    assert.equal(row.status, "suspended_by_source_delete");
    assert.equal(row.projectId, a.id, "a move never relocates the memory");
    await prisma.conversation.update({ where: { id: chat.id }, data: { projectId: a.id } });
    await onConversationProjectChanged({ userId: owner.id, conversationId: chat.id, fromProjectId: b.id, toProjectId: a.id });
    row = await prisma.memoryItem.findUniqueOrThrow({ where: { id: memory.id } });
    assert.equal(row.status, "active");
    await prisma.conversation.update({ where: { id: chat.id }, data: { password: "hash" } });
    await onConversationLockChanged({ userId: owner.id, conversationId: chat.id, projectId: a.id });
    row = await prisma.memoryItem.findUniqueOrThrow({ where: { id: memory.id } });
    assert.equal(row.status, "suspended_by_source_lock");
});

test("deleting a source conversation deletes derived project memories and suspends user-edited ones", async () => {
    const owner = await user();
    const a = await project(owner.id, "Alpha");
    const chat = await conversation(owner.id, a.id);
    const said = await message(chat.id, "user", "Budget is 10k");
    const evidence = { create: { userId: owner.id, sourceType: "tomverse_message", tomverseMessageId: said.id, evidenceDigest: nativeMessageDigest("Budget is 10k") } };
    const derived = await seedMemory(owner.id, a.id, "Budget is 10k", { evidences: evidence });
    const edited = await seedMemory(owner.id, a.id, "Budget is ten thousand", { evidences: evidence, userEdited: true });
    await prisma.$transaction(async (tx) => {
        await applyNativeSourceDeletion(tx, owner.id, [chat.id]);
        await tx.conversation.delete({ where: { id: chat.id } });
    });
    assert.equal(await prisma.memoryItem.count({ where: { id: derived.id } }), 0);
    assert.equal((await prisma.memoryItem.findUniqueOrThrow({ where: { id: edited.id } })).status, "suspended_by_source_delete");
});

test("explicit scope moves keep the memory's grounds and refuse a conflicting target", async () => {
    const owner = await user();
    const a = await project(owner.id, "Alpha");
    const id = await createManualMemory({ userId: owner.id, kind: "project", statement: "Use semver", groundsText: "mine" });
    const before = await prisma.memoryItem.findUniqueOrThrow({ where: { id } });
    await moveMemoryScope({ userId: owner.id, memoryId: id, expectedRevision: before.revision, targetProjectId: a.id });
    const moved = await prisma.memoryItem.findUniqueOrThrow({ where: { id }, include: { evidences: true } });
    assert.equal(moved.projectId, a.id);
    assert.equal(moved.evidences.length, 1);
    assert.equal(moved.status, "active");
    await assert.rejects(moveMemoryScope({ userId: owner.id, memoryId: id, expectedRevision: before.revision, targetProjectId: null }),
        (error: { code?: string }) => error.code === "MEMORY_ITEM_STATE");
    await createManualMemory({ userId: owner.id, kind: "project", statement: "Use semver", groundsText: "again" });
    await assert.rejects(moveMemoryScope({ userId: owner.id, memoryId: id, expectedRevision: moved.revision, targetProjectId: null }),
        (error: { code?: string }) => error.code === "MEMORY_ITEM_CONFLICT");
});

// -------------------------------------------------------- deletion

test("a bare delete of a project holding materials or memories is refused; a confirmed one keeps chats and never personalises memories", async () => {
    const owner = await user();
    const a = await project(owner.id, "Alpha");
    const chat = await conversation(owner.id, a.id);
    await seedMemory(owner.id, a.id, "Alpha only fact");
    await prisma.assistantKnowledgeFile.create({
        data: { userId: owner.id, projectId: a.id, name: "spec.md", mime: "text/markdown", bytes: 10, digest: "d", r2Key: `assistant-knowledge/${randomUUID()}` },
    });
    await assert.rejects(deleteProject(owner.id, a.id), (error: { code?: string }) => error.code === "PROJECT_DELETE_CONFIRMATION_REQUIRED");
    await assert.rejects(prisma.conversationProject.delete({ where: { id: a.id } }), "the NO ACTION FK refuses an unconfirmed raw delete");
    const row = await prisma.conversationProject.findUniqueOrThrow({ where: { id: a.id } });
    await assert.rejects(deleteProject(owner.id, a.id, { revision: row.revision, materials: 1, memories: 0 }),
        (error: { code?: string }) => error.code === "PROJECT_DELETE_STALE");
    const result = await deleteProject(owner.id, a.id, { revision: row.revision, materials: 1, memories: 1 });
    assert.equal(result.deletedMaterials, 1);
    assert.equal(result.deletedMemories, 1);
    assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: chat.id } })).projectId, null);
    assert.equal(await prisma.memoryItem.count({ where: { userId: owner.id } }), 0, "no project memory became personal");
    assert.equal(await prisma.assistantKnowledgeCleanup.count({ where: { reason: "project_deleted" } }), 1);
});

test("account deletion removes project files after enqueueing their objects", async () => {
    const owner = await user();
    const a = await project(owner.id, "Alpha");
    await seedMemory(owner.id, a.id, "fact");
    await prisma.assistantKnowledgeFile.create({
        data: { userId: owner.id, projectId: a.id, name: "spec.md", mime: "text/markdown", bytes: 10, digest: "d", r2Key: `assistant-knowledge/${randomUUID()}` },
    });
    const result = await deleteTomverseAccount(owner.id, { cancelSubscription: false });
    assert.equal(result.deleted, true);
    assert.equal(await prisma.conversationProject.count({ where: { userId: owner.id } }), 0);
    assert.equal(await prisma.assistantKnowledgeFile.count({ where: { userId: owner.id } }), 0);
    assert.equal(await prisma.assistantKnowledgeCleanup.count({ where: { reason: "account_deleted" } }), 1);
});

// ------------------------------------------------------- materials

test("knowledge files have exactly one container, retry keys are per project, and quota is account-wide", async () => {
    const owner = await user();
    const a = await project(owner.id, "Alpha");
    const b = await project(owner.id, "Beta");
    const profile = await prisma.assistantProfile.create({ data: { userId: owner.id, name: "Helper" } as never });
    const base = { userId: owner.id, name: "f.md", mime: "text/markdown", bytes: 10, digest: "d" };
    await assert.rejects(prisma.assistantKnowledgeFile.create({ data: { ...base, r2Key: `assistant-knowledge/${randomUUID()}` } }));
    await assert.rejects(prisma.assistantKnowledgeFile.create({ data: { ...base, profileId: profile.id, projectId: a.id, r2Key: `assistant-knowledge/${randomUUID()}` } }));
    const key = `assistant-knowledge/${randomUUID()}`;
    await prisma.assistantKnowledgeFile.create({ data: { ...base, projectId: a.id, r2Key: key, sourceKind: "note", requestKey: "same" } });
    await prisma.assistantKnowledgeFile.create({ data: { ...base, projectId: b.id, r2Key: `assistant-knowledge/${randomUUID()}`, sourceKind: "note", requestKey: "same" } });
    await assert.rejects(prisma.assistantKnowledgeFile.create({ data: { ...base, projectId: a.id, r2Key: `assistant-knowledge/${randomUUID()}`, sourceKind: "note", requestKey: "same" } }));
    await prisma.assistantKnowledgeFile.create({ data: { ...base, profileId: profile.id, r2Key: `assistant-knowledge/${randomUUID()}` } });
    const usage = await knowledgeUsage(owner.id, { kind: "project", projectId: a.id });
    assert.equal(usage.filesInProfile, 1);
    assert.equal(usage.filesInAccount, 3, "profile and project files share one account budget");
    // The same upload key finalised into another container is refused before any storage read.
    await assert.rejects(
        finalizeKnowledgeUpload({ userId: owner.id, container: { kind: "project", projectId: b.id }, uploadKey: key, filename: "f.md", mime: "text/markdown" }),
        (error: { code?: string }) => error.code === "ASSISTANT_KNOWLEDGE_KEY_OTHER_CONTAINER"
    );
});

test("knowledge retrieval with a project container never reads another container's file", async () => {
    const owner = await user();
    const a = await project(owner.id, "Alpha");
    const b = await project(owner.id, "Beta");
    const file = await prisma.assistantKnowledgeFile.create({
        data: { userId: owner.id, projectId: b.id, name: "beta.md", mime: "text/markdown", bytes: 10, digest: "d", r2Key: `assistant-knowledge/${randomUUID()}`, processingStatus: "ready", chunkCount: 1 },
    });
    await prisma.assistantKnowledgeChunk.create({
        data: { fileId: file.id, userId: owner.id, ordinal: 0, content: "Beta pricing is 20 dollars", searchTerms: memoryRetrievalTerms("Beta pricing is 20 dollars") },
    });
    const forged = await retrieveKnowledgeContext({ userId: owner.id, fileIds: [file.id], query: "pricing dollars", container: { projectId: a.id }, semantic: "off" });
    assert.equal(forged.chunks.length, 0);
    const own = await retrieveKnowledgeContext({ userId: owner.id, fileIds: [file.id], query: "pricing dollars", container: { projectId: b.id }, semantic: "off" });
    assert.equal(own.chunks.length, 1);
});

// --------------------------------------------- other conversations

test("project search is scoped before limits and never returns another project's or a locked conversation", async () => {
    const owner = await user();
    const a = await project(owner.id, "Alpha");
    const b = await project(owner.id, "Beta");
    const current = await conversation(owner.id, a.id, "current");
    const other = await conversation(owner.id, a.id, "decision log");
    const locked = await conversation(owner.id, a.id, "locked");
    const outside = await conversation(owner.id, b.id, "beta");
    await message(other.id, "user", "Correction: the deadline is now Friday");
    await message(current.id, "user", "When is the deadline?");
    await message(locked.id, "user", "deadline secret");
    await message(outside.id, "user", "deadline for beta is Monday");
    await prisma.conversation.update({ where: { id: locked.id }, data: { password: "hash" } });
    const answer = await searchProjectSources({ userId: owner.id, projectId: a.id, query: "deadline", excludeConversationId: current.id });
    assert.deepEqual(answer.hits.map((hit) => hit.title), ["decision log"]);
    const hit = answer.hits[0];
    const read = await readProjectSource({ userId: owner.id, projectId: a.id, location: hit.location });
    assert.equal(read.status, "ok");
    // A read after the source moved away is refused, not served from the earlier hit.
    await prisma.conversation.update({ where: { id: other.id }, data: { projectId: b.id } });
    const after = await readProjectSource({ userId: owner.id, projectId: a.id, location: hit.location });
    assert.deepEqual(after, { status: "unavailable", reason: "outside_project" });
});

// ------------------------------------------------- turn identity

test("project context joins the turn's system prompt and identity; a settings change between prepare and send is stale", async () => {
    const owner = await user();
    const a = await project(owner.id, "Alpha", { instructions: "Write release notes in a dry tone." });
    const chat = await conversation(owner.id, a.id);
    const scope = await resolveConversationProjectScope(owner.id, chat.id);
    const prepared = await buildChatTurnContext({ userId: owner.id, query: "draft notes", project: scope, semantic: "off" });
    assert.match(prepared.systemPrompt ?? "", /dry tone/);
    assert.ok(prepared.projectTokens > 0);
    const plain = await buildChatTurnContext({ userId: owner.id, query: "draft notes", project: null, semantic: "off" });
    assert.notEqual(prepared.fingerprint, plain.fingerprint);
    await updateProject(owner.id, a.id, { expectedRevision: scope!.revision, instructions: "Write release notes cheerfully." });
    const atSend = await buildChatTurnContext({
        userId: owner.id, query: "draft notes", project: await resolveConversationProjectScope(owner.id, chat.id), semantic: "off",
    });
    assert.notEqual(atSend.fingerprint, prepared.fingerprint, "a prepared bundle goes stale");
    const folder = await createProject(owner.id, { name: "Folder", instructions: "ignored" });
    const folderChat = await conversation(owner.id, folder.id);
    const folderTurn = await buildChatTurnContext({
        userId: owner.id, query: "draft notes", project: await resolveConversationProjectScope(owner.id, folderChat.id), semantic: "off",
    });
    assert.equal(folderTurn.fingerprint, plain.fingerprint, "context off is exactly the pre-project context");
    assert.doesNotMatch(folderTurn.systemPrompt ?? "", /ignored/);
});

// ------------------------------------------- retrieval quality (offline)

test("retrieval quality fixture: corrections are found next to the original, other projects never leak, a miss is reported as empty", async () => {
    const owner = await user();
    const a = await project(owner.id, "Alpha");
    const b = await project(owner.id, "Beta");
    const current = await conversation(owner.id, a.id, "current");
    const early = await conversation(owner.id, a.id, "kickoff");
    const later = await conversation(owner.id, a.id, "follow-up");
    const beta = await conversation(owner.id, b.id, "beta kickoff");
    await message(early.id, "user", "The launch budget is 10k", new Date("2026-11-01T00:00:00Z"));
    await message(later.id, "user", "Correction: the launch budget is now 15k", new Date("2026-11-10T00:00:00Z"));
    await message(beta.id, "user", "The launch budget is 99k");
    await prisma.conversation.update({ where: { id: later.id }, data: { updatedAt: new Date("2026-11-10T00:00:00Z") } });
    await prisma.conversation.update({ where: { id: early.id }, data: { updatedAt: new Date("2026-11-01T00:00:00Z") } });
    const answer = await searchProjectSources({ userId: owner.id, projectId: a.id, query: "launch budget", excludeConversationId: current.id });
    const titles = answer.hits.map((hit) => hit.title);
    assert.deepEqual(new Set(titles), new Set(["kickoff", "follow-up"]));
    assert.ok(!answer.hits.some((hit) => hit.snippet.includes("99k")), "another project's same-word fact never appears");
    assert.equal(titles[0], "follow-up", "the newer conversation (the correction) ranks first");
    // Lexical search does not translate: a Korean query for English text finds
    // nothing, and says so rather than implying the project was checked.
    const crossLanguage = await searchProjectSources({ userId: owner.id, projectId: a.id, query: "예산", excludeConversationId: current.id });
    assert.equal(crossLanguage.status, "empty");
    assert.equal(crossLanguage.hits.length, 0);
});

// --------------------------------------------- review r-20261122-165507

test("a material created while a deletion is being confirmed is never deleted unconfirmed", async () => {
    const owner = await user();
    const a = await project(owner.id, "Alpha");
    await seedMemory(owner.id, a.id, "fact");
    const before = await prisma.conversationProject.findUniqueOrThrow({ where: { id: a.id } });
    let releaseInsert!: () => void;
    const insertHeld = new Promise<void>((resolve) => { releaseInsert = resolve; });
    let inserted!: () => void;
    const insertDone = new Promise<void>((resolve) => { inserted = resolve; });
    // A material insert that has taken its FK lock on the project and not committed yet.
    const writer = prisma.$transaction(async (tx) => {
        await tx.assistantKnowledgeFile.create({
            data: { userId: owner.id, projectId: a.id, name: "late.md", mime: "text/markdown", bytes: 10, digest: "d", r2Key: `assistant-knowledge/${randomUUID()}` },
        });
        inserted();
        await insertHeld;
    }, { timeout: 20_000 });
    await insertDone;
    const deletion = deleteProject(owner.id, a.id, { revision: before.revision, materials: 0, memories: 1 });
    setTimeout(releaseInsert, 300);
    await writer;
    await assert.rejects(deletion, (error: { code?: string; details?: { materials?: number } }) =>
        error.code === "PROJECT_DELETE_STALE" && error.details?.materials === 1);
    assert.equal(await prisma.assistantKnowledgeFile.count({ where: { projectId: a.id } }), 1);
    assert.equal(await prisma.conversationProject.count({ where: { id: a.id } }), 1);
});

test("a move and the re-decision of its memories commit together", async () => {
    const owner = await user();
    const a = await project(owner.id, "Alpha");
    const b = await project(owner.id, "Beta");
    const chat = await conversation(owner.id, a.id);
    const said = await message(chat.id, "user", "We chose Kotlin");
    const memory = await seedMemory(owner.id, a.id, "The app uses Kotlin", {
        evidences: { create: { userId: owner.id, sourceType: "tomverse_message", tomverseMessageId: said.id, evidenceDigest: nativeMessageDigest("We chose Kotlin") } },
    });
    // A failure after the move rolls back the move too: nothing is left half-applied.
    await assert.rejects(updateConversationWithProjectGrounds({
        userId: owner.id, conversationId: chat.id,
        update: async (tx) => {
            const row = await tx.conversation.update({ where: { id: chat.id }, data: { projectId: b.id } });
            throw Object.assign(new Error("boom"), { row });
        },
    }));
    assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: chat.id } })).projectId, a.id);
    const moved = await updateConversationWithProjectGrounds({
        userId: owner.id, conversationId: chat.id,
        update: (tx) => tx.conversation.update({ where: { id: chat.id }, data: { projectId: b.id } }),
    });
    assert.equal(moved.projectId, b.id);
    assert.equal((await prisma.memoryItem.findUniqueOrThrow({ where: { id: memory.id } })).status, "suspended_by_source_delete");
});


// --------------------------------------------- review r-20261122-170209

test("locking a source suspends a memory the user moved out of its project; a later move does not re-judge it", async () => {
    const owner = await user();
    const a = await project(owner.id, "Alpha");
    const b = await project(owner.id, "Beta");
    const chat = await conversation(owner.id, a.id);
    const said = await message(chat.id, "user", "I prefer short answers");
    const memory = await seedMemory(owner.id, a.id, "Prefers short answers", {
        kind: "preference",
        evidences: { create: { userId: owner.id, sourceType: "tomverse_message", tomverseMessageId: said.id, evidenceDigest: nativeMessageDigest("I prefer short answers") } },
    });
    await moveMemoryScope({ userId: owner.id, memoryId: memory.id, expectedRevision: memory.revision, targetProjectId: null });
    // An explicit move to personal is not undone by moving the conversation.
    await updateConversationWithProjectGrounds({
        userId: owner.id, conversationId: chat.id,
        update: (tx) => tx.conversation.update({ where: { id: chat.id }, data: { projectId: b.id } }),
    });
    assert.equal((await prisma.memoryItem.findUniqueOrThrow({ where: { id: memory.id } })).status, "active");
    // A lock reaches it wherever it lives now.
    await updateConversationWithProjectGrounds({
        userId: owner.id, conversationId: chat.id,
        update: (tx) => tx.conversation.update({ where: { id: chat.id }, data: { password: "hash" } }),
    });
    assert.equal((await prisma.memoryItem.findUniqueOrThrow({ where: { id: memory.id } })).status, "suspended_by_source_lock");
});

test("concurrent moves each re-judge the project they really left", async () => {
    const owner = await user();
    const a = await project(owner.id, "Alpha");
    const b = await project(owner.id, "Beta");
    const c = await project(owner.id, "Gamma");
    const chat = await conversation(owner.id, a.id);
    const said = await message(chat.id, "user", "Deploy on Fridays");
    const evidence = () => ({ create: { userId: owner.id, sourceType: "tomverse_message", tomverseMessageId: said.id, evidenceDigest: nativeMessageDigest("Deploy on Fridays") } });
    const inB = await seedMemory(owner.id, b.id, "Deploys happen on Fridays", { evidences: evidence() });
    const move = (to: string) => updateConversationWithProjectGrounds({
        userId: owner.id, conversationId: chat.id,
        update: (tx) => tx.conversation.update({ where: { id: chat.id }, data: { projectId: to } }),
    });
    await Promise.all([move(b.id), move(c.id)]);
    const final = (await prisma.conversation.findUniqueOrThrow({ where: { id: chat.id } })).projectId;
    const status = (await prisma.memoryItem.findUniqueOrThrow({ where: { id: inB.id } })).status;
    // B's memory is usable only while the conversation really is in B.
    assert.equal(status, final === b.id ? "active" : "suspended_by_source_delete");
});


// --------------------------------------------- review r-20261122-170725

test("a move back to the project read before a concurrent move still re-judges the project it really left", async () => {
    const owner = await user();
    const a = await project(owner.id, "Alpha");
    const b = await project(owner.id, "Beta");
    const chat = await conversation(owner.id, a.id);
    const said = await message(chat.id, "user", "Release notes go out on Mondays");
    const inB = await seedMemory(owner.id, b.id, "Release notes go out on Mondays", {
        evidences: { create: { userId: owner.id, sourceType: "tomverse_message", tomverseMessageId: said.id, evidenceDigest: nativeMessageDigest("Release notes go out on Mondays") } },
    });
    // Another request moved the conversation to B after this request read A.
    await prisma.conversation.update({ where: { id: chat.id }, data: { projectId: b.id } });
    // This request asks for A, which it believes is a no-op; the row lock
    // shows the conversation is in B, so B's memory is re-judged.
    await updateConversationWithProjectGrounds({
        userId: owner.id, conversationId: chat.id,
        update: (tx) => tx.conversation.update({ where: { id: chat.id }, data: { projectId: a.id } }),
    });
    assert.equal((await prisma.memoryItem.findUniqueOrThrow({ where: { id: inB.id } })).status, "suspended_by_source_delete");
});

test("an update that neither moves nor (un)locks the conversation leaves extraction and memories alone", async () => {
    const owner = await user();
    const a = await project(owner.id, "Alpha");
    const chat = await conversation(owner.id, a.id);
    const said = await message(chat.id, "user", "Use metric units");
    const memory = await seedMemory(owner.id, a.id, "Uses metric units", {
        evidences: { create: { userId: owner.id, sourceType: "tomverse_message", tomverseMessageId: said.id, evidenceDigest: nativeMessageDigest("Use metric units") } },
    });
    const before = await prisma.memoryItem.findUniqueOrThrow({ where: { id: memory.id } });
    await updateConversationWithProjectGrounds({
        userId: owner.id, conversationId: chat.id,
        update: (tx) => tx.conversation.update({ where: { id: chat.id }, data: { projectId: a.id } }),
    });
    const after = await prisma.memoryItem.findUniqueOrThrow({ where: { id: memory.id } });
    assert.equal(after.status, "active");
    assert.equal(after.revision, before.revision);
});


// --------------------------------------------- review r-20261122-183413

test("locking and unlocking does not restore a memory whose grounds left its project", async () => {
    const owner = await user();
    const a = await project(owner.id, "Alpha");
    const b = await project(owner.id, "Beta");
    const chat = await conversation(owner.id, a.id);
    const said = await message(chat.id, "user", "Invoices are due in 14 days");
    const inA = await seedMemory(owner.id, a.id, "Invoices are due in 14 days", {
        evidences: { create: { userId: owner.id, sourceType: "tomverse_message", tomverseMessageId: said.id, evidenceDigest: nativeMessageDigest("Invoices are due in 14 days") } },
    });
    const patch = (data: { projectId?: string; password?: string | null }) => updateConversationWithProjectGrounds({
        userId: owner.id, conversationId: chat.id,
        update: (tx) => tx.conversation.update({ where: { id: chat.id }, data }),
    });
    await patch({ projectId: b.id });
    assert.equal((await prisma.memoryItem.findUniqueOrThrow({ where: { id: inA.id } })).status, "suspended_by_source_delete");
    await patch({ password: "hash" });
    await patch({ password: null });
    assert.equal((await prisma.memoryItem.findUniqueOrThrow({ where: { id: inA.id } })).status, "suspended_by_source_delete");
    // Back in A, it is usable again.
    await patch({ projectId: a.id });
    assert.equal((await prisma.memoryItem.findUniqueOrThrow({ where: { id: inA.id } })).status, "active");
});

test("a memory locked in its project and then moved out while locked is not restored by the unlock", async () => {
    const owner = await user();
    const a = await project(owner.id, "Alpha");
    const b = await project(owner.id, "Beta");
    const chat = await conversation(owner.id, a.id);
    const said = await message(chat.id, "user", "Standup is at nine");
    const inA = await seedMemory(owner.id, a.id, "Standup is at nine", {
        evidences: { create: { userId: owner.id, sourceType: "tomverse_message", tomverseMessageId: said.id, evidenceDigest: nativeMessageDigest("Standup is at nine") } },
    });
    const patch = (data: { projectId?: string; password?: string | null }) => updateConversationWithProjectGrounds({
        userId: owner.id, conversationId: chat.id,
        update: (tx) => tx.conversation.update({ where: { id: chat.id }, data }),
    });
    await patch({ password: "hash" });
    assert.equal((await prisma.memoryItem.findUniqueOrThrow({ where: { id: inA.id } })).status, "suspended_by_source_lock");
    await patch({ projectId: b.id });
    await patch({ password: null });
    const after = await prisma.memoryItem.findUniqueOrThrow({ where: { id: inA.id } });
    assert.equal(after.status, "suspended_by_source_delete");
});

test("concurrent project creates cannot pass the per-account limit together", async () => {
    const owner = await user();
    for (let i = 0; i < PROJECT_LIMITS.maxProjectsPerAccount - 1; i += 1) await project(owner.id, `Seed ${i}`);
    const results = await Promise.allSettled([
        createProject(owner.id, { name: "Race one" }),
        createProject(owner.id, { name: "Race two" }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(await prisma.conversationProject.count({ where: { userId: owner.id } }), PROJECT_LIMITS.maxProjectsPerAccount);
});
