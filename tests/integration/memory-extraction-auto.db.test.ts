import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { externalContentDigest } from "@/lib/externalImportDigest";
import { MEMORY_EXTRACTION_FLAG_KEY } from "@/lib/memoryAccess";
import {
    AUTO_EXTRACTION_MAX_FAILED_RUNS,
    AUTO_EXTRACTION_RETRY_AFTER_MS,
    startAutomaticMemoryExtraction,
    startAwaitingAutomaticExtractions,
} from "@/lib/memoryExtractionAuto";
import type { MemoryExtractionEvalEntry } from "@/lib/memoryExtractionEvalRegister";
import { MEMORY_EXTRACTION_PROMPT_VERSION } from "@/lib/memoryExtractionPrompt";
import { prisma } from "@/lib/prisma";

/**
 * Automatic extraction (owner decision 2026-10-24) against a real database:
 * which conversations a finished import puts into a free run, and when the
 * dispatcher starts one for an account that could not start it then. No
 * provider is contacted; a run is created and never driven.
 */

const resetData = () =>
    prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "MemoryExtractionCreditReservation",
      "MemoryExtractionChunk",
      "MemoryExtractionRun",
      "UserMemorySettings",
      "ExternalMessage",
      "ExternalConversation",
      "ExternalImport",
      "AppSetting",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(resetData);
after(async () => {
    await resetData();
    await prisma.$disconnect();
});

const launch = (promptVersion: string): MemoryExtractionEvalEntry => ({
    extractionModelId: "gpt-5-6-luna",
    promptVersion,
    status: "approved",
    owner: "@qa",
    registeredAt: "2026-10-24",
    evalBudget: null,
    evaluation: null,
    ownerLaunch: {
        approver: "@qa",
        approvedAt: "2026-10-24",
        expiresAt: "2099-01-01",
        decisionRef: "test fixture",
        knownLimitations: "test fixture",
    },
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
        ownerLaunch: {
            approver: "@qa",
            approvedAt: "2026-10-24",
            expiresAt: "2099-01-01",
            decisionRef: "test fixture",
            knownLimitations: "test fixture",
        },
    },
];

const setFlag = (value: boolean) =>
    prisma.appSetting.upsert({
        where: { key: MEMORY_EXTRACTION_FLAG_KEY },
        create: { key: MEMORY_EXTRACTION_FLAG_KEY, value: String(value) },
        update: { value: String(value) },
    });

const createUser = () =>
    prisma.user.create({
        data: { email: `auto-extraction-${randomUUID()}@example.test` },
    });

const seedConversations = async (
    userId: string,
    count: number,
    overrides: { password?: string; finalized?: boolean } = {}
) => {
    const importRow = await prisma.externalImport.create({
        data: {
            userId,
            provider: "chatgpt",
            status: "completed",
            parserVersion: "test-1",
            digestVersion: 1,
        },
    });
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
        const content = `auto extraction body ${index}`;
        const conversation = await prisma.externalConversation.create({
            data: {
                userId,
                importId: importRow.id,
                provider: "chatgpt",
                externalStableId: randomUUID().replaceAll("-", ""),
                title: `auto fixture ${index}`,
                conversationDigest: randomUUID().replaceAll("-", "").repeat(2),
                digestVersion: 1,
                messageCount: 1,
                contentBytes: BigInt(content.length),
                finalized: overrides.finalized ?? true,
                password: overrides.password ?? null,
            },
        });
        await prisma.externalMessage.create({
            data: {
                userId,
                externalConversationId: conversation.id,
                externalStableId: randomUUID().replaceAll("-", ""),
                role: "user",
                content,
                contentDigest: externalContentDigest(content),
                digestVersion: 1,
                ordinal: 0,
            },
        });
        ids.push(conversation.id);
    }
    return ids;
};

const start = (userId: string) =>
    startAutomaticMemoryExtraction(userId, { register: REGISTER });

const selectionOf = async (runId: string) =>
    (
        (await prisma.memoryExtractionRun.findUniqueOrThrow({
            where: { id: runId },
        })).sourceSelection as string[]
    ).slice().sort();

test("a finished import starts a free run over its unlocked conversations", async () => {
    await setFlag(true);
    const user = await createUser();
    const ids = await seedConversations(user.id, 2);
    await seedConversations(user.id, 1, { password: "locked-hash" });
    await seedConversations(user.id, 1, { finalized: false });

    const result = await start(user.id);
    assert.ok(result.outcome === "started");
    assert.deepEqual(await selectionOf(result.runId), ids.slice().sort());

    const reservation = await prisma.memoryExtractionCreditReservation.findUniqueOrThrow({
        where: { runId: result.runId },
    });
    assert.equal(reservation.reservedCredits, 0, "free to the account");
});

test("nothing starts while the rollout flag is off or the account turned memory off", async () => {
    const user = await createUser();
    await seedConversations(user.id, 1);

    assert.deepEqual(await start(user.id), { outcome: "skipped", reason: "feature_disabled" });

    await setFlag(true);
    await prisma.userMemorySettings.create({
        data: { userId: user.id, masterEnabled: false },
    });
    assert.deepEqual(await start(user.id), { outcome: "skipped", reason: "memory_off" });
    assert.equal(await prisma.memoryExtractionRun.count(), 0);
});

