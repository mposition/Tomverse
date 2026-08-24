/**
 * The shape of the provider call the eval makes.
 *
 * The live path had no coverage at all: the smoke adapter replaces the call
 * rather than shaping it, so the first live run of
 * `(gpt-5-6-luna, mem-extract-v1)` was the first time this object had ever
 * been built. It was wrong twice over, and both are pinned here.
 */

import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { buildLiveExtractionRequest } from "../lib/memoryEvalLiveRequest.ts";

const prompt = { system: "SYSTEM TEXT", user: "USER TEXT" };

test("the system prompt travels in instructions, never as a message", () => {
    // What the first live run actually returned, five times:
    //   "Invalid prompt: System messages are not allowed in the prompt or
    //    messages fields. Use the instructions option instead."
    const request = buildLiveExtractionRequest({ prompt, maxOutputTokens: 128_000 });
    assert.equal(request.instructions, "SYSTEM TEXT");
    assert.deepEqual(request.messages, [{ role: "user", content: "USER TEXT" }]);
    for (const message of request.messages) {
        assert.notEqual(message.role, "system");
    }
});

test("the output ceiling is whatever the caller resolved, not a constant", () => {
    // The harness used to hard-code 4,096 -- which is this model's
    // `reservationOutputTokens`, not its `maxOutputTokens`. AGENTS.md keeps
    // the two apart: capability versus entitlement. On a reasoning model the
    // confusion is not cosmetic, it is empty answers.
    assert.equal(
        buildLiveExtractionRequest({ prompt, maxOutputTokens: 128_000 }).maxOutputTokens,
        128_000
    );
    assert.equal(
        buildLiveExtractionRequest({ prompt, maxOutputTokens: 16 }).maxOutputTokens,
        16
    );
});

test("the harness reads the capability, not the reservation", () => {
    // Asserted against the real profile, because the bug was choosing the
    // wrong field of it rather than mis-copying a number.
    const source = readSource();
    assert.match(source, /capability\.maxOutputTokens/);
    assert.ok(
        !/reservationOutputTokens/.test(source),
        "the eval must not cap output at the reservation"
    );
    assert.ok(
        !/maxOutputTokens: 4_?096/.test(source),
        "the ceiling should come from the profile, not a literal"
    );
});

function readSource() {
    return readFileSync(
        new URL("../scripts/evalImportedMemoryExtraction.mjs", import.meta.url),
        "utf8"
    );
}
