/**
 * `promptVersion` binds the schema and the transport, not only the words.
 *
 * v1's prompt was fine and v1's schema was fine, and the answers were
 * unusable because nothing connected them: the adapter sent free-form text
 * while the prompt said "matching the requested schema". A version covering
 * the prompt text alone would have called the fix the same eval.
 *
 * So the digest below covers the system prompt, the user prompt's fixed
 * sentences, the output schema and the way that schema reaches the provider.
 * Changing any of them without bumping the version fails here.
 *
 * **Updating this file is the last step of a version bump, never the first.**
 * If this test fails and the version did not change, the change needs a new
 * version -- the register entry, the approved budget and any archived verdict
 * are all keyed to the old one.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    extractionPromptContract,
    MEMORY_EXTRACTION_PROMPT_VERSION,
    MEMORY_EXTRACTION_OUTPUT_SCHEMA,
    MEMORY_EXTRACTION_TRANSPORT,
} from "../lib/memoryExtractionPrompt.ts";
import {
    MEMORY_KINDS,
    MEMORY_POLARITIES,
    MEMORY_SENSITIVITIES,
} from "../lib/memoryValidatorCore.ts";

const FINGERPRINTS = {
    "mem-extract-v2":
        "600af30a3047faec36d786e1b049e1d72ab59d4f4ce39ce8a4e3a58aa608428a",
    "mem-extract-v3": "fdba01bfe18f2cf29a656cc255aad57df7e041360d717cf6aa824e625698eec7",
    "mem-extract-v4":
        "1223dd184292c56d71672ce4af0985a2fd0d0c8a5a3caedb0853c114857a244f",
    "mem-extract-v5":
        "7bb6b27abce3f29dee70f4defd24d8a65175d7a17ab2b9e8d3846ebcc76de281",
    "mem-extract-v6":
        "c85389d8360a997fe80e4d8905304c223f67f67b1676fa2df483daf902b05052",
    "mem-extract-v7":
        "7ec5e591628ad719be7f13faf850a537c6f77cfcb22cc50471a245bee7beb912",
    "mem-extract-v8":
        "5eb52b1d08fb360a1643278659761ada25738dc7f77718ba7a9806e1bec5f86e",
};

test("the shipped version matches its recorded fingerprint", () => {
    const digest = createHash("sha256")
        .update(extractionPromptContract(), "utf8")
        .digest("hex");
    const expected = FINGERPRINTS[MEMORY_EXTRACTION_PROMPT_VERSION];
    assert.ok(
        expected,
        `${MEMORY_EXTRACTION_PROMPT_VERSION} has no recorded fingerprint. ` +
            "Add one here as the last step of the bump."
    );
    assert.equal(
        digest,
        expected,
        `the prompt contract changed under ${MEMORY_EXTRACTION_PROMPT_VERSION}. ` +
            "Bump the version rather than editing the fingerprint."
    );
});

test("the contract covers the schema and the transport", () => {
    // Not a restatement of the digest: it proves the digest would move, which
    // is the property the whole file rests on.
    const contract = extractionPromptContract();
    assert.ok(contract.includes(MEMORY_EXTRACTION_TRANSPORT));
    assert.ok(contract.includes(JSON.stringify(MEMORY_EXTRACTION_OUTPUT_SCHEMA)));
});

test("the schema is strict-compatible", () => {
    // OpenAI's strict mode requires every property in `required` and
    // `additionalProperties: false`; an optional field is a union with null,
    // not an absent one. A schema that violates this is rejected by the
    // provider at call time -- one round trip per case, for every case.
    const walk = (node) => {
        if (!node || typeof node !== "object") return;
        if (node.type === "object") {
            assert.equal(
                node.additionalProperties,
                false,
                "every object must close additionalProperties"
            );
            assert.deepEqual(
                [...(node.required ?? [])].sort(),
                Object.keys(node.properties ?? {}).sort(),
                "every property must be required"
            );
        }
        for (const child of Object.values(node.properties ?? {})) walk(child);
        if (node.items) walk(node.items);
    };
    walk(MEMORY_EXTRACTION_OUTPUT_SCHEMA);
});

test("optional fields are nullable rather than absent", () => {
    const candidate =
        MEMORY_EXTRACTION_OUTPUT_SCHEMA.properties.candidates.items.properties;
    assert.deepEqual(candidate.expiresAt.type, ["string", "null"]);
    assert.deepEqual([...candidate.sensitivity.enum], [...MEMORY_SENSITIVITIES]);
});

test("the kind enum is the validator's list, not a copy", () => {
    // Two lists drift; the parser would then reject a kind the provider was
    // told to produce, and the failure would look like a model problem.
    const candidate =
        MEMORY_EXTRACTION_OUTPUT_SCHEMA.properties.candidates.items.properties;
    assert.deepEqual([...candidate.kind.enum], [...MEMORY_KINDS]);
});

test("polarity is required and enumerated, never a free string", () => {
    // The field schema-3 scoring compares. A free string would let the model
    // answer "positive", which is neither value and means something else
    // again -- and the parser would drop the candidate for a reason the
    // provider could have refused up front.
    const items = MEMORY_EXTRACTION_OUTPUT_SCHEMA.properties.candidates.items;
    assert.ok(items.required.includes("polarity"));
    assert.deepEqual([...items.properties.polarity.enum], [...MEMORY_POLARITIES]);
});

test("a citation carries the quote as well as the label", () => {
    // v6's other required field. A bare-string item would leave the quote
    // something a model could omit by answering v5's shape, and an omitted
    // quote is not checked rather than checked and passed.
    const evidence =
        MEMORY_EXTRACTION_OUTPUT_SCHEMA.properties.candidates.items.properties
            .evidence;
    assert.equal(evidence.items.type, "object");
    assert.deepEqual([...evidence.items.required].sort(), [
        "messageLabel",
        "quote",
    ]);
});
