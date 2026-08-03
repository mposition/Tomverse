import assert from "node:assert/strict";
import { test } from "node:test";
import {
    BATCH_SHAPE_LIMITS,
    ExternalImportPipelineError,
    buildBatchPayloads,
    buildImportPreview,
    classifyConversation,
    estimateStoredBytes,
    mergeConversationSets,
    parseConversationItems,
} from "../lib/externalImportPipeline.ts";
import { EXTERNAL_IMPORT_STORAGE_LIMITS } from "../lib/externalImportLimits.ts";

// docs/policy/external-conversation-import-and-memory.md §5.3–§5.6.

const conversation = (id, contents, extra = {}) => ({
    rawExternalConversationId: id,
    title: `conversation ${id}`,
    sourceModelLabels: [],
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    messages: contents.map((content, index) => ({
        rawExternalMessageId: `${id}-${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        ordinal: index,
        content,
        sourceModelLabel: null,
        sourceTimestamp: null,
    })),
    warnings: {
        skippedNonConversationMessages: 0,
        skippedNonTextParts: 0,
        skippedEmptyMessages: 0,
        additionalBranchCount: 0,
        ...extra,
    },
});

const overStored = "가".repeat(
    EXTERNAL_IMPORT_STORAGE_LIMITS.maxStoredMessageCodePoints + 1
);
const overInbound = "x".repeat(
    EXTERNAL_IMPORT_STORAGE_LIMITS.maxInboundMessageCodePoints + 1
);

test("conversations are classified into the three preview states", () => {
    assert.deepEqual(classifyConversation(conversation("a", ["short"])), {
        kind: "importable",
        truncatedMessageCount: 0,
    });
    assert.deepEqual(
        classifyConversation(conversation("b", ["short", overStored])),
        { kind: "requires_truncation_approval", truncatedMessageCount: 1 }
    );
    // §5.3: one message past the inbound limit excludes the whole
    // conversation — the server never drops individual messages.
    assert.deepEqual(
        classifyConversation(conversation("c", ["short", overInbound])),
        { kind: "not_importable", oversizedMessageCount: 1 }
    );
});

test("stored-byte estimates count only what survives truncation", () => {
    const plain = conversation("a", ["hello"]);
    assert.equal(estimateStoredBytes(plain), 5);

    const truncated = conversation("b", [overStored]);
    const estimate = estimateStoredBytes(truncated);
    // Retained is the stored cap minus the marker, at 3 bytes per Hangul
    // syllable — far below the untruncated size.
    assert.ok(estimate > 0);
    assert.ok(
        estimate <
            EXTERNAL_IMPORT_STORAGE_LIMITS.maxStoredMessageCodePoints * 3
    );

    // A conversation that cannot be imported contributes nothing.
    assert.equal(estimateStoredBytes(conversation("c", [overInbound])), 0);
});

test("the preview totals separate importable from excluded content", () => {
    const preview = buildImportPreview("chatgpt", [
        conversation("a", ["one", "two"]),
        conversation("b", [overStored]),
        conversation("c", [overInbound]),
        conversation("d", ["x"], {
            skippedNonTextParts: 2,
            additionalBranchCount: 3,
        }),
    ]);
    assert.equal(preview.provider, "chatgpt");
    assert.equal(preview.totals.conversations, 4);
    assert.equal(preview.totals.importableConversations, 2);
    assert.equal(preview.totals.requiresTruncationApproval, 1);
    assert.equal(preview.totals.notImportable, 1);
    // The not-importable conversation's messages are excluded from totals.
    assert.equal(preview.totals.messages, 4);
    assert.equal(preview.totals.skippedNonTextParts, 2);
    assert.equal(preview.totals.additionalBranches, 3);
});

test("batches never split a conversation", () => {
    // Each conversation is ~2KB; a 5KB request budget fits two per batch.
    const big = "y".repeat(1_000);
    const selected = Array.from({ length: 5 }, (_, index) =>
        conversation(`c${index}`, [big, big])
    );
    const batches = buildBatchPayloads(selected, { maxRequestBytes: 5_000 });

    assert.ok(batches.length > 1);
    const flattened = batches.flatMap((batch) => batch.conversations);
    assert.equal(flattened.length, 5);
    // Every conversation appears exactly once, whole.
    for (const conv of flattened) {
        assert.equal(conv.messages.length, 2);
    }
    assert.deepEqual(
        batches.map((batch) => batch.sequence),
        batches.map((_, index) => index)
    );
});

test("batch sequences start at zero and are contiguous", () => {
    const batches = buildBatchPayloads([conversation("a", ["x"])]);
    assert.deepEqual(batches, [
        {
            sequence: 0,
            conversations: [
                {
                    rawExternalConversationId: "a",
                    title: "conversation a",
                    messages: [
                        {
                            rawExternalMessageId: "a-0",
                            role: "user",
                            ordinal: 0,
                            content: "x",
                        },
                    ],
                },
            ],
        },
    ]);
});

test("the per-batch conversation count cap is respected", () => {
    const selected = Array.from({ length: 120 }, (_, index) =>
        conversation(`c${index}`, ["short"])
    );
    const batches = buildBatchPayloads(selected);
    assert.ok(
        batches.every(
            (batch) =>
                batch.conversations.length <=
                BATCH_SHAPE_LIMITS.maxConversationsPerBatch
        )
    );
    assert.equal(
        batches.reduce((total, batch) => total + batch.conversations.length, 0),
        120
    );
});

test("optional fields are omitted rather than sent as null", () => {
    const withLabels = {
        ...conversation("a", ["x"]),
        sourceModelLabels: ["gpt-5"],
        sourceCreatedAt: "2026-08-01T00:00:00.000Z",
    };
    withLabels.messages[0].sourceModelLabel = "gpt-5";
    const [batch] = buildBatchPayloads([withLabels]);
    const payload = batch.conversations[0];
    assert.deepEqual(payload.sourceModelLabels, ["gpt-5"]);
    assert.equal(payload.sourceCreatedAt, "2026-08-01T00:00:00.000Z");
    assert.ok(!("sourceUpdatedAt" in payload));
    assert.ok(!("sourceTimestamp" in payload.messages[0]));
});

test("a selection the transport cannot carry is refused, not silently split", () => {
    assert.throws(
        () => buildBatchPayloads([conversation("a", [overInbound])]),
        (error) =>
            error instanceof ExternalImportPipelineError &&
            error.reason === "conversation_not_importable"
    );

    assert.throws(
        () =>
            buildBatchPayloads([conversation("a", ["y".repeat(5_000)])], {
                maxRequestBytes: 1_000,
            }),
        (error) =>
            error instanceof ExternalImportPipelineError &&
            error.reason === "conversation_too_large_for_batch"
    );

    const tooMany = conversation(
        "a",
        Array.from(
            { length: BATCH_SHAPE_LIMITS.maxMessagesPerConversation + 1 },
            () => "x"
        )
    );
    assert.throws(
        () => buildBatchPayloads([tooMany]),
        (error) =>
            error instanceof ExternalImportPipelineError &&
            error.reason === "too_many_messages"
    );
});

test("malformed items are counted, never fatal", () => {
    const result = parseConversationItems("claude", [
        {
            uuid: "ok",
            name: "fine",
            chat_messages: [{ uuid: "m", sender: "human", text: "hi" }],
        },
        null,
        { unrelated: true },
        "not an object",
    ]);
    assert.equal(result.conversations.length, 1);
    assert.equal(result.unparsableCount, 3);
});

test("multi-part exports merge on source id, keeping the richer snapshot", () => {
    // Takeout-style split archives repeat conversations; the later, longer
    // copy is the one to keep.
    const merged = mergeConversationSets([
        [conversation("a", ["one"]), conversation("b", ["x"])],
        [conversation("a", ["one", "two", "three"])],
    ]);
    assert.equal(merged.length, 2);
    const a = merged.find((c) => c.rawExternalConversationId === "a");
    assert.equal(a.messages.length, 3);
});
