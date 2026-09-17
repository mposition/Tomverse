import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    CONTINUATION_SOURCE_EXPORT_LIMITS,
    continuationSourceExportFooter,
    formatImportedExportMessage,
} from "../lib/continuationSourceExport.ts";
import { continuationExportProvenance } from "../lib/continuationSharingPolicy.ts";

/**
 * CONT-EXPORT-01B (docs/policy/external-conversation-continuation.md §9.1):
 * what the file says about the half it did not produce.
 */

test("an imported turn is labelled by its own provider, model and clock", () => {
    const text = formatImportedExportMessage(
        {
            role: "assistant",
            content: "You decided to expand first.",
            sourceModelLabel: "gpt-4-turbo",
            sourceTimestamp: new Date("2026-07-01T00:00:10.000Z"),
            truncated: false,
        },
        "ChatGPT"
    );
    assert.match(text, /\[Imported · ChatGPT · gpt-4-turbo\] 2026-07-01T00:00:10\.000Z/);
    assert.match(text, /You decided to expand first\./);
    // Never a Tomverse model name: the label is the source's own word.
    assert.doesNotMatch(text, /Luna|Tomverse/);
});

test("an imported turn with no model or time says so rather than inventing either", () => {
    const text = formatImportedExportMessage(
        { role: "assistant", content: "…", sourceModelLabel: null, sourceTimestamp: null, truncated: false },
        "Claude"
    );
    assert.match(text, /\[Imported · Claude · Assistant\] time unknown/);
    const user = formatImportedExportMessage(
        { role: "user", content: "?", sourceModelLabel: "ignored", sourceTimestamp: null, truncated: false },
        "Claude"
    );
    assert.match(user, /\[Imported · Claude · User\]/);
});

test("a message shortened at import says it was", () => {
    const text = formatImportedExportMessage(
        { role: "user", content: "long", sourceModelLabel: null, sourceTimestamp: null, truncated: true },
        "ChatGPT"
    );
    assert.match(text, /shortened when it was imported/);
});

test("the footer states both halves, so a cut file is visible", () => {
    assert.equal(
        continuationSourceExportFooter({ importedMessageCount: 12, nativeMessageCount: 3 }),
        "===== End of export (12 imported, 3 Tomverse messages) =====\n"
    );
});

test("the provenance line says the original is included only in that file", () => {
    const included = continuationExportProvenance({
        providerLabel: "ChatGPT",
        importedAt: "2026-07-02T00:00:00.000Z",
        sourceDeleted: false,
        includesSource: true,
    });
    assert.equal(included.length, 3);
    assert.match(included[1], /included below as Tomverse stored it/);
    assert.match(included[1], /not recoverable/);

    // The ordinary export is unchanged, byte for byte.
    const separate = continuationExportProvenance({
        providerLabel: "ChatGPT",
        importedAt: "2026-07-02T00:00:00.000Z",
        sourceDeleted: false,
    });
    assert.match(separate[1], /stored separately/);
    // A deleted source says that, whichever file was asked for.
    for (const includesSource of [true, false, undefined]) {
        assert.match(
            continuationExportProvenance({
                providerLabel: "ChatGPT",
                importedAt: "2026-07-02T00:00:00.000Z",
                sourceDeleted: true,
                includesSource,
            })[1],
            /has since been deleted/
        );
    }
});

test("the caps are on the finished file and are not the import limits", () => {
    assert.equal(CONTINUATION_SOURCE_EXPORT_LIMITS.maxBytes, 10 * 1024 * 1024);
    assert.equal(CONTINUATION_SOURCE_EXPORT_LIMITS.maxMessages, 10_000);
    const importLimits = readFileSync("lib/externalImportLimits.ts", "utf8");
    // The import ceiling is a different decision about a different thing.
    assert.match(importLimits, /maxNormalizedTextBytesPerAccount: 50 \* 1024 \* 1024/);
});

test("only the opted-in mode is verified, and only it may carry the original", () => {
    const route = readFileSync("app/api/conversations/[conversationId]/export/route.ts", "utf8");
    // One entry point for the source-included file, and it is the query the
    // menu's second item sends.
    assert.match(route, /searchParams\.get\("include"\) === "source"/);
    assert.match(route, /X-Export-Bytes/);
    assert.match(route, /X-Export-SHA256/);
    // The ordinary path still streams, and still says the original is separate.
    assert.match(route, /new ReadableStream<Uint8Array>/);
    const client = readFileSync("app/(site)/(application)/chat/ChatPageClient.tsx", "utf8");
    assert.match(client, /options\.includeSource \? "\?include=source" : ""/);
    assert.match(client, /saveVerifiedResponseAsFile\(response, "conversation\.txt"\)/);
});
