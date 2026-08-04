import assert from "node:assert/strict";
import test from "node:test";
import {
    CHAT_CONTEXT_BUNDLE_STALE,
    MEMORY_CONTEXT_BUNDLE_TTL_MS,
    MEMORY_CONTEXT_BUNDLE_VERSION,
    contextBundleStaleBody,
    isRepreflightableBundleFailure,
    issueContextBundle,
    memoryStateHash,
    retrievalHash,
    verifyContextBundle,
} from "../lib/memoryContextBundleCore.ts";

/**
 * docs/policy/external-conversation-import-and-memory.md §10.
 *
 * A bundle exists to make one thing impossible: sending a prompt that differs
 * from the one a reservation was taken against. So the tests below are mostly
 * about what must be REJECTED — a forged token, a borrowed one, one for
 * another conversation or model set, and one whose snapshot moved.
 */

const SECRET = "context-bundle-test-secret-at-least-32-chars";
const NOW = new Date("2026-08-04T00:00:00.000Z");

const CURRENT = {
    memoryStateHash: memoryStateHash([{ id: "m1", revision: 1 }]),
    retrievalHash: retrievalHash("v1|f:m1"),
    retrievalVersion: 1,
    styleEnabled: true,
    memoryMode: "on",
    profileVersion: null,
    promptVersion: "mem-context-v1",
};

const payload = (overrides = {}) => ({
    version: MEMORY_CONTEXT_BUNDLE_VERSION,
    bundleId: "bundle-1",
    subjectKey: "user:alice",
    conversationId: "conv-1",
    memoryMode: "on",
    modelIds: ["gpt-5-6-luna"],
    ...CURRENT,
    memoryTokens: 42,
    issuedAtMs: NOW.getTime(),
    expiresAtMs: NOW.getTime() + MEMORY_CONTEXT_BUNDLE_TTL_MS,
    ...overrides,
});

const verify = (token, options = {}) =>
    verifyContextBundle(token, {
        secret: SECRET,
        subjectKey: "user:alice",
        conversationId: "conv-1",
        modelIds: ["gpt-5-6-luna"],
        now: NOW,
        current: CURRENT,
        ...options,
    });

test("a freshly issued bundle verifies against the same snapshot", () => {
    const result = verify(issueContextBundle(payload(), SECRET));
    assert.equal(result.ok, true);
    assert.equal(result.payload.memoryTokens, 42);
});

test("the token carries no memory text, only hashes", () => {
    const token = issueContextBundle(payload(), SECRET);
    const body = Buffer.from(token.slice(0, token.lastIndexOf(".")), "base64url")
        .toString("utf8");
    // The whole point of hashing: a user's memories never travel through the
    // browser (§16). The statement below is what a real memory would look like.
    assert.ok(!body.includes("The user prefers"));
    assert.ok(body.includes(CURRENT.memoryStateHash));
});

test("an edited payload no longer verifies", () => {
    const token = issueContextBundle(payload(), SECRET);
    const separator = token.lastIndexOf(".");
    const forged = Buffer.from(
        Buffer.from(token.slice(0, separator), "base64url")
            .toString("utf8")
            .replace('"mt":42', '"mt":9999'),
        "utf8"
    ).toString("base64url");
    const result = verify(`${forged}${token.slice(separator)}`);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid_signature");
});

test("a bundle signed with another secret is rejected", () => {
    const result = verify(issueContextBundle(payload(), "a-different-secret"));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid_signature");
});

test("another subject's bundle is rejected even if stolen verbatim", () => {
    const token = issueContextBundle(
        payload({ subjectKey: "user:mallory" }),
        SECRET
    );
    const result = verify(token);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "subject_mismatch");
});

