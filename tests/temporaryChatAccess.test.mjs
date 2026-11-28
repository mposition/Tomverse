import assert from "node:assert/strict";
import test from "node:test";

import {
    TEMPORARY_CHAT_FLAG_KEY,
    TEMPORARY_CHAT_NOT_ALLOWED,
    TEMPORARY_CHAT_SWEEP_GRACE_MS,
    TEMPORARY_CHAT_SWEEP_MAX_DEFER_MS,
    TEMPORARY_CHAT_TTL_MS,
    TEMPORARY_SWEEP_LIVE_IMAGE_STATUSES,
    TEMPORARY_SWEEP_LIVE_RESEARCH_STATUSES,
    conversationDeletionScope,
    isTemporaryConversation,
    isTemporaryConversationExpired,
    temporaryChatEnabledFromValue,
    temporaryConversationExpiresAt,
    temporaryConversationSweepWhere,
    temporaryConversationUpdateRefusal,
    temporarySweepCutoff,
    temporarySweepMayDefer,
} from "../lib/temporaryChatAccess.ts";

/**
 * The deletion boundary of temporary Chat, without a database: what the sweep
 * may select and what one deletion may touch. The database half -- that an
 * ordinary conversation survives a real sweep -- is
 * tests/integration/chat-personalization-privacy.db.test.ts.
 */

const NOW = new Date("2026-11-27T03:00:00.000Z");

test("the switch is default-off: only the literal 'true' offers temporary Chat", () => {
    assert.equal(TEMPORARY_CHAT_FLAG_KEY, "feature.temporaryChatEnabled");
    for (const value of [undefined, null, "", "TRUE", "1", "yes", "on", " true"]) {
        assert.equal(temporaryChatEnabledFromValue(value), false, String(value));
    }
    assert.equal(temporaryChatEnabledFromValue("true"), true);
});

test("a temporary Chat expires 24 hours after it starts and takes no answer from then", () => {
    assert.equal(TEMPORARY_CHAT_TTL_MS, 24 * 60 * 60 * 1000);
    const expiresAt = temporaryConversationExpiresAt(NOW);
    assert.equal(expiresAt.getTime() - NOW.getTime(), TEMPORARY_CHAT_TTL_MS);
    assert.equal(isTemporaryConversationExpired(expiresAt, new Date(expiresAt.getTime() - 1)), false);
    assert.equal(isTemporaryConversationExpired(expiresAt, expiresAt), true);
    // An ordinary conversation never expires.
    assert.equal(isTemporaryConversationExpired(null, NOW), false);
    assert.equal(isTemporaryConversationExpired(undefined, NOW), false);
    assert.equal(isTemporaryConversation(null), false);
    assert.equal(isTemporaryConversation(expiresAt), true);
});

test("the sweep can only select a conversation that carries the temporary marker", () => {
    const cutoff = temporarySweepCutoff(NOW);
    assert.equal(NOW.getTime() - cutoff.getTime(), TEMPORARY_CHAT_SWEEP_GRACE_MS);
    const where = temporaryConversationSweepWhere(cutoff);
    // The whole predicate: nothing about age, owner or content can widen it.
    assert.deepEqual(Object.keys(where), ["temporaryExpiresAt"]);
    assert.deepEqual(where.temporaryExpiresAt, { not: null, lte: cutoff });
});

test("one deletion is scoped to the owner, and the sweep's to expired temporary rows", () => {
    const owner = conversationDeletionScope({ userId: "u-1", conversationIds: ["c-1", "c-1", "c-2"] });
    assert.deepEqual(owner, { userId: "u-1", id: { in: ["c-1", "c-2"] } });

    const cutoff = temporarySweepCutoff(NOW);
    const sweep = conversationDeletionScope({ userId: "u-1", conversationIds: ["c-1"], temporaryExpiredBefore: cutoff });
    assert.deepEqual(sweep, {
        userId: "u-1",
        id: { in: ["c-1"] },
        temporaryExpiresAt: { not: null, lte: cutoff },
    });
});

test("a temporary Chat refuses a project move and memory, and nothing else", () => {
    const expiresAt = temporaryConversationExpiresAt(NOW);
    assert.equal(temporaryConversationUpdateRefusal(expiresAt, { projectId: "p-1" }), TEMPORARY_CHAT_NOT_ALLOWED);
    assert.equal(temporaryConversationUpdateRefusal(expiresAt, { memoryMode: "on" }), TEMPORARY_CHAT_NOT_ALLOWED);
    assert.equal(temporaryConversationUpdateRefusal(expiresAt, { memoryMode: "inherit" }), TEMPORARY_CHAT_NOT_ALLOWED);
    assert.equal(temporaryConversationUpdateRefusal(expiresAt, { memoryMode: "off" }), null);
    assert.equal(temporaryConversationUpdateRefusal(expiresAt, { projectId: null }), null);
    assert.equal(temporaryConversationUpdateRefusal(expiresAt, {}), null);
    // An ordinary conversation is never refused here.
    assert.equal(temporaryConversationUpdateRefusal(null, { projectId: "p-1", memoryMode: "on" }), null);
});

test("the sweep waits for running Research and image work, but only for a bounded time past the expiry", () => {
    const expiresAt = temporaryConversationExpiresAt(NOW);
    // Longest Research profile is six hours: the wait must cover it, and must not be open-ended.
    assert.ok(TEMPORARY_CHAT_SWEEP_MAX_DEFER_MS >= 6 * 60 * 60 * 1000);
    assert.ok(TEMPORARY_CHAT_SWEEP_MAX_DEFER_MS <= 12 * 60 * 60 * 1000);
    assert.equal(temporarySweepMayDefer(expiresAt, expiresAt), true);
    assert.equal(
        temporarySweepMayDefer(expiresAt, new Date(expiresAt.getTime() + TEMPORARY_CHAT_SWEEP_MAX_DEFER_MS - 1)),
        true
    );
    // Past the cap a run that still looks "executing" is stuck: the deletion promise wins.
    assert.equal(
        temporarySweepMayDefer(expiresAt, new Date(expiresAt.getTime() + TEMPORARY_CHAT_SWEEP_MAX_DEFER_MS)),
        false
    );
});

test("only executing Research and in-flight image statuses hold a conversation back", () => {
    // Waiting on the person (draft, awaiting_input, paused) and every terminal status never defers.
    for (const status of ["draft", "awaiting_input", "paused", "completed", "failed", "cancelled", "attention"]) {
        assert.ok(!TEMPORARY_SWEEP_LIVE_RESEARCH_STATUSES.includes(status), status);
    }
    for (const status of ["queued", "running", "checkpointed", "planning", "finalizing", "preparing"]) {
        assert.ok(TEMPORARY_SWEEP_LIVE_RESEARCH_STATUSES.includes(status), status);
    }
    assert.deepEqual([...TEMPORARY_SWEEP_LIVE_IMAGE_STATUSES], ["pending", "processing", "settling"]);
});

test("the sweep's live statuses are real statuses, so a rename cannot silently stop the wait", async () => {
    const { RESEARCH_PREVIEW_RUN_STATUSES } = await import("../lib/researchPreviewRunTypes.ts");
    const { IMAGE_GENERATION_STATUSES } = await import("../lib/imageGenerationStateCore.ts");
    for (const status of TEMPORARY_SWEEP_LIVE_RESEARCH_STATUSES) assert.ok(RESEARCH_PREVIEW_RUN_STATUSES.includes(status), status);
    for (const status of TEMPORARY_SWEEP_LIVE_IMAGE_STATUSES) assert.ok(IMAGE_GENERATION_STATUSES.includes(status), status);
});
