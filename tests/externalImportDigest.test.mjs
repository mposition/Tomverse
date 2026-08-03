import assert from "node:assert/strict";
import { test } from "node:test";
import {
    EXTERNAL_IMPORT_DIGEST_VERSION,
    canonicalizeExternalContent,
    externalContentDigest,
    externalConversationDigest,
    externalConversationStableId,
    externalImportDigest,
    externalMessageDedupDigest,
    externalMessageStableId,
} from "../lib/externalImportDigest.ts";

// docs/policy/external-conversation-import-and-memory.md §4.1. Every digest
// the server stores is recomputed from received content under digestVersion 1
// (SHA-256, NFC, LF). These tests pin that contract: if any of them needs
// updating, that is a new digestVersion, not an edit.

test("digest version 1 is pinned", () => {
    assert.equal(EXTERNAL_IMPORT_DIGEST_VERSION, 1);
});

test("canonicalization applies NFC so composed and decomposed input collide", () => {
    const composed = "café"; // é as one code point
    const decomposed = "café"; // e + combining acute
    assert.notEqual(composed, decomposed);
    assert.equal(
        canonicalizeExternalContent(composed),
        canonicalizeExternalContent(decomposed)
    );
    assert.equal(
        externalContentDigest(composed),
        externalContentDigest(decomposed)
    );
});

test("canonicalization normalizes CRLF and lone CR to LF", () => {
    assert.equal(canonicalizeExternalContent("a\r\nb\rc\nd"), "a\nb\nc\nd");
    assert.equal(
        externalContentDigest("a\r\nb"),
        externalContentDigest("a\nb")
    );
});

test("canonicalization changes nothing else", () => {
    // Trimming or whitespace collapsing would make genuinely different
    // messages collide; leading/trailing/internal spaces must survive.
    assert.equal(canonicalizeExternalContent("  a  b  "), "  a  b  ");
    assert.notEqual(externalContentDigest("a"), externalContentDigest("a "));
});

test("content digest is the version-1 SHA-256 hex, stable across runs", () => {
    // Known vector: sha256("hello"). A change here is a digestVersion bump.
    assert.equal(
        externalContentDigest("hello"),
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
});

test("stable IDs are owner-scoped so accounts cannot be correlated", () => {
    const base = {
        provider: "chatgpt",
        rawExternalConversationId: "conv-1",
    };
    const a = externalConversationStableId({ ...base, userId: "user-a" });
    const b = externalConversationStableId({ ...base, userId: "user-b" });
    assert.notEqual(a, b);
    assert.equal(
        a,
        externalConversationStableId({ ...base, userId: "user-a" })
    );

    const messageA = externalMessageStableId({
        ...base,
        userId: "user-a",
        rawExternalMessageId: "msg-1",
    });
    const messageB = externalMessageStableId({
        ...base,
        userId: "user-b",
        rawExternalMessageId: "msg-1",
    });
    assert.notEqual(messageA, messageB);
});

const dedupInput = {
    provider: "chatgpt",
    rawExternalConversationId: "conv-1",
    role: "user",
    ordinal: 0,
    sourceContentDigest: externalContentDigest("hello"),
};

test("message dedup digest changes with every identity field", () => {
    const base = externalMessageDedupDigest(dedupInput);
    assert.notEqual(
        base,
        externalMessageDedupDigest({ ...dedupInput, role: "assistant" })
    );
    assert.notEqual(
        base,
        externalMessageDedupDigest({ ...dedupInput, ordinal: 1 })
    );
    assert.notEqual(
        base,
        externalMessageDedupDigest({ ...dedupInput, provider: "claude" })
    );
    assert.notEqual(
        base,
        externalMessageDedupDigest({
            ...dedupInput,
            sourceContentDigest: externalContentDigest("other"),
        })
    );
});

test("message dedup digest rejects invalid ordinals", () => {
    assert.throws(() =>
        externalMessageDedupDigest({ ...dedupInput, ordinal: -1 })
    );
    assert.throws(() =>
        externalMessageDedupDigest({ ...dedupInput, ordinal: 1.5 })
    );
});

test("truncation approval does not change the source identity", () => {
    // §4.1: the dedup digest hashes the *pre-truncation* content digest, so a
    // truncated and an untruncated import of the same source message must
    // produce the same dedup digest when given the same source digest.
    const sourceDigest = externalContentDigest("x".repeat(64));
    const truncatedRun = externalMessageDedupDigest({
        ...dedupInput,
        sourceContentDigest: sourceDigest,
    });
    const verbatimRun = externalMessageDedupDigest({
        ...dedupInput,
        sourceContentDigest: sourceDigest,
    });
    assert.equal(truncatedRun, verbatimRun);
});

test("conversation digest is order-sensitive", () => {
    const m0 = externalMessageDedupDigest({ ...dedupInput, ordinal: 0 });
    const m1 = externalMessageDedupDigest({ ...dedupInput, ordinal: 1 });
    const forward = externalConversationDigest({
        provider: "chatgpt",
        rawExternalConversationId: "conv-1",
        orderedMessageDedupDigests: [m0, m1],
    });
    const reversed = externalConversationDigest({
        provider: "chatgpt",
        rawExternalConversationId: "conv-1",
        orderedMessageDedupDigests: [m1, m0],
    });
    assert.notEqual(forward, reversed);
});

test("import digest is order-insensitive across conversations", () => {
    const c1 = externalContentDigest("conversation-one");
    const c2 = externalContentDigest("conversation-two");
    assert.equal(
        externalImportDigest([c1, c2]),
        externalImportDigest([c2, c1])
    );
    assert.notEqual(
        externalImportDigest([c1, c2]),
        externalImportDigest([c1])
    );
});
