import assert from "node:assert/strict";
import test from "node:test";

import { isEchoOfRequest, resolveModelAlias } from "../lib/routerEvalModelAlias.ts";

// The listing Mistral actually returned on 2026-08-25 for /v1/models, filtered
// to the large family. Both directions of the mapping are present, which is
// what the resolver reads.
const MISTRAL = [
    { id: "mistral-large-2512", name: "mistral-large-2512", aliases: ["mistral-large-latest"] },
    { id: "mistral-large-latest", name: "mistral-large-2512", aliases: ["mistral-large-2512"] },
];

test("a moving alias resolves to the concrete model behind it", () => {
    assert.deepEqual(resolveModelAlias(MISTRAL, "mistral-large-latest"), {
        resolvedModelId: "mistral-large-2512",
        outcome: "resolved",
        candidates: ["mistral-large-2512"],
    });
});

// Reading only the requested entry would miss providers that record the
// mapping the other way round, so the reverse direction is read too.
test("the mapping is found when only the concrete entry names the alias", () => {
    const oneWay = [{ id: "mistral-large-2512", aliases: ["mistral-large-latest"] }];
    assert.equal(resolveModelAlias(oneWay, "mistral-large-latest").resolvedModelId, "mistral-large-2512");
});

// "The listing recorded no alias" is not "it resolves to itself". Returning
// the requested id would turn silence into a claim, and the record would show
// a resolution that nothing supports.
test("a concrete id resolves to nothing rather than to itself", () => {
    const result = resolveModelAlias(MISTRAL, "mistral-large-2512");
    assert.equal(result.outcome, "no-alias-recorded");
    assert.equal(result.resolvedModelId, null);
});

test("an id the provider does not list is distinguished from one with no alias", () => {
    assert.equal(resolveModelAlias(MISTRAL, "mistral-medium-latest").outcome, "not-listed");
});

// A provider whose listing carries no alias field at all -- OpenAI's shape.
// The resolver must not invent a mapping from ids that merely look related.
test("a listing without alias information yields no resolution", () => {
    const openai = [{ id: "gpt-5.5" }, { id: "gpt-5.5-2026-01-14" }];
    const result = resolveModelAlias(openai, "gpt-5.5");
    assert.equal(result.outcome, "no-alias-recorded");
    assert.equal(result.resolvedModelId, null);
});

// One pointer behind another resolves nothing, so an alias-shaped candidate is
// never accepted as the answer.
test("an alias is not accepted as the resolution of another alias", () => {
    const chained = [{ id: "some-latest", aliases: ["some-model-latest"] }];
    assert.equal(resolveModelAlias(chained, "some-latest").outcome, "no-alias-recorded");
});

// Two concrete ids behind one alias is a contradiction in the provider's own
// listing. Picking one would hide it; the reviewer gets both instead.
test("conflicting candidates are reported, not chosen between", () => {
    const conflicting = [
        { id: "x-latest", name: "x-2511", aliases: ["x-2512"] },
        { id: "x-2510", aliases: ["x-latest"] },
    ];
    const result = resolveModelAlias(conflicting, "x-latest");
    assert.equal(result.outcome, "ambiguous");
    assert.equal(result.resolvedModelId, null);
    assert.deepEqual(result.candidates, ["x-2510", "x-2511", "x-2512"]);
});

test("junk entries are skipped rather than thrown on", () => {
    const junk = [null, 42, {}, { id: 7 }, { id: "a-latest", aliases: "not-an-array" }];
    assert.doesNotThrow(() => resolveModelAlias(junk, "a-latest"));
    assert.equal(resolveModelAlias(junk, "a-latest").outcome, "no-alias-recorded");
    assert.equal(resolveModelAlias([], "").outcome, "not-listed");
});

// --- echo detection --------------------------------------------------------

// The Wave 1 record: the completion response handed the request back, and the
// review sheet told a reviewer to compare that value across batches.
test("a version equal to the requested name is an echo", () => {
    assert.equal(isEchoOfRequest("mistral-large-latest", "mistral-large-latest"), true);
    assert.equal(isEchoOfRequest("mistral-large-latest", "mistral-large-2512"), false);
});

test("a missing version is not an echo -- it is an absence", () => {
    assert.equal(isEchoOfRequest("mistral-large-latest", null), false);
    assert.equal(isEchoOfRequest(null, "mistral-large-latest"), false);
    assert.equal(isEchoOfRequest("  ", "  "), false);
});
