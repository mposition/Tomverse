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

/**
 * The delegation moved into a module, and gained a second caller.
 *
 * It used to live inside the harness, and these assertions read the harness's
 * source. Then the development probe needed the same call, and "both build
 * the same adapter" is a claim nobody checks — so the definition became
 * `lib/memoryEvalLiveAdapter.ts` and both scripts import it.
 *
 * So the property is now checked in three places rather than one: the module
 * delegates, and neither script builds a call of its own.
 */
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

/**
 * Comments stripped, because these assertions are about what the code does.
 *
 * The probe's header explains that the shared adapter delegates to
 * `createExtractionProviderAdapter` — and the un-stripped check read that
 * sentence as a second call site. A source-text assertion that fires on prose
 * is one that will be silenced by editing a comment.
 */
const code = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const adapterModule = code(read("../lib/memoryEvalLiveAdapter.ts"));
const harnessScript = code(read("../scripts/evalImportedMemoryExtraction.mjs"));
const probeScript = code(
    read("../scripts/probeMemoryExtractionDevelopment.mjs")
);
const callers = [
    ["harness", harnessScript],
    ["probe", probeScript],
];
/** What the old assertions read: the module plus every caller. */
const harness = [adapterModule, harnessScript, probeScript].join("\n");

test("the live path goes through createExtractionProviderAdapter", () => {
    assert.match(adapterModule, /createExtractionProviderAdapter/);
    // Not a second call site beside it: the adapter is the call.
    assert.ok(
        !/generateText\(/.test(harness),
        "nothing here may build its own provider call"
    );
});

test("every caller uses the shared adapter rather than its own", () => {
    // The reason the module exists. A script that built the adapter itself
    // would be the defect that killed three live runs, with a new filename.
    for (const [name, source] of callers) {
        assert.match(
            source,
            /createEvalLiveAdapter/,
            `${name} does not use the shared adapter`
        );
        assert.ok(
            !/createExtractionProviderAdapter/.test(source),
            `${name} builds the product adapter itself instead of importing the shared one`
        );
    }
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