test("a bundle for another conversation is rejected", () => {
    const result = verify(issueContextBundle(payload(), SECRET), {
        conversationId: "conv-2",
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "conversation_mismatch");
});

test("a bundle for a different model set is rejected", () => {
    const result = verify(issueContextBundle(payload(), SECRET), {
        modelIds: ["gpt-5-6-luna", "claude-sonnet-5"],
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "model_set_mismatch");
});

test("a comparison panel checks membership, not the whole set", () => {
    // One bundle serves every panel of a comparison, and each POST /api/chat
    // knows only its own model. Equality would reject all of them.
    const token = issueContextBundle(
        payload({ modelIds: ["a-model", "b-model", "c-model"] }),
        SECRET
    );
    for (const modelId of ["a-model", "b-model", "c-model"]) {
        const result = verify(token, { modelIds: undefined, modelId });
        assert.equal(result.ok, true, modelId);
    }
    const outsider = verify(token, {
        modelIds: undefined,
        modelId: "d-model",
    });
    assert.equal(outsider.ok, false);
    assert.equal(outsider.reason, "model_not_bound");
});

test("model order never decides the match, so panels agree", () => {
    const token = issueContextBundle(
        payload({ modelIds: ["a-model", "b-model"] }),
        SECRET
    );
    assert.equal(verify(token, { modelIds: ["b-model", "a-model"] }).ok, true);
});

test("an expired bundle is rejected", () => {
    const result = verify(issueContextBundle(payload(), SECRET), {
        now: new Date(NOW.getTime() + MEMORY_CONTEXT_BUNDLE_TTL_MS + 1),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "expired");
});

test("a first-turn bundle binds to no conversation", () => {
    const token = issueContextBundle(payload({ conversationId: null }), SECRET);
    assert.equal(verify(token, { conversationId: null }).ok, true);
    // And still cannot be replayed into an existing conversation.
    assert.equal(
        verify(token, { conversationId: "conv-1" }).reason,
        "conversation_mismatch"
    );
});

// --- staleness: every bound field must be able to invalidate ---

const staleWhen = (changes) => {
    const result = verify(issueContextBundle(payload(), SECRET), {
        current: { ...CURRENT, ...changes },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "snapshot_changed");
};

test("approving or deleting a memory makes the bundle stale", () => {
    staleWhen({
        memoryStateHash: memoryStateHash([
            { id: "m1", revision: 1 },
            { id: "m2", revision: 1 },
        ]),
    });
});

test("editing a memory in place makes the bundle stale", () => {
    // Revision rather than a timestamp: two edits in the same millisecond are
    // two different memories and must not hash the same.
    staleWhen({ memoryStateHash: memoryStateHash([{ id: "m1", revision: 2 }]) });
});

test("a different retrieval result makes the bundle stale", () => {
    staleWhen({ retrievalHash: retrievalHash("v1|f:m2") });
});

test("changing the retrieval algorithm makes the bundle stale", () => {
    staleWhen({ retrievalVersion: 2 });
});

test("turning answer style off makes the bundle stale", () => {
    staleWhen({ styleEnabled: false });
});

test("turning memory off for the conversation makes the bundle stale", () => {
    staleWhen({ memoryMode: "off" });
});

test("a prompt-boundary change makes the bundle stale", () => {
    // §9.1 wording is part of what was reserved: changing it changes the
    // prompt a quoted turn would send.
    staleWhen({ promptVersion: "mem-context-v2" });
});

test("a profile version appearing makes the bundle stale (Release C)", () => {
    staleWhen({ profileVersion: "profile-1" });
});

test("verification without a rebuilt snapshot checks identity only", () => {
    // The preflight echo path: useful for "is this mine and unexpired", and
    // deliberately unable to answer "may I spend on it".
    const result = verify(issueContextBundle(payload(), SECRET), {
        current: undefined,
    });
    assert.equal(result.ok, true);
});

// --- malformed input ---

test("garbage never throws, it is just rejected", () => {
    for (const token of [
        "",
        "no-separator",
        ".",
        "a.b",
        `${"x".repeat(5000)}.y`,
        Buffer.from("{}", "utf8").toString("base64url") + ".sig",
    ]) {
        const result = verify(token);
        assert.equal(result.ok, false);
        assert.ok(typeof result.reason === "string");
    }
});

test("a bundle from a future version is not accepted as v1", () => {
    const body = Buffer.from(
        JSON.stringify({ ...payload(), v: 2 }),
        "utf8"
    ).toString("base64url");
    assert.equal(verify(`${body}.whatever`).ok, false);
});

// --- the §10 error contract ---

test("the stale response tells the client to re-preflight", () => {
    const body = contextBundleStaleBody("snapshot_changed");
    assert.equal(body.code, CHAT_CONTEXT_BUNDLE_STALE);
    assert.equal(body.details.requiresPreflight, true);
});

test("only expiry and snapshot drift are re-preflightable", () => {
    assert.ok(isRepreflightableBundleFailure("expired"));
    assert.ok(isRepreflightableBundleFailure("snapshot_changed"));
    // A forged or borrowed token is not something a retry should fix.
    for (const reason of [
        "malformed",
        "invalid_signature",
        "subject_mismatch",
        "conversation_mismatch",
        "model_set_mismatch",
        "model_not_bound",
    ]) {
        assert.ok(!isRepreflightableBundleFailure(reason), reason);
    }
});

// --- hashing ---

test("the memory state hash ignores row order", () => {
    assert.equal(
        memoryStateHash([
            { id: "b", revision: 1 },
            { id: "a", revision: 2 },
        ]),
        memoryStateHash([
            { id: "a", revision: 2 },
            { id: "b", revision: 1 },
        ])
    );
});

test("an empty store still has a stable hash", () => {
    assert.equal(memoryStateHash([]), memoryStateHash([]));
    assert.notEqual(memoryStateHash([]), memoryStateHash([{ id: "a", revision: 1 }]));
});
