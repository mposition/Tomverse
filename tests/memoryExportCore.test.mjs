import assert from "node:assert/strict";
import test from "node:test";
import {
    MEMORY_EXPORT_FORMAT,
    serializeMemoryExportItem,
} from "../lib/memoryExportCore.ts";

/**
 * docs/policy/external-conversation-import-and-memory.md §13.2.
 *
 * The export is the one place a user's whole memory store leaves the account,
 * so what it may and may not contain is pinned here rather than left to the
 * route. The negative assertions matter more than the positive ones: a field
 * added to MemoryItem later must not reach the export just because someone
 * spread the row.
 */

const baseRow = (overrides = {}) => ({
    kind: "preference",
    statement: "The user prefers concise answers",
    status: "active",
    sensitivity: "standard",
    confidence: 0.9,
    pinned: false,
    expiresAt: null,
    retrievalVersion: 1,
    revision: 2,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    approvedAt: new Date("2026-08-02T00:00:00.000Z"),
    extractionModelId: null,
    promptVersion: null,
    evidences: [],
    ...overrides,
});

test("the format identifier is the one the policy settled on", () => {
    assert.equal(MEMORY_EXPORT_FORMAT, "tomverse.memories.v1");
});

test("an item carries the enumerated fields as serializable values", () => {
    const item = serializeMemoryExportItem(
        baseRow({ expiresAt: new Date("2026-12-31T00:00:00.000Z") })
    );
    assert.deepEqual(item, {
        kind: "preference",
        statement: "The user prefers concise answers",
        status: "active",
        sensitivity: "standard",
        confidence: 0.9,
        pinned: false,
        expiresAt: "2026-12-31T00:00:00.000Z",
        retrievalVersion: 1,
        revision: 2,
        createdAt: "2026-08-01T00:00:00.000Z",
        approvedAt: "2026-08-02T00:00:00.000Z",
        extraction: null,
        evidence: [],
    });
    // Dates must already be strings: the route streams JSON.stringify output
    // per item, and a Date that slipped through would serialize differently
    // depending on how it was reached.
    assert.equal(typeof item.createdAt, "string");
});

test("retrieval-internal and scoring fields never reach the export", () => {
    const item = serializeMemoryExportItem(
        baseRow({
            // Fields a future refactor might carry along on the row.
            searchTerms: ["concise", "answers"],
            importance: 7,
            conflictKey: "preference:concise",
            suspendedReason: "source_locked",
            userId: "user-1",
            id: "memory-1",
        })
    );
    for (const forbidden of [
        "searchTerms",
        "importance",
        "conflictKey",
        "suspendedReason",
        "userId",
        "id",
    ]) {
        assert.ok(
            !(forbidden in item),
            `${forbidden} must not appear in an exported item`
        );
    }
});

test("extraction provenance is present for extracted items and null for authored ones", () => {
    assert.deepEqual(
        serializeMemoryExportItem(
            baseRow({
                extractionModelId: "gpt-5-6-luna",
                promptVersion: "mem-extract-v1",
            })
        ).extraction,
        { modelId: "gpt-5-6-luna", promptVersion: "mem-extract-v1" }
    );
    assert.equal(serializeMemoryExportItem(baseRow()).extraction, null);
    // A half-populated row is not provenance — both halves identify the pair.
    assert.equal(
        serializeMemoryExportItem(
            baseRow({ extractionModelId: "gpt-5-6-luna" })
        ).extraction,
        null
    );
});

test("manual evidence returns the grounds the user wrote", () => {
    const item = serializeMemoryExportItem(
        baseRow({
            evidences: [
                {
                    sourceType: "manual",
                    manualContent: "I said so in the settings page",
                    externalMessage: null,
                },
            ],
        })
    );
    assert.deepEqual(item.evidence, [
        { sourceType: "manual", grounds: "I said so in the settings page" },
    ]);
});

