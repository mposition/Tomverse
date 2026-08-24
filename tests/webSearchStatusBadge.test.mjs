import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decideWebSearchBadge } from "../lib/webSearchStatusBadge.ts";

/**
 * The badge beside an assistant answer reports web search. The two failures
 * this file exists to prevent are both failures of *scope*:
 *
 *   1. The badge claiming the answer came from the model's training. It has
 *      one input -- whether a web search happened -- and account memory
 *      (policy §8) and profile knowledge (§14) both ground answers without
 *      touching it. The claim was observed on answers quoting the user's own
 *      uploaded file during the assistant-knowledge staging round.
 *   2. The badge rendering for a message with no search record. Its absence
 *      means the row predates the field, and the old code guessed from the
 *      model's provider -- an assertion about a turn nothing recorded.
 */

const meta = (overrides = {}) => ({
    requested: true,
    supported: true,
    executed: true,
    ...overrides,
});

test("a finished message with no search metadata gets no badge", () => {
    // Historical rows: normalizeWebSearchExecution always returns an object,
    // so every message the current code *persists* carries one. A turn still
    // running is the other way to have none, and is covered below.
    for (const usageClass of ["standard", "research", "deep-research", undefined]) {
        assert.deepEqual(
            decideWebSearchBadge({ searchMetadata: null, usageClass }),
            { shown: false },
            `usageClass ${usageClass} must not resurrect the badge`
        );
        assert.deepEqual(
            decideWebSearchBadge({ searchMetadata: undefined, usageClass }),
            { shown: false }
        );
    }
});

// The regression this pair exists to stop: `searchMetadata` arrives in the
// stream trailer, so it is absent for the whole of a running turn. Reading
// that absence as "old row" hid the Deep Research badge for the entire visible
// run -- the job is asynchronous, so "running" is where the panel sits until
// the research finishes. It was caught by one golden of the four that show the
// state; the other three moved fewer pixels than the diff threshold allows.
test("a Deep Research turn keeps its badge while it is still running", () => {
    assert.deepEqual(
        decideWebSearchBadge({
            searchMetadata: null,
            usageClass: "deep-research",
            generating: true,
        }),
        { shown: true, status: "deep-research" }
    );
    assert.deepEqual(
        decideWebSearchBadge({
            searchMetadata: undefined,
            usageClass: "deep-research",
            generating: true,
        }),
        { shown: true, status: "deep-research" }
    );
});

test("running is not a way back in for the guess the provider fallback made", () => {
    // Only the mode is reachable without a record, and only a Deep Research
    // model has one to report. Everything else stays silent until the trailer
    // says what actually happened -- in particular nothing here may claim a
    // search was executed, which is the assertion this module removed.
    for (const usageClass of ["standard", "research", undefined]) {
        assert.deepEqual(
            decideWebSearchBadge({
                searchMetadata: null,
                usageClass,
                generating: true,
            }),
            { shown: false },
            `usageClass ${usageClass} must stay silent while running`
        );
    }
});

test("no badge is derived from the provider for a message with no record", () => {
    // The specific guess that was removed: a Perplexity research model was
    // reported as having searched, on a row that says nothing at all.
    assert.deepEqual(
        decideWebSearchBadge({ searchMetadata: null, usageClass: "research" }),
        { shown: false }
    );
});

test("an answer that did not search says so, and says nothing more", () => {
    assert.deepEqual(
        decideWebSearchBadge({
            searchMetadata: meta({ requested: false, executed: false }),
            usageClass: "standard",
        }),
        { shown: true, status: "not-searched" }
    );
});

test("the search outcomes each report themselves", () => {
    const cases = [
        [meta({ supported: false, executed: false }), "unsupported"],
        [meta({ executed: false, failureCode: "SEARCH_PROVIDER_ERROR" }), "failed"],
        [meta(), "executed"],
        [meta({ executed: false }), "requested-not-executed"],
    ];
    for (const [searchMetadata, expected] of cases) {
        assert.deepEqual(
            decideWebSearchBadge({ searchMetadata, usageClass: "standard" }),
            { shown: true, status: expected }
        );
    }
});

test("a failure outranks execution, so a partial search is never reported as done", () => {
    assert.deepEqual(
        decideWebSearchBadge({
            searchMetadata: meta({ executed: true, failureCode: "SEARCH_TIMEOUT" }),
            usageClass: "standard",
        }),
        { shown: true, status: "failed" }
    );
});

test("a Deep Research model reports its mode, but not on a row with no record", () => {
    assert.deepEqual(
        decideWebSearchBadge({
            searchMetadata: meta({ requested: false, executed: false }),
            usageClass: "deep-research",
        }),
        { shown: true, status: "deep-research" }
    );
    // Finished, and nothing was recorded: a row from before the field, where
    // the label would describe the model rather than this answer.
    assert.deepEqual(
        decideWebSearchBadge({ searchMetadata: null, usageClass: "deep-research" }),
        { shown: false }
    );
    assert.deepEqual(
        decideWebSearchBadge({
            searchMetadata: null,
            usageClass: "deep-research",
            generating: false,
        }),
        { shown: false }
    );
});

test("nothing in the badge names a source of grounding other than the web", () => {
    // The regression is a word, not a branch: the next person to add an
    // `else` here would reach for the same phrase. Memory and knowledge
    // attribution are stated by the disclosures that count them, and this
    // module must not grow a second, uncounted opinion about them.
    const source = readFileSync(
        fileURLToPath(new URL("../lib/webSearchStatusBadge.ts", import.meta.url)),
        "utf8"
    );
    const statuses = source.slice(source.indexOf("export type WebSearchBadgeStatus"));
    for (const forbidden of ["training-knowledge", "memory", "knowledge"]) {
        assert.ok(
            !statuses.includes(`"${forbidden}"`),
            `"${forbidden}" is not a web-search status`
        );
    }
});
