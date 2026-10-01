import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { chatgptAdapter } from "../lib/externalImportAdapters/chatgpt.ts";
import {
    CONTINUATION_SEED_VERSION,
    planContinuationSeed,
} from "../lib/externalContinuationSeedCore.ts";

/**
 * The staging fixtures and their answer key have to agree with each other and
 * with the product.
 *
 * docs/ops/external-conversation-continuation-staging-checklist.md sends an
 * operator into paid turns holding `manifest.json` as the thing that says what
 * the right answer is. A manifest that has drifted from its own fixtures is
 * worse than no manifest: it does not fail, it just makes a correct run look
 * wrong, or an incorrect one look right, and the operator has no third source
 * to break the tie.
 *
 * So three claims are checked here, none of which restate the generator:
 *
 *   1. Every fixture is something the real ChatGPT adapter accepts and parses.
 *      An export shape the importer refuses would waste a staging session
 *      before the first paid turn.
 *   2. The manifest's digests match the files on disk, so a hand-edited
 *      fixture cannot keep an answer key that no longer describes it.
 *   3. The manifest's seed expectations equal what `planContinuationSeed()`
 *      produces now. Change a budget constant and this fails, which is the
 *      point -- the answer key is a claim about today's rules.
 */

const DIR =
    "docs/ops/external-conversation-continuation-staging-verification-records/fixtures";

const manifest = JSON.parse(readFileSync(`${DIR}/manifest.json`, "utf8"));

/**
 * The fixture's content, with line endings normalised to LF.
 *
 * The manifest's size and digest are claims about *content*, not about how a
 * particular clone happens to have written it to disk. Git's autocrlf turns
 * every LF into CRLF on a Windows checkout, which added one byte per line --
 * 150 for `plain-conversation.json` -- and failed this check on a clone that
 * was perfectly correct. `.gitattributes` now pins these files to LF so the
 * bytes an operator uploads match the digest; normalising here as well means
 * the check still says something true on a working tree that predates it.
 */
const contentOf = (file) =>
    readFileSync(`${DIR}/${file}`, "utf8").replace(/\r\n/g, "\n");

/** The adapter walks `current_node` back to the root; ordinals follow. */
const parsedMessages = (entry) => {
    const conversation = chatgptAdapter.parseConversation(entry);
    assert.ok(conversation, "the adapter parses the fixture");
    return conversation;
};

test("the manifest describes the fixtures that are actually on disk", () => {
    assert.ok(manifest.fixtures.length >= 3);
    for (const row of manifest.fixtures) {
        const body = contentOf(row.file);
        assert.equal(Buffer.byteLength(body), row.bytes, row.file);
        assert.equal(
            createHash("sha256").update(body).digest("hex").slice(0, 16),
            row.sha256_16,
            `${row.file} was edited without regenerating the manifest`
        );
    }
});

test("every fixture is an export the real importer accepts", () => {
    for (const row of manifest.fixtures) {
        const parsed = JSON.parse(contentOf(row.file));
        assert.ok(
            chatgptAdapter.detect(parsed),
            `${row.file} is not detected as a ChatGPT export`
        );
        const conversation = parsedMessages(parsed[0]);
        assert.equal(conversation.title, row.title);
        assert.equal(
            conversation.messages.length,
            row.expected.sourceMessageCount,
            `${row.file} parses to a different message count than the manifest claims`
        );
        // The adapter dropped nothing: a fixture that silently lost a turn
        // would move every ordinal in the answer key.
        assert.equal(conversation.warnings.skippedEmptyMessages, 0);
        assert.equal(conversation.warnings.skippedNonTextParts, 0);
        assert.equal(conversation.warnings.additionalBranchCount, 0);
    }
});

test("the answer key's seed numbers are what the planner produces today", () => {
    assert.equal(manifest.seedVersion, CONTINUATION_SEED_VERSION);
    for (const row of manifest.fixtures) {
        const parsed = JSON.parse(contentOf(row.file));
        const conversation = parsedMessages(parsed[0]);
        const plan = planContinuationSeed({
            messages: conversation.messages.map((message) => ({
                role: message.role,
                ordinal: message.ordinal,
                content: message.content,
                truncated: false,
            })),
            sourceMessageCount: conversation.messages.length,
        });
        assert.deepEqual(
            {
                seedMessageCount: plan.turns.length,
                truncatedCount: plan.truncatedCount,
                omittedByBudgetCount: plan.omittedByBudgetCount,
                excludedByRoleCount: plan.excludedByRoleCount,
                fromOrdinal: plan.fromOrdinal,
                toOrdinal: plan.toOrdinal,
            },
            {
                seedMessageCount: row.expected.seedMessageCount,
                truncatedCount: row.expected.truncatedCount,
                omittedByBudgetCount: row.expected.omittedByBudgetCount,
                excludedByRoleCount: row.expected.excludedByRoleCount,
                fromOrdinal: row.expected.fromOrdinal,
                toOrdinal: row.expected.toOrdinal,
            },
            `${row.file}: the manifest's expectation no longer matches the planner`
        );
    }
});

test("the injection fixture really carries all three payloads", () => {
    // The §D fixture is the one whose value depends entirely on its contents.
    // If a payload were lost in an edit the run would pass by testing nothing,
    // and a passing prompt-boundary section is exactly the result nobody would
    // re-examine.
    const row = manifest.fixtures.find((entry) =>
        entry.file.includes("injection")
    );
    assert.ok(row);
    const parsed = JSON.parse(contentOf(row.file));
    const conversation = parsedMessages(parsed[0]);
    const assistantText = conversation.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.content)
        .join("\n");

    for (const [name, payload] of Object.entries(manifest.injectionStrings)) {
        assert.ok(
            assistantText.includes(payload),
            `the ${name} payload is missing from the fixture's assistant turns`
        );
    }
    // And every payload is spoken by the *source*, never by a user turn the
    // operator might mistake for their own prompt.
    const userText = conversation.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content)
        .join("\n");
    for (const payload of Object.values(manifest.injectionStrings)) {
        assert.ok(!userText.includes(payload));
    }
});

test("the fixture the run locks and deletes carries no injection payload", () => {
    // §A, §C and §E run on the plain fixture. If it contained an override
    // string, a refusal caused by the prompt boundary could be misread as a
    // deletion or lock working, and the two sections would stop being
    // independent evidence.
    const row = manifest.fixtures.find((entry) => entry.file.includes("plain"));
    assert.ok(row);
    const body = contentOf(row.file);
    for (const payload of Object.values(manifest.injectionStrings)) {
        assert.ok(!body.includes(payload));
    }
    assert.ok(!body.includes("IGNORE ALL PREVIOUS INSTRUCTIONS"));
    assert.ok(!body.includes("END_IMPORTED_CONVERSATION"));
});