test("external evidence carries a reference, never the source message text", () => {
    const item = serializeMemoryExportItem(
        baseRow({
            evidences: [
                {
                    sourceType: "external_message",
                    manualContent: null,
                    externalMessage: {
                        externalConversationId: "ext-conv-1",
                        ordinal: 4,
                        role: "user",
                        sourceLocked: false,
                    },
                },
            ],
        })
    );
    assert.deepEqual(item.evidence, [
        {
            sourceType: "external_message",
            externalConversationId: "ext-conv-1",
            ordinal: 4,
            role: "user",
        },
    ]);
    assert.ok(
        !JSON.stringify(item).includes("content"),
        "the exported evidence must not carry source content"
    );
});

test("evidence whose source row is gone still reports its type", () => {
    // The FK cascades, so a dangling include resolves to null rather than
    // throwing; the export should say a memory rests on external evidence
    // without inventing a reference.
    const item = serializeMemoryExportItem(
        baseRow({
            evidences: [
                {
                    sourceType: "external_message",
                    manualContent: null,
                    externalMessage: null,
                },
            ],
        })
    );
    assert.deepEqual(item.evidence, [
        {
            sourceType: "external_message",
            externalConversationId: null,
            ordinal: null,
            role: null,
        },
    ]);
});

test("an unknown source type degrades to its type alone", () => {
    const item = serializeMemoryExportItem(
        baseRow({
            evidences: [
                {
                    sourceType: "tomverse_message",
                    manualContent: null,
                    externalMessage: null,
                },
            ],
        })
    );
    assert.deepEqual(item.evidence, [{ sourceType: "tomverse_message" }]);
});

/* ------------------------------------------------------------ locked source */

test("a locked source is reduced to the fact that it exists", () => {
    // §13.2. The export is a document that leaves the account, so unlike the
    // review screen — where an id only leads to a page the lock itself
    // refuses — a reference here outlives the lock entirely.
    const item = serializeMemoryExportItem(
        baseRow({
            evidences: [
                {
                    sourceType: "external_message",
                    manualContent: null,
                    externalMessage: {
                        externalConversationId: "ext-conv-locked",
                        ordinal: 7,
                        role: "assistant",
                        sourceLocked: true,
                    },
                },
            ],
        })
    );

    assert.deepEqual(item.evidence, [
        { sourceType: "external_message", locked: true },
    ]);
    const serialized = JSON.stringify(item);
    // Each of these describes the thing the lock hides. The position and the
    // role would still narrow it down for anyone holding the account's
    // Release A export, which is why "no id" is not enough on its own.
    assert.ok(!serialized.includes("ext-conv-locked"));
    assert.ok(!serialized.includes('"ordinal"'));
    assert.ok(!serialized.includes('"role"'));
});

test("the memory itself is still exported when its source is locked", () => {
    // Withholding the reference is not withholding the memory: the user is
    // entitled to know a statement is held and what it says.
    const item = serializeMemoryExportItem(
        baseRow({
            statement: "사용자는 커피를 좋아한다",
            evidences: [
                {
                    sourceType: "external_message",
                    manualContent: null,
                    externalMessage: {
                        externalConversationId: "ext-conv-locked",
                        ordinal: 1,
                        role: "user",
                        sourceLocked: true,
                    },
                },
            ],
        })
    );
    assert.equal(item.statement, "사용자는 커피를 좋아한다");
    assert.equal(item.evidence.length, 1);
});

test("one locked source does not withhold the unlocked evidence beside it", () => {
    const item = serializeMemoryExportItem(
        baseRow({
            evidences: [
                {
                    sourceType: "external_message",
                    manualContent: null,
                    externalMessage: {
                        externalConversationId: "ext-conv-locked",
                        ordinal: 1,
                        role: "user",
                        sourceLocked: true,
                    },
                },
                {
                    sourceType: "external_message",
                    manualContent: null,
                    externalMessage: {
                        externalConversationId: "ext-conv-open",
                        ordinal: 2,
                        role: "user",
                        sourceLocked: false,
                    },
                },
                {
                    sourceType: "manual",
                    manualContent: "직접 적은 근거",
                    externalMessage: null,
                },
            ],
        })
    );
    assert.deepEqual(item.evidence, [
        { sourceType: "external_message", locked: true },
        {
            sourceType: "external_message",
            externalConversationId: "ext-conv-open",
            ordinal: 2,
            role: "user",
        },
        { sourceType: "manual", grounds: "직접 적은 근거" },
    ]);
});
