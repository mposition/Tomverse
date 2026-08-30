import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
    CONTINUATION_SHARE_REFUSAL_CODE,
    continuationExportProvenance,
    continuationShareRefusal,
} from "../lib/continuationSharingPolicy.ts";
import {
    CONTINUATION_SURFACE_PATH,
    continuationPath,
} from "../lib/continuationRoutes.ts";
import { buildChatTurnSystemBlocks } from "../lib/chatTurnSystemBlocks.ts";
import { buildContinuationSeedPrompt } from "../lib/externalContinuationSeedPrompt.ts";
import { planContinuationSeed } from "../lib/externalContinuationSeedCore.ts";
import { estimateTextTokens } from "../lib/chatTokenEstimate.ts";
import { PRODUCT_SURFACE_PATH } from "../lib/productSurfaceRoutes.ts";

/**
 * docs/policy/external-conversation-continuation.md §5, §8, §9 — the contracts
 * that live outside the seed builder.
 */

const systemBlockInput = (overrides = {}) => ({
    modelId: "gpt-5-6-luna",
    provider: "openai",
    isDeepResearchTurn: false,
    isAuthenticated: true,
    canPersist: true,
    nativeSearchEnabled: false,
    nativeSearchForced: false,
    appManagedSearchEnabled: false,
    turnAttachments: [],
    promptText: "carry on",
    imageGenerationFlagEnabled: false,
    planAllowsImageGeneration: false,
    ...overrides,
});

/* ------------------------------------------------------- pricing (§4.4, §5) */

test("a turn with no seed is byte-for-byte the turn it was before", () => {
    const without = buildChatTurnSystemBlocks(systemBlockInput());
    const empty = buildChatTurnSystemBlocks(
        systemBlockInput({ continuationSeedPrompt: "" })
    );
    assert.deepEqual(empty.systemMessages, without.systemMessages);
    assert.equal(empty.promptTokens, without.promptTokens);
});

test("the seed is a system block and its tokens are in the priced total", () => {
    const seed = buildContinuationSeedPrompt({
        provider: "chatgpt",
        importedAt: "2026-08-01T00:00:00.000Z",
        plan: planContinuationSeed({
            messages: [
                { role: "user", ordinal: 0, content: "q", truncated: false },
                {
                    role: "assistant",
                    ordinal: 1,
                    content: "a".repeat(400),
                    truncated: false,
                },
            ],
        }),
    });
    assert.ok(seed.text, "the fixture should render a block");

    const without = buildChatTurnSystemBlocks(systemBlockInput());
    const with_ = buildChatTurnSystemBlocks(
        systemBlockInput({ continuationSeedPrompt: seed.text })
    );

    assert.equal(
        with_.systemMessages.length,
        without.systemMessages.length + 1
    );
    assert.equal(
        with_.systemMessages.at(-1).content,
        seed.text,
        "the seed is the last system block, still above the conversation"
    );
    assert.equal(
        with_.promptTokens - without.promptTokens,
        estimateTextTokens(seed.text),
        "the difference is exactly the block's own tokens"
    );
});

test("a deep research turn carries no blocks at all, seed included", () => {
    const blocks = buildChatTurnSystemBlocks(
        systemBlockInput({
            isDeepResearchTurn: true,
            continuationSeedPrompt: "an excerpt",
        })
    );
    assert.deepEqual(blocks.systemMessages, []);
    assert.equal(blocks.promptTokens, 0);
});

test("the two routes that price a turn both pass the seed through", () => {
    // The whole point of the shared builder is that the quote and the send
    // count the same blocks. A route that built the seed and forgot to hand it
    // over would price a prompt it then sends anyway.
    for (const path of [
        "app/api/chat/route.ts",
        "app/api/chat/preflight/route.ts",
    ]) {
        const source = readFileSync(path, "utf8");
        assert.match(
            source,
            /loadContinuationTurnSeed/,
            `${path} should load the seed`
        );
        assert.match(
            source,
            /continuationSeedPrompt,/,
            `${path} should hand the seed to buildChatTurnSystemBlocks`
        );
        assert.match(
            source,
            /isExternalContinuationEnabled/,
            `${path} should read the rollout flag before seeding`
        );
    }
});

/* ------------------------------------------------------------ share (§9) */

test("an ordinary conversation is not refused", () => {
    assert.equal(
        continuationShareRefusal({ hasContinuationBridge: false }),
        null
    );
});

test("a bridged conversation is refused with its own code", () => {
    const refusal = continuationShareRefusal({ hasContinuationBridge: true });
    assert.ok(refusal);
    assert.equal(refusal.code, CONTINUATION_SHARE_REFUSAL_CODE);
    assert.equal(refusal.status, 409);
    assert.ok(refusal.message.length > 0);
});

