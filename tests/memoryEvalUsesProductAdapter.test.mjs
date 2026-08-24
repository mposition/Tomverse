/**
 * The eval calls the product's provider adapter, not one of its own.
 *
 * Three live runs died on the gap between them. First a system message inside
 * `messages`, which AI SDK 7 refuses outright. Then an output ceiling the
 * harness had chosen for itself -- the model's full 128,000-token capability,
 * where `memoryExtractionWorker` deliberately sends 4,096 because "an answer
 * far past this is a model that has stopped following the format".
 *
 * The second was the worse mistake and it was mine to make twice: a harness
 * free to shape its own request is a harness that can measure something the
 * product never sends, and report the result as the product's quality.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MEMORY_EXTRACTION_CHUNK_MAX_OUTPUT_TOKENS } from "../lib/memoryExtractionWorker.ts";

const harness = readFileSync(
    new URL("../scripts/evalImportedMemoryExtraction.mjs", import.meta.url),
    "utf8"
);

test("the live path goes through createExtractionProviderAdapter", () => {
    assert.match(harness, /createExtractionProviderAdapter/);
    // Not a second call site beside it: the adapter is the call.
    assert.ok(
        !/generateText\(/.test(harness),
        "the harness must not build its own provider call"
    );
});

test("the output ceiling is the product's constant, not a local number", () => {
    assert.match(harness, /MEMORY_EXTRACTION_CHUNK_MAX_OUTPUT_TOKENS/);
    assert.ok(
        !/maxOutputTokens:\s*[\d_]+/.test(harness),
        "no literal ceiling"
    );
    assert.ok(
        !/\.maxOutputTokens\b/.test(harness),
        "the pricing profile's capability is not this prompt's ceiling"
    );
    // And the constant is a real number, so the assertions above are about
    // something rather than about a name that resolves to undefined.
    assert.equal(typeof MEMORY_EXTRACTION_CHUNK_MAX_OUTPUT_TOKENS, "number");
    assert.ok(MEMORY_EXTRACTION_CHUNK_MAX_OUTPUT_TOKENS > 0);
});

test("no system message is constructed anywhere in the harness", () => {
    // The first of the three failures, kept pinned even though the adapter
    // now owns the request: it costs nothing and it is the shape that burned
    // a dispatch.
    assert.ok(
        !/role:\s*["']system["']/.test(harness),
        "the system prompt travels as the adapter sends it"
    );
});
