import assert from "node:assert/strict";
import test from "node:test";

import {
    KNOWN_SILENT_SOURCES,
    modelContextWindowEvidence,
} from "../scripts/report-model-context-window-evidence-core.mjs";

// The report exists so that 16 context windows get written from what providers
// published rather than from memory. Its whole value is the bucket a model
// lands in: "declarable" means somebody may write a number into lib/models.ts
// on the strength of it, and a model that reaches that bucket without evidence
// is how a wrong window gets declared -- which is worse than none, because a
// too-large window passes the guard by inventing headroom.

const model = (id, extra = {}) => ({
    id,
    provider: "openai",
    apiModel: `${id}-api`,
    minimumPlan: "Free",
    contextWindowTokens: null,
    ...extra,
});

const entry = (apiModel, metadata, extra = {}) => ({
    provider: "openai",
    apiModel,
    lifecycle: null,
    lastSeenAt: "2026-08-20T00:00:00.000Z",
    metadata,
    ...extra,
});

test("a model that already declares a window is not asked about", () => {
    const result = modelContextWindowEvidence({
        models: [model("a", { contextWindowTokens: 200_000 })],
        catalogEntries: [entry("a-api", { contextLength: 200_000 })],
    });
    assert.equal(result.rows.length, 0);
});

test("a published context length is declarable, and carries its date", () => {
    const result = modelContextWindowEvidence({
        models: [model("a")],
        catalogEntries: [entry("a-api", { contextLength: 128_000 })],
    });
    assert.deepEqual(
        result.declarable.map((row) => [row.modelId, row.contextLength]),
        [["a", 128_000]]
    );
    assert.equal(result.rows[0].lastSeenAt, "2026-08-20T00:00:00.000Z");
    assert.equal(result.unobserved.length, 0);
});

// The distinction the whole report turns on. An input limit excludes the
// answer, so declaring it as a context window understates the room by every
// reply -- and adding the two together guesses at how the provider counts.
test("an input limit is evidence, but not the kind you may declare from", () => {
    const result = modelContextWindowEvidence({
        models: [model("a")],
        catalogEntries: [
            entry("a-api", { inputTokenLimit: 200_000, outputTokenLimit: 8_000 }),
        ],
    });
    assert.equal(result.declarable.length, 0);
    assert.deepEqual(
        result.partial.map((row) => row.modelId),
        ["a"]
    );
    assert.equal(result.rows[0].inputTokenLimit, 200_000);
    assert.equal(result.rows[0].outputTokenLimit, 8_000);
});

test("a context length wins over an input limit when both are published", () => {
    const result = modelContextWindowEvidence({
        models: [model("a")],
        catalogEntries: [
            entry("a-api", { contextLength: 208_000, inputTokenLimit: 200_000 }),
        ],
    });
    assert.deepEqual(result.declarable.map((row) => row.modelId), ["a"]);
    assert.equal(result.partial.length, 0);
});

test("a model the catalog never saw is separated from one it saw and learned nothing from", () => {
    const result = modelContextWindowEvidence({
        models: [model("seen"), model("unseen")],
        catalogEntries: [entry("seen-api", { ownedBy: "openai" })],
    });
    assert.deepEqual(
        result.unobserved.map((row) => [row.modelId, row.observed]),
        [
            ["seen", true],
            ["unseen", false],
        ]
    );
});

test("a provider whose list endpoint cannot answer says so on the row", () => {
    const result = modelContextWindowEvidence({
        models: [model("sonar", { provider: "perplexity", apiModel: "sonar" })],
        catalogEntries: [],
    });
    assert.equal(result.unobserved.length, 1);
    assert.equal(
        result.unobserved[0].knownSilentSource,
        KNOWN_SILENT_SOURCES.perplexity
    );
});

// Zero and negative are not windows. A provider that returns 0 has told you
// nothing, and treating it as a figure would declare a model guarded whose fit
// has no room to divide.
test("a non-positive published figure is no figure", () => {
    for (const value of [0, -1]) {
        const result = modelContextWindowEvidence({
            models: [model("a")],
            catalogEntries: [entry("a-api", { contextLength: value })],
        });
        assert.equal(result.declarable.length, 0, `${value} was accepted`);
        assert.equal(result.unobserved.length, 1);
    }
});

test("evidence is matched on provider and apiModel together, not either alone", () => {
    const result = modelContextWindowEvidence({
        models: [model("a", { provider: "mistral", apiModel: "shared-name" })],
        // Same apiModel, different provider: not this model's evidence.
        catalogEntries: [
            entry("shared-name", { contextLength: 999_999 }, { provider: "openai" }),
        ],
    });
    assert.equal(result.declarable.length, 0);
    assert.equal(result.unobserved[0].observed, false);
});

test("rows are ordered by model id so two runs can be diffed", () => {
    const result = modelContextWindowEvidence({
        models: [model("c"), model("a"), model("b")],
        catalogEntries: [],
    });
    assert.deepEqual(
        result.rows.map((row) => row.modelId),
        ["a", "b", "c"]
    );
});