test("a conversation already covered by a run is not extracted again", async () => {
    await setFlag(true);
    const user = await createUser();
    const first = await seedConversations(user.id, 1);
    const started = await start(user.id);
    assert.ok(started.outcome === "started");

    // An open run blocks a second one; the dispatcher starts it later.
    await seedConversations(user.id, 1);
    const blocked = await start(user.id);
    assert.deepEqual(blocked, {
        outcome: "skipped",
        reason: "MEMORY_EXTRACTION_ALREADY_RUNNING",
    });

    // Cancelled -- or wiped by delete-all -- still counts as covered.
    await prisma.memoryExtractionRun.update({
        where: { id: started.runId },
        data: { status: "cancelled" },
    });
    const next = await start(user.id);
    assert.ok(next.outcome === "started");
    const selection = await selectionOf(next.runId);
    assert.equal(selection.length, 1);
    assert.ok(!selection.includes(first[0]));

    await prisma.memoryExtractionRun.update({
        where: { id: next.runId },
        data: { status: "completed" },
    });
    assert.deepEqual(await start(user.id), {
        outcome: "skipped",
        reason: "nothing_to_extract",
    });
});

test("a failed run is retried after a pause, and given up on after repeated failures", async () => {
    await setFlag(true);
    const user = await createUser();
    const [id] = await seedConversations(user.id, 1);
    const failedRun = (createdAt: Date) =>
        prisma.memoryExtractionRun.create({
            data: {
                userId: user.id,
                status: "failed",
                extractionModelId: "gpt-5-6-luna",
                promptVersion: "mem-extract-v1",
                sourceSelection: [id],
                chunkTotal: 1,
                pricingVersion: "test",
                createdAt,
            },
        });

    await failedRun(new Date());
    assert.deepEqual(await start(user.id), {
        outcome: "skipped",
        reason: "nothing_to_extract",
    });

    await prisma.memoryExtractionRun.updateMany({
        data: { createdAt: new Date(Date.now() - AUTO_EXTRACTION_RETRY_AFTER_MS - 1000) },
    });
    const retried = await start(user.id);
    assert.ok(retried.outcome === "started", "an old failure is due a retry");
    await prisma.memoryExtractionRun.delete({ where: { id: retried.runId } });

    for (let index = 1; index < AUTO_EXTRACTION_MAX_FAILED_RUNS; index += 1) {
        await failedRun(new Date(Date.now() - AUTO_EXTRACTION_RETRY_AFTER_MS - 1000));
    }
    assert.deepEqual(await start(user.id), {
        outcome: "skipped",
        reason: "nothing_to_extract",
    });
});

test("the dispatcher starts runs for accounts that are still waiting", async () => {
    await setFlag(true);
    const waiting = await createUser();
    const busy = await createUser();
    await seedConversations(waiting.id, 1);
    await seedConversations(busy.id, 1);
    const open = await start(busy.id);
    assert.ok(open.outcome === "started");
    await seedConversations(busy.id, 1);

    const started = await startAwaitingAutomaticExtractions({ register: REGISTER });
    assert.equal(started, 1, "the account with an open run finishes it first");
    assert.equal(
        await prisma.memoryExtractionRun.count({ where: { userId: waiting.id } }),
        1
    );
    assert.equal(
        await prisma.memoryExtractionRun.count({ where: { userId: busy.id } }),
        1
    );
});

test("only a pair for the prompt this build sends is used", async () => {
    // The worker always builds the shipped prompt, so an approved older
    // version would label memories with a prompt that was never sent.
    await setFlag(true);
    const user = await createUser();
    await seedConversations(user.id, 1);
    const older = await startAutomaticMemoryExtraction(user.id, {
        register: [launch("mem-extract-v1")],
    });
    assert.deepEqual(older, { outcome: "skipped", reason: "no_approved_pair" });

    const current = await startAutomaticMemoryExtraction(user.id, {
        register: [launch("mem-extract-v1"), launch(MEMORY_EXTRACTION_PROMPT_VERSION)],
    });
    assert.ok(current.outcome === "started");
    const run = await prisma.memoryExtractionRun.findUniqueOrThrow({
        where: { id: current.runId },
    });
    assert.equal(run.promptVersion, MEMORY_EXTRACTION_PROMPT_VERSION);
});

test("accounts that cannot start never hold up the ones that can", async () => {
    await setFlag(true);
    const off = await createUser();
    const restricted = await createUser();
    const ready = await createUser();
    // The two that cannot start have the newest imports, and a pass that
    // only had room for them would otherwise start nothing.
    await seedConversations(ready.id, 1);
    await seedConversations(off.id, 3);
    await seedConversations(restricted.id, 3);
    await prisma.userMemorySettings.create({
        data: { userId: off.id, masterEnabled: false },
    });
    await prisma.user.update({
        where: { id: restricted.id },
        data: { accountStatus: "pending_deletion" },
    });

    const started = await startAwaitingAutomaticExtractions({
        register: REGISTER,
        maxAccounts: 1,
    });
    assert.equal(started, 1);
    assert.equal(
        await prisma.memoryExtractionRun.count({ where: { userId: ready.id } }),
        1
    );
});

test("a restricted account's refusal is a coded skip, not a thrown error", async () => {
    await setFlag(true);
    const user = await createUser();
    await seedConversations(user.id, 1);
    await prisma.user.update({
        where: { id: user.id },
        data: { accountStatus: "pending_deletion" },
    });
    const result = await start(user.id);
    assert.equal(result.outcome, "skipped");
    assert.ok(result.outcome === "skipped" && result.reason.length > 0);
    assert.equal(await prisma.memoryExtractionRun.count(), 0);
});
