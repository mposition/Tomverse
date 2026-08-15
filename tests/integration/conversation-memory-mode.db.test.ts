import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { recordConversationMemoryOff } from "@/lib/memoryModeSignals";
import { getMemoryReport } from "@/lib/memoryMetrics";
import { prisma } from "@/lib/prisma";

/**
 * §8.1 invariant 1 — the conversation's memory mode is stored by the server.
 *
 * The column existed before this slice and nothing read or wrote it. What a
 * database can prove is the storage half: the value round-trips, `inherit` is
 * the default, and §22's memory-off signal fires on exactly the conjunction
 * it is supposed to.
 *
 * The *effect* half deliberately is not asserted here. §8.1 orders the gate
 * so that the rollout flag and the approved-pair check refuse before the mode
 * is consulted, and no pair is approved (§12.4), so no test can reach the
 * mode branch through this service today without faking a governance
 * decision. The composition that decides it is pure and is asserted in
 * tests/conversationMemoryMode.test.mjs instead.
 */

const resetData = async () => {
    await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "MemoryEvidence",
      "MemoryItem",
      "UserMemorySettings",
      "Message",
      "Conversation",
      "ChatUsageBucket"
    RESTART IDENTITY CASCADE
  `);
};

const createUser = () =>
    prisma.user.create({
        data: { email: `memory-mode-${randomUUID()}@example.test` },
    });

const seedConversation = (userId: string, memoryMode?: string) =>
    prisma.conversation.create({
        data: {
            userId,
            title: "mode fixture",
            ...(memoryMode ? { memoryMode } : {}),
        },
    });

beforeEach(resetData);

after(async () => {
    await resetData();
    await prisma.$disconnect();
});

/* ---------------------------------------------------------------- storage */


test("the column stores what was written and defaults to inherit", async () => {
    const user = await createUser();
    const inherited = await seedConversation(user.id);
    assert.equal(inherited.memoryMode, "inherit");

    const off = await seedConversation(user.id, "off");
    assert.equal(
        (
            await prisma.conversation.findUnique({
                where: { id: off.id },
                select: { memoryMode: true },
            })
        )?.memoryMode,
        "off"
    );
});

/* ------------------------------------------------------- §22 off signal -- */

const seedAnswer = (
    conversationId: string,
    memoryUsedCount: number | null,
    createdAt = new Date()
) =>
    prisma.message.create({
        data: {
            conversationId,
            role: "assistant",
            content: "답변",
            createdAt,
            memoryUsedCount,
            memoryTokens: memoryUsedCount === null ? null : 100,
        },
    });

const offCount = async () =>
    (await getMemoryReport()).counters.memory_off_after_injection;

test("turning memory off right after a memory answer is counted", async () => {
    const user = await createUser();
    const conversation = await seedConversation(user.id);
    await seedAnswer(conversation.id, 3);

    await recordConversationMemoryOff({
        conversationId: conversation.id,
        previousMode: "inherit",
        nextMode: "off",
    });
    assert.equal(await offCount(), 1);
});

test("turning it off after an answer memory did not shape is not", async () => {
    // The signal is about memory. Counting every mode change would bury the
    // one case §22 wants under a pile of ordinary preference changes.
    const user = await createUser();
    const conversation = await seedConversation(user.id);
    await seedAnswer(conversation.id, null);

    await recordConversationMemoryOff({
        conversationId: conversation.id,
        previousMode: "inherit",
        nextMode: "off",
    });
    assert.equal(await offCount(), 0);
});

test("turning it off long after the answer is not counted", async () => {
    const user = await createUser();
    const conversation = await seedConversation(user.id);
    await seedAnswer(
        conversation.id,
        3,
        new Date(Date.now() - 10 * 60 * 1000)
    );

    await recordConversationMemoryOff({
        conversationId: conversation.id,
        previousMode: "inherit",
        nextMode: "off",
    });
    assert.equal(await offCount(), 0);
});

test("a conversation with no answers yet counts nothing", async () => {
    // Opening a conversation and turning memory off before saying anything is
    // a preference, not a complaint.
    const user = await createUser();
    const conversation = await seedConversation(user.id);

    await recordConversationMemoryOff({
        conversationId: conversation.id,
        previousMode: "inherit",
        nextMode: "off",
    });
    assert.equal(await offCount(), 0);
});

test("re-saving off, or switching on, counts nothing", async () => {
    const user = await createUser();
    const conversation = await seedConversation(user.id, "off");
    await seedAnswer(conversation.id, 3);

    await recordConversationMemoryOff({
        conversationId: conversation.id,
        previousMode: "off",
        nextMode: "off",
    });
    await recordConversationMemoryOff({
        conversationId: conversation.id,
        previousMode: "off",
        nextMode: "on",
    });
    assert.equal(await offCount(), 0);
});
