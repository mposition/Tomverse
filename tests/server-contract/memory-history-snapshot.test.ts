import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { issueContextBundle, verifyContextBundle, type ContextBundlePayload } from "../../lib/chatContextBundleCore";
import { memoryCurrentQueryDigest, memoryHistoryContentDigest } from "../../lib/memoryHistorySnapshotCore";

const mod = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
const secret = "local-memory-history-contract";
const query = "그 프로젝트의 마감은?";
const source = { id: "source", content: "아틀라스 출시 프로젝트" };
let rows = [source];
let owner = "owner";
let unlocked = true;
const sourceReads = mock.fn(async (input: { where: { id?: { in: string[] } } }) => { assert.ok(input.where); return rows; });
const accessReads = mock.fn(async () => ({ userId: owner, password: unlocked ? null : "locked", passwordVersion: 3, kind: "chat" }));
class AccessError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
}
mock.module(mod("lib/chatSecurity.ts"), { namedExports: { ChatAccessError: AccessError } });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
    conversation: { findUnique: accessReads }, message: { findMany: sourceReads },
} } });
mock.module(mod("lib/conversationLock.ts"), { namedExports: { hasConversationUnlockGrant: () => unlocked } });
mock.module(mod("lib/chatContextBundleService.ts"), { namedExports: {
    verifyChatContextBundle: (token: string, options: object) => verifyContextBundle(token, { secret, ...options } as Parameters<typeof verifyContextBundle>[1]),
} });
let prepareMemoryHistoryContext: typeof import("../../lib/memoryHistorySnapshot").prepareMemoryHistoryContext;
let replayMemoryHistoryContext: typeof import("../../lib/memoryHistorySnapshot").replayMemoryHistoryContext;
const input = { request: new Request("http://localhost/api/chat/context"), userId: "owner", conversationId: "conversation",
    query, modelIds: ["a", "b"] };
const payload = (overrides: Partial<ContextBundlePayload> = {}): ContextBundlePayload => ({
    version: 1, bundleId: "bundle", subjectKey: "owner", conversationId: "conversation", modelIds: ["a", "b"],
    memoryMode: "on", memoryVersion: "v", styleVersion: "s", profileVersion: null, retrievalHash: "r",
    retrievalVersion: 1, promptVersion: "p", knowledgeHash: "none", memoryTokens: 0, profileTokens: 0,
    expiresAtMs: Date.now() + 60000, semanticSteps: { memoryRerank: true, knowledgeNeighbours: false, knowledgeRerank: false },
    memoryQueryPolicy: "full", memoryHistory: { version: 1, queryDigest: memoryCurrentQueryDigest(query),
        sources: [{ id: source.id, digest: memoryHistoryContentDigest(source.content) }] }, ...overrides,
});
beforeEach(async () => {
    ({ prepareMemoryHistoryContext, replayMemoryHistoryContext } = await import(mod("lib/memoryHistorySnapshot.ts")));
    process.env.MEMORY_RELEVANCE_CONTEXT_ENABLED = "true";
    sourceReads.mock.resetCalls(); accessReads.mock.resetCalls(); rows = [source]; owner = "owner"; unlocked = true;
});

test("untrusted, mismatched and expired-model bundles cannot cause source queries", () => {
    const tokens = ["malformed", issueContextBundle(payload(), "wrong-secret"),
        issueContextBundle(payload({ subjectKey: "other-owner" }), secret),
        issueContextBundle(payload({ conversationId: "other-conversation" }), secret),
        issueContextBundle(payload({ modelIds: ["a"] }), secret),
        issueContextBundle(payload({ modelIds: ["a"], expiresAtMs: 0 }), secret)];
    for (const previousContextBundle of tokens) {
        assert.throws(() => prepareMemoryHistoryContext({ ...input, previousContextBundle }),
            (error: unknown) => (error as AccessError).code === "INVALID_CONTEXT_BUNDLE");
    }
    assert.equal(sourceReads.mock.callCount(), 0);
    assert.equal(accessReads.mock.callCount(), 0);
});

test("expired, legacy and empty snapshots recover current-only without selecting newer messages", async () => {
    for (const previous of [payload({ expiresAtMs: 0 }), payload({ memoryHistory: undefined }),
        payload({ memoryHistory: undefined, memoryQueryPolicy: undefined })]) {
        const context = await prepareMemoryHistoryContext({ ...input, previousContextBundle: issueContextBundle(previous, secret) })!();
        assert.deepEqual(context, { queryPolicy: "full", history: [] });
    }
    assert.equal(sourceReads.mock.callCount(), 0);
});

test("reprepare reuses only signed sources, and changed sources recover current-only", async () => {
    const previous = payload();
    const previousContextBundle = issueContextBundle(previous, secret);
    const prepared = await prepareMemoryHistoryContext({ ...input, previousContextBundle })!();
    assert.deepEqual(prepared.history.map((row: { id: string }) => row.id), [source.id]);
    assert.deepEqual(sourceReads.mock.calls[0].arguments[0].where.id?.in, [source.id]);
    rows = [{ ...source, content: "Edited source" }];
    assert.equal(await replayMemoryHistoryContext({ ...input, payload: previous }), null);
    assert.deepEqual((await prepareMemoryHistoryContext({ ...input, previousContextBundle })!()).history, []);
    rows = [];
    assert.equal(await replayMemoryHistoryContext({ ...input, payload: previous }), null);
});

test("source authorization uses current owner and lock instead of fallback", async () => {
    const previousContextBundle = issueContextBundle(payload(), secret);
    for (const expected of ["CONVERSATION_LOCKED", "CONVERSATION_FORBIDDEN"]) {
        if (expected === "CONVERSATION_LOCKED") unlocked = false;
        else { unlocked = true; owner = "other-owner"; }
        await assert.rejects(prepareMemoryHistoryContext({ ...input, previousContextBundle })!,
            (error: unknown) => (error as AccessError).code === expected);
    }
    assert.equal(sourceReads.mock.callCount(), 0);
});