test("the share route and the export route both read this one module", () => {
    const share = readFileSync(
        "app/api/conversations/[conversationId]/share/route.ts",
        "utf8"
    );
    assert.match(share, /continuationShareRefusal/);
    const exported = readFileSync(
        "app/api/conversations/[conversationId]/export/route.ts",
        "utf8"
    );
    assert.match(exported, /continuationExportProvenance/);
});

/* ----------------------------------------------------------- export (§9) */

test("the export provenance names the source and says the original is elsewhere", () => {
    const lines = continuationExportProvenance({
        providerLabel: "ChatGPT (OpenAI)",
        importedAt: new Date("2026-08-01T00:00:00.000Z"),
        sourceDeleted: false,
    });
    assert.equal(lines.length, 3);
    assert.match(lines[0], /ChatGPT \(OpenAI\)/);
    assert.match(lines[0], /2026-08-01/);
    assert.match(lines[1], /stored separately/);
    assert.match(lines[2], /Only the Tomverse turns/);
});

test("a deleted source is stated as deleted rather than as a separate download", () => {
    const lines = continuationExportProvenance({
        providerLabel: "Claude (Anthropic)",
        importedAt: "2026-08-01T00:00:00.000Z",
        sourceDeleted: true,
    });
    assert.match(lines[1], /deleted/);
    assert.doesNotMatch(lines[1], /stored separately/);
});

test("no imported message text can reach the provenance lines", () => {
    // The function takes a provider label, a timestamp and a boolean. There is
    // no parameter that could carry a transcript, which is the point: the
    // export cannot widen by accident.
    const lines = continuationExportProvenance({
        providerLabel: "Gemini (Google)",
        importedAt: "2026-08-01T00:00:00.000Z",
        sourceDeleted: false,
    });
    for (const line of lines) {
        assert.doesNotMatch(line, /\n/);
    }
});

/* ---------------------------------------------------------- surface (§8.2) */

test("the continuation surface is its own path, not the future Chat path", () => {
    assert.equal(CONTINUATION_SURFACE_PATH, "/continuations");
    assert.notEqual(CONTINUATION_SURFACE_PATH, PRODUCT_SURFACE_PATH.chat);
    assert.notEqual(CONTINUATION_SURFACE_PATH, PRODUCT_SURFACE_PATH.review);
});

test("a conversation id is encoded into the path", () => {
    assert.equal(continuationPath("abc123"), "/continuations/abc123");
    assert.equal(continuationPath("a/b"), "/continuations/a%2Fb");
});

/* --------------------------------------------- product identity (§3, §10) */

test("the service creates chat conversations through the shared writer", () => {
    const source = readFileSync("lib/externalContinuationService.ts", "utf8");
    assert.match(source, /createConversation\(/);
    assert.match(source, /productKey: CHAT_PRODUCT_KEY/);
    // The three substitutions the policy forbids outright.
    assert.doesNotMatch(source, /REVIEW_PRODUCT_KEY/);
    assert.doesNotMatch(source, /prisma\.conversation\.create/);
    assert.doesNotMatch(source, /selectionMode: "auto"/);
});

test("the service never copies an imported message into a Message row", () => {
    const source = readFileSync("lib/externalContinuationService.ts", "utf8");
    assert.doesNotMatch(source, /\bmessage\.create\b/);
    assert.doesNotMatch(source, /\bmessage\.createMany\b/);
    // `sourceModelLabel` is read for the read-only timeline -- it is display
    // provenance about somebody else's service. What must never happen is it
    // reaching a runtime model field, so that is what is asserted rather than
    // its absence.
    const code = source
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
    assert.doesNotMatch(code, /\bmodelId\b/);
});

test("ownership is scoped in the where clause, never compared afterwards", () => {
    const source = readFileSync("lib/externalContinuationService.ts", "utf8");
    // Every bridge read names the owner inside the query.
    const bridgeReads = source.match(/conversationContinuationBridge\.find\w+\(\{[\s\S]*?\}\)/g) ?? [];
    assert.ok(bridgeReads.length >= 2);
    for (const read of bridgeReads) {
        assert.match(read, /userId/);
    }
});

test("the lock grant is the external namespace, never the native one", () => {
    const source = readFileSync("lib/externalContinuationService.ts", "utf8");
    const grants = source.match(/hasResourceUnlockGrant\(\s*"[a-z_]+"/g) ?? [];
    assert.ok(grants.length >= 3, "every source read checks a grant");
    for (const grant of grants) {
        assert.match(grant, /"external_conversation"/);
    }
    assert.doesNotMatch(source, /hasConversationUnlockGrant/);
});
