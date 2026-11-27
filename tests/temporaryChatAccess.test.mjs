import assert from "node:assert/strict";
import test from "node:test";

import {
    TEMPORARY_CHAT_FLAG_KEY,
    TEMPORARY_CHAT_NOT_ALLOWED,
    TEMPORARY_CHAT_SWEEP_GRACE_MS,
    TEMPORARY_CHAT_TTL_MS,
    conversationDeletionScope,
    isTemporaryConversation,
    isTemporaryConversationExpired,
    temporaryChatEnabledFromValue,
    temporaryConversationExpiresAt,
    temporaryConversationSweepWhere,
    temporaryConversationUpdateRefusal,
    temporarySweepCutoff,
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
