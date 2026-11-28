import assert from "node:assert/strict";
import test from "node:test";

import {
    CHAT_AUTO_MEMORY_ENV,
    CHAT_AUTO_MEMORY_LIMITS,
    chatAutoMemoryOperatorEnabled,
    chatExtractionAllowed,
    chatExtractionPaced,
    isNativeExtractionSelection,
    nativeRunScope,
} from "../lib/projectWorkspaceCore.ts";

const allowed = {
    operatorEnabled: true,
    accountMemoryEnabled: true,
    conversationMemoryOn: true,
    conversationLocked: false,
    temporary: false,
    inProject: false,
    kind: "chat",
    productKey: "chat",
    profileUsesAccountMemory: null,
    continuedFromImport: false,
};

test("Chat auto memory is off unless the operator switch is exactly true", () => {
    assert.equal(chatAutoMemoryOperatorEnabled({}), false);
    assert.equal(chatAutoMemoryOperatorEnabled({ [CHAT_AUTO_MEMORY_ENV]: "1" }), false);
    assert.equal(chatAutoMemoryOperatorEnabled({ [CHAT_AUTO_MEMORY_ENV]: "TRUE" }), false);
    assert.equal(chatAutoMemoryOperatorEnabled({ [CHAT_AUTO_MEMORY_ENV]: "true" }), true);
    assert.deepEqual(chatExtractionAllowed({ ...allowed, operatorEnabled: false }), { allowed: false, reason: "operator_off" });
});

test("an ordinary signed-in Chat conversation is allowed, and every excluded kind of conversation is refused with its own reason", () => {
    assert.deepEqual(chatExtractionAllowed(allowed), { allowed: true });
    const refused = (overrides, reason) =>
        assert.deepEqual(chatExtractionAllowed({ ...allowed, ...overrides }), { allowed: false, reason });
    refused({ temporary: true }, "temporary");
    refused({ conversationLocked: true }, "locked");
    refused({ conversationMemoryOn: false }, "conversation_memory_off");
    refused({ accountMemoryEnabled: false }, "memory_off");
    refused({ kind: "image" }, "not_chat");
    refused({ productKey: "review" }, "not_chat_product");
    refused({ productKey: null }, "not_chat_product");
    refused({ inProject: true }, "in_project");
    refused({ profileUsesAccountMemory: false }, "assistant_memory_off");
    refused({ continuedFromImport: true }, "continued_from_import");
    assert.deepEqual(chatExtractionAllowed({ ...allowed, profileUsesAccountMemory: true }), { allowed: true });
});

test("the account master switch outranks everything a conversation or an Assistant says", () => {
    assert.equal(
        chatExtractionAllowed({ ...allowed, accountMemoryEnabled: false, profileUsesAccountMemory: true, conversationMemoryOn: true }).allowed,
        false
    );
});

test("pacing: a window needs two new user messages, a conversation is cut at most every 15 minutes, an account ten times a day", () => {
    const now = new Date("2026-11-28T12:00:00.000Z");
    const base = { now, newUserMessages: 2, lastSnapshotAt: null, snapshotsLast24h: 0 };
    assert.deepEqual(chatExtractionPaced(base), { allowed: true });
    assert.equal(chatExtractionPaced({ ...base, newUserMessages: 1 }).reason, "too_little_new");
    const minutes = (count) => new Date(now.getTime() - count * 60 * 1000);
    assert.equal(chatExtractionPaced({ ...base, lastSnapshotAt: minutes(14) }).reason, "too_soon");
    assert.equal(chatExtractionPaced({ ...base, lastSnapshotAt: minutes(16) }).allowed, true);
    assert.equal(chatExtractionPaced({ ...base, snapshotsLast24h: CHAT_AUTO_MEMORY_LIMITS.runsPerDay - 1 }).allowed, true);
    assert.equal(chatExtractionPaced({ ...base, snapshotsLast24h: CHAT_AUTO_MEMORY_LIMITS.runsPerDay }).reason, "daily_cap");
});

test("a native run is a project run, a Chat run or nothing: a deleted project never turns into a Chat run", () => {
    const selection = (projectId) => ({
        kind: "native", projectId, conversationId: "c", throughMessageId: "m",
        throughMessageCreatedAt: "2026-11-28T00:00:00.000Z", afterMessageId: null, afterMessageCreatedAt: null,
    });
    assert.equal(isNativeExtractionSelection(selection(null)), true);
    assert.deepEqual(nativeRunScope({ projectId: "p1", sourceSelection: selection("p1") }), { kind: "project", projectId: "p1" });
    assert.deepEqual(nativeRunScope({ projectId: null, sourceSelection: selection(null) }), { kind: "chat" });
    // SET NULL on the column, the selection still names the project.
    assert.equal(nativeRunScope({ projectId: null, sourceSelection: selection("p1") }), null);
    assert.equal(nativeRunScope({ projectId: null, sourceSelection: { kind: "native" } }), null);
    assert.equal(nativeRunScope({ projectId: null, sourceSelection: ["c1"] }), null);
});
