import assert from "node:assert/strict";
import test from "node:test";

import { classifyContextWindows } from "../scripts/check-router-context-window-db-core.mjs";

// `npm run check:router-context-window-db` needs the deployed database, so it
// is manually gated and CI never runs it. These tests are the only thing that
// exercises the rule it applies -- and the rule decides whether a model is
// guarded, so it decaying unnoticed is the exact failure the check exists to
// prevent.

const model = (id, contextWindowTokens, extra = {}) => ({
    id,
    provider: "openai",
    minimumPlan: "Free",
    contextWindowTokens,
    ...extra,
});

test("a matching pair is neither a finding nor an exception", () => {
    const result = classifyContextWindows({
        runtime: [model("a", 200_000)],
        catalogue: [model("a", 200_000)],
    });
    assert.equal(result.cleared.length, 0);
    assert.equal(result.differing.length, 0);
    assert.equal(result.closed.length, 0);
    assert.equal(result.undeclared.length, 0);
});

// The finding the whole check exists for. `getRuntimeModels` builds each model
// from its row alone, so the row is the whole truth: a NULL there is an
// unguarded model no matter what lib/models.ts declares.
test("a row that clears a declared window is the finding, not a difference", () => {
    const result = classifyContextWindows({
        runtime: [model("a", null)],
        catalogue: [model("a", 200_000)],
    });
    assert.deepEqual(
        result.cleared.map((entry) => entry.modelId),
        ["a"]
    );
    assert.equal(result.differing.length, 0, "a cleared window is not a disagreement about a number");
    assert.deepEqual(
        result.undeclared.map((entry) => entry.modelId),
        ["a"]
    );
});

// The catalogue check holds a ratcheted baseline of models that declare no
// window. Those are known and accounted for; this must not re-report them as
// the regression above.
test("a model undeclared in both is not reported as cleared", () => {
    const result = classifyContextWindows({
        runtime: [model("a", null)],
        catalogue: [model("a", null)],
    });
    assert.equal(result.cleared.length, 0);
    assert.equal(result.entries[0].undeclaredEverywhere, true);
    assert.deepEqual(
        result.undeclared.map((entry) => entry.modelId),
        ["a"]
    );
});

test("a model only the registry knows about, with no window, is nobody else's finding", () => {
    const result = classifyContextWindows({
        runtime: [model("only-in-registry", null)],
        catalogue: [model("a", 200_000)],
    });
    assert.deepEqual(
        result.unknownUndeclared.map((entry) => entry.modelId),
        ["only-in-registry"]
    );
    assert.equal(result.entries[0].inCatalogue, false);
    // Not `clearedByRow`: there is no catalogue window for a row to have
    // cleared, and reporting it as such would send someone to a file that
    // does not mention the model.
    assert.equal(result.cleared.length, 0);
});

test("a registry-only model that declares a window is not a finding at all", () => {
    const result = classifyContextWindows({
        runtime: [model("only-in-registry", 128_000)],
        catalogue: [model("a", 200_000)],
    });
    assert.equal(result.unknownUndeclared.length, 0);
    assert.equal(result.cleared.length, 0);
    assert.equal(result.undeclared.length, 0);
});

test("a row supplying a window the catalogue lacks is reported apart from a disagreement", () => {
    const result = classifyContextWindows({
        runtime: [model("a", 128_000)],
        catalogue: [model("a", null)],
    });
    assert.deepEqual(
        result.closed.map((entry) => entry.modelId),
        ["a"]
    );
    assert.equal(result.differing.length, 0);
    assert.equal(result.cleared.length, 0);
});

test("two declared windows that disagree are a disagreement, in both directions", () => {
    const larger = classifyContextWindows({
        runtime: [model("a", 300_000)],
        catalogue: [model("a", 200_000)],
    });
    assert.deepEqual(larger.differing.map((entry) => entry.modelId), ["a"]);

    const smaller = classifyContextWindows({
        runtime: [model("a", 100_000)],
        catalogue: [model("a", 200_000)],
    });
    assert.deepEqual(smaller.differing.map((entry) => entry.modelId), ["a"]);
});

// `registryRowToModel` maps a stored 0 to undefined, so a zero window is not a
// window. Reading it as one would report a model as guarded whose fit has no
// room to divide.
test("a zero window is an absent window, not a very small one", () => {
    const result = classifyContextWindows({
        runtime: [model("a", 0)],
        catalogue: [model("a", 200_000)],
    });
    assert.equal(result.entries[0].runtimeWindowTokens, null);
    assert.deepEqual(
        result.cleared.map((entry) => entry.modelId),
        ["a"]
    );
});

test("output is ordered by model id so two runs can be diffed", () => {
    const result = classifyContextWindows({
        runtime: [model("c", 1), model("a", 1), model("b", 1)],
        catalogue: [model("a", 1), model("b", 1), model("c", 1)],
    });
    assert.deepEqual(
        result.entries.map((entry) => entry.modelId),
        ["a", "b", "c"]
    );
});
