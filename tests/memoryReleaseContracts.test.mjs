import assert from "node:assert/strict";
import test from "node:test";
import { formatConversationAsText } from "../lib/exportConversation.ts";
import {
    isPairRevoked,
    memoryExtractionEnabledFromValue,
    memoryInjectionEnabledFromValue,
    parseRevokedPairs,
} from "../lib/memoryAccess.ts";
import {
    externalImportEnabledFromValue,
} from "../lib/externalImportAccess.ts";
import { shareSnapshotSchema } from "../lib/shareSnapshot.ts";

/**
 * Two release contracts that nothing was asserting, and that break quietly.
 *
 *   §13.3 — a share link and a conversation export carry no memory. Today
 *   that is true because the shapes are narrow, not because anything checks;
 *   the failure mode is somebody widening a shape and nobody noticing until
 *   a stranger can read the author's stored memories.
 *
 *   §15 — every rollout flag defaults off and fails closed. The failure mode
 *   is a flag that reads a missing or malformed setting as "on", which turns
 *   a configuration gap into an enabled feature.
 *
 * Both are cheap to state and expensive to discover late.
 */

/* ---------------------------------------------------- §13.3 share exclusion */

/** Everything a share snapshot is allowed to carry. */
const ALLOWED_SNAPSHOT_KEYS = [
    "version",
    "title",
    "conversationCreatedAt",
    "sharedAt",
    "messages",
];

const ALLOWED_MESSAGE_KEYS = ["id", "role", "content", "modelId", "createdAt"];

/** Field names that would mean memory reached a third party. */
const FORBIDDEN = [
    "memory",
    "memories",
    "memoryContext",
    "memoryIds",
    "statement",
    "statements",
    "evidence",
    "searchTerms",
    "contextBundle",
    "bundleId",
    "retrievalHash",
    "knowledgeChunks",
];

const validSnapshot = () => ({
    version: 1,
    title: "Shared conversation",
    conversationCreatedAt: "2026-08-01T00:00:00.000Z",
    sharedAt: "2026-08-02T00:00:00.000Z",
    messages: [
        {
            id: "m-1",
            role: "assistant",
            content: "An answer.",
            modelId: "gpt-5-6-luna",
            createdAt: "2026-08-01T00:00:01.000Z",
        },
    ],
});

test("the share snapshot shape is exactly the allowed keys", () => {
    // Pinned rather than inspected: adding a field here has to be a deliberate
    // edit to this list, which is the moment to ask whether it is memory.
    assert.deepEqual(
        Object.keys(shareSnapshotSchema.shape).sort(),
        [...ALLOWED_SNAPSHOT_KEYS].sort()
    );
    const parsed = shareSnapshotSchema.parse(validSnapshot());
    assert.deepEqual(Object.keys(parsed.messages[0]).sort(), [
        ...ALLOWED_MESSAGE_KEYS,
    ].sort());
});

test("no share snapshot field is named after anything memory carries", () => {
    for (const key of Object.keys(shareSnapshotSchema.shape)) {
        assert.ok(
            !FORBIDDEN.includes(key),
            `${key} must not appear in a share snapshot (§13.3)`
        );
    }
});

test("memory fields smuggled into a snapshot are dropped, not stored", () => {
    const parsed = shareSnapshotSchema.parse({
        ...validSnapshot(),
        memoryContext: "What is known about the user: …",
        memoryIds: ["mem-1"],
        contextBundle: "abc.def",
        messages: [
            {
                ...validSnapshot().messages[0],
                memoryIds: ["mem-1"],
                evidence: ["conv-1"],
            },
        ],
    });
    const serialized = JSON.stringify(parsed);
    for (const key of FORBIDDEN) {
        assert.ok(
            !serialized.includes(key),
            `${key} survived into the parsed snapshot`
        );
    }
    assert.ok(!serialized.includes("What is known about the user"));
});

test("a conversation export prints only the conversation", () => {
    const text = formatConversationAsText({
        title: "Exported",
        createdAt: "2026-08-01T00:00:00.000Z",
        messages: [
            {
                role: "assistant",
                content: "An answer.",
                modelId: "gpt-5-6-luna",
                createdAt: "2026-08-01T00:00:01.000Z",
            },
        ],
    });
    assert.ok(text.includes("An answer."));
    for (const key of FORBIDDEN) {
        assert.ok(!text.includes(key), `${key} reached a conversation export`);
    }
    assert.ok(!text.includes("ACCOUNT_MEMORY"), "no memory block markers");
});

test("an export ignores fields it was not asked to print", () => {
    // The formatter reads a fixed set; anything extra on the object — which is
    // how a memory field would arrive — must not be rendered.
    const text = formatConversationAsText({
        title: "Exported",
        messages: [
            {
                role: "assistant",
                content: "An answer.",
                // Deliberately extra: this is the shape a leak would arrive in.
                memoryContext: "leaked memory block",
                statement: "사용자는 커피를 좋아한다",
            },
        ],
    });
    assert.ok(!text.includes("leaked memory block"));
    assert.ok(!text.includes("커피"));
});

/* ------------------------------------------------------- §15 fail-closed -- */

test("every rollout flag is off unless it says exactly true", () => {
    const readers = {
        memoryExtraction: memoryExtractionEnabledFromValue,
        memoryInjection: memoryInjectionEnabledFromValue,
        externalImport: externalImportEnabledFromValue,
    };
    for (const [name, read] of Object.entries(readers)) {
        assert.equal(read("true"), true, `${name} opts in on "true"`);
        for (const value of [
            undefined,
            null,
            "",
            " ",
            "TRUE",
            "True",
            "1",
            "yes",
            "on",
            "enabled",
            "false",
            "{}",
            "null",
        ]) {
            assert.equal(
                read(value),
                false,
                `${name} must stay off for ${JSON.stringify(value)}`
            );
        }
    }
});

/* --------------------------------------------- §12.1 revocation direction -- */

test("an unreadable revocation list revokes everything, never nothing", () => {
    // The dangerous direction is un-revoking: a malformed list must not let a
    // pair an operator pulled keep running.
    const pair = {
        extractionModelId: "gpt-5-6-luna",
        promptVersion: "mem-extract-v1",
    };
    for (const value of [
        "not json",
        "{}",
        '"a string"',
        "[1]",
        '["missing-separator"]',
        '["::leading"]',
        '["trailing::"]',
    ]) {
        const state = parseRevokedPairs(value);
        assert.equal(
            state.kind,
            "revoke_all",
            `${value} must fail closed`
        );
        assert.equal(isPairRevoked(state, pair), true);
    }
});

test("an absent or empty list revokes nothing", () => {
    for (const value of [undefined, null, "", "   ", "[]"]) {
        assert.equal(parseRevokedPairs(value).kind, "none");
    }
});

test("a well-formed list revokes exactly what it names", () => {
    const state = parseRevokedPairs(
        JSON.stringify(["gpt-5-6-luna::mem-extract-v1"])
    );
    assert.equal(
        isPairRevoked(state, {
            extractionModelId: "gpt-5-6-luna",
            promptVersion: "mem-extract-v1",
        }),
        true
    );
    assert.equal(
        isPairRevoked(state, {
            extractionModelId: "gpt-5-6-luna",
            promptVersion: "mem-extract-v2",
        }),
        false,
        "a different prompt version is a different pair"
    );
});
